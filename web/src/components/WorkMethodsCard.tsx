import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../api";
import { Card, Button, Input, money } from "./ui";

// Working-from-home (fixed-rate) + car (cents-per-km) inputs. WFH is captured in DAYS PER WEEK — the
// way people actually think about it — and the annual hours are derived transparently (≈ days × 7.6h ×
// 48 weeks), shown as an editable figure. Hours stay the authoritative number the engine reads; an
// explicit hours edit always wins. General information only — the ATO requires a contemporaneous record
// of your actual hours, so this estimate is a starting point to refine.
const HOURS_PER_DAY = 7.6;
const DEFAULT_WEEKS = 48;
const deriveHours = (daysPerWeek: number, weeks: number) => Math.round(Math.max(0, daysPerWeek) * HOURS_PER_DAY * (weeks > 0 ? weeks : DEFAULT_WEEKS));

export function WorkMethodsCard({ fyNum, compact }: { fyNum: number; compact?: boolean }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["work-use", fyNum], queryFn: () => api.workUse(fyNum) });
  const [days, setDays] = useState<string>("");
  const [weeks, setWeeks] = useState<string>("");
  const [hours, setHours] = useState<string>("");
  const [km, setKm] = useState<string>("");
  const [seeded, setSeeded] = useState<number | null>(null);
  if (data && seeded !== fyNum) {
    setDays(data.wfh_days_per_week != null ? String(data.wfh_days_per_week) : "");
    setWeeks(data.wfh_weeks != null ? String(data.wfh_weeks) : "");
    setHours(data.wfh_hours != null ? String(data.wfh_hours) : "");
    setKm(data.car_work_km != null ? String(data.car_work_km) : "");
    setSeeded(fyNum);
  }

  // Editing days/week re-derives the hours figure (still editable afterwards).
  const onDays = (v: string) => {
    setDays(v);
    if (v.trim() !== "") setHours(String(deriveHours(Number(v) || 0, Number(weeks) || DEFAULT_WEEKS)));
  };
  const onWeeks = (v: string) => {
    setWeeks(v);
    if (days.trim() !== "") setHours(String(deriveHours(Number(days) || 0, Number(v) || DEFAULT_WEEKS)));
  };

  const save = useMutation({
    mutationFn: () =>
      api.setWorkUse(fyNum, {
        wfh_hours: hours.trim() === "" ? null : Math.max(0, Number(hours)),
        car_work_km: km.trim() === "" ? null : Math.max(0, Number(km)),
        wfh_days_per_week: days.trim() === "" ? null : Math.max(0, Number(days)),
        wfh_weeks: weeks.trim() === "" ? null : Math.max(0, Number(weeks)),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["work-use", fyNum] });
      qc.invalidateQueries({ queryKey: ["filing-readiness"] });
      qc.invalidateQueries({ queryKey: ["report"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success("Saved your work-from-home & car inputs.");
    },
    onError: (e) => toast.error("Couldn't save", { description: (e as Error).message }),
  });

  const estWfh = Math.round((Number(hours) || 0) * 70);
  const estCar = Math.round(Math.min(Number(km) || 0, 5000) * 88);

  return (
    <Card className="space-y-3 p-4">
      <div>
        <div className="text-sm font-semibold">Working from home{compact ? "" : " & car (fixed-rate methods)"}</div>
        <div className="text-xs text-muted">
          Tell us how many days a week you work from home and we'll estimate your hours. The home-office fixed
          rate covers electricity, internet, phone &amp; stationery, so those receipts aren't claimed again. Keep a
          record of your actual hours. General information only — confirm with a registered tax agent.
        </div>
      </div>
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
        <Input type="number" min="0" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="e.g. 730" />
        <span className="mt-0.5 block text-xs text-muted">≈ {money(estWfh)} at 70c/hr{days.trim() !== "" ? ` · derived from ${days} day(s)/week` : ""}</span>
      </label>
      {!compact && (
        <label className="block text-sm">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Work-related car km this year</span>
          <Input type="number" min="0" value={km} onChange={(e) => setKm(e.target.value)} placeholder="e.g. 1200" />
          <span className="mt-0.5 block text-xs text-muted">≈ {money(estCar)} at 88c/km (max 5,000 km)</span>
        </label>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? "Saving…" : "Save"}</Button>
        <span className="text-xs text-muted">Approximate — your hand-off shows the exact figure using this year's ATO rates.</span>
      </div>
    </Card>
  );
}
