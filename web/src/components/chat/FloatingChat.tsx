import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  ThreadPrimitive,
  ComposerPrimitive,
  type ThreadMessageLike,
  type AppendMessage,
} from "@assistant-ui/react";
import { api, ApiError } from "../../api";
import { useActiveFy } from "../../lib/activeFy";
import { useFeatures } from "../../lib/features";
import { ProposedActionCard } from "../AskQuillo";
import { BUCKET_LABEL } from "../ui";
import { useChatUI } from "./ChatProvider";
import type { AskAnswer } from "../../types";

/**
 * Floating "Ask Quillo" widget (flag `floating_chat`). The agent stays 100% server-side: this is a
 * client shell that POSTs to the existing /api/chat. We adopt assistant-ui as the headless runtime
 * (composer, autoscroll, message lifecycle — the seam for future streaming / tool UI) but render
 * with our OWN ui.tsx + design tokens (no shadcn). Because /api/chat is non-streaming and returns
 * rich structured data (answer + caveats + proposed_actions), ExternalStoreRuntime is the right
 * fit: we own the message array as the source of truth and convert it to assistant-ui messages,
 * carrying the structured extras on `metadata.custom.extra`.
 *
 * Mounted once near the app root via a portal, so the conversation + open panel survive client-side
 * route changes (the widget never unmounts as React Router swaps the page). APP-8 consent + the
 * daily budget + the per-session rate limit are all enforced server-side before any model call; a
 * 403/429 here is surfaced as a calm inline notice, never a crash.
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
  const { open, toggle, closeChat, unread, bumpUnread, clearUnread } = useChatUI();
  const location = useLocation();
  // Send the current route as page context (Phase 2) so the agent can scope its answer and propose
  // navigation. Read from a ref so onNew's closure always sees the live route without re-binding.
  const pageRef = useRef(location.pathname);
  pageRef.current = location.pathname;

  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [isRunning, setRunning] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [notice, setNotice] = useState<{ kind: "consent" | "warn"; text: string } | null>(null);

  // onNew runs in a closure; read the freshest `open` to decide whether to bump the unread badge.
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
    if (open) clearUnread();
  }, [open, clearUnread]);

  const onNew = async (message: AppendMessage) => {
    const text = (message.content as { type: string; text?: string }[])
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("\n")
      .trim();
    if (!text || isRunning) return;
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
        // 429 (daily budget OR per-session rate limit) and everything else: the server message is
        // already user-friendly ("AI is paused…", "You're sending messages too quickly…").
        setNotice({ kind: "warn", text: err.message || "Something went wrong — try again in a moment." });
      }
    } finally {
      setRunning(false);
    }
  };

  const convertMessage = (m: ChatMsg): ThreadMessageLike => ({
    role: m.role,
    content: [{ type: "text", text: m.text }],
    ...(m.extra ? { metadata: { custom: { extra: m.extra } } } : {}),
  });

  const runtime = useExternalStoreRuntime({ messages, isRunning, onNew, convertMessage });

  return createPortal(
    <AssistantRuntimeProvider runtime={runtime}>
      {/* Launcher — fixed bottom-right. z below Radix tooltips (70) and the mobile drawer is full-screen
          when shown; transient sonner toasts (bottom-right) may briefly overlap and auto-dismiss. */}
      {!open && (
        <button
          type="button"
          onClick={toggle}
          aria-label="Open chat with Quillo"
          className="fixed bottom-4 right-4 z-[60] grid h-14 w-14 place-items-center rounded-full bg-ink text-cream shadow-float transition hover:bg-green focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
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
          className="fixed inset-0 z-[60] flex flex-col border-line bg-card shadow-float md:inset-auto md:bottom-4 md:right-4 md:h-[560px] md:max-h-[calc(100vh-2rem)] md:w-[380px] md:rounded-2xl md:border"
        >
          <Header onClose={closeChat} />
          <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
            <ThreadPrimitive.Viewport className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
              <ThreadPrimitive.Empty>
                <Welcome />
              </ThreadPrimitive.Empty>
              <ThreadPrimitive.Messages>
                {({ message }) =>
                  message.role === "user" ? (
                    <UserBubble message={message as unknown as RenderMsg} />
                  ) : (
                    <AssistantBubble message={message as unknown as RenderMsg} onNavigate={closeChat} />
                  )
                }
              </ThreadPrimitive.Messages>
              {isRunning && (
                <div role="status" className="max-w-[92%] rounded-2xl border border-line bg-surface px-3 py-2 text-sm text-muted">
                  Thinking…
                </div>
              )}
            </ThreadPrimitive.Viewport>

            <div className="border-t border-line px-3 py-3">
              {notice && (
                <p className={`mb-2 text-xs ${notice.kind === "consent" ? "text-muted" : "text-warn"}`}>{notice.text}</p>
              )}
              <ComposerPrimitive.Root className="flex items-end gap-2">
                <ComposerPrimitive.Input
                  autoFocus
                  rows={1}
                  placeholder="Ask about your tax position…"
                  aria-label="Ask Quillo a question"
                  className="max-h-32 min-h-[40px] flex-1 resize-none rounded-xl border border-line bg-card px-3 py-2 text-sm outline-none transition focus:border-ink/40 focus:ring-2 focus:ring-ink/10"
                />
                <ComposerPrimitive.Send
                  aria-label="Send"
                  className="grid h-10 w-10 flex-none place-items-center rounded-full bg-ink text-cream transition hover:bg-green disabled:opacity-50"
                >
                  <SendGlyph />
                </ComposerPrimitive.Send>
              </ComposerPrimitive.Root>
              <p className="mt-2 text-[10px] leading-snug text-muted">
                General information only — not tax advice. Confirm with a registered tax agent.
              </p>
            </div>
          </ThreadPrimitive.Root>
        </div>
      )}
    </AssistantRuntimeProvider>,
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

