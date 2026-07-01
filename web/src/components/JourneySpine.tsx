import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { QueryError } from "./ui";
import { TabGuide } from "./TabGuide";

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
  { key: "check", label: "Check", href: "/reconcile", match: ["/reconcile", "/review"] },
  { key: "position", label: "Position", href: "/", match: ["/", "/dashboard", "/reports"] },
  { key: "file", label: "File", href: "/filing", match: ["/filing"] },
];

// `enhanced` (Slice 7, guidance_v2): the spine also carries the next-action CTA + summary + per-tab guide,
// becoming the single guidance surface. OFF/un-enhanced ⇒ the breadcrumb-only spine, byte-identical.
export function JourneySpine({ pathname, enhanced = false }: { pathname: string; enhanced?: boolean }) {
  const navigate = useNavigate();
  const { data, isError, error, refetch } = useQuery({ queryKey: ["progress"], queryFn: () => api.progress(), staleTime: 15_000 });

  if (pathname === "/onboarding") return null;
  // As the single guidance surface, port NextActionBar's guard so the "what's next" CTA can't silently
  // vanish on a failed load. Only in enhanced mode (the un-enhanced spine never showed a CTA).
  if (enhanced && isError) return <QueryError what="what's next" error={error} onRetry={() => refetch()} />;
  const currentIdx = STOPS.findIndex((s) => s.match.includes(pathname));

  // Data-aware badge for the stop that has outstanding work (mirrors NextActionBar's signals, as a spine).
  // The undated badge on Position is enhanced-only, so the un-enhanced (journey_spine) render is unchanged.
  const badgeFor = (key: string): string | null => {
    if (!data) return null;
    if (key === "bring") return data.imported.transactions === 0 ? "start" : null;
    if (key === "sort") return data.needs_review > 0 ? String(data.needs_review) : null;
    if (key === "check") return data.unreconciled_receipts > 0 ? String(data.unreconciled_receipts) : null;
    if (key === "position") return enhanced && data.undated > 0 ? String(data.undated) : null;
    if (key === "file") return data.done ? "ready" : null;
    return null;
  };

  const spineNav = (
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

  if (!enhanced) return spineNav;

  // Enhanced: the merged next-action summary + CTA (ported from NextActionBar) and the per-tab guide
  // (TabGuide, reused as-is — placed outside the overflow-x-auto nav so its popover isn't clipped).
  const parts: string[] = [];
  if (data) {
    const { imported, categorised, needs_review, undated } = data;
    if (imported.transactions > 0) {
      parts.push(`${imported.transactions} ${imported.transactions === 1 ? "transaction" : "transactions"}`);
      parts.push(categorised >= imported.transactions ? "all categorised" : `${categorised} categorised`);
      if (needs_review > 0) parts.push(`${needs_review} to review`);
      if (undated > 0) parts.push(`${undated} to date`);
    } else {
      parts.push("Nothing imported yet");
    }
  }

  return (
    <div className="space-y-2">
      {spineNav}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 text-xs text-muted">{parts.join(" · ")}</span>
        <div className="flex flex-none items-center gap-2">
          {data && (
            <button
              type="button"
              onClick={() => navigate(data.next_action.href)}
              className="inline-flex items-center gap-1.5 rounded-full bg-ink px-3 py-1 text-xs font-semibold text-cream transition hover:bg-green"
            >
              {data.done ? "You're ready — open File to hand off" : data.next_action.label}
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M6 3l5 5-5 5" />
              </svg>
            </button>
          )}
          <TabGuide pathname={pathname} />
        </div>
      </div>
    </div>
  );
}
