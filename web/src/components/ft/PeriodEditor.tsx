import { useId, useState } from "react";
import { FtButton, FtCard, FtInput, FtSelect, Skeleton, StatusGate, type StatusProps } from "./primitives";

/** The editable part of one dated situation period. Dates are ISO (YYYY-MM-DD); "" = open-ended. */
export interface PeriodDraft {
  value: string;
  starts_on: string;
  ends_on: string;
}

/**
 * Edit one dated period (spec A2 profile mode, #585): its answer and the dates it applies between.
 * `options` renders a dropdown; without options the answer is free text with `suggestions` offered
 * (the occupation picklist). The server validates (overlaps, unknown values) and its plain message is
 * shown here, never swallowed. Profile mode is the only path that edits an existing period.
 */
export function PeriodEditor({
  label,
  initial,
  options,
  suggestions,
  onSave,
  onCancel,
  onDelete,
  ...status
}: {
  label: string;
  initial: PeriodDraft;
  options?: readonly { value: string; label: string }[];
  suggestions?: readonly { value: string; label: string }[];
  onSave: (d: PeriodDraft) => Promise<unknown>;
  onCancel: () => void;
  onDelete?: () => Promise<unknown>;
} & StatusProps) {
  const id = useId();
  const [d, setD] = useState<PeriodDraft>(initial);
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (kind: "save" | "delete", fn: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that.");
    } finally {
      setBusy(null);
    }
  };
  const invalidDates = d.starts_on !== "" && d.ends_on !== "" && d.starts_on > d.ends_on;

  return (
    <FtCard className="space-y-3 p-4">
      <StatusGate what={label} {...status} skeleton={<Skeleton lines={3} />}>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block space-y-1 text-sm" htmlFor={`${id}-v`}>
            <span className="font-medium text-ink">{label}</span>
            {options ? (
              <FtSelect id={`${id}-v`} className="w-full" value={d.value} onChange={(e) => setD({ ...d, value: e.target.value })}>
                <option value="">Choose…</option>
                {options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </FtSelect>
            ) : (
              <>
                <FtInput id={`${id}-v`} className="w-full" list={`${id}-list`} value={d.value} onChange={(e) => setD({ ...d, value: e.target.value })} />
                {suggestions && (
                  <datalist id={`${id}-list`}>
                    {suggestions.map((s) => (
                      <option key={s.value} value={s.label} />
                    ))}
                  </datalist>
                )}
              </>
            )}
          </label>
          <label className="block space-y-1 text-sm" htmlFor={`${id}-s`}>
            <span className="font-medium text-ink">From</span>
            <FtInput id={`${id}-s`} type="date" className="w-full" value={d.starts_on} onChange={(e) => setD({ ...d, starts_on: e.target.value })} />
          </label>
          <label className="block space-y-1 text-sm" htmlFor={`${id}-e`}>
            <span className="font-medium text-ink">To</span>
            <FtInput id={`${id}-e`} type="date" className="w-full" value={d.ends_on} onChange={(e) => setD({ ...d, ends_on: e.target.value })} />
          </label>
        </div>
        <p className="text-xs text-muted">Leave a date empty if it has no start or end.</p>
        {(error || invalidDates) && (
          <p role="alert" className="text-sm text-danger">
            {error ?? "The start date must be on or before the end date."}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <FtButton variant="primary" busy={busy === "save"} disabled={!d.value.trim() || invalidDates || busy !== null} onClick={() => run("save", () => onSave(d))}>
            Save
          </FtButton>
          <FtButton variant="ghost" onClick={onCancel} disabled={busy !== null}>
            Cancel
          </FtButton>
          {onDelete && (
            <FtButton variant="danger" className="ml-auto" busy={busy === "delete"} disabled={busy !== null} onClick={() => run("delete", onDelete)}>
              Remove
            </FtButton>
          )}
        </div>
      </StatusGate>
    </FtCard>
  );
}
