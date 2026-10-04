import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../../api";
import { fyLabel } from "../../lib/activeFy";
import { INPUT_CLASS, money, parseMoneyToCents } from "../ui";
import { Badge, FtButton, FtCard, RecordRow } from "../ft";
import { WorkMethodsCard } from "../WorkMethodsCard";
import { CarMethodsCard } from "../CarMethodsCard";
import type { RecordFactKey, RecordsRow, RecordsView } from "../../types";

// Record cards in the Review queue (spec A7 inside spec §0 step 3; #587 absorbing #588; flag ft_journey).
// A confirmed claim with no record is a card until it has one: Snap a receipt (the existing upload + the
// existing manual link, so the receipt becomes the line's record and stops counting separately) or, where
// the pack's record-keeping exception covers it, the user's own attestation (stored on the line, never
// evidence, never read by the position). Facts no bank feed carries (WFH hours, car km, platform gross +
// fees) are cards with their editor inline. Counts and the claim's own amount only; never a refund figure.

export function recordMeta(r: RecordsRow): string {
  const bits = [r.txn_date ?? "No date", money(r.claim_cents)];
  if (r.record?.kind === "receipt") bits.push("receipt attached");
  if (r.record?.kind === "document") bits.push("from a document");
  if (r.record?.kind === "claim_link") bits.push("linked to a claim");
  return bits.join(" · ");
}

export function groupName(view: RecordsView, r: RecordsRow): string | null {
  return r.group ? `${r.group} · ${view.group_labels[r.group] ?? "Claims"}` : null;
}

