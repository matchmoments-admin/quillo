import { useEffect, type ReactNode } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { Card } from "../components/ui";
import { useFeatures, usePartnerAccess } from "./features";
import { setGlossaryQboRetired } from "../content/glossary";
import type { GrowLayerKey } from "../types";

// #697 cut list (design audit docs/ux/design-audit-2026-10.md): surfaces hidden behind one `hide_*` flag each.
// Hiding is UI-only — the engines, APIs and tables stay — so every helper here renders today's output while
// its flag is OFF (or while the flag set is still loading), and only redirects or hides once it is ON.

/**
 * A route a cut retires. OFF (or loading) ⇒ the page as today. ON ⇒ a direct link lands on `to`, unless
 * `allow` says this user keeps access (true) or that is still being checked (null ⇒ render nothing yet).
 */
export function CutRoute({ flag, to, allow, children }: { flag: string; to: string; allow?: boolean | null; children: ReactNode }) {
  const { has, loaded } = useFeatures();
  if (!loaded || !has(flag) || allow === true) return <>{children}</>;
  if (allow === null) return null;
  return <Navigate to={to} replace />;
}

/**
 * hide_quickbooks_nav: whether this user has a QuickBooks connection (a live one, or one whose authorisation
 * expired and needs a reconnect). null while checking. Shares the QuickBooks page's ["qbo-status"] query and
 * only runs while the flag is ON, so flag-OFF makes no extra request.
 */
export function useQboLinked(): boolean | null {
  const { has } = useFeatures();
  const on = has("hide_quickbooks_nav");
  const retired = has("qbo_retired");
  const q = useQuery({ queryKey: ["qbo-status"], queryFn: () => api.qboStatus(), enabled: on && !retired });
  if (retired) return false; // qbo_retired: hidden for everyone, connected or not, and no /api/qbo request
  if (!on) return true;
  if (q.isLoading) return null;
  if (q.isError) return false;
  return !!(q.data?.connected || q.data?.needs_reconnect);
}

/** /quickbooks: a user who never connected QBO goes to Accounts (statement import); a connected one keeps it. */
export function QuickBooksRoute({ children }: { children: ReactNode }) {
  const linked = useQboLinked();
  const [params] = useSearchParams();
  // Coming back from Intuit's OAuth (?connected=1|0) always shows the page, so the result is never swallowed.
  const returning = params.has("connected");
  // qbo_retired (map #692): QuickBooks is gone for everyone, so the page always lands on Accounts.
  return (
    <CutRoute flag="qbo_retired" to="/accounts">
      <CutRoute flag="hide_quickbooks_nav" to="/accounts" allow={returning || linked}>
        {children}
      </CutRoute>
    </CutRoute>
  );
}

/**
 * qbo_retired (map #692, owner 2026-10-24): QuickBooks connect isn't needed now, so every QuickBooks surface
 * is hidden for everyone, including a user who has connected it (their stored tokens and data are kept).
 * OFF (or while the flag set loads) ⇒ false, so each surface renders as before.
 */
export function useQboRetired(): boolean {
  const { has } = useFeatures();
  return has("qbo_retired");
}

/** Keeps the glossary's QuickBooks-free tips in step with the flag (call once from the app shell). */
export function useQboRetiredGlossarySync(): void {
  const retired = useQboRetired();
  useEffect(() => setGlossaryQboRetired(retired), [retired]);
}

/** /partner (the referral portal): a non-partner is sent Home instead of reading a bare "Not available.". */
export function PartnerRoute({ children }: { children: ReactNode }) {
  const { isPartner, loaded } = usePartnerAccess();
  return (
    <CutRoute flag="hide_partner_nav" to="/" allow={loaded ? isPartner : null}>
      {children}
    </CutRoute>
  );
}

/** The nav label for the partner portal: "Partner" reads as a spouse in a tax app. */
export const PARTNER_NAV_LABEL = "Referral partners";

/**
 * The Grow layers a cut hides (ft_journey rail, switcher and /grow/:layer). Integrations stays for a user who
 * already has a QuickBooks connection (`has_data` on the layer is exactly that).
 */
export function useGrowLayerCut(): (layer: GrowLayerKey, hasData?: boolean) => boolean {
  const { has } = useFeatures();
  return (layer, hasData) =>
    (layer === "savings" && has("hide_savings")) ||
    (layer === "extras" && has("hide_extras")) ||
    (layer === "integrations" && (has("qbo_retired") || (has("hide_quickbooks_nav") && !hasData)));
}

/** Settings: the way back to QuickBooks for a user who has connected it, once it's out of the default nav. */
export function QuickBooksSettingsLink({ to }: { to: string }) {
  const { has } = useFeatures();
  const linked = useQboLinked(); // qbo_retired ⇒ false, so the card never shows
  if (!has("hide_quickbooks_nav") || linked !== true) return null;
  return (
    <Card className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
      <span className="text-muted">QuickBooks is connected. Reconcile, sync accounts or disconnect it here.</span>
      <Link to={to} className="font-medium text-ink underline underline-offset-2">
        Open QuickBooks
      </Link>
    </Card>
  );
}
