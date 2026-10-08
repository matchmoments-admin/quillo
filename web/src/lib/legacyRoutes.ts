// Legacy URL → first-timer journey route (spec A11 "Page-by-page migration", #582; flag ft_journey).
//
// ONE table, used by the flag-aware <FtRedirect> in main.tsx (pages/Steps.tsx). Server hrefs (readiness
// fix links, progress next_action, notifications) are deliberately NOT changed, so server output stays
// byte-identical with the flag OFF; today they reach the journey through that redirect, and
// toJourneyHref() is the same mapping for link renderers to use directly as the step pages land.
//
// Routes the spec keeps ("route kept": /transactions plain list, /txn/:id, /reports, /settings,
// /notifications, /billing, /glossary, /partner, /admin) are absent on purpose. The Grow pages
// (/assets, /extras, /savings, /quickbooks → /grow/:layer) joined with the Grow ticket (A11b, #592).

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
  { from: "/onboarding", to: "/setup" },
  { from: "/accounts", to: "/connect" },
  { from: "/income", to: "/connect#income" },
  { from: "/documents", to: "/review#documents" },
  { from: "/transactions", to: "/review", when: { param: "view", value: "review" } },
  { from: "/reconcile", to: "/review#check" },
  { from: "/filing", to: "/lodge" },
  { from: "/assets", to: "/grow/assets" },
  { from: "/extras", to: "/grow/extras" },
  { from: "/savings", to: "/grow/savings" },
  { from: "/quickbooks", to: "/grow/integrations" },
  // Legacy /review (the "By label" roll-up) is NOT here: since the 4-step design review (#585) its path IS
  // the Review step, which renders the legacy page itself when the flag is OFF (pages/Steps.tsx ReviewStep).
];

/**
 * The 6-step journey's step URLs (#582) → the 4-step journey (spec §0, #585). These redirect whatever the
 * flag says (the new step route then sends a flag-OFF visitor on to the legacy page), so a bookmark or a
 * link from a page agent still on the old keys always lands. `/claims?view=labels` keeps its `view`.
 */
export const OLD_STEP_ROUTES: readonly LegacyRoute[] = [
  { from: "/about", to: "/setup" },
  { from: "/bring-in", to: "/connect" },
  { from: "/claims", to: "/review" },
  { from: "/records", to: "/review#documents" },
  { from: "/check", to: "/review#check" },
  { from: "/check/match", to: "/review/match" },
  { from: "/ship", to: "/lodge" },
];

/** The journey route for a legacy pathname + search, or null when the URL stays where it is. */
export function journeyRouteFor(pathname: string, search = ""): string | null {
  const params = new URLSearchParams(search);
  const hit = LEGACY_ROUTES.find((r) => r.from === pathname && (!r.when || params.get(r.when.param) === r.when.value));
  return hit ? hit.to : null;
}

/** The 4-step route for an old 6-step URL's pathname, or null. */
export function oldStepRouteFor(pathname: string): string | null {
  return OLD_STEP_ROUTES.find((r) => r.from === pathname)?.to ?? null;
}

/**
 * Map any in-app href (path + optional ?query/#hash) to its journey equivalent; unknown hrefs pass
 * through unchanged. `/inbox` is the oldest alias of the review queue and maps to Review too; the old
 * 6-step URLs map to their 4-step home.
 */
export function toJourneyHref(href: string): string {
  if (!href.startsWith("/")) return href;
  // A protocol-relative ("//host") or backslash ("/\\host") href is not an in-app path: never map it.
  if (/^\/[/\\]/.test(href)) return href;
  const m = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(href);
  const path = m?.[1] ?? href;
  const search = m?.[2] ?? "";
  if (path === "/inbox") return "/review";
  const old = oldStepRouteFor(path);
  if (old) return withQuery(old, search);
  return journeyRouteFor(path, search) ?? href;
}

/** Append a ?query to a target that may already carry a #hash (query goes before the hash). */
function withQuery(to: string, search: string): string {
  if (!search || search === "?") return to;
  const i = to.indexOf("#");
  return i < 0 ? `${to}${search}` : `${to.slice(0, i)}${search}${to.slice(i)}`;
}

