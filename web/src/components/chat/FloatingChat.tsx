import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../api";
import { useActiveFy } from "../../lib/activeFy";
import { useFeatures } from "../../lib/features";
import { ProposedActionCard } from "../AskQuillo";
import { BUCKET_LABEL } from "../ui";
import { useChatUI } from "./ChatProvider";
import type { AskAnswer, EntityAction } from "../../types";

/**
 * Floating "Ask Quillo" widget (flag `floating_chat`). The agent stays 100% server-side: this is a
 * plain-React client shell that POSTs to the existing /api/chat and renders the structured response
 * (answer + caveats + proposed_actions + entity_actions + navigate) with our own ui.tsx/tokens.
 *
 * NOTE: deliberately NO assistant-ui. @assistant-ui/react@0.14 (via @assistant-ui/tap) calls React 19
 * hooks (useEffectEvent / use / useMemoCache) that don't exist in this app's React 18.3, which crashed
 * the whole app on mount. Our backend is non-streaming and data-rich, so a hand-rolled message list +
 * composer is both sufficient and dependency-free. Revisit assistant-ui only if/when we move to React 19.
 *
 * Mounted once near the app root via a portal, so the conversation + open panel survive client-side
 * route changes. APP-8 consent + the daily budget + the per-tenant rate limit are enforced server-side
 * before any model call; a 403/429 here is surfaced as a calm inline notice, never a crash.
 */
type ChatMsg = { id: string; role: "user" | "assistant"; text: string; extra?: AskAnswer };

const uid = (): string =>
  typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `m_${Date.now()}_${Math.round(Math.random() * 1e9)}`;

export function FloatingChat() {
  const { has, loaded } = useFeatures();
  // Flag OFF (or still loading) ⇒ render nothing → byte-identical to today.
  if (!loaded || !has("floating_chat")) return null;
  return <FloatingChatInner />;
}

