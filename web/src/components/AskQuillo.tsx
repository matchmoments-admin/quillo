import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Card, Button, BUCKET_LABEL, money } from "./ui";
import { useActiveFy } from "../lib/activeFy";
import type { AskAnswer, ProposedAction } from "../types";

/**
 * "Ask Quillo" (flag ask_quillo) — a multi-turn, grounded tax chat (C2). Each turn is answered from the
 * user's OWN ledger (server assembles their situation + computed FY position + the conversation so far),
 * GENERAL-INFO framed, APP-8 consent + budget gated server-side. When the model proposes a categorisation
 * rule (suggested_rule), the user can confirm it → written via the existing /api/rules path (never
 * auto-written). 403 → consent prompt; 429 → budget message.
 */
type Turn = { role: "user" | "assistant"; content: string; extra?: AskAnswer };

export function AskQuillo() {
  const { fy } = useActiveFy();
  const [q, setQ] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>();

  const chat = useMutation({
    mutationFn: (message: string) => api.chat(message, sessionId, fy),
    onSuccess: (r) => {
      setSessionId(r.session_id);
      setTurns((t) => [...t, { role: "assistant", content: r.answer, extra: r }]);
    },
  });
  const err = chat.error ? (chat.error as Error).message : "";
  const needsConsent = err.includes("consent_required");

  const send = () => {
    const message = q.trim();
    if (!message || chat.isPending) return;
    setTurns((t) => [...t, { role: "user", content: message }]);
    setQ("");
    chat.mutate(message);
  };

  return (
    <Card className="space-y-3 p-4">
      <div>
        <h2 className="text-base font-semibold">Ask Quillo</h2>
        <p className="text-xs text-muted">
          Ask anything about your own records — “what's my work-from-home claim?”, “why isn't this deductible?”,
          “what's left before I can hand off?”. Answered from your data. General information only — not tax advice.
        </p>
      </div>

      {turns.length > 0 && (
        <div className="space-y-2">
          {turns.map((t, i) =>
            t.role === "user" ? (
              <p key={i} className="ml-auto max-w-[85%] rounded-lg bg-ink px-3 py-2 text-sm text-white">{t.content}</p>
            ) : (
              <div key={i} className="max-w-[92%] space-y-2 rounded-lg border border-line bg-surface p-3 text-sm">
                <p className="whitespace-pre-wrap text-ink">{t.content}</p>
                {!!t.extra?.caveats.length && (
                  <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted">{t.extra.caveats.map((c, j) => <li key={j}>{c}</li>)}</ul>
                )}
                {!!t.extra?.see_also.length && <p className="text-xs text-muted">See also: {t.extra.see_also.join(" · ")}</p>}
                {t.extra?.proposed_actions?.map((a, j) => <ProposedActionCard key={j} action={a} />)}
                {t.extra?.suggested_rule && <SaveRule rule={t.extra.suggested_rule} />}
              </div>
            ),
          )}
          {chat.isPending && <p className="max-w-[92%] rounded-lg border border-line bg-surface p-3 text-sm text-muted">Thinking…</p>}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <textarea
          value={q}
          onChange={(e) => setQ(e.target.value)}
          rows={2}
          placeholder="Ask about your tax position…"
          aria-label="Ask Quillo a question"
          className="min-w-[16rem] flex-1 rounded-lg border border-line bg-card px-3 py-2 text-sm"
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }}
        />
        <Button onClick={send} disabled={chat.isPending || !q.trim()}>{chat.isPending ? "Thinking…" : "Ask"}</Button>
      </div>

      {needsConsent ? (
        <p className="text-sm text-muted">Turn on AI assistance to use this — Settings → Privacy &amp; AI (or the onboarding walkthrough).</p>
      ) : err ? (
        <p className="text-sm text-warn">{err}</p>
      ) : turns.length > 0 ? (
        <p className="text-xs text-muted">General information only — not tax advice. Confirm with a registered tax agent.</p>
      ) : null}
    </Card>
  );
}

// Human labels for the deductibility states a proposal can carry.
const STATE_LABEL: Record<string, string> = {
  confirmed_deductible: "confirmed deductible",
  confirmed_not: "confirmed NOT deductible",
  likely_not: "likely not deductible",
  needs_apportionment: "needs a work-use split",
};

/**
 * Ask Quillo C3 (flag ask_actions): a model-PROPOSED fix the user confirms with one click. The Apply
 * button calls the EXISTING audited write path for the action's kind — the model never writes:
 *  - set_deductibility → POST /api/deductibility (stub.setDeductibility)
 *  - recategorise      → POST /api/correct/batch (undoable as a unit)
 *  - add_rule          → POST /api/rules
 */
