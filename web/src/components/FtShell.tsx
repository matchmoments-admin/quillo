import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { UserButton } from "@clerk/clerk-react";
import { Toaster } from "sonner";
import * as Tooltip from "@radix-ui/react-tooltip";
import { useFeatures, useAdminAccess } from "../lib/features";
import { FySwitcher } from "../lib/activeFy";
import { JOURNEY_STEP_KEYS, STATUS_LABEL, STEP_LABEL, STEP_ROUTE, stepForPath, useJourney } from "../lib/journey";
import { GROW_LABEL, GROW_ROUTE, useSetGrowLayer } from "../lib/grow";
import type { JourneyStepKey, JourneyStepStatus } from "../types";
import { ChatProvider } from "./chat/ChatProvider";
import { WhySheet, cx, FOCUS, TAP } from "./ft";

// The first-timer app shell (spec A11 "Shell", #582; flag ft_journey). App.tsx renders this instead of
// the legacy sidebar + JourneySpine when the flag is ON, so OFF never reaches this file.
//   • md and up: a left rail — Home, the six numbered steps with a status dot, then the account menu
//     (year switcher, Billing, Alerts, Learn & glossary, Settings, Appearance, sign out; Partner/Admin
//     keep their role gating). Then the Grow group (A11 ticket b, #592): only the layers that are visible
//     (switched on, a detection the user said Yes to, or data already there). The account menu carries the
//     Grow switcher. Advisers (the Partner portal) is a Grow layer, so it moved out of the account menu.
//   • below md: a bottom bar of four — Home, Steps (sheet of the six with status), Ask (the Why?
//     sheet for the current step), Account (sheet with the account menu). The step header with its
//     progress segments sits at the top of each step page (StepPage), not in the shell.
// Step status comes from the one shared /api/journey query (useJourney), which Home reads too.

const DOT: Record<JourneyStepStatus, string> = {
  not_started: "border border-line-strong bg-transparent",
  in_progress: "bg-accent/50",
  needs_attention: "bg-warn",
  done: "bg-ok",
};

function StatusDot({ status }: { status: JourneyStepStatus | undefined }) {
  return (
    <span
      aria-hidden
      className={cx("inline-block h-2.5 w-2.5 flex-none rounded-full", status ? DOT[status] : "border border-line bg-transparent")}
    />
  );
}

const railLink = (isActive: boolean) =>
  cx(
    "flex items-center gap-3 rounded-lg px-3 text-sm font-semibold",
    TAP,
    FOCUS,
    isActive ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface hover:text-ink",
  );

/** The four steps with their status — the rail on desktop, the Steps sheet on a phone. */
function StepList({ onPick }: { onPick?: () => void }) {
  const journey = useJourney();
  const byKey = new Map<JourneyStepKey, { status: JourneyStepStatus; count: number }>(
    (journey.data?.steps ?? []).map((s) => [s.key, { status: s.status, count: s.count }]),
  );
  return (
    <ol className="space-y-0.5">
      {JOURNEY_STEP_KEYS.map((k, i) => {
        const s = byKey.get(k);
        return (
          <li key={k}>
            <NavLink to={STEP_ROUTE[k]} onClick={onPick} className={({ isActive }) => railLink(isActive)}>
              <span className="w-4 flex-none text-right font-mono text-xs text-muted">{i + 1}</span>
              <span className="flex-1">{STEP_LABEL[k]}</span>
              <StatusDot status={s?.status} />
              <span className="sr-only">{s ? STATUS_LABEL[s.status] : "Status loading"}</span>
            </NavLink>
          </li>
        );
      })}
    </ol>
  );
}

