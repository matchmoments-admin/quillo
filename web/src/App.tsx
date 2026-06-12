import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { UserButton } from "@clerk/clerk-react";
import { useQuery } from "@tanstack/react-query";
import { Toaster } from "sonner";
import * as Tooltip from "@radix-ui/react-tooltip";
import { api } from "./api";
import { useFeatures, useAdminAccess, usePartnerAccess } from "./lib/features";
import { FySwitcher, useActiveFy } from "./lib/activeFy";
import { NextActionBar } from "./components/NextAction";
import { TabGuide } from "./components/TabGuide";
import { Coachmarks } from "./components/Coachmarks";
import { ChatProvider } from "./components/chat/ChatProvider";
import { FloatingChat } from "./components/chat/FloatingChat";

type NavItem = { to: string; label: string; icon: IconName; end?: boolean; badge?: boolean; flag?: string; admin?: boolean; partner?: boolean };
type NavGroup = { label: string; items: NavItem[] };

// Grouped destinations — the forest sidebar, ordered as the six-stop work spine
// (Set up → Bring in → Sort → Check → Position → File) so the nav reads top-to-bottom
// in the order you actually do the job. The numbered labels are ORIENTATION, not locks:
// every route stays freely clickable and tax work is iterative (import more, re-run books,
// re-reconcile). "Bring in" lives on the Accounts page (add an account + upload its
// statement together), surfaced as the active CTA by NextActionBar rather than a duplicate
// route. See memory: simplification-plan (six-stop happy path, 2026-06-07).
const GROUPS: NavGroup[] = [
  // Dashboard is the home/landing tab (the default route "/"), sitting at the very top under the logo.
  {
    label: "",
    items: [{ to: "/", label: "Dashboard", icon: "grid", end: true }],
  },
  {
    label: "1 · Set up",
    items: [
      // Accounts is where you add accounts AND bring in statements/CSVs (the "Bring in" stop).
      { to: "/accounts", label: "Accounts & import", icon: "card" },
      { to: "/income", label: "Income", icon: "income" },
      { to: "/assets", label: "Assets", icon: "shield" },
      { to: "/documents", label: "Documents", icon: "doc" },
    ],
  },
  {
    label: "2 · Sort",
    items: [
      { to: "/inbox", label: "Inbox", icon: "inbox", badge: true },
      { to: "/transactions", label: "Transactions", icon: "list" },
    ],
  },
  {
    label: "3 · Check",
    items: [
      { to: "/reconcile", label: "Reconcile", icon: "swap" },
      { to: "/review", label: "Review", icon: "check", flag: "deductibility_review" },
    ],
  },
  {
    label: "4 · Position",
    items: [
      { to: "/reports", label: "Reports", icon: "bars" },
    ],
  },
  {
    label: "5 · Save",
    items: [{ to: "/savings", label: "Savings", icon: "income", flag: "advisory_layer" }],
  },
  {
    label: "6 · File",
    items: [{ to: "/filing", label: "File", icon: "file" }],
  },
  {
    label: "Connections",
    items: [
      { to: "/quickbooks", label: "QuickBooks", icon: "check" },
      { to: "/notifications", label: "Alerts", icon: "bell" },
    ],
  },
  {
    label: "Partner",
    items: [{ to: "/partner", label: "Partner portal", icon: "income", partner: true }],
  },
  {
    label: "Platform",
    items: [{ to: "/admin", label: "Admin", icon: "gear", admin: true }],
  },
];

// First-run gate: a brand-new tenant (no consent AND no entities) is sent to the onboarding
// wizard once. We don't redirect once either is satisfied, so users can always navigate away.
// Reuses the shared ["situation"] query (no extra fetch).
function FirstRunGate() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const sit = useQuery({ queryKey: ["situation"], queryFn: () => api.situation() });
  useEffect(() => {
    if (sit.isLoading || !sit.data || pathname === "/onboarding") return;
    const p = sit.data;
    const hasConsent = (p.profile?.consent_xborder ?? 0) === 1 || p.profile?.inference_provider === "bedrock";
    const hasEntities = (p.entities?.length ?? 0) > 0;
    if (!hasConsent && !hasEntities) navigate("/onboarding", { replace: true });
  }, [sit.isLoading, sit.data, pathname, navigate]);
  return null;
}

