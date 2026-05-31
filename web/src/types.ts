export interface Txn {
  id: string;
  source: string;
  status: string;
  merchant: string | null;
  amount_cents: number | null;
  gst_cents: number | null;
  txn_date: string | null;
  bucket: string | null;
  ato_label: string | null;
  property_id: string | null;
  confidence: number | null;
  ledger_ref: string | null;
  created_at: string;
}

export interface Correction {
  field: string;
  old_value: string | null;
  new_value: string | null;
  created_at: string;
}

export type TxnDetail = Txn & { receipt_key: string | null; corrections: Correction[] };

export interface Property {
  id: string;
  label: string;
  status: string;
}

export interface Situation {
  properties: Property[];
  entities: { kind: string; name: string | null }[];
  rules: { pattern: string; bucket: string; ato_label: string }[];
}

export const BUCKETS = ["payg", "company", "property_rented", "property_vacant", "unknown"] as const;
export type Bucket = (typeof BUCKETS)[number];