export function ProposedActionCard({ action }: { action: ProposedAction }) {
  const qc = useQueryClient();
  // Map a routed property_id → its label for the summary (cached situation query, shared app-wide).
  const { data: situation } = useQuery({ queryKey: ["situation"], queryFn: api.situation });
  const propertyId = action.kind === "recategorise" || action.kind === "add_rule" ? action.property_id : undefined;
  const propertyLabel = propertyId ? situation?.properties?.find((p) => p.id === propertyId)?.label : undefined;
  const apply = useMutation({
    mutationFn: async () => {
      if (action.kind === "set_deductibility") {
        return api.resolveDeductibility({ state: action.state, txnIds: action.txn_ids, deductibleAmountCents: action.deductible_amount_cents ?? null });
      }
      if (action.kind === "recategorise") {
        const edits = [
          { field: "bucket", value: action.bucket },
          ...(action.ato_label ? [{ field: "ato_label", value: action.ato_label }] : []),
          ...(action.property_id ? [{ field: "property_id", value: action.property_id }] : []),
        ];
        return api.correctBatch(action.txn_ids, edits, false);
      }
      return api.addRule({ pattern: action.pattern, bucket: action.bucket, ato_label: action.ato_label ?? "", ...(action.property_id ? { property_id: action.property_id } : {}) });
    },
    onSuccess: () => {
      // The applied fix moves money figures — refresh every surface that shows them.
      for (const key of ["dashboard", "report", "transactions", "review", "rules"]) qc.invalidateQueries({ queryKey: [key] });
    },
  });
  const summary =
    action.kind === "set_deductibility"
      ? `${action.txn_ids.length} transaction(s) → ${STATE_LABEL[action.state] ?? action.state}${action.deductible_amount_cents != null ? ` (${money(action.deductible_amount_cents)} claimable)` : ""}`
      : action.kind === "recategorise"
        ? `${action.txn_ids.length} transaction(s) → ${BUCKET_LABEL[action.bucket] ?? action.bucket}${action.ato_label ? ` (${action.ato_label})` : ""}${propertyLabel ? ` · ${propertyLabel}` : ""}`
        : `“${action.pattern}” → ${BUCKET_LABEL[action.bucket] ?? action.bucket}${action.ato_label ? ` (${action.ato_label})` : ""}${propertyLabel ? ` · ${propertyLabel}` : ""} on future imports`;
  return (
    <div className="space-y-1 rounded-lg border border-dashed border-line bg-card p-2 text-xs">
      <p className="font-medium text-ink">{action.title}</p>
      <p className="text-muted">{action.rationale}</p>
      <div className="flex flex-wrap items-center gap-2">
        <span>{summary}</span>
        {apply.isSuccess ? (
          <span className="font-medium text-safe">Applied ✓</span>
        ) : (
          <button onClick={() => apply.mutate()} disabled={apply.isPending} className="rounded-lg border border-line bg-surface px-2 py-1 font-medium hover:bg-card disabled:opacity-50">
            {apply.isPending ? "Applying…" : "Apply"}
          </button>
        )}
        {apply.isError && <span className="text-danger">{(apply.error as Error).message}</span>}
      </div>
      <p className="text-[10px] text-muted">You're confirming this change — review the summary first. General information only.</p>
    </div>
  );
}

/** Confirm-to-write a model-suggested categorisation rule via the existing /api/rules path. */
function SaveRule({ rule }: { rule: { pattern: string; bucket: string; ato_label?: string } }) {
  const save = useMutation({ mutationFn: () => api.addRule({ pattern: rule.pattern, bucket: rule.bucket, ato_label: rule.ato_label ?? "" }) });
  if (save.isSuccess) return <p className="text-xs text-safe">Rule saved — “{rule.pattern}” → {BUCKET_LABEL[rule.bucket] ?? rule.bucket}. Future imports auto-apply it.</p>;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-line bg-card p-2 text-xs">
      <span>Remember: <span className="font-medium">“{rule.pattern}” → {BUCKET_LABEL[rule.bucket] ?? rule.bucket}</span>{rule.ato_label ? ` (${rule.ato_label})` : ""}?</span>
      <button onClick={() => save.mutate()} disabled={save.isPending} className="rounded-lg border border-line bg-surface px-2 py-1 font-medium hover:bg-card disabled:opacity-50">
        {save.isPending ? "Saving…" : "Save as a rule"}
      </button>
      {save.isError && <span className="text-danger">{(save.error as Error).message}</span>}
    </div>
  );
}
