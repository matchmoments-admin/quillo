// Extras "Suggested Next" ranking + a small geo helper. PURE / deterministic so it's unit-assertable
// (see scripts/check-units.ts). Computes a short, ranked list of factual next actions from the existing
// PhiOverview — NO new API call, NO new data. Stays factual/non-advice: it surfaces the member's own
// unused cover and detected spending, it does not recommend products or treatment.

import type { PhiOverview, PhiLoggable } from "../types";

export type SuggestionKind = "find" | "log" | "confirm" | "setup";

export interface Suggestion {
  kind: SuggestionKind;
  key: string;            // stable React key
  title: string;          // short heading
  body: string;           // one factual supporting line
  badge?: string;         // e.g. "$1,000 available"
  sub?: string;           // small right-aligned label (category name)
  amountCents?: number;   // unused cover this suggestion represents (drives ranking)
  // action payloads — only the fields relevant to `kind` are set:
  policyId?: string;
  category?: string;
  providerTerm?: string;
  loggable?: PhiLoggable;
  confirmCount?: number;
}

function money(cents: number): string {
  // Local, dependency-free dollar formatter for suggestion copy (whole dollars — these are cover amounts).
  return `$${Math.round(cents / 100).toLocaleString("en-AU")}`;
}

/**
 * Rank the "biggest, easiest wins" for the Extras dashboard, capped at `limit` (default 3):
 *   1. Categories with the most unused cover AND a provider term — "you have $X, here's where to use it".
 *   2. Detected recent health spend not yet logged — one-tap "log your visit".
 *   3. A single "confirm your pre-filled limits" nudge when any limit is unverified.
 *   4. Empty state — "set up your fund" when there are no policies at all.
 * Pure: depends only on the overview. Returns [] when nothing is actionable.
 */
export function computeSuggestions(overview: PhiOverview, limit = 3): Suggestion[] {
  if (!overview.consented) return [];
  if (overview.policies.length === 0) {
    return [{
      kind: "setup",
      key: "setup",
      title: "Set up your extras cover",
      body: "Add your fund to see what cover you have left to use before it resets.",
    }];
  }

  const find: Suggestion[] = [];
  for (const p of overview.policies) {
    for (const c of p.categories) {
      if (c.provider_term && c.remaining_cents > 0) {
        find.push({
          kind: "find",
          key: `find:${p.id}:${c.category}`,
          title: c.label,
          body: `${money(c.remaining_cents)} of your ${c.label.toLowerCase()} cover is unused — find a provider to put it to use before it resets.`,
          badge: `${money(c.remaining_cents)} available`,
          sub: c.label,
          amountCents: c.remaining_cents,
          policyId: p.id,
          category: c.category,
          providerTerm: c.provider_term,
        });
      }
    }
  }
  // Largest unused cover first — the "biggest win".
  find.sort((a, b) => (b.amountCents ?? 0) - (a.amountCents ?? 0));

  const log: Suggestion[] = overview.loggable.map((t) => {
    // Route the detected visit to the policy that actually covers its category — a multi-policy member
    // would otherwise have every visit logged against policies[0] regardless of which fund covers it.
    const policy = overview.policies.find((p) => p.categories.some((c) => c.category === t.suggested_category)) ?? overview.policies[0];
    return {
      kind: "log" as const,
      key: `log:${t.txn_id}`,
      title: "Log a recent visit",
      body: `We spotted ${t.merchant} (${money(t.amount_cents)}) in your transactions — one tap logs it against your extras.`,
      sub: "Detected",
      policyId: policy.id,
      loggable: t,
    };
  });

  const unverified = overview.policies.reduce(
    (n, p) => n + p.categories.filter((c) => c.verified === 0).length,
    0,
  );
  const confirm: Suggestion[] = unverified > 0
    ? [{
        kind: "confirm",
        key: "confirm",
        title: "Confirm your limits",
        body: `${unverified} limit${unverified === 1 ? "" : "s"} ${unverified === 1 ? "was" : "were"} pre-filled from the standard product — check them against your fund's app and confirm.`,
        confirmCount: unverified,
        policyId: overview.policies.find((p) => p.categories.some((c) => c.verified === 0))?.id,
      }]
    : [];

  // At most 2 "log" cards lead (concrete, time-sensitive), then the biggest unused-cover prompts, then
  // a single confirm nudge — so a member with detected spend still sees where their cover can go.
  return [...log.slice(0, 2), ...find, ...confirm].slice(0, limit);
}

export interface LatLng { lat: number; lng: number }

/**
 * Great-circle distance in km between a search centre and a provider point. Returns null when the
 * provider has no coordinates (so the caller omits the distance chip). PURE.
 */
export function haversineKm(a: LatLng, b: { lat?: number; lng?: number }): number | null {
  if (b.lat == null || b.lng == null) return null;
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Human distance label: "0.4 km" close in, "12 km" further out. */
export function formatKm(km: number): string {
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}
