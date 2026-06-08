import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Button, BUCKET_LABEL, Card, money } from "./ui";
import { BUCKETS } from "../types";
import type { ClarifyQuestion, ClarifySuggestion, ClarifyAnswer, ClarifyAnswerKind } from "../types";

// The flexible picker exposes every bucket EXCEPT refund (a credit that nets against spend — it has no
// clarify answer kind and the server rejects bucket='refund') and unknown (not a real choice). Income
// buckets must route through their income_* answer kind so the credit is recorded once, not double-
// counted — the server enforces this too.
const PICKER_BUCKETS = BUCKETS.filter((b) => b !== "refund" && b !== "unknown");
const INCOME_BUCKET_KIND: Record<string, ClarifyAnswerKind> = {
  income_business: "income_business",
  income_property: "income_property",
  income_personal: "income_personal",
};
const NEEDS_PROPERTY = new Set(["property_rented", "property_vacant", "income_property"]);

/**
 * Stage B — "Clarify recurring patterns". Deterministic, free, no AI/consent. Shows ONE question per
 * recurring merchant stem; answering once creates a rule (future auto-apply) AND recategorises the
 * whole group now. Income answers route the credits to the income table and exclude the bank line so
 * rent counts once. Renders nothing when there are no open questions. General information only.
 */
