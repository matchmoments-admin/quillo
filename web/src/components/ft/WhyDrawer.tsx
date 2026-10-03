import { useCallback, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, ApiError } from "../../api";
import type { StepKey } from "../../content/stepGuides";
import { useActiveFy } from "../../lib/activeFy";
import { useFeatures } from "../../lib/features";
import type { AskAnswer } from "../../types";
import { whyStarterQuestions } from "./model";
import { FtButton, FtCard, FtTextArea, Skeleton, type StatusProps } from "./primitives";
import { WhySheet } from "./WhySheet";

/** The claim/record a Why? is about. `id` is the transaction id (the server reads it tenant-scoped). */
export interface WhyItem {
  id: string;
  label: string;
}

/**
 * The Why? drawer (spec A10 ticket b, #591; owner ruling #537: "Why? = Ask Quillo in context"). Opens
 * the WhySheet with the step's static explainer from content/stepGuides.ts, and, when Ask Quillo is on,
 * an in-context question box underneath that asks POST /api/ask with `context: { step, item_id }`.
 *
 * Safety: the model call goes through the existing Ask Quillo path, so the server runs the APP-8
 * consent gate, the daily budget and getLLM's residency guard before any model call, and 404s when the
 * ask_quillo kill-switch is off (this component also hides the box then). The agent explains, never
 * drives: only the answer and its caveats render, never proposed actions, navigation or rule saves.
 */
export function WhyDrawer({
  open,
  onClose,
  step,
  item,
  ...status
}: { open: boolean; onClose: () => void; step: StepKey; item?: WhyItem | null } & StatusProps) {
  const { has } = useFeatures();
  const askOn = has("ask_quillo");
  return (
    <WhySheet open={open} onClose={onClose} step={step} title={step === "home" ? "Why?" : undefined} {...status}>
      {item && <p className="text-sm text-muted">About: {item.label}</p>}
      {askOn && <AskInContext key={`${step}:${item?.id ?? ""}`} step={step} item={item ?? null} />}
    </WhySheet>
  );
}

/** One in-context question to Ask Quillo. Remounted per step/item, so a new Why? starts clean. */
// The surrounding WhySheet owns the loading/empty/error states; this box only has its own ask states.
function AskInContext({ step, item }: { step: StepKey; item: WhyItem | null }) {
  const { fy } = useActiveFy();
  const [input, setInput] = useState("");
  const ask = useMutation<AskAnswer, Error, string>({
    mutationFn: (q: string) => api.ask(q, fy, item ? { step, item_id: item.id } : { step }),
  });
  // `fromBox`: only a question typed in the box clears the box (a starter tap keeps a half-typed one).
  const send = (q: string, fromBox: boolean) => {
    const text = q.trim();
    if (!text || ask.isPending) return;
    if (fromBox) setInput("");
    ask.mutate(text);
  };
  const starters = whyStarterQuestions(step, !!item);

  return (
      <section aria-label="Ask Quillo about this" className="space-y-3 border-t border-line pt-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted">Ask Quillo about this</p>
        <div className="flex flex-wrap gap-2">
          {starters.map((q) => (
            <FtButton key={q} variant="secondary" className="text-sm font-medium" onClick={() => send(q, false)} disabled={ask.isPending}>
              {q}
            </FtButton>
          ))}
        </div>
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            send(input, true);
          }}
        >
          <FtTextArea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send(input, true);
              }
            }}
            maxLength={600}
            placeholder="Or ask your own question"
            aria-label="Ask Quillo a question about this"
          />
          <FtButton type="submit" variant="primary" busy={ask.isPending} disabled={!input.trim()}>
            Ask
          </FtButton>
        </form>
        {ask.isPending && (
          <div role="status" aria-live="polite">
            <span className="sr-only">Asking Quillo</span>
            <Skeleton lines={3} />
          </div>
        )}
        {ask.isError && <AskNotice error={ask.error} />}
        {ask.data && <Answer data={ask.data} />}
      </section>
  );
}

function Answer({ data }: { data: AskAnswer }) {
  return (
    <FtCard className="space-y-2 p-4">
      <div aria-live="polite" className="space-y-2">
        <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-ink">{data.answer}</p>
        {data.caveats.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-muted">
            {data.caveats.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        )}
      </div>
    </FtCard>
  );
}

/** A failed ask is never silent: consent, kill-switch and budget each say what happened. */
function AskNotice({ error }: { error: Error }) {
  const status = error instanceof ApiError ? error.status : 0;
  let text: ReactNode;
  if (/consent/i.test(error.message)) {
    text = "Ask Quillo needs your OK to use AI first. Turn it on in Settings, under Privacy & AI. The points above still apply.";
  } else if (status === 404) {
    text = "Ask Quillo isn't available right now. The points above still apply.";
  } else {
    text = error.message || "Something went wrong. Try again in a moment.";
  }
  return (
    <p role="alert" className="rounded-lg bg-warn-surface px-3 py-2 text-sm text-warn">
      {text}
    </p>
  );
}

/**
 * For step pages: `openWhy()` for the step footer, `openWhy(item)` for a card's Why?, and `drawer` to
 * render once on the page. Keeps the item context with the open state so the two can't drift.
 */
export function useWhyDrawer(step: StepKey): { openWhy: (item?: WhyItem) => void; closeWhy: () => void; drawer: ReactNode } {
  const [state, setState] = useState<{ open: boolean; item: WhyItem | null }>({ open: false, item: null });
  const openWhy = useCallback((item?: WhyItem) => setState({ open: true, item: item ?? null }), []);
  const closeWhy = useCallback(() => setState((s) => ({ ...s, open: false })), []);
  const drawer = <WhyDrawer open={state.open} onClose={closeWhy} step={step} item={state.item} />;
  return { openWhy, closeWhy, drawer };
}
