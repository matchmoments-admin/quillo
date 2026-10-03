import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../../api";
import { money } from "../ui";
import { Chip, ClaimCard, FtButton, FtCard, FtLink, TAP, FOCUS, cx, type WhyItem } from "../ft";
import { parseWorkUsePct, summariseConfirm, type WorthALookGroup } from "../../lib/claims";

// A worth-a-look claim card in the Review queue (spec A6 inside spec §0 step 3, #587; owner rulings #555 /
// #537 / #533). Self-completing: Claim it walks golden rule 1 ("Were you paid back?"), then asks only what
// the rule needs (the return label when it names alternatives, the work-use share for mixed use), confirms
// through POST /api/relevance/confirm, and the card leaves the queue; the confirmed claim then shows up as
// a record card ("Needs a record") until it has one. Nothing counts until the user confirms. A server
// refusal (needs_label / needs_apportionment / needs_asset) re-asks, never fails silently.

type Phase = "idle" | "paid_back" | "details";

/**
 * One worth-a-look card. Claim it walks golden rule 1 ("Were you paid back for this?"), then asks only what
 * this rule needs (the return label when it names alternatives, the work-use share for mixed use), and
 * confirms every claimable line through POST /api/relevance/confirm. Hooks first, no early returns.
 */
export function WorthALookCard({ group: g, labelNames, onWhy }: { group: WorthALookGroup; labelNames: Record<string, string>; onWhy?: (item: WhyItem) => void }) {
  const qc = useQueryClient();
  const [phase, setPhase] = useState<Phase>("idle");
  const [labelPick, setLabelPick] = useState<string | null>(null);
  const [labelOptions, setLabelOptions] = useState<string[]>(g.label_options);
  const [needShare, setNeedShare] = useState(g.needs_work_use_pct);
  const [pctRaw, setPctRaw] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const refresh = () => {
    for (const k of ["relevance", "review", "records", "transactions", "journey", "dashboard", "report", "filing-readiness"]) void qc.invalidateQueries({ queryKey: [k] });
  };

  const confirm = useMutation({
    mutationFn: async (opts: { atoLabel: string | null; workUsePct: number | null }) => {
      const out = [];
      // The share applies only to the mixed-use lines; an immediate line in the same group counts in full.
      for (const l of g.claimable_lines) out.push(await api.confirmWorthALook(l.txn_id, { ...opts, workUsePct: l.needs_work_use_pct || l.deductibility === "needs_apportionment" ? opts.workUsePct : null }));
      return summariseConfirm(out);
    },
    onSuccess: (s) => {
      if (s.confirmed > 0) {
        toast.success(s.confirmed === 1 ? "Claimed. It now counts in your year. Next: its record." : `${s.confirmed} items claimed. They now count in your year. Next: their records.`);
        refresh();
      }
      if (s.needs_label) {
        setLabelOptions(s.needs_label);
        setPhase("details");
        setNote("Pick the label that fits, then claim it.");
      } else if (s.needs_share) {
        setNeedShare(true);
        setPhase("details");
        setNote("This is mixed use. Enter the share you used for work, then claim it.");
      } else if (s.covered_by_wfh_rate > 0) {
        setPhase("idle");
        setNote("Your work-from-home hours already cover this: the fixed rate per hour includes energy, internet, phone and stationery, so it isn't claimed again on its own.");
      } else if (s.needs_asset > 0) {
        setNote("Some of these are over the limit for an immediate claim. Add them in Assets instead.");
      } else if (s.failed > 0) {
        setNote(s.confirmed > 0 ? "Some items couldn't be claimed: they've changed since this list loaded." : "This couldn't be claimed: it's changed since this list loaded.");
        refresh();
      } else {
        setPhase("idle");
        setNote(null);
      }
    },
    onError: (e) => {
      setNote(`Couldn't claim this: ${(e as Error).message}`);
      refresh(); // some lines may already be claimed
    },
  });

  const paidBack = useMutation({
    mutationFn: async () => {
      for (const l of g.lines) await api.setTxnReimbursed(l.txn_id, true);
    },
    onSuccess: () => {
      toast.success("Marked as paid back. It won't count.");
      refresh();
    },
    onError: (e) => {
      setNote(`Couldn't save that: ${(e as Error).message}`);
      refresh();
    },
  });

  const notWork = useMutation({
    mutationFn: () => api.resolveDeductibility({ txnIds: g.lines.map((l) => l.txn_id), state: "confirmed_not" }),
    onSuccess: () => {
      toast.success("Marked as not work-related.");
      refresh();
    },
    onError: (e) => setNote(`Couldn't save that: ${(e as Error).message}`),
  });

  const pct = parseWorkUsePct(pctRaw);
  const labelReady = labelOptions.length <= 1 || (labelPick !== null && labelOptions.includes(labelPick));
  const shareReady = !needShare || pct !== null;
  const submit = () => confirm.mutate({ atoLabel: labelOptions.length > 1 ? labelPick : null, workUsePct: needShare ? pct : null });
  const afterNotPaidBack = () => {
    if (labelOptions.length > 1 || needShare) setPhase("details");
    else submit();
  };
  const busy = confirm.isPending ? "claim" : notWork.isPending ? "not_work" : undefined;
  const canClaim = g.claimable_lines.length > 0;
  const n = g.lines.length;
  const dates = g.lines.map((l) => l.txn_date).filter((d): d is string => !!d).sort();
  const meta = `${n} ${n === 1 ? "line" : "lines"}${dates.length ? ` · ${dates[0]}${dates.length > 1 && dates[dates.length - 1] !== dates[0] ? ` to ${dates[dates.length - 1]}` : ""}` : ""}`;

  return (
    <div className="space-y-2">
      <ClaimCard
        title={g.title}
        amountCents={g.total_cents}
        meta={meta}
        badge="worth_a_look"
        why={g.why}
        rules={{ hasBankLine: true, reimbursed: false, workUseConfirmed: false, recordStatus: g.all_have_record ? "recorded" : null }}
        guide={g.ato_url ? { label: (g.occupation_label ?? "your job").toLowerCase(), ato_url: g.ato_url } : null}
        busy={busy}
        onClaim={canClaim && phase === "idle" ? () => setPhase("paid_back") : undefined}
        onNotWork={phase === "idle" ? () => notWork.mutate() : undefined}
        onWhy={onWhy ? () => onWhy({ id: g.lines[0]!.txn_id, label: g.title }) : undefined}
        evidence={
          <div className="space-y-2">
            <details>
              <summary className={cx(TAP, FOCUS, "inline-flex cursor-pointer items-center rounded-lg text-[13px] text-accent")}>Show the matched lines</summary>
              <ul className="mt-1 space-y-1 text-[13px]">
                {g.lines.map((l) => (
                  <li key={l.txn_id} className="flex justify-between gap-3">
                    <span className="text-muted">
                      {l.txn_date ?? "No date"} · {l.merchant ?? "Bank line"}
                      {l.needs_asset && " · add in Assets"}
                    </span>
                    <span className="font-mono tnum text-ink">{money(l.amount_cents)}</span>
                  </li>
                ))}
              </ul>
            </details>
            {g.asset_lines.length > 0 && (
              <p className="text-[13px] text-ink">
                {g.asset_lines.length === n ? "This is" : `${g.asset_lines.length} of these are`} over the limit for an immediate claim on a work item, so it's
                usually claimed over its life instead.{" "}
                <FtLink to="/assets" className="text-[13px]">
                  Add it in Assets
                </FtLink>
              </p>
            )}
          </div>
        }
      />

      {phase === "paid_back" && (
        <FtCard className="space-y-3 p-4">
          <p className="text-[15px] font-semibold text-ink">Were you paid back for this?</p>
          <p className="text-sm text-muted">If your employer or anyone else paid you back, it isn't yours to claim.</p>
          <div className="flex flex-wrap gap-2">
            <FtButton variant="primary" onClick={afterNotPaidBack} busy={confirm.isPending}>
              No, I paid for it myself
            </FtButton>
            <FtButton variant="secondary" onClick={() => paidBack.mutate()} busy={paidBack.isPending}>
              Yes, I was paid back
            </FtButton>
            <FtButton variant="ghost" onClick={() => setPhase("idle")}>
              Cancel
            </FtButton>
          </div>
        </FtCard>
      )}

      {phase === "details" && (
        <FtCard className="space-y-4 p-4">
          {labelOptions.length > 1 && (
            <fieldset className="space-y-2">
              <legend className="text-[15px] font-semibold text-ink">Which label fits this?</legend>
              <div className="flex flex-wrap gap-2">
                {labelOptions.map((o) => (
                  <Chip key={o} selected={labelPick === o} onToggle={() => setLabelPick(labelPick === o ? null : o)}>
                    {labelNames[o] ? `${o} · ${labelNames[o]}` : o}
                  </Chip>
                ))}
              </div>
            </fieldset>
          )}
          {needShare && (
            <div className="space-y-1">
              <label htmlFor={`pct-${g.key}`} className="block text-[15px] font-semibold text-ink">
                What share did you use for work?
              </label>
              <p className="text-sm text-muted">This is mixed use, so only the work part counts. Keep a note of how you worked it out.</p>
              <div className="flex items-center gap-2">
                <input
                  id={`pct-${g.key}`}
                  inputMode="numeric"
                  value={pctRaw}
                  onChange={(e) => setPctRaw(e.target.value)}
                  placeholder="e.g. 40"
                  aria-invalid={pctRaw !== "" && pct === null}
                  className={cx(TAP, FOCUS, "w-24 rounded-lg border border-line-strong bg-card px-3 text-[15px] text-ink")}
                />
                <span className="text-[15px] text-ink">%</span>
              </div>
              {pctRaw !== "" && pct === null && <p className="text-[13px] text-warn">Enter a whole number from 1 to 100.</p>}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <FtButton variant="primary" onClick={submit} busy={confirm.isPending} disabled={!labelReady || !shareReady}>
              Claim it
            </FtButton>
            <FtButton variant="ghost" onClick={() => setPhase("idle")}>
              Cancel
            </FtButton>
          </div>
        </FtCard>
      )}

      {note && (
        <p role="status" className="rounded-lg bg-warn-surface px-3 py-2 text-sm text-warn">
          {note}
        </p>
      )}
    </div>
  );
}
