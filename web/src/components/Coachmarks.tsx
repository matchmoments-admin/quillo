import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";

// First-login walkthrough (C5): a 5-step guided tour of the core workflow, shown ONCE per tenant on
// the first authenticated session after onboarding. Cancellable at any step ("Skip tour"). Persisted
// server-side via profiles.ui_state.tour_seen (no localStorage). Deliberately a small, non-blocking
// bottom-corner card — it guides without getting in the way (distinct from the always-on per-tab
// "What do I do here?" pills, which the user triggers themselves).

interface Step {
  title: string;
  body: string;
  href?: string;
  cta?: string;
}

const STEPS: Step[] = [
  {
    title: "Welcome to Quillo 👋",
    body: "A quick 5-step tour of how it works — or skip and explore. First: get a record in.",
    href: "/accounts",
    cta: "Go to Accounts",
  },
  {
    title: "1 · Import a statement",
    body: "Add an account, then upload a CSV or PDF. Quillo reads and categorises every line automatically — there's no separate 'process' step.",
    href: "/accounts",
    cta: "Open Accounts",
  },
  {
    title: "2 · Review what's flagged",
    body: "Anything Quillo wasn't confident about lands in your Inbox. Open an item to see the category and confidence, then confirm or change it — that teaches Quillo.",
    href: "/",
    cta: "Open Inbox",
  },
  {
    title: "3 · Reconcile (optional)",
    body: "Got receipts? Reconcile attaches them to bank lines as evidence. If you only import statements, you can skip this entirely.",
    href: "/reconcile",
    cta: "Open Reconcile",
  },
  {
    title: "4 · Your live position → lodge",
    body: "Your Dashboard updates as you confirm, and File pulls it together for your tax agent. That's the finish line.",
    href: "/dashboard",
    cta: "Open Dashboard",
  },
];

export function Coachmarks({ pathname }: { pathname: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [i, setI] = useState(0);
  const sit = useQuery({ queryKey: ["situation"], queryFn: () => api.situation() });
  const seen = useMutation({
    mutationFn: () => api.setUiState({ tour_seen: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["situation"] }),
  });

  // Parse the server-side UI flag. Only show once the tenant has a profile (onboarded) and hasn't
  // seen the tour — and never on the onboarding wizard itself.
  const profile = sit.data?.profile;
  let tourSeen = true;
  try {
    tourSeen = profile?.ui_state ? !!(JSON.parse(profile.ui_state) as { tour_seen?: boolean }).tour_seen : false;
  } catch {
    tourSeen = false;
  }
  // Hide once dismissed — including on a failed PATCH (best-effort): a persistence error must not
  // trap the user with a tour they can't close. It may re-show next session; that's acceptable.
  if (!profile || tourSeen || pathname === "/onboarding" || seen.isPending || seen.isSuccess || seen.isError) return null;

  const step = STEPS[i];
  const last = i === STEPS.length - 1;
  const dismiss = () => seen.mutate();

  return (
    <div className="fixed bottom-4 right-4 z-50 w-[20rem] max-w-[calc(100vw-2rem)] rounded-2xl border border-line bg-card p-4 shadow-card">
      <div className="flex items-start justify-between gap-2">
        <div className="font-display text-base tracking-wide text-forest">{step.title}</div>
        <button onClick={dismiss} aria-label="Skip tour" className="flex-none text-xs font-semibold text-ink-3 transition hover:text-ink">
          Skip
        </button>
      </div>
      <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{step.body}</p>

      <div className="mt-3 flex items-center gap-1.5">
        {STEPS.map((_, j) => (
          <div key={j} className={`h-1.5 flex-1 rounded-full ${j <= i ? "bg-ink" : "bg-line"}`} />
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        {step.href && step.cta ? (
          <button
            onClick={() => navigate(step.href!)}
            className="rounded-full border border-ink/25 px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-ink/5"
          >
            {step.cta}
          </button>
        ) : (
          <span />
        )}
        <button
          onClick={() => (last ? dismiss() : setI((n) => n + 1))}
          className="rounded-full bg-ink px-4 py-1.5 text-xs font-semibold text-cream transition hover:bg-green"
        >
          {last ? "Done" : "Next"}
        </button>
      </div>
    </div>
  );
}
