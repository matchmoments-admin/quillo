import { BUCKETS } from "../types";

// Buckets where a transaction property_id is VALID: rental-property expense (property_rented /
// property_vacant) and rent income (income_property). Mirrors src/lib/taxonomy.ts PROPERTY_BUCKETS —
// the single web-side source of truth for "show a property selector / a property_id may ride here".
// Used by TxnDetail, BulkBar, the Settings rule form and the Income entry form so they can't drift.
export const PROPERTY_BUCKETS = ["property_rented", "property_vacant", "income_property"];
export function isPropertyBucket(bucket: string | null | undefined): boolean {
  return !!bucket && PROPERTY_BUCKETS.includes(bucket);
}

// Income/refund/unknown are NOT re-categorisation targets in the bulk / inline pickers: income must
// route through an income ANSWER (so it's recorded in the income table + single-counted, not merely
// re-bucketed — see ClarifyCard → answerClarify → recordCreditAsIncome), and refund/unknown aren't real
// spend buckets. The server rejects them too. Single source so BulkBar + ReviewView can't drift on the
// money-correctness guard. (#275)
export const CREDIT_OR_UNKNOWN = new Set(["income_business", "income_property", "income_personal", "refund", "unknown"]);
export const PICKABLE = BUCKETS.filter((b) => !CREDIT_OR_UNKNOWN.has(b));
