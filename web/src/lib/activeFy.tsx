import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { setMoneyCurrency } from "../components/ui";

/**
 * FY start year for "today". The period defaults to AU (Jul 1) so existing call sites are byte-identical;
 * the ActiveFyProvider passes the tenant's server-resolved period so a UK tenant (Apr 6) defaults to the
 * right FY. e.g. AU Mar 2026 → 2025; UK Mar 2026 → 2025; UK May 2026 → 2026.
 */
export function currentFyStart(period: { start_month: number; start_day: number } = { start_month: 7, start_day: 1 }): number {
  const now = new Date();
  const mo = now.getMonth() + 1;
  const day = now.getDate();
  const onOrAfter = mo > period.start_month || (mo === period.start_month && day >= period.start_day);
  return onOrAfter ? now.getFullYear() : now.getFullYear() - 1;
}
// The straddle FY label is jurisdiction-invariant (UK Apr 2025–Apr 2026 is also '2025-26').
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
  // The default FY follows the tenant's tax period (server-resolved), so a UK tenant defaults to Apr 6–5.
  // Seed order: stored ui_state.active_fy → situation.lodging_fy (#572, the year being lodged; present only with
  // situation_profile ON) → the current FY. Flag OFF ⇒ lodging_fy absent ⇒ the seed is unchanged.
  useEffect(() => {
    if (fy === null && sit.data) setFyState(parseStored(sit.data.profile?.ui_state) ?? sit.data.lodging_fy ?? currentFyStart(sit.data.tax_period));
  }, [sit.data, fy]);
  // Stop 2: set the session's base currency once from the server (drives money()'s symbol + locale). AU
  // tenant ⇒ 'AUD' ⇒ '$'/'en-AU' (byte-identical). Absent (old/cached situation) ⇒ setMoneyCurrency no-ops.
  useEffect(() => {
    if (sit.data?.base_currency) setMoneyCurrency(sit.data.base_currency);
  }, [sit.data?.base_currency]);
  const effFy = fy ?? sit.data?.lodging_fy ?? currentFyStart(sit.data?.tax_period);
  const setFy: ActiveFy["setFy"] = (next) => {
    const y = typeof next === "function" ? next(effFy) : next;
    setFyState(y);
    api.setUiState({ active_fy: y }).catch(() => {}); // best-effort persist; UI is already updated
  };
  return <ActiveFyCtx.Provider value={{ fy: effFy, label: fyLabel(effFy), setFy }}>{children}</ActiveFyCtx.Provider>;
}

export const useActiveFy = (): ActiveFy => useContext(ActiveFyCtx);

/**
 * #572 (situation_profile): mark a year as lodged / undo it, then move the app to the new default year (the
 * server returns lodging_fy) and persist it, so the move survives a reload. The Ship it UI (A9, #590) calls this.
 * Throws the server's plain-message error (400 bad date / year) for the caller to show inline.
 */
export function useLodgedMark() {
  const qc = useQueryClient();
  const { setFy } = useActiveFy();
  const after = (lodgingFy: number) => {
    setFy(lodgingFy);
    qc.invalidateQueries({ queryKey: ["situation"] });
    qc.invalidateQueries({ queryKey: ["fy-signoff"] });
    qc.invalidateQueries({ queryKey: ["fy-lodged"] });
  };
  return {
    mark: async (fy: number, lodgedOn?: string) => {
      const r = await api.markLodged(fy, lodgedOn);
      after(r.lodging_fy);
      return r.lodged;
    },
    undo: async (fy: number) => {
      const r = await api.unmarkLodged(fy);
      after(r.lodging_fy);
    },
  };
}

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
