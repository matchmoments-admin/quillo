import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../api";
import { Card, money } from "./ui";
import { PropertyFields, propertyToBody, propertyError, emptyProperty, type PropertyValue } from "./SituationFields";
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
  // Inline property selection: revealed ONLY after a property-related category is tapped (R1/R2).
  // Holds the suggestion index being applied; null while hidden. The selector is a child of the
  // chosen category, never a header sibling — so it can't imply a property on a salary/transfer.
  const [propertyFor, setPropertyFor] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<PropertyValue>(emptyProperty());

  const answer = useMutation({
    mutationFn: (a: ClarifyAnswer) => api.answerClarify(q.id, a),
    onSuccess: () => {
      // Income answers write to the income table → refresh income + report surfaces too.
      for (const k of ["transactions", "dashboard", "income", "report"]) qc.invalidateQueries({ queryKey: [k] });
      onDone();
    },
    onError: (e) => toast.error("Couldn't apply that category", { description: (e as Error).message }),
  });
  const dismiss = useMutation({
    mutationFn: () => api.dismissClarify(q.id),
    onSuccess: onDone,
    onError: (e) => toast.error("Couldn't dismiss", { description: (e as Error).message }),
  });
  // Inline "+ Add property" (R4): create without leaving the Sort screen, then default to the new one.
  const addProperty = useMutation({
    mutationFn: () => api.addProperty(propertyToBody(draft)),
    onSuccess: async ({ id }) => {
      await qc.invalidateQueries({ queryKey: ["situation"] });
      setPropertyId(id);
      setAdding(false);
      setDraft(emptyProperty());
    },
  });
  const busy = answer.isPending || dismiss.isPending || addProperty.isPending;

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
      setPropertyFor(null);
      setLabelFor(i);
      return;
    }
    // Property-related category (rental income / rental-property expense) — reveal the selector inline
    // instead of applying. The selector is shown ONLY here, never up front (R1/R2).
    if (s.needs_property) {
      if (!propertyId && properties[0]) setPropertyId(properties[0].id);
      setLabelFor(null);
      // A tenant with no properties yet can't pick from an empty list — drop them straight into the
      // inline add form (R4) so they're never stuck on a rental category with nothing to choose.
      setAdding(properties.length === 0);
      setPropertyFor(i);
      return;
    }
    // Any non-property category clears the inline selector; apply() attaches no property_id, so a
    // switch away from rental can't carry a stale association (R3).
    setPropertyFor(null);
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
      <div className="mt-2 flex flex-wrap gap-2">
        {q.suggestions.map((s, i) => (
          <button
            key={i}
            onClick={() => pick(s, i)}
            disabled={busy}
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
      {propertyFor != null && (
        <div className="mt-2 space-y-2 rounded-lg border border-line bg-surface p-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted">Which property?</span>
            <select
              value={adding ? "__add__" : propertyId}
              onChange={(e) => {
                if (e.target.value === "__add__") {
                  setAdding(true);
                } else {
                  setAdding(false);
                  setPropertyId(e.target.value);
                }
              }}
              aria-label="Property"
              className="rounded-lg border border-line bg-card px-2 py-1 text-sm"
            >
              {properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
              <option value="__add__">+ Add new property</option>
            </select>
            {!adding && (
              <button
                onClick={() => {
                  if (!propertyId) return;
                  apply(q.suggestions[propertyFor]);
                  setPropertyFor(null);
                }}
                disabled={busy || !propertyId}
                className="rounded-lg border border-line bg-card px-2.5 py-1 text-xs font-medium hover:bg-surface disabled:opacity-50"
              >
                Apply to all {q.n}
              </button>
            )}
            <button
              onClick={() => {
                setPropertyFor(null);
                setAdding(false);
                setDraft(emptyProperty());
              }}
              className="px-2 py-1 text-xs text-muted hover:text-ink"
            >
              Cancel
            </button>
          </div>
          {adding && (
            <div className="space-y-2 rounded-lg border border-line bg-card p-2.5">
              <PropertyFields value={draft} onChange={setDraft} />
              <div className="flex items-center gap-2">
                <button
                  onClick={() => addProperty.mutate()}
                  disabled={busy || !!propertyError(draft)}
                  title={propertyError(draft) ?? undefined}
                  className="rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-medium hover:bg-card disabled:opacity-50"
                >
                  {addProperty.isPending ? "Saving…" : "Save property"}
                </button>
                {addProperty.isError && <span className="text-xs text-danger">{(addProperty.error as Error).message}</span>}
              </div>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
