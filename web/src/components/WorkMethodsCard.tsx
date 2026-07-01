import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../api";
import { useFeatures } from "../lib/features";
import { Card, Button, Input, money } from "./ui";

// Working-from-home (fixed-rate) + car (cents-per-km) inputs. WFH is captured in DAYS PER WEEK — the
// way people actually think about it — and the annual hours are derived transparently (≈ days × 7.6h ×
// 48 weeks), shown as an editable figure. Hours stay the authoritative number the engine reads; an
// explicit hours edit always wins. General information only — the ATO requires a contemporaneous record
// of your actual hours, so this estimate is a starting point to refine.
const HOURS_PER_DAY = 7.6;
const DEFAULT_WEEKS = 48;
const deriveHours = (daysPerWeek: number, weeks: number) => Math.round(Math.max(0, daysPerWeek) * HOURS_PER_DAY * (weeks > 0 ? weeks : DEFAULT_WEEKS));

// Mon-first weekday options for the diary (value 0=Mon … 6=Sun, matching generateWfhDiary on the server).
const WEEKDAYS: { v: number; label: string }[] = [
  { v: 0, label: "Mon" }, { v: 1, label: "Tue" }, { v: 2, label: "Wed" }, { v: 3, label: "Thu" },
  { v: 4, label: "Fri" }, { v: 5, label: "Sat" }, { v: 6, label: "Sun" },
];
// Pre-tick the first N weekdays (Mon-first) so the diary stays consistent with the days/week figure.
const defaultWeekdays = (daysPerWeek: string | number | null | undefined): number[] => {
  const n = Math.min(7, Math.max(0, Math.round(Number(daysPerWeek) || 0)));
  return [0, 1, 2, 3, 4, 5, 6].slice(0, n);
};
type LeaveRange = { start: string; end: string; label?: string };

