export interface Txn {
  id: string;
  source: string;
  status: string;
  merchant: string | null;
  amount_cents: number | null;
  currency: string | null;
  amount_aud_cents: number | null;
  fx_rate: number | null;
  fx_date: string | null;
  gst_cents: number | null;
  txn_date: string | null;
  bucket: string | null;
  ato_label: string | null;
  property_id: string | null;
  paid_account: string | null;
  confidence: number | null;
  duplicate_of: string | null;
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
  profile?: { consent_xborder: number; inference_provider: string | null };
  properties: Property[];
  entities: { kind: string; name: string | null }[];
  rules: { pattern: string; bucket: string; ato_label: string }[];
}

export const BUCKETS = ["payg", "company", "property_rented", "property_vacant", "unknown"] as const;
export type Bucket = (typeof BUCKETS)[number];

export interface Notification {
  id: string;
  body: string;
  txn_id: string | null;
  read_at: string | null;
  created_at: string;
}

export interface DashboardData {
  by_bucket: { bucket: string; n: number; total_cents: number }[];
  by_property: { property_id: string; label: string | null; n: number; total_cents: number }[];
  needs_review: number;
}

export interface KeyRow {
  key_id: string;
  label: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface QboStatus {
  connected: boolean;
  realm_id: string | null;
  updated_at: string | null;
}

export interface Reconcile {
  connected: boolean;
  company: Txn[];
  purchases: { Id: string; TotalAmt: number; TxnDate: string; PrivateNote?: string }[];
  error: string | null;
}

export interface Report {
  fy: string;
  start: string;
  end: string;
  by_bucket: { bucket: string; ato_label: string | null; n: number; total_cents: number; gst_cents: number }[];
  by_property: { property_id: string; label: string | null; n: number; total_cents: number }[];
  company_quarters: { quarter: string; total_cents: number; gst_cents: number }[];
  undated: { n: number; total_cents: number };
}
