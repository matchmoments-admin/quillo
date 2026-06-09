import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Card, money } from "./ui";
import type { ClarifyQuestion, ClarifySuggestion, ClarifyAnswer } from "../types";

/**
 * "Repeat merchants to sort" — the demoted Clarify card (#164). It is a thin DISCOVERY + one-tap
 * answer prompt, NOT a parallel re-bucketing engine. Each recurring-merchant group shows the
 * server's suggested answers; picking one routes through `answerClarify`:
 *   • income kinds  → the income table + single-count dedupe (the ONLY UI path that records grouped income)
 *   • ignore/capital → status only (bulk-ignore transfers / park CGT deposits)
 *   • spend bucket   → the shared applyCorrectionBatch + ensureClarifyRule seam — the SAME path as
 *                      edit-one → apply-to-siblings (the one rule-learning path for spend).
 * Custom spend categories now live on the transaction detail page (open the line → apply to
 * look-alikes), so this card no longer duplicates the full taxonomy picker. Renders nothing when
 * there are no open groups. General information only.
 */
export function ClarifyCard({ fy }: { fy?: number }) {
  const qc = useQueryClient();
  const { data: questions } = useQuery({ queryKey: ["clarify", fy], queryFn: () => api.clarifyQuestions(fy) });
  const { data: situation } = useQuery({ queryKey: ["situation"], queryFn: api.situation });

  const properties = situation?.properties ?? [];
  const open = questions ?? [];
  if (open.length === 0) return null; // discovery feed is empty — keep the page quiet

  return (
    <Card className="space-y-3 p-4">
      <div>
        <h2 className="text-base font-semibold">Repeat merchants to sort</h2>
        <p className="text-xs text-muted">
          We grouped your repeating merchants — pick a category once and it applies to the whole group
          (and is remembered for next time). <span className="text-muted">General information only.</span>
        </p>
      </div>
      <ul className="space-y-3">
        {open.map((q) => (
          <ClarifyRow key={q.id} q={q} properties={properties} onDone={() => qc.invalidateQueries({ queryKey: ["clarify"] })} />
        ))}
      </ul>
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
  // Inline label entry for the one suggestion that needs a category name (replaces a window.prompt).
  const [labelFor, setLabelFor] = useState<number | null>(null);
  const [label, setLabel] = useState("");

  const answer = useMutation({
    mutationFn: (a: ClarifyAnswer) => api.answerClarify(q.id, a),
    onSuccess: () => {
      // Income answers write to the income table → refresh income + report surfaces too.
      for (const k of ["transactions", "dashboard", "income", "report"]) qc.invalidateQueries({ queryKey: [k] });
      onDone();
    },
  });
  const dismiss = useMutation({ mutationFn: () => api.dismissClarify(q.id), onSuccess: onDone });
  const busy = answer.isPending || dismiss.isPending;

  const apply = (s: ClarifySuggestion, atoLabel?: string) => {
    const a: ClarifyAnswer = { kind: s.kind, bucket: s.bucket, ato_label: atoLabel ?? s.ato_label };
    if (s.needs_property) {
      if (!propertyId) return; // need a property selected first
      a.property_id = propertyId;
    }
    answer.mutate(a);
  };

  const pick = (s: ClarifySuggestion, i: number) => {
    // "Work-related deduction (choose category)" carries no label — collect one inline.
    if (s.kind === "bucket" && s.bucket === "payg" && !s.ato_label) {
      setLabelFor(i);
      return;
    }
    apply(s);
  };

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
            onClick={() => pick(s, i)}
            disabled={busy || (s.needs_property && properties.length === 0)}
            className="rounded-lg border border-line px-2.5 py-1 text-xs hover:bg-surface disabled:opacity-50"
          >
            {s.label}
          </button>
        ))}
        <button onClick={() => dismiss.mutate()} disabled={busy} className="px-2 py-1 text-xs text-muted hover:text-ink">
          Dismiss
        </button>
      </div>
      {labelFor != null && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface p-2.5">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Category name (e.g. union-fees, tools, self-education)"
            aria-label="Category name"
            className="w-64 rounded-lg border border-line bg-card px-2 py-1 text-sm"
          />
          <button
            onClick={() => {
              if (!label.trim()) return;
              apply(q.suggestions[labelFor], label.trim());
              setLabelFor(null);
              setLabel("");
            }}
            disabled={busy || !label.trim()}
            className="rounded-lg border border-line bg-card px-2.5 py-1 text-xs font-medium hover:bg-surface disabled:opacity-50"
          >
            Apply to all {q.n}
          </button>
          <button
            onClick={() => {
              setLabelFor(null);
              setLabel("");
            }}
            className="px-2 py-1 text-xs text-muted hover:text-ink"
          >
            Cancel
          </button>
        </div>
      )}
    </li>
  );
}
