// Single source of truth for every categorical taxonomy in Quillo.
//
// Before this module the `bucket` enum was duplicated 5× (extract.ts zod, RECORD_TOOL,
// BATCH_TOOL, SituationDraft, au-v1.json) and would silently drift. Everything categorical
// now derives from the `as const` tuples here:
//   - zod schemas:        z.enum(BUCKETS)
//   - tool input_schema:  enum: [...BUCKETS]
//   - rulepack validation: assertBucketKeys()
//
// Adding/removing a category is a one-file change. Keep the tuples as the ONLY place a
// literal category string is written.

/** Expense/deduction buckets — which tax "pocket" an expense belongs to. */
export const BUCKETS = ["payg", "company", "property_rented", "property_vacant", "unknown"] as const;
export type Bucket = (typeof BUCKETS)[number];

/** First-class income kinds (income is modelled, never inferred from bank credits). */
export const INCOME_TYPES = [
  "salary_payg",
  "rent",
  "interest",
  "dividend",
  "managed_fund_distribution",
  "foreign_pension",
  "foreign_rent",
  "other",
] as const;
export type IncomeType = (typeof INCOME_TYPES)[number];

/** Depreciating/capital asset classes (Div 40 / Div 43 / business / pool / immediate). */
export const ASSET_CLASSES = [
  "div40_plant",
  "div43_capital_works",
  "business_asset",
  "low_value_pool",
  "immediate",
] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

/** How a claim is treated (drives the depreciation engine + claimability brain). */
export const CLAIM_TYPES = ["immediate", "div40", "div43", "apportioned", "not_deductible"] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

/** Capital classification stamped on a transaction that creates/relates to an asset. */
export const CAPITAL_CLASSES = ["repair", "div40", "div43", "initial_repair"] as const;
export type CapitalClass = (typeof CAPITAL_CLASSES)[number];

/** Document types the Smart-Inbox classifier can emit. */
export const DOC_TYPES = [
  "receipt",
  "bank_statement",
  "agent_rental_summary",
  "payslip",
  "dividend_statement",
  "managed_fund_amma",
  "depreciation_schedule",
  "super_statement",
  "loan_statement",
  "invoice",
  "unknown",
] as const;
export type DocType = (typeof DOC_TYPES)[number];

/** Tax entities a tenant can own (employment/company/lease/individual/trust). */
export const ENTITY_KINDS = ["employment", "company", "novated_lease", "individual", "trust"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/**
 * Property status — captures the user's RELATIONSHIP to a property, which drives deductibility.
 * Landlord/owner side: rented (you let it out), vacant, owner_occupied, sold. Tenant side:
 * renting_residence (you rent your home — generally private/non-deductible), renting_business
 * (you rent business/commercial premises — generally deductible). The tenant statuses fall through
 * src/lib/db.ts categoriser hints and src/lib/report.ts per-property logic.
 * NOTE: this tuple is hand-mirrored in web/src/components/SituationFields.tsx (PROPERTY_STATUSES +
 * propertyStatusLabel) — keep them in sync.
 */
export const PROPERTY_STATUSES = ["rented", "vacant", "owner_occupied", "sold", "renting_residence", "renting_business"] as const;
export type PropertyStatus = (typeof PROPERTY_STATUSES)[number];

/** Taxpayer roles under a tenant (persons are the apportionment root). */
export const PERSON_ROLES = ["self", "spouse", "dependent", "other"] as const;
export type PersonRole = (typeof PERSON_ROLES)[number];

const BUCKET_SET: ReadonlySet<string> = new Set(BUCKETS);

/** True when `b` is a known bucket. */
export function isBucket(b: string): b is Bucket {
  return BUCKET_SET.has(b);
}

/**
 * Non-throwing drift check for a loaded rule pack: warns if it declares a bucket key the
 * taxonomy doesn't know about (so a stale KV override surfaces in logs without breaking
 * prod). Returns the list of unknown keys.
 */
export function assertBucketKeys(buckets: Record<string, unknown>): string[] {
  const unknown = Object.keys(buckets).filter((k) => !BUCKET_SET.has(k));
  if (unknown.length) {
    console.warn(`[taxonomy] rule pack declares unknown bucket(s): ${unknown.join(", ")}`);
  }
  return unknown;
}
