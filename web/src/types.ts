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
  reasoning: string | null;
  duplicate_of: string | null;
  kind?: string;
  account_id?: string | null;
  statement_id?: string | null;
  matched_txn_id?: string | null;
  direction?: string | null;
  raw_description?: string | null;
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

// Derived completion state (GET /api/progress) — drives the cross-tab spine + per-tab guides.
export interface NextActionData {
  kind: "import" | "review" | "date" | "export";
  count: number;
  label: string;
  href: string;
}
export interface Progress {
  imported: { statements: number; transactions: number };
  categorised: number;
  needs_review: number;
  undated: number;
  unreconciled_receipts: number;
  has_qbo: boolean;
  done: boolean;
  next_action: NextActionData;
}

export interface Property {
  id: string;
  label: string;
  status: string;
}

export interface Account {
  id: string;
  institution: string | null;
  name: string;
  last4: string | null;
  type: string; // transaction|credit_card|loan|investment
  source: string; // qbo_feed|statement|manual
  qbo_account_id: string | null;
  line_count?: number;
  created_at?: string;
}

export interface StatementLine {
  date: string | null;
  amount_cents: number;
  direction: "debit" | "credit";
  description: string;
  raw_description: string;
  balance_cents?: number | null;
}

export interface Reconciliation {
  available: boolean;
  ok: boolean;
  opening_cents: number | null;
  closing_cents: number | null;
  expected_cents: number | null;
  diff_cents: number;
  txn_count: number;
  first_bad_line: number | null;
}

export interface StatementParse {
  statementId: string;
  columnMap: unknown;
  preview: StatementLine[];
  rowCount: number;
  duplicate: boolean;
  reconciliation?: Reconciliation;
}

export interface StatementInfo {
  id: string;
  account_id: string;
  filename: string | null;
  format: string | null;
  status: string; // parsed|categorising|imported|failed
  row_count: number | null;
  imported_count: number | null;
  reconciled: number | null;
  recon_diff_cents: number | null;
  created_at: string;
  total_lines?: number | null; // bank lines imported from this statement
  categorised_count?: number | null; // of those, how many are categorised/ignored (vs needs_review)
}

export interface Person {
  id: string;
  display_name: string;
  role: string; // self|spouse|dependent|other
  occupation: string | null;
  tax_residency: string;
}

export interface Situation {
  profile?: {
    consent_xborder: number;
    consent_xborder_at?: string | null;
    consent_xborder_text?: string | null;
    inference_provider: string | null;
    inference_region?: string | null;
    ui_state?: string | null;
  };
  persons?: Person[];
  properties: Property[];
  entities: { id: string; kind: string; name: string | null; detail_json?: string | null }[];
  rules: { id: string; pattern: string; bucket: string; ato_label: string }[];
}

export const BUCKETS = ["payg", "company", "property_rented", "property_vacant", "unknown"] as const;
export type Bucket = (typeof BUCKETS)[number];

// Onboarding conversational-intake draft (POST /api/situation/draft). A best-effort
// extraction the wizard pre-fills for the user to confirm; never persisted as-is.
export interface EntityDetail {
  abn?: string | null;
  gst_registered?: boolean | null;
  employer?: string | null;
  vehicle?: string | null;
  provider?: string | null;
}
export interface DraftEntity {
  kind: "company" | "employment" | "novated_lease" | "individual" | "trust";
  name: string | null;
  detail: EntityDetail;
}
export interface DraftProperty {
  label: string;
  address: string | null;
  // Mirror of PROPERTY_STATUSES (src/lib/taxonomy.ts). The onboarding extractor emits any of these.
  status: "rented" | "vacant" | "owner_occupied" | "sold" | "renting_residence" | "renting_business";
  ownership_pct: number | null;
}
export interface DraftRule {
  pattern: string;
  bucket: Bucket;
  ato_label: string;
}
export interface SituationDraft {
  entities: DraftEntity[];
  properties: DraftProperty[];
  rules: DraftRule[];
}

export interface Notification {
  id: string;
  body: string;
  txn_id: string | null;
  read_at: string | null;
  created_at: string;
}

export interface DashboardData {
  by_bucket: { bucket: string; n: number; total_cents: number }[];
  income_by_bucket: { bucket: string; n: number; total_cents: number }[];
  by_property: { property_id: string; label: string | null; n: number; total_cents: number }[];
  needs_review: number;
  features: string[]; // enabled feature flags — gate nav/UI on these
}

export interface UsageData {
  today_cents: number;
  month_cents: number;
  calls: number;
  by_feature: { feature: string | null; calls: number; cost_cents: number }[];
  // Per Australian financial year — the tax-time billing rollup. billable_cents = measured cost
  // marked up by the pricing policy (display only today; no charging wired up).
  by_fy: { fy: string; calls: number; cost_cents: number; billable_cents: number }[];
  markup_pct: number;
  app_fee_cents: number;
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
  needs_reconnect?: boolean;
}