// Reads the message handed in by ThreadPrimitive.Messages (MessageState extends ThreadMessage), so
// we can render the plain text + our structured extras without any extra context plumbing.
type RenderMsg = { role: string; content: readonly { type: string; text?: string }[]; metadata?: { custom?: Record<string, unknown> } };

function msgText(m: RenderMsg): string {
  return m.content
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("");
}

function UserBubble({ message }: { message: RenderMsg }) {
  return <p className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl bg-ink px-3 py-2 text-sm text-cream">{msgText(message)}</p>;
}

function AssistantBubble({ message, onNavigate }: { message: RenderMsg; onNavigate: () => void }) {
  const extra = message.metadata?.custom?.extra as AskAnswer | undefined;
  return (
    <div className="max-w-[92%] space-y-2 rounded-2xl border border-line bg-surface p-3 text-sm">
      <p className="whitespace-pre-wrap text-ink">{msgText(message)}</p>
      {!!extra?.caveats?.length && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted">
          {extra.caveats.map((c, j) => (
            <li key={j}>{c}</li>
          ))}
        </ul>
      )}
      {!!extra?.see_also?.length && <p className="text-xs text-muted">See also: {extra.see_also.join(" · ")}</p>}
      {extra?.proposed_actions?.map((a, j) => <ProposedActionCard key={j} action={a} />)}
      {extra?.suggested_rule && <SaveRuleInline rule={extra.suggested_rule} />}
      {extra?.navigate && <NavigateButton navigate={extra.navigate} onNavigate={onNavigate} />}
    </div>
  );
}

// Phase 2 (chat_nav): the agent's "take me to a screen" affordance. A visible button — never a silent
// jump — that uses React Router to swap the page and closes the panel (so the user lands on the page).
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
      <button
        onClick={() => save.mutate()}
        disabled={save.isPending}
        className="rounded-lg border border-line bg-surface px-2 py-1 font-medium hover:bg-card disabled:opacity-50"
      >
        {save.isPending ? "Saving…" : "Save as a rule"}
      </button>
      {save.isError && <span className="text-danger">{(save.error as Error).message}</span>}
    </div>
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
