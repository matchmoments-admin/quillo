import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { tabGuide, tabKeyForPath } from "../content/tabGuides";

// The always-on, user-triggered "What do I do here?" pill — available on every tab at any time
// (for the user who's lost days into the app, not just on first run). Collapsed by default so it
// never gets in the way; click to open a short, data-aware explainer. Distinct from the first-login
// walkthrough (which is a separate, cancellable, once-only tour).
export function TabGuide({ pathname }: { pathname: string }) {
  const [open, setOpen] = useState(false);
  const tab = tabKeyForPath(pathname);
  const { data } = useQuery({
    queryKey: ["progress"],
    queryFn: () => api.progress(),
    staleTime: 15_000,
    enabled: !!tab,
  });

  if (!tab) return null;
  const guide = tabGuide(tab, data);

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
          <button
            type="button"
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default"
          />
          <div
            role="dialog"
            className="absolute right-0 z-50 mt-2 w-80 rounded-xl border border-line bg-card p-4 text-left shadow-card"
          >
            <div className="font-display text-base tracking-wide text-forest">{guide.title}</div>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{guide.body}</p>
            <div className="mt-3 text-right">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-xs font-semibold text-ink-3 transition hover:text-ink"
              >
                Got it
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
