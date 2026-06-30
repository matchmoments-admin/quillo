import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api";

// #247/#244 (Wave 3): the persistent journey breadcrumb. The app already has the "what's next" action
// (NextActionBar) and per-tab "what do I do here" (TabGuide); the missing piece the research flagged is
// a constant sense of WHERE you are in the overall flow. This renders the six happy-path stops, marks
// the current one, badges the stops with outstanding work (from the shared ["progress"] query — no new
// endpoint), and lets the user jump to any stop. Flag-gated; hidden on the onboarding wizard.

type Stop = { key: string; label: string; href: string; match: string[] };

// The canonical spine (CLAUDE.md / Coachmarks): Set up → Bring in → Sort → Check → Position → File.
// `match` maps the data-entry / sub-pages onto their stop so the breadcrumb stays oriented everywhere.
// The Sort stop owns /transactions (its "Needs review" tab) + the legacy /inbox redirect, so it's out
// of Position's match.
const STOPS: Stop[] = [
  { key: "setup", label: "Set up", href: "/settings", match: ["/settings", "/onboarding"] },
  { key: "bring", label: "Bring in", href: "/accounts", match: ["/accounts", "/income", "/assets", "/documents"] },
  { key: "sort", label: "Sort", href: "/transactions", match: ["/inbox", "/transactions"] },
  { key: "check", label: "Check", href: "/reconcile", match: ["/reconcile"] },
  { key: "position", label: "Position", href: "/", match: ["/", "/dashboard", "/reports"] },
  { key: "file", label: "File", href: "/filing", match: ["/filing"] },
];

export function JourneySpine({ pathname }: { pathname: string }) {
  const { data } = useQuery({ queryKey: ["progress"], queryFn: () => api.progress(), staleTime: 15_000 });

  if (pathname === "/onboarding") return null;
  const currentIdx = STOPS.findIndex((s) => s.match.includes(pathname));

  // Data-aware badge for the stop that has outstanding work (mirrors NextActionBar's signals, as a spine).
  const badgeFor = (key: string): string | null => {
    if (!data) return null;
    if (key === "bring") return data.imported.transactions === 0 ? "start" : null;
    if (key === "sort") return data.needs_review > 0 ? String(data.needs_review) : null;
    if (key === "check") return data.unreconciled_receipts > 0 ? String(data.unreconciled_receipts) : null;
    if (key === "file") return data.done ? "ready" : null;
    return null;
  };

  return (
    <nav aria-label="Your tax-year journey" className="flex items-center gap-1 overflow-x-auto pb-0.5 text-xs">
      {STOPS.map((s, i) => {
        const current = i === currentIdx;
        const badge = badgeFor(s.key);
        return (
          <span key={s.key} className="flex flex-none items-center gap-1">
            {i > 0 && <span className="text-ink-3" aria-hidden>›</span>}
            <Link
              to={s.href}
              aria-current={current ? "step" : undefined}
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 transition ${
                current ? "bg-ink text-cream font-semibold" : "text-ink-3 hover:bg-ink/5 hover:text-ink"
              }`}
            >
              {s.label}
              {badge && (
                <span className={`rounded-full px-1.5 text-[10px] font-semibold leading-tight ${current ? "bg-cream/20 text-cream" : "bg-warn/15 text-warn"}`}>
                  {badge}
                </span>
              )}
            </Link>
          </span>
        );
      })}
    </nav>
  );
}
