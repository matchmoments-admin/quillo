import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { api } from "../api";
import { useFeatures } from "../lib/features";
import { tabGuide, tabKeyForPath } from "../content/tabGuides";

// The always-on, user-triggered "What do I do here?" pill — available on every tab at any time
// (for the user who's lost days into the app, not just on first run). Collapsed by default so it
// never gets in the way; click to open a short, data-aware explainer. When the `guide_me` flag is
// on, a "Guide me" button asks Haiku for a personalised, data-grounded walkthrough (budget + consent
// gated server-side; falls back to the static copy). Distinct from the first-login walkthrough.
export function TabGuide({ pathname }: { pathname: string }) {
  const [open, setOpen] = useState(false);
  const tab = tabKeyForPath(pathname);
  const { has } = useFeatures();
  const { data } = useQuery({
    queryKey: ["progress"],
    queryFn: () => api.progress(),
    staleTime: 15_000,
    enabled: !!tab,
  });
  const guideAI = useMutation({ mutationFn: () => api.guideMe(tab as string) });

  if (!tab) return null;
  const guide = tabGuide(tab, data);
  const ai = guideAI.data;
  const aiErr = guideAI.error ? friendlyGuideError((guideAI.error as Error).message) : null;
  const close = () => { setOpen(false); guideAI.reset(); };

  return (
    <div className="relative flex-none">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-full border border-line bg-card px-3 py-1.5 text-xs font-semibold text-ink-2 shadow-card transition hover:border-ink/40 hover:text-ink"
      >
        <span className="grid h-4 w-4 place-items-center rounded-full border border-ink-3/50 text-[10px] leading-none">?</span>
        What do I do here?
      </button>

      {open && (
        <>
          {/* Click-away backdrop (no extra dependency; closes the popover). */}
          <button type="button" aria-label="Close" onClick={close} className="fixed inset-0 z-40 cursor-default" />
          <div role="dialog" className="absolute right-0 z-50 mt-2 w-80 rounded-xl border border-line bg-card p-4 text-left shadow-card">
            <div className="font-display text-base tracking-wide text-forest">{ai?.headline ?? guide.title}</div>
            {ai ? (
              <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-sm leading-relaxed text-ink-2">
                {ai.steps.map((s, i) => <li key={i}>{s}</li>)}
              </ol>
            ) : (
              <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{guide.body}</p>
            )}
            {aiErr && <p className="mt-2 text-xs text-danger">{aiErr}</p>}
            {ai && <p className="mt-2 text-[11px] text-ink-3">General information only — not tax advice.</p>}

            <div className="mt-3 flex items-center justify-between">
              {has("guide_me") && !ai ? (
                <button
                  type="button"
                  onClick={() => guideAI.mutate()}
                  disabled={guideAI.isPending}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-forest transition hover:text-green disabled:opacity-50"
                >
                  {guideAI.isPending ? "Thinking…" : "✦ Guide me with my data"}
                </button>
              ) : (
                <span />
              )}
              <button type="button" onClick={close} className="text-xs font-semibold text-ink-3 transition hover:text-ink">
                {ai ? "Done" : "Got it"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function friendlyGuideError(msg: string): string {
  if (msg.includes("consent_required")) return "Turn on AI assistance (onboarding or Settings) to use this.";
  if (msg.includes("paused") || msg.includes("429")) return "AI is paused for today (daily limit) — try again after the reset.";
  return "Couldn't generate a guide just now — try again.";
}
