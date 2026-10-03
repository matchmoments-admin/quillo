import type { GrowLayerKey } from "../types";

// The Grow layer's names and routes (#592; flag ft_journey). Pure — no React / react-query imports — so the
// server-side route-table golden (scripts/check-units.ts) can import it in CI. The hook lives in ./grow.

export const GROW_LABEL: Record<GrowLayerKey, string> = {
  property: "Property",
  investments: "Shares & investments",
  business: "Business & companies",
  assets: "Assets",
  integrations: "Integrations",
  extras: "Extras",
  savings: "Savings",
  advisers: "Advisers",
};

export const GROW_BLURB: Record<GrowLayerKey, string> = {
  property: "Rental properties, their loans and the income they earn.",
  investments: "Shares, ETFs and managed funds: holdings, dividends, distributions and employee share schemes.",
  business: "An ABN activity, a company, trust or partnership, GST and BAS.",
  assets: "Things you bought for work or a rental that wear out over time (depreciation).",
  integrations: "Connect QuickBooks to reconcile what you've recorded.",
  extras: "Private health extras: limits, what you've used and when they reset.",
  savings: "Recurring bills and subscriptions, and where switching might save you money.",
  advisers: "The partner portal.",
};

/** Where a layer lives. Advisers is the Partner portal, whose route is kept (role-gated). */
export const GROW_ROUTE: Record<GrowLayerKey, string> = {
  property: "/grow/property",
  investments: "/grow/investments",
  business: "/grow/business",
  assets: "/grow/assets",
  integrations: "/grow/integrations",
  extras: "/grow/extras",
  savings: "/grow/savings",
  advisers: "/partner",
};

/** A /grow/:layer URL visited with the flag OFF (an old bookmark after a rollback) → the page it composes. */
export const GROW_LEGACY_ROUTE: Record<GrowLayerKey, string> = {
  property: "/settings",
  investments: "/income",
  business: "/settings",
  assets: "/assets",
  integrations: "/quickbooks",
  extras: "/extras",
  savings: "/savings",
  advisers: "/partner",
};

export const GROW_KEYS = Object.keys(GROW_LABEL) as GrowLayerKey[];

export function isGrowKey(v: string | undefined): v is GrowLayerKey {
  return !!v && (GROW_KEYS as string[]).includes(v);
}