/** One confirmed claim that still needs a record. Hooks first, no early returns. */
export function NeedsRecordCard({
  row,
  view,
  snapBusy,
  onSnap,
  attestBusy,
  onAttest,
}: {
  row: RecordsRow;
  view: RecordsView;
  snapBusy: boolean;
  onSnap: () => void;
  attestBusy: boolean;
  onAttest: (kind: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const byKey = new Map(view.exceptions.map((e) => [e.key, e]));
  // An attestation the server no longer honours (the covered total passed the limit) is explained, not hidden.
  const stale = row.exception.set ? byKey.get(row.exception.set) : undefined;
  const group = groupName(view, row);
  return (
    <FtCard className="px-4 py-2">
      <div className="flex flex-wrap items-center gap-2 pt-2">
        <Badge tone="warn">Needs a record</Badge>
        {group && <span className="text-xs text-muted">{group}</span>}
      </div>
      <RecordRow label={row.description ?? "Claim"} meta={recordMeta(row)} recordStatus={row.status} action={{ label: "Snap a receipt", onClick: onSnap, busy: snapBusy }} />
      {stale && (
        <p className="pb-2 text-xs text-warn">
          You said this was under "{stale.title}", but your claims it covers are now over that limit, so it needs a record.
        </p>
      )}
      {row.exception.eligible.length > 0 && (
        <div className="pb-3">
          {open ? (
            <div className="space-y-3 rounded-lg border border-line bg-surface p-3">
              {row.exception.eligible.map((k) => {
                const e = byKey.get(k);
                if (!e) return null;
                return (
                  <div key={k} className="space-y-2">
                    <p className="text-sm font-semibold text-ink">{e.title}</p>
                    <p className="text-sm text-muted">{e.wording}</p>
                    <FtButton variant="primary" busy={attestBusy} onClick={() => onAttest(k)}>
                      This claim is under this exception
                    </FtButton>
                  </div>
                );
              })}
              <p className="text-xs text-muted">This is your own statement, not a record. Keep a note of how you worked the amount out.</p>
              <FtButton variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </FtButton>
            </div>
          ) : (
            <FtButton variant="ghost" className="text-sm" onClick={() => setOpen(true)}>
              It's under the record-keeping exception
            </FtButton>
          )}
        </div>
      )}
    </FtCard>
  );
}

/** A fact the user states (WFH hours, car km, platform gross + fees), with its editor. */
export function FactCard({
  fact,
  view,
  fy,
  wfhEditor,
  carEditor,
  onSaved,
  defaultOpen = true,
}: {
  fact: RecordsView["facts"][number];
  view: RecordsView;
  fy: number;
  wfhEditor: boolean;
  carEditor: boolean;
  onSaved: () => void;
  defaultOpen?: boolean;
}) {
  return (
    <FtCard className="p-4">
      <details open={defaultOpen}>
        <summary className="flex min-h-[44px] cursor-pointer flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-ink">{fact.label}</span>
          <Badge tone={fact.done ? "ok" : "warn"}>{fact.done ? "Stated" : "To do"}</Badge>
        </summary>
        <div className="mt-3">
          <FactEditor k={fact.key} view={view} fy={fy} wfhEditor={wfhEditor} carEditor={carEditor} onSaved={onSaved} />
        </div>
      </details>
    </FtCard>
  );
}

function FactEditor({ k, view, fy, wfhEditor, carEditor, onSaved }: { k: RecordFactKey; view: RecordsView; fy: number; wfhEditor: boolean; carEditor: boolean; onSaved: () => void }) {
  if (k === "wfh_hours")
    return wfhEditor ? <WorkMethodsCard fyNum={fy} diaryCollapsed /> : <p className="text-sm text-muted">Work-from-home hours aren't switched on for your account yet.</p>;
  if (k === "car_km") return carEditor ? <CarMethodsCard fyNum={fy} /> : <p className="text-sm text-muted">Car kilometres aren't switched on for your account yet.</p>;
  return <PlatformFees view={view} fy={fy} onSaved={onSaved} />;
}

/** Platform payouts arrive after fees; the platform's annual summary has the gross and the fees. Manual entry only. */
function PlatformFees({ view, fy, onSaved }: { view: RecordsView; fy: number; onSaved: () => void }) {
  const qc = useQueryClient();
  const [platform, setPlatform] = useState("");
  const [gross, setGross] = useState("");
  const [fees, setFees] = useState("");
  const grossC = parseMoneyToCents(gross);
  const feesC = parseMoneyToCents(fees);
  const invalid = grossC == null || grossC <= 0 || feesC == null || feesC < 0 || feesC > grossC;
  const after = () => {
    onSaved();
    qc.invalidateQueries({ queryKey: ["income"] });
    qc.invalidateQueries({ queryKey: ["report"] });
  };
  const add = useMutation({
    mutationFn: () =>
      api.addIncome({
        income_type: "business",
        fy: fyLabel(fy),
        gross_cents: grossC!,
        net_cents: grossC! - feesC!,
        detail_json: JSON.stringify({ platform: platform.trim() || null, platform_fees_cents: feesC, source: "records_platform_summary" }),
      }),
    onSuccess: () => {
      setPlatform("");
      setGross("");
      setFees("");
      toast.success("Saved your platform summary.");
      after();
    },
    onError: (e) => toast.error("Couldn't save", { description: (e as Error).message }),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.deleteIncome(id),
    onSuccess: after,
    onError: (e) => toast.error("Couldn't remove", { description: (e as Error).message }),
  });
  const field = `mt-1 block min-h-[44px] w-full ${INPUT_CLASS}`;
  // Payouts already recorded from the bank lines (We noticed → platform) count the money once already;
  // adding the summary's gross on top would count it twice, so the entry form isn't offered.
  if (view.platform.payouts_recorded > 0 && view.platform.entries.length === 0) {
    return (
      <p className="text-sm text-muted">
        Your platform payouts are already recorded as business income from your bank lines ({view.platform.payouts_recorded}{" "}
        {view.platform.payouts_recorded === 1 ? "payout" : "payouts"}). Payouts are after fees; your platform's annual summary shows the gross
        amount and the fees. Keep that summary as your record, and confirm with a registered tax agent how to show the gross and the fees.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Payouts are after fees. Your platform's annual summary shows the gross amount and the fees. Enter both here; the gross is recorded as
        business income. Platform fees are generally a business expense: confirm how to claim them with a registered tax agent.
      </p>
      {view.platform.entries.length > 0 && (
        <ul className="divide-y divide-line text-sm">
          {view.platform.entries.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="text-ink">
                {e.label ?? "Platform"} · gross <span className="tnum">{money(e.gross_cents)}</span> · fees <span className="tnum">{money(e.fees_cents)}</span>
              </span>
              <FtButton variant="ghost" busy={del.isPending && del.variables === e.id} onClick={() => del.mutate(e.id)}>
                Remove
              </FtButton>
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block text-sm text-muted">
          Platform
          <input className={field} value={platform} onChange={(e) => setPlatform(e.target.value)} placeholder="e.g. your rideshare app" />
        </label>
        <label className="block text-sm text-muted">
          Gross amount
          <input className={field} inputMode="decimal" value={gross} onChange={(e) => setGross(e.target.value)} />
        </label>
        <label className="block text-sm text-muted">
          Fees
          <input className={field} inputMode="decimal" value={fees} onChange={(e) => setFees(e.target.value)} />
        </label>
      </div>
      {gross.trim() !== "" && fees.trim() !== "" && invalid && <p className="text-xs text-warn">Enter the gross and the fees as amounts; fees can't be more than the gross.</p>}
      <FtButton variant="primary" disabled={invalid} busy={add.isPending} onClick={() => add.mutate()}>
        Save platform summary
      </FtButton>
    </div>
  );
}