/**
 * The reverse direction, for a journey step URL visited with the flag OFF (an old bookmark after a
 * rollback, a shared link): the legacy page that step replaces, so nothing 404s either way.
 */
export const STEP_LEGACY_ROUTE: Record<JourneyStepKey, string> = {
  setup: "/onboarding",
  connect: "/accounts",
  // Review's own path is the legacy /review page; ReviewStep renders it in place when OFF (no redirect).
  review: "/review",
  lodge: "/filing",
};

/**
 * Settings becomes account-only (#593, spec A11 ticket c, decision #436; flag ft_journey). Each tax section
 * Settings used to hold has ONE new home, addressed by the same anchor id there, so `/settings#<anchor>`
 * (a bookmark, an old help link) redirects to `<home>#<anchor>` with the flag ON. People and the prior-year
 * carry-ins move only when Get set up's profile mode is live (ft_journey + situation_profile, #585);
 * otherwise they stay on Settings. Employers (`employment` entities) also live in Get set up while its profile
 * mode is live, next to the employment answers; otherwise they stay with the other entities on Grow › Business
 * (`fallback`). Per-user rules move to Review (the sorting step); the rest go to Grow.
 */
export interface SettingsSectionMove {
  /** The section's anchor id, on Settings (old) and on its new home. */
  anchor: string;
  /** New home route; the redirect appends `#<anchor>`. */
  home: string;
  /** Plain name of the new home, for the "moved" card on Settings. */
  homeLabel: string;
  /** Moves only when Get set up's profile mode is live (situation_profile ON too). */
  needsAboutYou?: boolean;
  /** needsAboutYou sections only: where it lives while the profile mode is off (else it stays on Settings). */
  fallback?: string;
}

export const SETTINGS_SECTION_MOVES: readonly SettingsSectionMove[] = [
  { anchor: "people", home: "/setup", homeLabel: "Get set up", needsAboutYou: true },
  { anchor: "carry-ins", home: "/setup", homeLabel: "Get set up", needsAboutYou: true },
  { anchor: "employers", home: "/setup", homeLabel: "Get set up", needsAboutYou: true, fallback: "/grow/business#entities" },
  { anchor: "properties", home: "/grow/property", homeLabel: "Grow › Property" },
  { anchor: "loans", home: "/grow/property", homeLabel: "Grow › Property" },
  { anchor: "entities", home: "/grow/business", homeLabel: "Grow › Business & companies" },
  { anchor: "activities", home: "/grow/business", homeLabel: "Grow › Business & companies" },
  { anchor: "gst", home: "/grow/business", homeLabel: "Grow › Business & companies" },
  { anchor: "bas", home: "/grow/business", homeLabel: "Grow › Business & companies" },
  { anchor: "trust", home: "/grow/business", homeLabel: "Grow › Business & companies" },
  { anchor: "partnership", home: "/grow/business", homeLabel: "Grow › Business & companies" },
  { anchor: "smsf", home: "/grow/business", homeLabel: "Grow › Business & companies" },
  { anchor: "super", home: "/grow/business", homeLabel: "Grow › Business & companies" },
  { anchor: "rules", home: "/review", homeLabel: "Review" },
];

/** The account sections that stay on Settings (their anchors resolve in place). */
export const SETTINGS_KEPT_ANCHORS: readonly string[] = ["ai-changes", "privacy", "your-data", "bank-connections", "devices"];

/**
 * Where `/settings#<hash>` goes with ft_journey ON: the moved section's new home (with its anchor), or null
 * when the section stays on Settings (a kept anchor, an unknown one, or People / carry-ins while Get set up's
 * profile mode is off). Employers fall back to Grow › Business's entities while the profile mode is off.
 */
export function settingsSectionHome(hash: string, opts: { aboutYou: boolean }): string | null {
  let anchor: string;
  try {
    anchor = decodeURIComponent(hash.replace(/^#/, ""));
  } catch {
    return null; // a malformed %-escape is not one of ours
  }
  const move = SETTINGS_SECTION_MOVES.find((m) => m.anchor === anchor);
  if (!move) return null;
  if (move.needsAboutYou && !opts.aboutYou) return move.fallback ?? null;
  return `${move.home}#${move.anchor}`;
}
