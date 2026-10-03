// Legacy URL → first-timer journey route (spec A11 "Page-by-page migration", #582; flag ft_journey).
//
// ONE table, used by the flag-aware <FtRedirect> in main.tsx (pages/Steps.tsx). Server hrefs (readiness
// fix links, progress next_action, notifications) are deliberately NOT changed, so server output stays
// byte-identical with the flag OFF; today they reach the journey through that redirect, and
// toJourneyHref() is the same mapping for link renderers to use directly as the step pages land.
//
// Routes the spec keeps ("route kept": /transactions plain list, /txn/:id, /reports, /settings,
// /notifications, /billing, /glossary, /partner, /admin) are absent on purpose. The Grow pages
// (/assets, /extras, /savings, /quickbooks → /grow/:layer) join this table with the Grow ticket (A11b).

import type { JourneyStepKey } from "../types";

export interface LegacyRoute {
  /** Legacy pathname. */
  from: string;
  /** Journey route (may carry ?query / #hash). */
  to: string;
  /** Only redirect when this query param has this value (e.g. /transactions?view=review). */
  when?: { param: string; value: string };
}

export const LEGACY_ROUTES: readonly LegacyRoute[] = [
  { from: "/dashboard", to: "/" },
  { from: "/onboarding", to: "/about" },
  { from: "/accounts", to: "/bring-in" },
  { from: "/income", to: "/bring-in#income" },
  { from: "/documents", to: "/records#documents" },
  { from: "/transactions", to: "/claims", when: { param: "view", value: "review" } },
  { from: "/review", to: "/claims?view=labels" },
  { from: "/reconcile", to: "/check" },
  { from: "/filing", to: "/ship" },
];

/** The journey route for a legacy pathname + search, or null when the URL stays where it is. */
export function journeyRouteFor(pathname: string, search = ""): string | null {
  const params = new URLSearchParams(search);
  const hit = LEGACY_ROUTES.find((r) => r.from === pathname && (!r.when || params.get(r.when.param) === r.when.value));
  return hit ? hit.to : null;
}

/**
 * Map any in-app href (path + optional ?query/#hash) to its journey equivalent; unknown hrefs pass
 * through unchanged. `/inbox` is the oldest alias of the review queue and maps to Claims too.
 */
export function toJourneyHref(href: string): string {
  if (!href.startsWith("/")) return href;
  // A protocol-relative ("//host") or backslash ("/\\host") href is not an in-app path: never map it.
  if (/^\/[/\\]/.test(href)) return href;
  const m = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(href);
  const path = m?.[1] ?? href;
  const search = m?.[2] ?? "";
  if (path === "/inbox") return "/claims";
  return journeyRouteFor(path, search) ?? href;
}

/**
 * The reverse direction, for a journey step URL visited with the flag OFF (an old bookmark after a
 * rollback, a shared link): the legacy page that step replaces, so nothing 404s either way.
 */
export const STEP_LEGACY_ROUTE: Record<JourneyStepKey, string> = {
  about: "/onboarding",
  bring_in: "/accounts",
  claims: "/transactions?view=review",
  records: "/documents",
  check: "/reconcile",
  ship: "/filing",
};