export function WorkMethodsCard({ fyNum }: { fyNum: number }) {
  const qc = useQueryClient();
  const { has } = useFeatures();
  const diaryEnabled = has("wfh_generate_diary");
  const hoursSimple = has("wfh_hours_simple"); // slice 10: one primary hours field + a one-way days×weeks estimator
  const { data } = useQuery({ queryKey: ["work-use", fyNum], queryFn: () => api.workUse(fyNum) });
  const [days, setDays] = useState<string>("");
  const [weeks, setWeeks] = useState<string>("");
  const [hours, setHours] = useState<string>("");
  const [hoursTouched, setHoursTouched] = useState(false); // did the user type hours directly? (then it wins)
  const [office, setOffice] = useState(false);
  const [hasRecord, setHasRecord] = useState(false);
  // 0059 diary inputs.
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [weekdaysTouched, setWeekdaysTouched] = useState(false); // hand-picked? (then days/week edits don't clobber)
  const [leave, setLeave] = useState<LeaveRange[]>([]);
  const [genDiary, setGenDiary] = useState(false);
  const [seeded, setSeeded] = useState<number | null>(null);
  if (data && seeded !== fyNum) {
    setDays(data.wfh_days_per_week != null ? String(data.wfh_days_per_week) : "");
    setWeeks(data.wfh_weeks != null ? String(data.wfh_weeks) : "");
    setHours(data.wfh_hours != null ? String(data.wfh_hours) : "");
    setHoursTouched(false);
    setOffice(!!data.has_dedicated_home_office);
    setHasRecord(!!data.wfh_has_record);
    const savedWeekdays = Array.isArray(data.wfh_weekdays) && data.wfh_weekdays.length > 0;
    setWeekdays(savedWeekdays ? data.wfh_weekdays! : defaultWeekdays(data.wfh_days_per_week));
    setWeekdaysTouched(savedWeekdays); // a previously-saved selection is authoritative, don't auto-overwrite it
    setLeave(Array.isArray(data.wfh_leave_ranges) ? data.wfh_leave_ranges : []);
    setGenDiary(!!data.wfh_generate_diary);
    setSeeded(fyNum);
  }

  // Editing days/week re-derives the hours figure (still editable afterwards) and keeps the pre-ticked
  // diary weekdays in step until the user hand-picks them.
  const onDays = (v: string) => {
    setDays(v);
    if (v.trim() !== "") setHours(String(deriveHours(Number(v) || 0, Number(weeks) || DEFAULT_WEEKS)));
    if (!weekdaysTouched) setWeekdays(defaultWeekdays(v)); // keep in step only while the user hasn't hand-picked days
    setHoursTouched(false);
  };
  const onWeeks = (v: string) => {
    setWeeks(v);
    if (days.trim() !== "") setHours(String(deriveHours(Number(days) || 0, Number(v) || DEFAULT_WEEKS)));
  };
  const onHours = (v: string) => { setHours(v); setHoursTouched(true); };
  // Slice 10 estimator: a ONE-WAY "fill the hours from days × weeks" action (mirrors onDays exactly —
  // derives hours, keeps the diary weekdays in step, and leaves hours non-"touched" so a live diary still
  // drives them). The days/weeks stay persisted for the diary pre-tick, same as the OFF layout.
  const applyEstimate = () => {
    setHours(String(deriveHours(Number(days) || 0, Number(weeks) || DEFAULT_WEEKS)));
    if (!weekdaysTouched) setWeekdays(defaultWeekdays(days));
    setHoursTouched(false);
  };
  const toggleWeekday = (d: number) => {
    setWeekdaysTouched(true);
    setWeekdays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort((a, b) => a - b)));
  };
  const addLeave = () => setLeave((cur) => [...cur, { start: "", end: "" }]);
  const updateLeave = (i: number, patch: Partial<LeaveRange>) => setLeave((cur) => cur.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const removeLeave = (i: number) => setLeave((cur) => cur.filter((_, j) => j !== i));

  // The diary is only generated when the flag is on, the user asked for it, and they're NOT keeping their
  // own record (a generated diary would then be misleading). When it IS generated, the diary drives the
  // authoritative hours — so send wfh_hours=null and let the server compute from the diary — UNLESS the
  // user explicitly typed an hours override (hoursTouched), which still wins (hours-stay-authoritative).
  const diaryActive = diaryEnabled && genDiary && !hasRecord && weekdays.length > 0;
  const cleanLeave = leave.filter((r) => r.start && r.end && r.start <= r.end);

  const save = useMutation({
    mutationFn: () =>
      api.setWorkUse(fyNum, {
        wfh_hours: diaryActive && !hoursTouched ? null : hours.trim() === "" ? null : Math.max(0, Number(hours)),
        car_work_km: null, // #245: car moved to its own tool (CarMethodsCard); WFH panel no longer carries it
        wfh_days_per_week: days.trim() === "" ? null : Math.max(0, Number(days)),
        wfh_weeks: weeks.trim() === "" ? null : Math.max(0, Number(weeks)),
        has_dedicated_home_office: office,
        wfh_has_record: hasRecord,
        wfh_weekdays: weekdays,
        wfh_leave_ranges: cleanLeave,
        wfh_generate_diary: genDiary,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["work-use", fyNum] });
      qc.invalidateQueries({ queryKey: ["filing-readiness"] });
      qc.invalidateQueries({ queryKey: ["report"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success("Saved your work-from-home inputs.");
    },
    onError: (e) => toast.error("Couldn't save", { description: (e as Error).message }),
  });

  // When the diary drives hours, echo the approximate figure from the ticked weekday count (the exact,
  // leave-adjusted total is generated in the hand-off CSV). Otherwise use the editable hours field.
  const diaryApproxHours = deriveHours(weekdays.length, Number(weeks) || DEFAULT_WEEKS);
  const effectiveHours = diaryActive && !hoursTouched ? diaryApproxHours : Number(hours) || 0;
  const estWfh = Math.round(effectiveHours * 70);

  return (
    <Card className="space-y-3 p-4">
      <div>
        <div className="text-sm font-semibold">Working from home (fixed-rate method)</div>
        <div className="text-xs text-muted">
          <span className="font-medium text-ink">Why this matters:</span> from 1 July 2024 the ATO needs a record of your{" "}
          <span className="font-medium">actual hours</span> worked from home for the whole year — a blanket "I worked X days"
          number isn't accepted. The real job here is to build a defensible record; the dollar figure (70c/hr, covering
          electricity, internet, phone &amp; stationery) is the by-product. General information only — confirm with a
          registered tax agent.
        </div>
      </div>
      {hoursSimple ? (
        /* Slice 10: one authoritative "hours" field; days×weeks demoted to a one-way estimator helper. */
        <>
          <label className="block text-sm">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">Hours worked from home this year</span>
            <Input type="number" min="0" value={hours} onChange={(e) => onHours(e.target.value)} placeholder="e.g. 730" />
            <span className="mt-0.5 block text-xs text-muted">
              ≈ {money(estWfh)} at 70c/hr
              {diaryActive && !hoursTouched
                ? ` · from your diary (≈ ${weekdays.length} day(s)/week — exact hours generated in your hand-off)`
                : hoursTouched || hours.trim() !== "" ? "" : " · enter your hours, or estimate them below"}
            </span>
          </label>
          <details className="rounded-lg border border-line bg-surface px-3 py-2">
            <summary className="cursor-pointer text-xs font-medium text-muted">Not sure of your hours? Estimate from days × weeks</summary>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="text-xs font-medium uppercase tracking-wide text-muted">Days per week from home</span>
                <Input type="number" min="0" max="7" step="0.5" value={days} onChange={(e) => setDays(e.target.value)} placeholder="e.g. 2" />
              </label>
              <label className="block text-sm">
                <span className="text-xs font-medium uppercase tracking-wide text-muted">Working weeks (≈48)</span>
                <Input type="number" min="0" max="52" value={weeks} onChange={(e) => setWeeks(e.target.value)} placeholder="48" />
              </label>
            </div>
            <Button variant="ghost" onClick={applyEstimate} className="mt-2 text-sm">Estimate ≈ {money(Math.round(deriveHours(Number(days) || 0, Number(weeks) || DEFAULT_WEEKS) * 70))} → fill the hours above</Button>
          </details>
        </>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="text-xs font-medium uppercase tracking-wide text-muted">Days per week from home</span>
              <Input type="number" min="0" max="7" step="0.5" value={days} onChange={(e) => onDays(e.target.value)} placeholder="e.g. 2" />
            </label>
            <label className="block text-sm">
              <span className="text-xs font-medium uppercase tracking-wide text-muted">Working weeks (≈48)</span>
              <Input type="number" min="0" max="52" value={weeks} onChange={(e) => onWeeks(e.target.value)} placeholder="48" />
            </label>
          </div>
          <label className="block text-sm">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">Hours worked from home this year (editable)</span>
            <Input type="number" min="0" value={hours} onChange={(e) => onHours(e.target.value)} placeholder="e.g. 730" />
            <span className="mt-0.5 block text-xs text-muted">
              ≈ {money(estWfh)} at 70c/hr
              {diaryActive && !hoursTouched
                ? ` · from your diary (≈ ${weekdays.length} day(s)/week — exact hours generated in your hand-off)`
                : days.trim() !== "" ? ` · derived from ${days} day(s)/week` : ""}
            </span>
          </label>
        </>
      )}
      <div className="space-y-2 border-t border-line pt-3">
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={office} onChange={(e) => setOffice(e.target.checked)} className="mt-0.5 h-4 w-4 flex-none accent-forest" />
          <span>I have a <span className="font-medium">dedicated home office</span> (a room used mainly for work)</span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={hasRecord} onChange={(e) => setHasRecord(e.target.checked)} className="mt-0.5 h-4 w-4 flex-none accent-forest" />
          <span>I keep a <span className="font-medium">record of my actual hours</span> worked from home</span>
        </label>
        {!hasRecord && (
          <p className="text-xs text-warn">
            Since 1 July 2024 the ATO needs a record of your <span className="font-medium">actual</span> hours for the whole year — a 4-week
            estimate isn't accepted for the fixed-rate method. Start a simple log (a diary or timesheet) now.
          </p>
        )}
        {office && (
          <p className="text-xs text-muted">
            A dedicated office doesn't change the 70c fixed rate, but it may open up the actual-cost method and cleaning claims —
            worth a chat with a registered tax agent.
          </p>
        )}
      </div>

      {diaryEnabled && (
        <div className="space-y-3 border-t border-line pt-3">
          <div>
            <div className="text-sm font-semibold">Work-from-home diary <span className="font-normal text-muted">(optional — for your ATO record)</span></div>
            <div className="text-xs text-muted">
              Tell us which days you work from home and any leave you took, and we'll generate a day-by-day diary in your
              accountant hand-off. The ATO wants a record of your actual hours — review and adjust it. General information only.
            </div>
          </div>

          {hasRecord ? (
            <p className="text-xs text-muted">You've ticked that you keep your own record of actual hours, so Quillo won't generate a diary (a generated one would duplicate yours). Untick that above to generate one here.</p>
          ) : (
            <>
              <div>
                <span className="text-xs font-medium uppercase tracking-wide text-muted">Days I work from home</span>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {WEEKDAYS.map((d) => {
                    const on = weekdays.includes(d.v);
                    return (
                      <button
                        key={d.v}
                        type="button"
                        onClick={() => toggleWeekday(d.v)}
                        aria-pressed={on}
                        className={`min-w-[44px] rounded-lg border px-2.5 py-2 text-sm font-medium transition ${on ? "border-forest bg-forest/10 text-forest" : "border-line text-muted hover:bg-surface"}`}
                      >
                        {d.label}
                      </button>
                    );
                  })}
                </div>
                <span className="mt-1 block text-xs text-muted">≈ {weekdays.length} day(s)/week selected{days.trim() !== "" && Math.round(Number(days)) !== weekdays.length ? ` (your days/week says ${days})` : ""}</span>
              </div>

              <div>
                <span className="text-xs font-medium uppercase tracking-wide text-muted">Leave / holidays (days not worked from home)</span>
                <div className="mt-1 space-y-2">
                  {leave.map((r, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2">
                      <Input type="date" value={r.start} onChange={(e) => updateLeave(i, { start: e.target.value })} className="min-w-[9rem] flex-1" aria-label="Leave start date" />
                      <span className="text-xs text-muted">to</span>
                      <Input type="date" value={r.end} onChange={(e) => updateLeave(i, { end: e.target.value })} className="min-w-[9rem] flex-1" aria-label="Leave end date" />
                      <Input type="text" value={r.label ?? ""} onChange={(e) => updateLeave(i, { label: e.target.value })} placeholder="label (optional)" className="min-w-[8rem] flex-1" aria-label="Leave label" />
                      <button type="button" onClick={() => removeLeave(i)} className="rounded-lg border border-line px-2.5 py-2 text-sm text-muted transition hover:bg-surface" aria-label="Remove leave period">✕</button>
                    </div>
                  ))}
                  <Button variant="ghost" onClick={addLeave} className="text-sm">+ Add leave period</Button>
                </div>
              </div>

              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={genDiary} onChange={(e) => setGenDiary(e.target.checked)} className="mt-0.5 h-4 w-4 flex-none accent-forest" />
                <span>Generate a work-from-home <span className="font-medium">diary</span> for my records (added to my accountant CSV)</span>
              </label>
              {diaryActive && hoursTouched && (
                <p className="text-xs text-warn">You've edited the hours figure, so your typed hours ({hours}) are claimed — not the diary total. Clear the hours field to let the diary drive them.</p>
              )}
            </>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? "Saving…" : "Save"}</Button>
        <span className="text-xs text-muted">Approximate — your hand-off shows the exact figure using this year's ATO rates.</span>
      </div>
    </Card>
  );
}
