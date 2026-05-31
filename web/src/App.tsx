import { Link, NavLink, Outlet } from "react-router-dom";

const NAV = [
  { to: "/", label: "Inbox", end: true },
  { to: "/dashboard", label: "Dashboard" },
  { to: "/reports", label: "Reports" },
  { to: "/notifications", label: "Alerts" },
  { to: "/quickbooks", label: "QuickBooks" },
  { to: "/settings", label: "Settings" },
];

export function App() {
  return (
    <div className="min-h-screen bg-surface">
      <header className="sticky top-0 z-10 border-b border-line bg-white/85 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center gap-4 px-5 py-3">
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
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-5 py-8">
        <Outlet />
      </main>
      <footer className="mx-auto max-w-4xl px-5 pb-10 pt-4 text-xs text-muted">
        General information only — not tax advice. Confirm with a registered tax/BAS agent.{" "}
        <Link to="/onboarding" className="text-accent">
          Setup
        </Link>
      </footer>
    </div>
  );
}