export function App() {
  const [drawer, setDrawer] = useState(false);
  const { pathname } = useLocation();
  // Inbox review badge — reuses the shared ["dashboard", fy] query (the Dashboard page + feature
  // hooks use the same key, so this is one cache entry / one fetch per FY). `needs_review` itself is
  // all-time (a cross-year backlog that matches the Inbox), so the badge value doesn't change with
  // the FY — we key on fy only to share the page's fetch. App is the persistent layout, so this
  // fetches once per FY (not per navigation); a staleTime keeps focus-refetch from re-polling the DO
  // (the /api/dashboard handler does a pollBatchJobs round-trip) just to refresh a badge number.
  const { fy } = useActiveFy();
  const dash = useQuery({ queryKey: ["dashboard", fy], queryFn: () => api.dashboard(fy), staleTime: 60_000 });
  const needsReview = dash.data?.needs_review ?? 0;

  // Close the mobile drawer on navigation.
  useEffect(() => setDrawer(false), [pathname]);

  return (
    <Tooltip.Provider delayDuration={200} skipDelayDuration={400}>
    <ChatProvider>
    <div className="min-h-screen bg-paper text-ink">
      <div className="grain" aria-hidden />
      <FirstRunGate />
      <Coachmarks pathname={pathname} />
      <Toaster position="bottom-right" richColors closeButton toastOptions={{ duration: 6000 }} />
      {/* Floating "Ask Quillo" bubble — self-gates on the `floating_chat` flag (renders nothing when
          off, so this is byte-identical until enabled). Portals to document.body and persists across
          route changes because App is the durable layout that never unmounts. */}
      <FloatingChat />

      {/* Mobile top bar */}
      <div className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-paper/90 px-4 py-3 backdrop-blur lg:hidden">
        <button
          type="button"
          onClick={() => setDrawer(true)}
          aria-label="Open menu"
          className="grid h-9 w-9 place-items-center rounded-xl border border-ink/15 text-forest"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M3 5h12M3 9h12M3 13h12" />
          </svg>
        </button>
        <Brand />
        <span className="flex-1" />
        <UserButton afterSignOutUrl="/sign-in" />
      </div>

      <div className="lg:grid lg:grid-cols-[252px_1fr]">
        {/* Backdrop for the mobile drawer */}
        {drawer && (
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setDrawer(false)}
            className="fixed inset-0 z-40 bg-forest/40 lg:hidden"
          />
        )}
        <Sidebar needsReview={needsReview} open={drawer} />

        <div className="flex min-h-screen flex-col">
          <main className="flex-1">
            <div className="mx-auto max-w-5xl px-5 py-8 sm:px-8">
              {/* Clarity spine + per-tab guide — hidden on the full-screen onboarding wizard. */}
              {pathname !== "/onboarding" && (
                <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <NextActionBar />
                  </div>
                  <div className="flex flex-none items-center gap-3">
                    <FySwitcher />
                    <TabGuide pathname={pathname} />
                  </div>
                </div>
              )}
              <Outlet />
            </div>
          </main>
          <footer className="mx-auto max-w-5xl px-5 pb-10 pt-4 text-xs leading-relaxed text-muted sm:px-8">
            General information only — not tax advice. Quillo is not a registered tax or BAS agent,
            does not lodge returns, and never holds or moves your money. Confirm your situation with a
            registered tax/BAS agent.{" "}
            <Link to="/onboarding" className="text-ink underline underline-offset-2">
              Setup
            </Link>
            {" · "}
            <Link to="/glossary" className="text-ink underline underline-offset-2">
              Glossary
            </Link>
            {" · "}
            <a href="mailto:hello@quillo.au?subject=Quillo%20support" className="text-ink underline underline-offset-2">
              Contact support
            </a>
          </footer>
        </div>
      </div>
    </div>
    </ChatProvider>
    </Tooltip.Provider>
  );
}

function Brand() {
  return (
    <Link to="/" className="flex flex-none items-center gap-2.5">
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-sage font-display text-lg text-forest">Q</span>
      <span className="font-display text-xl tracking-wide text-forest">
        Quillo<span className="text-green">.</span>
      </span>
    </Link>
  );
}

