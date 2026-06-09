import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../api";
import { Card, Button, BUCKET_LABEL } from "./ui";
import { useActiveFy } from "../lib/activeFy";
import type { AskAnswer } from "../types";

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
