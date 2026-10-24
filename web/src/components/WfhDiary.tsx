import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, saveBlob } from "../api";
import type { WfhDiaryDay, WfhDiaryView, WfhDiaryWeek, WfhDayReason, WfhLateSource } from "../types";
import { Button, Input, Pill, Term } from "./ui";
import { WFH_DIARY_COPY as C, WFH_DAY_REASONS, WFH_LATE_SOURCES } from "../content/wfhDiary";

// #787 (wfh_weekly_diary): the weekly work-from-home diary. A usual week is set once; each week the user
// confirms it in one tap or changes the days that differed. The server stamps every save and decides on
// time vs late, and the FY's counted total becomes the card's hours figure (work_use_inputs.wfh_hours).
// Rules live in src/lib/wfh-diary.ts; this component never computes what counts.

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const fmtHours = (h: number) => `${Math.round(h * 100) / 100} h`;
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const fmtDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-AU", { day: "numeric", month: "short", timeZone: "UTC" });
const fmtWeek = (ws: string) => `Week of ${fmtDay(ws)}`;
const fmtStamp = (iso: string) => new Date(iso).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
const sum = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x, 0) * 100) / 100;
const isLateNow = (ws: string, view: WfhDiaryView) => view.today > addDays(ws, view.rules.on_time_days);

