import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../api";
import { Card, Button } from "./ui";
import { useActiveFy } from "../lib/activeFy";

/**
 * "Ask Quillo" (flag ask_quillo) — a single-turn, grounded tax-Q&A box. The question is answered from
 * the user's OWN ledger (server assembles their situation + computed FY position), GENERAL-INFO framed,
 * APP-8 consent + budget gated server-side. No chat history yet (that's the C2 epic). 403 → consent
 * prompt; 429 → budget message; otherwise the answer + caveats + related screens.
 */
export function AskQuillo() {
  const { fy } = useActiveFy();
  const [q, setQ] = useState("");
  const ask = useMutation({ mutationFn: (question: string) => api.ask(question, fy) });
  const err = ask.error ? (ask.error as Error).message : "";
  const needsConsent = err.includes("consent_required");

  return (
    <Card className="space-y-3 p-4">
      <div>
        <h2 className="text-base font-semibold">Ask Quillo</h2>
        <p className="text-xs text-muted">
          Ask anything about your own records — “what's my work-from-home claim?”, “why isn't this deductible?”,
          “what's left before I can hand off?”. Answered from your data. General information only — not tax advice.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <textarea
          value={q}
          onChange={(e) => setQ(e.target.value)}
          rows={2}
          placeholder="Ask about your tax position…"
          aria-label="Ask Quillo a question"
          className="min-w-[16rem] flex-1 rounded-lg border border-line bg-card px-3 py-2 text-sm"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && q.trim()) ask.mutate(q);
          }}
        />
        <Button onClick={() => ask.mutate(q)} disabled={ask.isPending || !q.trim()}>
          {ask.isPending ? "Thinking…" : "Ask"}
        </Button>
      </div>
      {needsConsent ? (
        <p className="text-sm text-muted">Turn on AI assistance to use this — Settings → Privacy &amp; AI (or the onboarding walkthrough).</p>
      ) : err ? (
        <p className="text-sm text-warn">{err}</p>
      ) : ask.data ? (
        <div className="space-y-2 rounded-lg border border-line bg-surface p-3 text-sm">
          <p className="whitespace-pre-wrap text-ink">{ask.data.answer}</p>
          {ask.data.caveats.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted">
              {ask.data.caveats.map((c, i) => <li key={i}>{c}</li>)}
            </ul>
          )}
          {ask.data.see_also.length > 0 && (
            <p className="text-xs text-muted">See also: {ask.data.see_also.join(" · ")}</p>
          )}
          <p className="text-xs text-muted">General information only — not tax advice. Confirm with a registered tax agent.</p>
        </div>
      ) : null}
    </Card>
  );
}