function Sidebar({ needsReview, open }: { needsReview: number; open: boolean }) {
  const { has } = useFeatures();
  const { isAdmin } = useAdminAccess();
  const { isPartner } = usePartnerAccess();
  return (
    <aside
      className={`fixed inset-y-0 left-0 z-50 flex w-[252px] flex-col bg-forest px-4 py-5 text-cream transition-transform lg:sticky lg:top-0 lg:z-auto lg:h-screen lg:translate-x-0 ${
        open ? "translate-x-0" : "-translate-x-full"
      }`}
    >
      <div className="flex items-center gap-2.5 px-2 pb-5">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-sage font-display text-lg text-forest">Q</span>
        <span className="font-display text-xl tracking-wide text-cream">
          Quillo<span className="text-sage">.</span>
        </span>
      </div>

      <nav className="-mx-1 flex-1 overflow-y-auto px-1">
        {GROUPS.map((g) => {
          const items = g.items.filter((it) => (!it.flag || has(it.flag)) && (!it.admin || isAdmin) && (!it.partner || isPartner));
          if (!items.length) return null; // hide a group whose every item is gated off (e.g. Platform for non-admins)
          return (
          <div key={g.label || "home"} className="mt-5 first:mt-1">
            {g.label && <div className="px-3 pb-2 text-[10px] font-bold uppercase tracking-[0.2em] text-cream/45">{g.label}</div>}
            {items.map((it) => (
              <NavLink
                key={it.to}
                to={it.to}
                end={it.end}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition ${
                    isActive ? "bg-sage text-forest" : "text-cream/70 hover:bg-cream/10 hover:text-cream"
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon name={it.icon} />
                    <span>{it.label}</span>
                    {it.badge && needsReview > 0 && (
                      <span
                        className={`ml-auto rounded-full px-2 py-0.5 text-[11px] font-bold tnum ${
                          isActive ? "bg-forest text-sage" : "bg-green text-cream"
                        }`}
                      >
                        {needsReview}
                      </span>
                    )}
                  </>
                )}
              </NavLink>
            ))}
          </div>
          );
        })}
      </nav>

      <div className="mt-4 border-t border-cream/15 pt-3">
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition ${
              isActive ? "bg-sage text-forest" : "text-cream/70 hover:bg-cream/10 hover:text-cream"
            }`
          }
        >
          <Icon name="gear" />
          <span>Settings</span>
        </NavLink>
        <div className="mt-1 flex items-center gap-3 rounded-xl px-2 py-2">
          <UserButton afterSignOutUrl="/sign-in" />
          <span className="text-[11px] text-cream/55">Account &amp; sign out</span>
        </div>
      </div>
    </aside>
  );
}

type IconName =
  | "grid"
  | "inbox"
  | "list"
  | "income"
  | "shield"
  | "doc"
  | "card"
  | "swap"
  | "bars"
  | "file"
  | "check"
  | "bell"
  | "gear";

function Icon({ name }: { name: IconName }) {
  const p: Record<IconName, ReactNode> = {
    grid: (
      <>
        <rect x="2.5" y="2.5" width="5.5" height="5.5" rx="1.2" />
        <rect x="10" y="2.5" width="5.5" height="5.5" rx="1.2" />
        <rect x="2.5" y="10" width="5.5" height="5.5" rx="1.2" />
        <rect x="10" y="10" width="5.5" height="5.5" rx="1.2" />
      </>
    ),
    inbox: (
      <>
        <path d="M2.5 5.5l6.5 4 6.5-4" />
        <rect x="2.5" y="3.5" width="13" height="11" rx="1.6" />
      </>
    ),
    list: (
      <>
        <path d="M6 4.5h9M6 9h9M6 13.5h9" />
        <path d="M3 4.5h.01M3 9h.01M3 13.5h.01" />
      </>
    ),
    income: <path d="M9 2.5v13M5.5 6h5a2 2 0 010 4h-3a2 2 0 000 4h5" />,
    shield: <path d="M9 2l6 3v4c0 3.5-2.5 6-6 7-3.5-1-6-3.5-6-7V5l6-3z" />,
    doc: (
      <>
        <path d="M4 2.5h6l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1v-12a1 1 0 011-1z" />
        <path d="M10 2.5V6h4" />
      </>
    ),
    card: (
      <>
        <rect x="2.5" y="4" width="13" height="10" rx="1.6" />
        <path d="M2.5 7.5h13" />
      </>
    ),
    swap: <path d="M3 6.5h9M9.5 3.5l3 3-3 3M15 11.5H6M8.5 8.5l-3 3 3 3" />,
    bars: <path d="M4 14.5v-5M9 14.5v-9M14 14.5v-3" />,
    file: (
      <>
        <path d="M4 2.5h7l3.5 3.5V15a.5.5 0 01-.5.5H4a.5.5 0 01-.5-.5v-12A.5.5 0 014 2.5z" />
        <path d="M6.5 9h5M6.5 11.5h5" />
      </>
    ),
    check: (
      <>
        <rect x="2.5" y="2.5" width="13" height="13" rx="2.5" />
        <path d="M6 9.5l2 2 4-4.5" />
      </>
    ),
    bell: (
      <>
        <path d="M9 2.5a4 4 0 014 4c0 4 1.5 5 1.5 5h-11s1.5-1 1.5-5a4 4 0 014-4z" />
        <path d="M7.5 14.5a1.6 1.6 0 003 0" />
      </>
    ),
    gear: (
      <>
        <circle cx="9" cy="9" r="2.5" />
        <path d="M9 1.5v2M9 14.5v2M16.5 9h-2M3.5 9h-2M14.3 3.7l-1.4 1.4M5.1 12.9l-1.4 1.4M14.3 14.3l-1.4-1.4M5.1 5.1L3.7 3.7" />
      </>
    ),
  };
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      className="flex-none opacity-90"
    >
      {p[name]}
    </svg>
  );
}
