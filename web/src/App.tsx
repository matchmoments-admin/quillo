import { Link, Outlet, useLocation } from "react-router-dom";

export function App() {
  const { pathname } = useLocation();
  return (
    <div className="min-h-screen bg-surface">
      <header className="border-b border-line bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-4">
          <Link to="/" className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-ink text-sm font-bold text-white">T</span>
            <span className="text-base font-semibold tracking-tight">Tax Agent</span>
          </Link>
          <nav className="text-sm text-muted">
            {pathname !== "/" ? (
              <Link to="/" className="hover:text-ink">
                ← Inbox
              </Link>
            ) : (
              <span className="text-ink">Review inbox</span>
            )}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-5 py-8">
        <Outlet />
      </main>
      <footer className="mx-auto max-w-3xl px-5 pb-10 pt-4 text-xs text-muted">
        General information only — not tax advice. Confirm with a registered tax/BAS agent.
      </footer>
    </div>
  );
}
