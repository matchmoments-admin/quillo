import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Card, Spinner, money } from "./ui";
import { ProposedActionCard } from "./AskQuillo";
import type { ScanFinding } from "../types";

// #256 — the pre-handoff "double-check my transactions" findings list. Deterministic, read-only: every
// row is a PROPOSAL the user confirms (reusing ProposedActionCard's one-tap apply) or a deep-link to the
// transaction. GENERAL INFORMATION ONLY — dollar figures are deduction deltas, never a refund/tax figure.
export function ScanFindings({ fyNum }: { fyNum: number }) {
  const { data, isLoading, error } = useQuery({ queryKey: ["scan", fyNum], queryFn: () => api.scan(fyNum) });

  if (isLoading) return <Card className="p-4"><Spinner /></Card>;
  if (error) return <Card className="p-4 text-sm text-muted">Couldn't run the check: {(error as Error).message}</Card>;
  if (!data) return null;

  const over = data.findings.filter((f) => f.category === "over_claim");
  const missed = data.findings.filter((f) => f.category === "missed");
  const checks = data.findings.filter((f) => f.category === "check"); // txn_scan_v2 completeness prompts ($0, no one-tap)

  if (data.summary.finding_count === 0) {
    return (
      <Card className="p-4 text-sm">
        <span className="font-medium text-safe">Nothing flagged.</span>{" "}
        <span className="text-muted">We didn't spot obvious over-claims or missed deductions in this year's transactions — but a registered tax agent is the final word. General information only.</span>
      </Card>
    );
  }

  return (
    <Card className="space-y-4 p-4">
      <div>
        <div className="text-sm font-semibold">Double-check before you hand off</div>
        <div className="text-xs text-muted">
          A quick review of this year's transactions. Each item is a suggestion to confirm — nothing is changed until you apply it.
          Amounts show how much each would add to or remove from your tracked deductions. General information only — not tax advice.
        </div>
      </div>

      {over.length > 0 && (
        <FindingGroup
          title={`Should probably not be claimed (−${money(data.summary.overclaim_downside_cents)})`}
          tone="danger"
          findings={over}
        />
      )}
      {missed.length > 0 && (
        <FindingGroup
          title={`Likely missed (+${money(data.summary.missed_upside_cents)})`}
          tone="safe"
          findings={missed}
        />
      )}
      {checks.length > 0 && (
        <FindingGroup
          title="Worth checking for completeness"
          tone="muted"
          findings={checks}
        />
      )}
    </Card>
  );
}

function FindingGroup({ title, tone, findings }: { title: string; tone: "danger" | "safe" | "muted"; findings: ScanFinding[] }) {
  return (
    <div className="space-y-2">
      <div className={`text-xs font-semibold uppercase tracking-wide ${tone === "danger" ? "text-danger" : tone === "safe" ? "text-safe" : "text-muted"}`}>{title}</div>
      {findings.map((f) => (
        <div key={f.key} className="space-y-1">
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="text-ink">{f.reason}</span>
            {/* Completeness prompts carry no dollar delta — showing "+$0.00" would be noise. */}
            {f.dollar_impact_cents > 0 && (
              <span className={`flex-none tabular-nums font-medium ${f.sign === "-" ? "text-danger" : "text-safe"}`}>{f.sign}{money(f.dollar_impact_cents)}</span>
            )}
          </div>
          {f.proposed_action ? (
            <ProposedActionCard action={f.proposed_action} />
          ) : f.affected_txn_ids[0] ? (
            <Link to={`/txn/${f.affected_txn_ids[0]}`} className="text-xs font-medium text-forest hover:underline">Review this transaction →</Link>
          ) : (
            <span className="text-xs text-muted">No action needed — just a heads-up.</span>
          )}
        </div>
      ))}
    </div>
  );
}
