import { useEffect } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { UserButton } from "@clerk/clerk-react";
import { useQuery } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { api } from "./api";

const NAV = [
  { to: "/", label: "Inbox", end: true },
  { to: "/dashboard", label: "Dashboard" },
  { to: "/income", label: "Income" },
  { to: "/assets", label: "Assets" },
  { to: "/documents", label: "Documents" },
  { to: "/accounts", label: "Accounts" },
  { to: "/reconcile", label: "Reconcile" },
  { to: "/reports", label: "Reports" },
  { to: "/filing", label: "File" },
  { to: "/notifications", label: "Alerts" },
  { to: "/quickbooks", label: "QuickBooks" },
  { to: "/settings", label: "Settings" },
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
  return (
    <div className="min-h-screen bg-paper">
      <FirstRunGate />
      <Toaster position="bottom-right" richColors closeButton toastOptions={{ duration: 6000 }} />
      <header className="sticky top-0 z-10 border-b border-line bg-paper/80 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center gap-4 px-6 py-3">
          <Link to="/" className="flex flex-none items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-ink text-sm font-bold text-white">Q</span>
            <span className="text-base font-semibold tracking-tight">Quillo</span>
          </Link>
          <nav className="flex flex-1 items-center gap-1 overflow-x-auto text-sm">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  `whitespace-nowrap rounded-lg px-2.5 py-1.5 ${isActive ? "bg-ink text-white" : "text-muted hover:text-ink"}`
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="flex-none">
            <UserButton afterSignOutUrl="/sign-in" />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-6 py-10">
        <Outlet />
      </main>
      <footer className="mx-auto max-w-4xl px-6 pb-10 pt-4 text-xs leading-relaxed text-muted">
        General information only — not tax advice. Quillo is not a registered tax or BAS agent,
        does not lodge returns, and never holds or moves your money. Confirm your situation with a
        registered tax/BAS agent.{" "}
        <Link to="/onboarding" className="text-ink underline underline-offset-2">
          Setup
        </Link>
        {" · "}
        <a href="mailto:hello@quillo.au?subject=Quillo%20support" className="text-ink underline underline-offset-2">
          Contact support
        </a>
      </footer>
    </div>
  );
}