export function WfhDiary({ fyNum, typedHours, hint }: { fyNum: number; typedHours: number | null; hint?: number[] }) {
  const qc = useQueryClient();
  const { data: view, isError } = useQuery({ queryKey: ["wfh-diary", fyNum], queryFn: () => api.wfhDiary(fyNum) });
  const [editPattern, setEditPattern] = useState(false);
  const [patternDraft, setPatternDraft] = useState<string[] | null>(null);
  const [adjusting, setAdjusting] = useState<string | null>(null); // week_start being adjusted
  const [dayDraft, setDayDraft] = useState<{ h: string; why: "" | WfhDayReason }[]>([]);
  const [source, setSource] = useState<"" | WfhLateSource>("");
  const [removing, setRemoving] = useState<string | null>(null);
  // F6: editing the hours recorded before the diary (needs a source, like a late week).
  const [editingPre, setEditingPre] = useState(false);
  const [preHours, setPreHours] = useState("");
  const [preSource, setPreSource] = useState<"" | WfhLateSource>("");

  const refresh = () => {
    for (const k of [["wfh-diary", fyNum], ["work-use", fyNum], ["records", fyNum], ["journey", fyNum], ["filing-readiness"], ["report"], ["dashboard"]])
      qc.invalidateQueries({ queryKey: k });
  };
  const savePattern = useMutation({
    mutationFn: (hours: number[]) => api.wfhDiarySetPattern(hours),
    onSuccess: () => { setEditPattern(false); setPatternDraft(null); refresh(); toast.success("Saved your usual week."); },
    onError: (e) => toast.error("Couldn't save your usual week", { description: (e as Error).message }),
  });
  const saveWeek = useMutation({
    mutationFn: (body: { week_start: string; days?: WfhDiaryDay[]; source?: WfhLateSource }) => api.wfhDiarySaveWeek(body),
    onSuccess: (r) => {
      setAdjusting(null);
      refresh();
      const h = sum(r.week.days.map((d) => d.h));
      toast.success(`${fmtWeek(r.week.week_start)} recorded: ${fmtHours(h)}${r.week.entry === "late" ? " (recorded late)" : ""}.`);
    },
    onError: (e) => toast.error("Couldn't record that week", { description: (e as Error).message }),
  });
  const removeWeek = useMutation({
    mutationFn: (ws: string) => api.wfhDiaryDeleteWeek(ws),
    onSuccess: () => { setRemoving(null); refresh(); toast.success("Week removed."); },
    onError: (e) => toast.error("Couldn't remove that week", { description: (e as Error).message }),
  });
  const savePre = useMutation({
    mutationFn: (body: { hours: number; source: WfhLateSource }) => api.wfhDiarySetPreDiary({ fy: fyNum, ...body }),
    onSuccess: () => { setEditingPre(false); refresh(); toast.success("Saved your hours from before the diary."); },
    onError: (e) => toast.error("Couldn't save those hours", { description: (e as Error).message }),
  });
  const download = useMutation({
    mutationFn: () => api.wfhDiaryCsv(fyNum),
    onSuccess: ({ blob, filename }) => saveBlob(blob, filename),
    onError: (e) => toast.error("Couldn't download your diary", { description: (e as Error).message }),
  });

  if (isError) return <p className="text-xs text-warn">Your hours diary couldn't load. Refresh the page to try again.</p>;
  if (!view) return <p className="text-xs text-muted">Loading your hours diary…</p>;

  const pre = view.pre_diary;
  const preFrom = (s: WfhLateSource | null) =>
    s === "memory" ? "from memory, not counted" : s ? `from your ${WFH_LATE_SOURCES.find((x) => x.v === s)?.label ?? s}` : C.preDiaryNoSource;
  const startPre = () => {
    setPreHours(pre ? String(pre.hours) : "");
    setPreSource(pre?.source ?? "");
    setEditingPre(true);
  };
  const submitPre = () => {
    const n = Number(preHours);
    if (preHours.trim() === "" || !Number.isFinite(n) || n < 0) { toast.error("Enter the hours, 0 or more"); return; }
    if (!preSource) { toast.error("Choose what these hours come from first"); return; }
    savePre.mutate({ hours: n, source: preSource });
  };
  const pattern = view.pattern;
  const usualTotal = pattern ? sum(pattern) : 0;
  const byWeek = new Map(view.weeks.map((w) => [w.week_start, w]));
  const showPatternEditor = !pattern || editPattern;
  const draft = patternDraft ?? (pattern ?? hint ?? [0, 0, 0, 0, 0, 0, 0]).map((h) => (h ? String(h) : ""));

  const startAdjust = (ws: string, existing?: WfhDiaryWeek) => {
    const base: WfhDiaryDay[] = existing?.days ?? (pattern ?? [0, 0, 0, 0, 0, 0, 0]).map((h) => ({ h }));
    if (existing?.source) setSource(existing.source);
    setDayDraft(base.map((d) => ({ h: d.h ? String(d.h) : "", why: d.why && d.why !== "other" ? d.why : "" })));
    setAdjusting(ws);
  };
  // A save that the server will treat as late needs a source; ask for it before sending.
  const needSource = (ws: string) => isLateNow(ws, view);
  const submit = (ws: string, days?: WfhDiaryDay[]) => {
    if (needSource(ws) && !source) { toast.error("Choose what you're working from first", { description: "This week is being recorded late." }); return; }
    saveWeek.mutate({ week_start: ws, ...(days ? { days } : {}), ...(needSource(ws) && source ? { source } : {}) });
  };
  const draftDays = (): WfhDiaryDay[] => dayDraft.map((d) => (d.why ? { h: 0, why: d.why } : { h: Math.max(0, Math.min(24, Number(d.h) || 0)) }));

  const current = view.current;
  const currentWeek = current ? byWeek.get(current) : undefined;
  const catchUp = view.missing.filter((ws) => ws !== current);
  const anyLateMissing = view.missing.some((ws) => needSource(ws));

  const sourcePicker = (
    <label className="mt-2 flex flex-wrap items-center gap-2 text-sm">
      <span>{C.catchUpSource}</span>
      <select value={source} onChange={(e) => setSource(e.target.value as "" | WfhLateSource)} className="min-h-[40px] rounded-lg border border-line bg-card px-2 text-sm" aria-label="What you're working from">
        <option value="">choose…</option>
        {WFH_LATE_SOURCES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
      </select>
    </label>
  );
  const adjustEditor = (ws: string) => (
    <div className="mt-2 space-y-2 rounded-lg border border-line bg-surface p-2">
      {needSource(ws) && !catchUp.includes(ws) && <p className="text-xs text-muted">{C.lateEdit}</p>}
      {needSource(ws) && !catchUp.includes(ws) && sourcePicker}
      {dayDraft.map((d, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
          <span className="w-24 text-xs text-muted">{DAYS[i]} {fmtDay(addDays(ws, i))}</span>
          <select
            aria-label={`${DAYS[i]} — where you worked`}
            value={d.why}
            onChange={(e) => setDayDraft((cur) => cur.map((x, j) => (j === i ? { ...x, why: e.target.value as "" | WfhDayReason } : x)))}
            className="min-h-[40px] rounded-lg border border-line bg-card px-2 text-sm"
          >
            {WFH_DAY_REASONS.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
          </select>
          {!d.why && (
            <Input type="number" min="0" max="24" step="0.25" value={d.h} aria-label={`${DAYS[i]} hours from home`} placeholder="0"
              onChange={(e) => setDayDraft((cur) => cur.map((x, j) => (j === i ? { ...x, h: e.target.value } : x)))} className="w-24" />
          )}
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => submit(ws, draftDays())} disabled={saveWeek.isPending}>
          {C.confirmAdjusted} ({fmtHours(sum(draftDays().map((d) => d.h)))})
        </Button>
        <Button variant="ghost" onClick={() => setAdjusting(null)}>Cancel</Button>
      </div>
    </div>
  );

  const weekActions = (ws: string, existing?: WfhDiaryWeek) => (
    <div className="mt-1 flex flex-wrap gap-2">
      {!existing && (
        <Button onClick={() => submit(ws)} disabled={saveWeek.isPending || !pattern}>{C.sameAsUsual} ({fmtHours(usualTotal)})</Button>
      )}
      <Button variant="ghost" onClick={() => startAdjust(ws, existing)} disabled={!pattern && !existing}>{existing ? "Change" : C.adjust}</Button>
    </div>
  );

  return (
    <div className="space-y-3 border-t border-line pt-3">
      <div>
        <div className="text-sm font-semibold"><Term k="wfh_diary">{C.title}</Term></div>
        <div className="text-xs text-muted">{C.intro}</div>
        <div className="mt-1 text-xs font-medium text-ink">
          {pre
            ? `${C.preDiaryTitle}: ${fmtHours(pre.hours)} (${preFrom(pre.source)}) + diary: ${fmtHours(view.totals.counted_hours)} = ${fmtHours(view.fy_hours)} for this year`
            : `${fmtHours(view.totals.counted_hours)} counted for this year`}
          {" · "}{view.totals.weeks_on_time + view.totals.weeks_late} week(s) recorded
          {view.totals.not_counted_hours > 0 ? ` · ${fmtHours(view.totals.not_counted_hours)} from memory, not counted` : ""}
        </div>
        {!view.in_use && (typedHours ?? 0) > 0 && <p className="mt-1 text-xs text-warn">{C.replacesTyped}</p>}
        {pre && !pre.source && !editingPre && <p className="mt-1 text-xs text-warn">{C.preDiaryTitle}: {C.preDiaryNoSource}.</p>}
        {view.in_use && !editingPre && (
          <button type="button" className="mt-1 min-h-[32px] text-xs font-medium text-forest underline" onClick={startPre}>
            {pre ? `${C.preDiaryEdit} hours from before the diary` : C.preDiaryAdd}
          </button>
        )}
        {view.in_use && editingPre && (
          <div className="mt-2 space-y-2 rounded-lg border border-line bg-surface p-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted">{C.preDiaryTitle}</div>
            <p className="text-xs text-muted">{C.preDiaryHelp}</p>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Input type="number" min="0" step="0.25" value={preHours} aria-label="Hours from before the diary" placeholder="0"
                onChange={(e) => setPreHours(e.target.value)} className="w-28" />
              <span>h</span>
            </div>
            <label className="flex flex-wrap items-center gap-2 text-sm">
              <span>{C.preDiarySourceLabel}</span>
              <select value={preSource} onChange={(e) => setPreSource(e.target.value as "" | WfhLateSource)} className="min-h-[40px] rounded-lg border border-line bg-card px-2 text-sm" aria-label="What the hours from before the diary come from">
                <option value="">choose…</option>
                {WFH_LATE_SOURCES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
              </select>
            </label>
            <div className="flex flex-wrap gap-2">
              <Button onClick={submitPre} disabled={savePre.isPending}>{C.preDiarySave}</Button>
              <Button variant="ghost" onClick={() => setEditingPre(false)}>Cancel</Button>
            </div>
          </div>
        )}
      </div>

      {/* 1. The usual week — set once. */}
      {showPatternEditor ? (
        <div className="rounded-lg border border-line p-2">
          <div className="text-xs font-medium uppercase tracking-wide text-muted">{C.patternTitle}</div>
          <div className="text-xs text-muted">{C.patternHelp}</div>
          <div className="mt-2 grid grid-cols-4 gap-2 sm:grid-cols-7">
            {DAYS.map((d, i) => (
              <label key={d} className="block text-xs">
                <span className="text-muted">{d}</span>
                <Input type="number" min="0" max="24" step="0.25" value={draft[i]} placeholder="0" aria-label={`Usual hours from home on ${d}`}
                  onChange={(e) => setPatternDraft(draft.map((x, j) => (j === i ? e.target.value : x)))} />
              </label>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button onClick={() => savePattern.mutate(draft.map((x) => Math.max(0, Math.min(24, Number(x) || 0))))} disabled={savePattern.isPending}>
              {C.patternSave} ({fmtHours(sum(draft.map((x) => Number(x) || 0)))})
            </Button>
            {pattern && <Button variant="ghost" onClick={() => { setEditPattern(false); setPatternDraft(null); }}>Cancel</Button>}
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>
            {C.patternTitle}: {pattern!.map((h, i) => (h ? `${DAYS[i]} ${h}` : null)).filter(Boolean).join(" · ") || "no days"} ({fmtHours(usualTotal)})
          </span>
          <button type="button" className="min-h-[32px] font-medium text-forest underline" onClick={() => setEditPattern(true)}>{C.patternChange}</button>
        </div>
      )}

      {/* 2. This week — one tap. */}
      {current ? (
        <div className="rounded-lg border border-line p-2">
          {/* A past year's last week is no longer "this week": say so, and ask for the source a late save needs. */}
          <div className="text-sm font-medium">{needSource(current) ? C.latestWeek : C.thisWeek}: {fmtWeek(current)}</div>
          {currentWeek ? (
            <div className="text-xs text-muted">
              ✓ {C.confirmedAt} {fmtStamp(currentWeek.recorded_at)} · {fmtHours(currentWeek.hours_in_fy)}
            </div>
          ) : needSource(current) && adjusting !== current ? (
            <>
              <p className="text-xs text-muted">{C.lateEdit}</p>
              {sourcePicker}
            </>
          ) : null}
          {adjusting === current ? adjustEditor(current) : weekActions(current, currentWeek)}
        </div>
      ) : (
        <p className="text-xs text-muted">{C.notYetOpen}</p>
      )}

      {/* 3. Catch-up — honestly labelled. */}
      {catchUp.length > 0 && (
        <details className="rounded-lg border border-line px-2 py-2">
          <summary className="cursor-pointer text-sm font-medium">{C.catchUpTitle} ({catchUp.length})</summary>
          <p className="mt-1 text-xs text-muted">{C.catchUpHelp}</p>
          {anyLateMissing && sourcePicker}
          <ul className="mt-2 space-y-2">
            {catchUp.map((ws) => (
              <li key={ws} className="text-sm">
                <span>{fmtWeek(ws)}</span>
                {!needSource(ws) && <span className="ml-2 text-xs text-muted">({C.stillOnTime})</span>}
                {adjusting === ws ? adjustEditor(ws) : weekActions(ws)}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* 4. What's been recorded. */}
      {view.weeks.length > 0 && (
        <details className="rounded-lg border border-line px-2 py-2">
          <summary className="cursor-pointer text-sm font-medium">{C.historyTitle} ({view.weeks.length})</summary>
          <ul className="mt-2 space-y-2">
            {view.weeks.map((w) => (
              <li key={w.week_start} className="text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{fmtWeek(w.week_start)}</span>
                  <span>{fmtHours(w.hours_in_fy)}</span>
                  {w.entry === "on_time" ? <Pill tone="ok">{C.onTime}</Pill> : w.counts ? <Pill tone="info">{C.late} · {WFH_LATE_SOURCES.find((s) => s.v === w.source)?.label}</Pill> : <Pill tone="warn">{C.notCounted}</Pill>}
                  <span className="text-xs text-muted">recorded {fmtStamp(w.recorded_at)}{w.updated_at !== w.recorded_at ? `, changed ${fmtStamp(w.updated_at)}` : ""}</span>
                </div>
                <div className="text-xs text-muted">
                  {w.days.map((d, i) => (d.why ? `${DAYS[i]} ${WFH_DAY_REASONS.find((r) => r.v === d.why)?.label ?? d.why}` : d.h ? `${DAYS[i]} ${d.h}` : null)).filter(Boolean).join(" · ") || "No hours from home"}
                </div>
                {adjusting === w.week_start ? adjustEditor(w.week_start) : removing === w.week_start ? (
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                    <span>{C.removeConfirm}</span>
                    <Button variant="ghost" onClick={() => removeWeek.mutate(w.week_start)} disabled={removeWeek.isPending}>{C.removeYes}</Button>
                    <Button variant="ghost" onClick={() => setRemoving(null)}>{C.keep}</Button>
                  </div>
                ) : (
                  <div className="mt-1 flex flex-wrap gap-2">
                    <Button variant="ghost" onClick={() => startAdjust(w.week_start, w)}>Change</Button>
                    <Button variant="ghost" onClick={() => setRemoving(w.week_start)}>{C.remove}</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {view.weeks.length > 0 && (
        <div className="space-y-1">
          <Button variant="ghost" onClick={() => download.mutate()} disabled={download.isPending}>{C.download}</Button>
          <p className="text-xs text-muted">{C.keepRecord}</p>
        </div>
      )}
      <p className="text-xs text-muted">{C.generalInfo}</p>
    </div>
  );
}