function FloatingChatInner() {
  const { fy } = useActiveFy();
  const { has } = useFeatures();
  const { open, toggle, closeChat, unread, bumpUnread, clearUnread } = useChatUI();
  const location = useLocation();
  // The <lg bottom tab bar (mobile_bottom_tabs) occupies the launcher's corner, so on small
  // screens the bubble must clear it or it covers the right-most tabs (Position / More).
  // --tabbar-clearance is defined once in index.css. Above lg the bar is hidden ⇒ bottom-4.
  const tabs = has("mobile_bottom_tabs");
  const launcherBottom = tabs ? "bottom-[var(--tabbar-clearance)] lg:bottom-4" : "bottom-4";
  const panelBottom = tabs ? "md:bottom-[var(--tabbar-clearance)] lg:bottom-4" : "md:bottom-4";
  // Send the current route as page context (Phase 2). Read from a ref so send() always sees the live route.
  const pageRef = useRef(location.pathname);
  pageRef.current = location.pathname;

  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [isRunning, setRunning] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [notice, setNotice] = useState<{ kind: "consent" | "warn"; text: string } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);

  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
    if (open) clearUnread();
  }, [open, clearUnread]);

  // Autoscroll the message log to the latest turn.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages, isRunning, open]);

  // Escape closes the panel and returns focus to the launcher.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeChat();
        launcherRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, closeChat]);

  const send = async () => {
    const text = input.trim();
    if (!text || isRunning) return;
    setInput("");
    setNotice(null);
    setMessages((prev) => [...prev, { id: uid(), role: "user", text }]);
    setRunning(true);
    try {
      const r = await api.chat(text, sessionId, fy, pageRef.current);
      setSessionId(r.session_id);
      setMessages((prev) => [...prev, { id: uid(), role: "assistant", text: r.answer, extra: r }]);
      if (!openRef.current) bumpUnread();
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 403 || err.message?.includes("consent")) {
        setNotice({ kind: "consent", text: "Turn on AI assistance to use this — Settings → Privacy & AI (or the onboarding walkthrough)." });
      } else {
        // 429 (daily budget OR per-tenant rate limit) and everything else: the server message is already
        // user-friendly ("AI is paused…", "You're sending messages too quickly…").
        setNotice({ kind: "warn", text: err.message || "Something went wrong — try again in a moment." });
      }
    } finally {
      setRunning(false);
    }
  };

  return createPortal(
    <>
      {/* Launcher — fixed bottom-right, lifted clear of the bottom tab bar on <lg. Transient
          sonner toasts (bottom-right) may briefly overlap and auto-dismiss. */}
      {!open && (
        <button
          ref={launcherRef}
          type="button"
          onClick={toggle}
          aria-label="Open chat with Quillo"
          className={`fixed ${launcherBottom} right-4 z-[60] grid h-14 w-14 place-items-center rounded-full bg-ink text-cream shadow-float transition hover:bg-green focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/30`}
        >
          <ChatGlyph />
          {unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 grid h-5 min-w-5 place-items-center rounded-full bg-sage px-1 text-[11px] font-bold text-forest">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </button>
      )}

      {open && (
        <div
          role="dialog"
          aria-label="Ask Quillo"
          className={`fixed inset-0 z-[60] flex flex-col border-line bg-card shadow-float md:inset-auto ${panelBottom} md:right-4 md:h-[560px] md:max-h-[calc(100vh-2rem)] md:w-[380px] md:rounded-2xl md:border`}
        >
          <Header onClose={closeChat} />

          <div ref={logRef} role="log" aria-live="polite" className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
            {messages.length === 0 && <Welcome />}
            {messages.map((m) =>
              m.role === "user" ? (
                <UserBubble key={m.id} text={m.text} />
              ) : (
                <AssistantBubble key={m.id} msg={m} onNavigate={closeChat} sessionId={sessionId} />
              ),
            )}
            {isRunning && (
              <div role="status" className="max-w-[92%] rounded-2xl border border-line bg-surface px-3 py-2 text-sm text-muted">
                Thinking…
              </div>
            )}
          </div>

          <div className="border-t border-line px-3 py-3">
            {notice && <p className={`mb-2 text-xs ${notice.kind === "consent" ? "text-muted" : "text-warn"}`}>{notice.text}</p>}
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
            >
              <textarea
                autoFocus
                rows={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder="Ask about your tax position…"
                aria-label="Ask Quillo a question"
                className="max-h-32 min-h-[40px] flex-1 resize-none rounded-xl border border-line bg-card px-3 py-2 text-sm outline-none transition focus:border-ink/40 focus:ring-2 focus:ring-ink/10"
              />
              <button
                type="submit"
                disabled={!input.trim() || isRunning}
                aria-label="Send"
                className="grid h-10 w-10 flex-none place-items-center rounded-full bg-ink text-cream transition hover:bg-green disabled:opacity-50"
              >
                <SendGlyph />
              </button>
            </form>
            <p className="mt-2 text-[10px] leading-snug text-muted">General information only — not tax advice. Confirm with a registered tax agent.</p>
          </div>
        </div>
      )}
    </>,
    document.body,
  );
}

function Header({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex flex-none items-center gap-2 rounded-t-2xl bg-forest px-4 py-3 text-cream">
      <span className="grid h-7 w-7 place-items-center rounded-lg bg-sage font-display text-sm text-forest">Q</span>
      <div className="min-w-0">
        <p className="font-display text-base leading-none tracking-wide">Ask Quillo</p>
        <p className="text-[11px] text-cream/60">Answered from your own records</p>
      </div>
      <span className="flex-1" />
      <button
        type="button"
        onClick={onClose}
        aria-label="Close chat"
        className="grid h-8 w-8 place-items-center rounded-full text-cream/80 transition hover:bg-cream/10 hover:text-cream focus:outline-none focus-visible:ring-2 focus-visible:ring-cream/40"
      >
        <CloseGlyph />
      </button>
    </div>
  );
}

function Welcome() {
  return (
    <div className="rounded-2xl border border-dashed border-line bg-surface px-4 py-5 text-sm text-muted">
      <p className="font-medium text-ink">Ask anything about your own records.</p>
      <p className="mt-1">
        “What's my work-from-home claim?”, “Why isn't this deductible?”, “What's left before I can hand off?” —
        answered from your data. General information only, not tax advice.
      </p>
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return <p className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl bg-ink px-3 py-2 text-sm text-cream">{text}</p>;
}

function AssistantBubble({ msg, onNavigate, sessionId }: { msg: ChatMsg; onNavigate: () => void; sessionId?: string }) {
  const extra = msg.extra;
  return (
    <div className="max-w-[92%] space-y-2 rounded-2xl border border-line bg-surface p-3 text-sm">
      <p className="whitespace-pre-wrap text-ink">{msg.text}</p>
      {!!extra?.caveats?.length && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted">
          {extra.caveats.map((c, j) => (
            <li key={j}>{c}</li>
          ))}
        </ul>
      )}
      {!!extra?.see_also?.length && <p className="text-xs text-muted">See also: {extra.see_also.join(" · ")}</p>}
      {extra?.proposed_actions?.map((a, j) => <ProposedActionCard key={j} action={a} />)}
      {extra?.entity_actions?.map((a, j) => <EntityActionCard key={j} action={a} sessionId={sessionId} />)}
      {extra?.suggested_rule && <SaveRuleInline rule={extra.suggested_rule} />}
      {extra?.navigate && <NavigateButton navigate={extra.navigate} onNavigate={onNavigate} />}
    </div>
  );
}

// Phase 3 (ask_actions_v2): a model-PROPOSED create/edit of a setup record. Never autonomous — the user
// confirms here, then it executes via the audited DO path (/api/ai-edits/apply → ai_edits + audit_log),
// undoable from "Recent changes". A stable per-card action_id makes a double-click idempotent server-side.
function EntityActionCard({ action, sessionId }: { action: EntityAction; sessionId?: string }) {
  const qc = useQueryClient();
  const [actionId] = useState(uid);
  const apply = useMutation({
    mutationFn: () => api.applyEntityAction({ kind: action.kind, entity_id: action.entity_id, fields: action.fields, action_id: actionId, session_id: sessionId }),
    onSuccess: () => {
      for (const k of ["situation", "dashboard", "rules", "report", "ai-edits"]) qc.invalidateQueries({ queryKey: [k] });
    },
  });
  const fieldList = Object.entries(action.fields)
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${String(v)}`)
    .join(" · ");
  return (
    <div className="space-y-1 rounded-lg border border-dashed border-line bg-card p-2 text-xs">
      <p className="font-medium text-ink">{action.title}</p>
      {action.rationale && <p className="text-muted">{action.rationale}</p>}
      <p className="text-ink-2">{fieldList}</p>
      <div className="flex flex-wrap items-center gap-2">
        {apply.isSuccess ? (
          <span className="font-medium text-safe">Saved ✓</span>
        ) : (
          <button onClick={() => apply.mutate()} disabled={apply.isPending} className="rounded-lg border border-line bg-surface px-2 py-1 font-medium hover:bg-card disabled:opacity-50">
            {apply.isPending ? "Saving…" : action.kind.startsWith("create") ? "Add it" : "Apply change"}
          </button>
        )}
        {apply.isError && <span className="text-danger">{(apply.error as Error).message}</span>}
      </div>
      <p className="text-[10px] text-muted">You're confirming this change — it's recorded and reversible under “Recent changes”. General information only.</p>
    </div>
  );
}

/** Confirm-to-write a model-suggested rule via the existing /api/rules path (mirrors AskQuillo). */
function SaveRuleInline({ rule }: { rule: { pattern: string; bucket: string; ato_label?: string } }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: () => api.addRule({ pattern: rule.pattern, bucket: rule.bucket, ato_label: rule.ato_label ?? "" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rules"] }),
  });
  if (save.isSuccess)
    return (
      <p className="text-xs text-safe">
        Rule saved — “{rule.pattern}” → {BUCKET_LABEL[rule.bucket] ?? rule.bucket}. Future imports auto-apply it.
      </p>
    );
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-line bg-card p-2 text-xs">
      <span>
        Remember:{" "}
        <span className="font-medium">
          “{rule.pattern}” → {BUCKET_LABEL[rule.bucket] ?? rule.bucket}
        </span>
        {rule.ato_label ? ` (${rule.ato_label})` : ""}?
      </span>
      <button onClick={() => save.mutate()} disabled={save.isPending} className="rounded-lg border border-line bg-surface px-2 py-1 font-medium hover:bg-card disabled:opacity-50">
        {save.isPending ? "Saving…" : "Save as a rule"}
      </button>
      {save.isError && <span className="text-danger">{(save.error as Error).message}</span>}
    </div>
  );
}

// Phase 2 (chat_nav): the agent's "take me to a screen" affordance — a visible button, never a silent
// jump, that uses React Router to swap the page and closes the panel.
function NavigateButton({ navigate, onNavigate }: { navigate: { route: string; reason: string }; onNavigate: () => void }) {
  const go = useNavigate();
  return (
    <button
      onClick={() => {
        go(navigate.route);
        onNavigate();
      }}
      className="flex w-full items-center justify-between gap-2 rounded-lg border border-line bg-card px-3 py-2 text-xs font-medium text-ink transition hover:bg-paper2"
    >
      <span>Take me to {navigate.reason || navigate.route} →</span>
    </button>
  );
}

function ChatGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 5.5h16a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H9l-4.5 3.5V17H4A1.5 1.5 0 0 1 2.5 15.5V7A1.5 1.5 0 0 1 4 5.5Z" />
    </svg>
  );
}
function CloseGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}
function SendGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12l16-8-6 16-3-6-7-2Z" />
    </svg>
  );
}