export interface Reconcile {
  connected: boolean;
  needsReconnect?: boolean;
  company: Txn[];
  purchases: { Id: string; TotalAmt: number; TxnDate: string; PrivateNote?: string }[];
  error: string | null;
}

export interface IncomeTypeRow {
  income_type: string;
  n: number;
  gross_cents: number;
  net_cents: number;
  withholding_cents: number;
  franking_credit_cents: number;
  foreign_tax_paid_cents: number;
}

export interface PropertyPosition {
  property_id: string;
  label: string | null;
  income_cents: number;
  deduction_cents: number;
  depreciation_cents: number;
  net_cents: number;
}

export interface Report {
  fy: string;
  start: string;
  end: string;
  by_bucket: { bucket: string; ato_label: string | null; n: number; total_cents: number; gst_cents: number }[];
  income_by_bucket: { bucket: string; ato_label: string | null; n: number; total_cents: number; gst_cents: number }[];
  by_property: { property_id: string; label: string | null; n: number; total_cents: number }[];
  company_quarters: { quarter: string; total_cents: number; gst_cents: number }[];
  undated: { n: number; total_cents: number };
  undated_detail: { merchant: string | null; total_cents: number }[];
  abn: string | null;
  gst_credits_cents: number;
  income: { by_type: IncomeTypeRow[]; gross_cents: number; withholding_cents: number; franking_credit_cents: number; foreign_tax_paid_cents: number };
  depreciation_cents: number;
  per_property: PropertyPosition[];
  total_income_cents: number;
  total_deductions_cents: number;
  refunds_cents: number;
  resolved_deductible_cents: number;
  taxable_position_cents: number;
}

// Year-end deductibility review summary (mirror of TaxAgent.reviewSummary).
export interface ReviewSummaryRow {
  bucket: string;
  ato_label: string | null;
  deductibility: string;
  n: number;
  total_cents: number;
  resolved_cents: number;
}
export interface ReviewSummary {
  fy: string;
  rows: ReviewSummaryRow[];
}

// Mirror of FilingReadiness in src/lib/readiness.ts — keep in sync.
export interface ReadinessFinding {
  id: string;
  category: string;
  severity: "blocker" | "review" | "info";
  title: string;
  general_info_note: string;
  defer_to_agent: boolean;
  evidence_refs: { kind: string; id?: string; label?: string; count?: number }[];
}
export interface PositionLine {
  group: "income" | "deduction" | "depreciation" | "property";
  label: string;
  amount_cents: number;
  basis: string;
  why: string;
}
export interface FilingReadiness {
  fy: string;
  generated_at: string;
  position: {
    indicative_taxable_position_cents: number;
    caption: string;
    lines: PositionLine[];
    credits: { withholding_cents: number; franking_credit_cents: number; foreign_tax_paid_cents: number; gst_credits_cents: number };
    per_property: PropertyPosition[];
  };
  findings: ReadinessFinding[];
  handoff: { abn: string | null; situation_summary: string };
  readiness_score: { blockers: number; review: number; info: number; ready: boolean };
  narrative: { position_plain_english: string; accountant_notes: string[] } | null;
  disclaimer: string;
}

export interface IncomeRow {
  id: string;
  person_id: string | null;
  entity_id: string | null;
  property_id: string | null;
  income_type: string;
  ato_label: string | null;
  fy: string;
  gross_cents: number;
  net_cents: number | null;
  withholding_cents: number;
  franking_credit_cents: number;
  foreign_tax_paid_cents: number;
  currency: string;
  amount_aud_cents: number | null;
  txn_date: string | null;
  needs_review: number;
  created_at: string;
}

export interface ClaimSuggestion {
  id: string;
  txn_id: string | null;
  asset_id: string | null;
  rule_id: string | null;
  suggestion: string;
  claim_type: string | null;
  estimated_deduction_cents: number | null;
  status: string; // suggested|accepted|dismissed
  created_at: string;
}

export interface ChecklistItem {
  id: string;
  fy: string;
  item_key: string;
  title: string;
  rationale: string | null;
  status: string; // open|done|dismissed|not_applicable
  trigger_bucket: string | null;
  due_hint: string | null;
}

export interface AssetRow {
  id: string;
  label: string;
  asset_class: string;
  cost_cents: number;
  acquired_date: string;
  method: string | null;
  effective_life_years: number | null;
  property_id: string | null;
  is_second_hand: number;
  status: string;
  needs_review: number;
  this_fy_deduction_cents: number | null;
  adjustable_value_cents: number | null;
}

export interface ScheduleRow {
  fy: string;
  opening_adjustable_value_cents: number;
  days_held: number;
  deduction_cents: number;
  closing_adjustable_value_cents: number;
  method_applied: string;
}

export interface DocRow {
  id: string;
  doc_type: string;
  fy: string | null;
  property_id: string | null;
  issuer: string | null;
  doc_date: string | null;
  classification_confidence: number | null;
  needs_review: number;
  created_at: string;
}
