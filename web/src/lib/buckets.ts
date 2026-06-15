// Buckets where a transaction property_id is VALID: rental-property expense (property_rented /
// property_vacant) and rent income (income_property). Mirrors src/lib/taxonomy.ts PROPERTY_BUCKETS —
// the single web-side source of truth for "show a property selector / a property_id may ride here".
// Used by TxnDetail, BulkBar, the Settings rule form and the Income entry form so they can't drift.
export const PROPERTY_BUCKETS = ["property_rented", "property_vacant", "income_property"];
export function isPropertyBucket(bucket: string | null | undefined): boolean {
  return !!bucket && PROPERTY_BUCKETS.includes(bucket);
}