/** The visible Grow layers (A11b, #592) — under the steps in the rail and the Steps sheet. Nothing when none. */
function GrowList({ onPick }: { onPick?: () => void }) {
  const journey = useJourney();
  const visible = (journey.data?.grow.layers ?? []).filter((l) => l.state === "on");
  if (visible.length === 0) return null;
  return (
    <div className="mt-4">
      <div className="px-3 pb-1 text-[10px] font-bold uppercase tracking-[0.2em] text-muted">Grow</div>
      <ul className="space-y-0.5">
        {visible.map((l) => (
          <li key={l.key}>
            <NavLink to={GROW_ROUTE[l.key]} onClick={onPick} className={({ isActive }) => railLink(isActive)}>
              {GROW_LABEL[l.key]}
            </NavLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The Grow switcher (account menu): turn a layer on or off. A layer that already holds the user's entries is
 * locked on (nobody loses sight of their own records); Advisers is role-gated and never listed here.
 */
function GrowSwitcher() {
  const journey = useJourney();
  const set = useSetGrowLayer();
  const [open, setOpen] = useState(false);
  const layers = (journey.data?.grow.layers ?? []).filter((l) => l.switchable);
  if (layers.length === 0) return null;
  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className={cx(railLink(false), "w-full justify-between")}>
        <span>Grow layers</span>
        <span aria-hidden className="text-xs">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <ul className="space-y-0.5 pb-1 pl-3">
          {layers.map((l) => {
            const on = l.state === "on";
            return (
              <li key={l.key}>
                <label className={cx("flex cursor-pointer items-center gap-3 rounded-lg px-3 text-sm text-ink", TAP, l.has_data && "cursor-default")}>
                  <input
                    type="checkbox"
                    className={cx("h-4 w-4 accent-accent", FOCUS)}
                    checked={on}
                    disabled={l.has_data || set.isPending}
                    onChange={() => set.mutate({ layer: l.key, state: on ? "off" : "on", source: "switched" })}
                  />
                  <span className="flex-1">{GROW_LABEL[l.key]}</span>
                  {l.has_data && <span className="text-[11px] text-muted">has your entries</span>}
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Account menu items (spec A11: Billing, Alerts, Learn & glossary, year switcher, Settings, sign out). */
function AccountMenu({ onPick }: { onPick?: () => void }) {
  const { has } = useFeatures();
  const { isAdmin } = useAdminAccess();
  const items: { to: string; label: string; show: boolean }[] = [
    { to: "/billing", label: "Billing", show: has("billing") },
    { to: "/notifications", label: "Alerts", show: true },
    { to: "/glossary", label: "Learn & glossary", show: true },
    { to: "/settings", label: "Settings", show: true },
    { to: "/admin", label: "Admin", show: isAdmin },
  ];
  return (
    <div className="space-y-1">
      <div className="px-3 py-1">
        <FySwitcher />
      </div>
      {items
        .filter((it) => it.show)
        .map((it) => (
          <NavLink key={it.to} to={it.to} onClick={onPick} className={({ isActive }) => railLink(isActive)}>
            {it.label}
          </NavLink>
        ))}
      <GrowSwitcher />
      <div className="flex items-center gap-3 px-3 py-2">
        <UserButton afterSignOutUrl="/sign-in" />
        <span className="text-xs text-muted">Account &amp; sign out</span>
      </div>
    </div>
  );
}

function Brand() {
  return (
    <Link to="/" className={cx("flex flex-none items-center gap-2.5 rounded-lg", FOCUS)}>
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-accent-soft font-display text-lg text-accent">Q</span>
      <span className="font-display text-xl tracking-wide text-ink">Quillo</span>
    </Link>
  );
}

type Sheet = "steps" | "ask" | "account" | null;

function BarButton({ label, onClick, active, children }: { label: string; onClick: () => void; active?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      className={cx("flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-semibold", TAP, FOCUS, active ? "text-accent" : "text-muted")}
    >
      {children}
      <span>{label}</span>
    </button>
  );
}

const Glyph = ({ d }: { d: string }) => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
    <path d={d} />
  </svg>
);

export function FtShell({ gate }: { gate?: ReactNode }) {
  const { pathname } = useLocation();
  const [sheet, setSheet] = useState<Sheet>(null);
  // Close any open sheet on navigation.
  useEffect(() => setSheet(null), [pathname]);
  const here = stepForPath(pathname);
  const close = () => setSheet(null);

  return (
    <Tooltip.Provider delayDuration={200} skipDelayDuration={400}>
      <ChatProvider>
        <div className="min-h-screen bg-paper text-ink">
          {gate}
          <Toaster
            position="bottom-right"
            richColors
            closeButton
            toastOptions={{ duration: 6000 }}
            offset={{ bottom: "var(--tabbar-clearance)" }}
            mobileOffset={{ bottom: "var(--tabbar-clearance)" }}
          />

          {/* Phone top bar: brand only — navigation lives in the bottom bar. */}
          <div className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-paper/90 px-4 py-2 backdrop-blur print:hidden md:hidden">
            <Brand />
          </div>

          <div className="md:grid md:grid-cols-[240px_1fr] print:block">
            <aside className="sticky top-0 hidden h-screen flex-col border-r border-line bg-card px-3 py-5 md:flex print:hidden" aria-label="Journey">
              <div className="px-2 pb-5">
                <Brand />
              </div>
              <nav className="-mx-1 flex-1 overflow-y-auto px-1" aria-label="Steps">
                <NavLink to="/" end className={({ isActive }) => railLink(isActive)}>
                  Home
                </NavLink>
                <div className="mt-4 px-3 pb-1 text-[10px] font-bold uppercase tracking-[0.2em] text-muted">Your return</div>
                <StepList />
                <GrowList />
              </nav>
              <div className="mt-4 border-t border-line pt-3">
                <AccountMenu />
              </div>
            </aside>

            <div className="flex min-h-screen flex-col">
              <main className="flex-1 pb-[calc(var(--tabbar-h)_+_var(--safe-b))] md:pb-0">
                <div className="mx-auto max-w-5xl px-4 py-6 sm:px-8 sm:py-8">
                  <Outlet />
                </div>
              </main>
              <footer className="mx-auto max-w-5xl px-4 pb-10 pt-4 text-xs leading-relaxed text-muted sm:px-8">
                General information only, not tax advice. Quillo is not a registered tax or BAS agent, does not
                lodge returns, and never holds or moves your money. If you're unsure, confirm with a registered
                tax agent.
              </footer>
            </div>
          </div>

          {/* Phone bottom bar of four (spec A11). */}
          <nav
            className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-paper/95 pb-[var(--safe-b)] backdrop-blur print:hidden md:hidden"
            aria-label="Primary"
          >
            <NavLink
              to="/"
              end
              className={({ isActive }) => cx("flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-semibold", TAP, FOCUS, isActive ? "text-accent" : "text-muted")}
            >
              <Glyph d="M3 8.5L9 3l6 5.5V15H3z" />
              <span>Home</span>
            </NavLink>
            <BarButton label="Steps" onClick={() => setSheet("steps")} active={here !== "home"}>
              <Glyph d="M6 4.5h9M6 9h9M6 13.5h9M3 4.5h.01M3 9h.01M3 13.5h.01" />
            </BarButton>
            <BarButton label="Ask" onClick={() => setSheet("ask")}>
              <Glyph d="M9 15.5a6.5 6.5 0 110-13 6.5 6.5 0 010 13zM7 7a2 2 0 113 1.7c-.6.4-1 .8-1 1.5M9 12.5h.01" />
            </BarButton>
            <BarButton label="Account" onClick={() => setSheet("account")}>
              <Glyph d="M9 9a3 3 0 100-6 3 3 0 000 6zM3.5 15.5a5.5 5.5 0 0111 0" />
            </BarButton>
          </nav>

          <WhySheet open={sheet === "steps"} onClose={close} title="Steps">
            <StepList onPick={close} />
            <GrowList onPick={close} />
          </WhySheet>
          {/* Ask = the Why? explainer for wherever you are (Home has a guide too). */}
          <WhySheet open={sheet === "ask"} onClose={close} step={here} />
          <WhySheet open={sheet === "account"} onClose={close} title="Account">
            <AccountMenu onPick={close} />
          </WhySheet>
        </div>
      </ChatProvider>
    </Tooltip.Provider>
  );
}
