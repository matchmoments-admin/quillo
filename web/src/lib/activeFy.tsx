import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

/** AU FY start year for "today" (Jul–Jun). e.g. Mar 2026 → 2025 (FY 2025-26). */
export function currentFyStart(): number {
  const now = new Date();
  return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
}
export const fyLabel = (start: number): string => `${start}-${String((start + 1) % 100).padStart(2, "0")}`;

function parseStored(uiState?: string | null): number | null {
  if (!uiState) return null;
  try {
    const v = (JSON.parse(uiState) as { active_fy?: unknown }).active_fy;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

type ActiveFy = { fy: number; label: string; setFy: (next: number | ((prev: number) => number)) => void };
const ActiveFyCtx = createContext<ActiveFy>({ fy: currentFyStart(), label: fyLabel(currentFyStart()), setFy: () => {} });

/**
 * One source of truth for the "active financial year" across the app, persisted per tenant in
 * profiles.ui_state.active_fy. Checklist, Reports and Filing all read this — set 2024-25 once and
 * the whole app follows. Changing it just updates state (consumers key their queries on fy, so they
 * auto-refetch) + fire-and-forget persists to ui_state.
 */
export function ActiveFyProvider({ children }: { children: ReactNode }) {
  const sit = useQuery({ queryKey: ["situation"], queryFn: () => api.situation() });
  const [fy, setFyState] = useState<number | null>(null);
  // Seed from the persisted value once the profile loads (only if the user hasn't already changed it).
  useEffect(() => {
    if (fy === null && sit.data) setFyState(parseStored(sit.data.profile?.ui_state) ?? currentFyStart());
  }, [sit.data, fy]);
  const effFy = fy ?? currentFyStart();
  const setFy: ActiveFy["setFy"] = (next) => {
    const y = typeof next === "function" ? next(effFy) : next;
    setFyState(y);
    api.setUiState({ active_fy: y }).catch(() => {}); // best-effort persist; UI is already updated
  };
  return <ActiveFyCtx.Provider value={{ fy: effFy, label: fyLabel(effFy), setFy }}>{children}</ActiveFyCtx.Provider>;
}

export const useActiveFy = (): ActiveFy => useContext(ActiveFyCtx);

/** Compact global FY stepper (← FY 2024-25 →) — the app-wide active-year control. */
export function FySwitcher() {
  const { label, setFy } = useActiveFy();
  return (
    <div className="inline-flex items-center gap-1.5 text-sm text-ink-2">
      <button className="rounded-lg border border-line px-2 py-0.5 hover:border-ink/40" onClick={() => setFy((y) => y - 1)} aria-label="Previous financial year">←</button>
      <span className="tabular-nums font-medium text-ink">FY {label}</span>
      <button className="rounded-lg border border-line px-2 py-0.5 hover:border-ink/40" onClick={() => setFy((y) => y + 1)} aria-label="Next financial year">→</button>
    </div>
  );
}