export function ClarifyCard({ fy }: { fy?: number }) {
  const qc = useQueryClient();
  const { data: questions } = useQuery({ queryKey: ["clarify", fy], queryFn: () => api.clarifyQuestions(fy) });
  const { data: situation } = useQuery({ queryKey: ["situation"], queryFn: api.situation });
  const [note, setNote] = useState<string | null>(null);

  const scan = useMutation({
    mutationFn: () => api.clarifyScan(fy),
    onSuccess: (r) => {
      setNote(`Found ${r.questions} pattern${r.questions === 1 ? "" : "s"} to clarify.`);
      qc.invalidateQueries({ queryKey: ["clarify"] });
    },
    onError: (e) => setNote(`Scan failed: ${(e as Error).message}`),
  });

  const properties = situation?.properties ?? [];
  const open = questions ?? [];

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Clarify recurring patterns</h2>
          <p className="text-xs text-muted">
            One question per repeating merchant — your answer is remembered and applied to every match.{" "}
            <span className="text-muted">General information only.</span>
          </p>
        </div>
        <Button onClick={() => scan.mutate()} disabled={scan.isPending}>
          {scan.isPending ? "Scanning…" : open.length ? "Re-scan" : "Find patterns"}
        </Button>
      </div>
      {note && <p className="text-xs text-muted">{note}</p>}
      {open.length === 0 ? (
        <p className="text-sm text-muted">No recurring patterns to clarify right now.</p>
      ) : (
        <ul className="space-y-3">
          {open.map((q) => (
            <ClarifyRow key={q.id} q={q} properties={properties} onDone={() => qc.invalidateQueries({ queryKey: ["clarify"] })} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function ClarifyRow({
  q,
  properties,
  onDone,
}: {
  q: ClarifyQuestion;
  properties: { id: string; label: string }[];
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [propertyId, setPropertyId] = useState<string>(properties[0]?.id ?? "");
  // Flexible "More categories…" picker — exposes the full taxonomy when none of the one-tap chips fit.
  const [showMore, setShowMore] = useState(false);
  const [pBucket, setPBucket] = useState<string>("");
  const [pLabel, setPLabel] = useState<string>("");
  const [pProp, setPProp] = useState<string>(properties[0]?.id ?? "");

  const answer = useMutation({
    mutationFn: (a: ClarifyAnswer) => api.answerClarify(q.id, a),
    onSuccess: () => {
      // Income answers write to the income table → refresh the income + report surfaces too.
      for (const k of ["transactions", "dashboard", "income", "report"]) qc.invalidateQueries({ queryKey: [k] });
      onDone();
    },
  });
  const dismiss = useMutation({ mutationFn: () => api.dismissClarify(q.id), onSuccess: onDone });

  const pick = (s: ClarifySuggestion) => {
    const a: ClarifyAnswer = { kind: s.kind, bucket: s.bucket, ato_label: s.ato_label };
    if (s.needs_property) {
      if (!propertyId) return; // need a property selected first
      a.property_id = propertyId;
    }
    // "Work-related deduction (choose category)" carries no label — ask for one (kept simple for v1).
    if (s.kind === "bucket" && s.bucket === "payg" && !s.ato_label) {
      const label = window.prompt("Deduction category (e.g. union-fees, tools, self-education):", "");
      if (!label) return;
      a.ato_label = label.trim();
    }
    answer.mutate(a);
  };

  // Apply a picked bucket to the WHOLE group. Income buckets route through their income_* answer kind
  // (so the credit is recorded once, not double-counted); everything else is a re-bucket. income_property
  // must attach a property, or the rent never ties to its property.
  const applyMore = () => {
    if (!pBucket) return;
    const incomeKind = INCOME_BUCKET_KIND[pBucket];
    const a: ClarifyAnswer = incomeKind ? { kind: incomeKind } : { kind: "bucket", bucket: pBucket };
    if (NEEDS_PROPERTY.has(pBucket) && pProp) a.property_id = pProp;
    if (!incomeKind && pLabel.trim()) a.ato_label = pLabel.trim();
    if (pBucket === "income_property" && !a.property_id) return; // rent must attach to a property
    answer.mutate(a);
  };

  const busy = answer.isPending || dismiss.isPending;

  return (
    <li className="rounded-lg border border-line p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm font-medium">{q.sample_desc || q.group_key}</span>
        <span className="shrink-0 text-xs text-muted">
          {q.n}× · {money(q.total_cents)} · {q.direction}
        </span>
      </div>
      {q.suggestions.some((s) => s.needs_property) && properties.length > 0 && (
        <select
          value={propertyId}
          onChange={(e) => setPropertyId(e.target.value)}
          className="mt-2 rounded-lg border border-line px-2 py-1 text-sm"
        >
          {properties.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {q.suggestions.map((s, i) => (
          <button
            key={i}
            onClick={() => pick(s)}
            disabled={busy || (s.needs_property && properties.length === 0)}
            className="rounded-lg border border-line px-2.5 py-1 text-xs hover:bg-surface disabled:opacity-50"
          >
            {s.label}
          </button>
        ))}
        <button
          onClick={() => setShowMore((v) => !v)}
          disabled={busy}
          className="rounded-lg border border-dashed border-line px-2.5 py-1 text-xs text-muted hover:bg-surface hover:text-ink disabled:opacity-50"
        >
          {showMore ? "Less" : "More categories…"}
        </button>
        <button onClick={() => dismiss.mutate()} disabled={busy} className="px-2 py-1 text-xs text-muted hover:text-ink">
          Dismiss
        </button>
      </div>
      {showMore && (
        <div className="mt-2 space-y-2 rounded-lg border border-line bg-surface p-2.5">
          <p className="text-xs text-muted">Pick any category to apply to all {q.n} — general information only.</p>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={pBucket}
              onChange={(e) => setPBucket(e.target.value)}
              aria-label="Category"
              className="rounded-lg border border-line bg-card px-2 py-1 text-sm"
            >
              <option value="">— choose category —</option>
              {PICKER_BUCKETS.map((b) => (
                <option key={b} value={b}>
                  {BUCKET_LABEL[b]}
                </option>
              ))}
            </select>
            {pBucket !== "" && !INCOME_BUCKET_KIND[pBucket] && (
              <input
                value={pLabel}
                onChange={(e) => setPLabel(e.target.value)}
                placeholder="ATO label (optional)"
                aria-label="ATO label"
                className="w-44 rounded-lg border border-line bg-card px-2 py-1 text-sm"
              />
            )}
            {NEEDS_PROPERTY.has(pBucket) && properties.length > 0 && (
              <select
                value={pProp}
                onChange={(e) => setPProp(e.target.value)}
                aria-label="Property"
                className="rounded-lg border border-line bg-card px-2 py-1 text-sm"
              >
                <option value="">— choose property —</option>
                {properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            )}
            <button
              onClick={applyMore}
              disabled={busy || !pBucket || (pBucket === "income_property" && !pProp)}
              className="rounded-lg border border-line bg-card px-2.5 py-1 text-xs font-medium hover:bg-surface disabled:opacity-50"
            >
              Apply to all {q.n}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
