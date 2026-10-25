/**
 * The ledger filter: the ONE definition of which ledger rows count towards a total, and how a counted row's
 * amount is read. report.ts, ledger-totals.ts, accountant-schedule.ts and the dashboard all build their WHERE
 * clauses from these, so the rule can't drift between surfaces. Every predicate takes the surrounding query's
 * column prefix (`""` for the bare table, `"t."` for an aliased join) instead of being regex-rewritten.
 *
 * These are static SQL fragments with no `?` (except excludeSplitInterestExpr, whose loan-id binds the
 * caller appends LAST), which is what lets the tenant handle reason about the placeholders around them.
 */
import type { Env } from "../env";
import { featureOn } from "./features";

/** Not a foreign-currency row that is still waiting for its AUD conversion. */
export const fxConverted = (p = "") => `NOT (COALESCE(${p}currency,'AUD') <> 'AUD' AND ${p}amount_aud_cents IS NULL)`;

/**
 * A countable EXPENSE row: not a duplicate or ignored; a bank line, or a receipt not already matched to one
 * (so a matched pair counts once); money out; and converted to AUD.
 */
export const countable = (p = "") =>
  `${p}status NOT IN ('duplicate','ignored') ` +
  `AND (${p}kind = 'bank_line' OR (${p}kind = 'receipt' AND ${p}matched_txn_id IS NULL)) ` +
  `AND COALESCE(${p}direction,'debit') = 'debit' ` +
  `AND ${fxConverted(p)}`;

/** The income counterpart of countable: same exclusions, but the CREDIT side (money in). */
export const countableIncome = (p = "") =>
  `${p}status NOT IN ('duplicate','ignored') ` +
  `AND (${p}kind = 'bank_line' OR (${p}kind = 'receipt' AND ${p}matched_txn_id IS NULL)) ` +
  `AND ${p}direction = 'credit' ` +
  `AND ${fxConverted(p)}`;

// The single "this row is countable spend" predicate, used everywhere money is summed so
// nothing double-counts across feed / statement / receipt sources:
//  - drop duplicates and transfers/cc-payments (status 'ignored')
//  - count bank lines + ONLY receipts that aren't matched to a line (cash / no statement)
//  - count debits (spend); credits/refunds are stored but excluded.
// A foreign-currency row we couldn't convert to AUD (currency != AUD AND amount_aud_cents IS NULL)
// has no trustworthy AUD value — it's flagged needs_review and must be EXCLUDED from every money sum
// (never summed 1:1 as if it were AUD). Surfaced separately so the excluded money stays visible.
export const FX_CONVERTED = fxConverted();

export const COUNTABLE = countable();

// The income counterpart of COUNTABLE: same dedup/transfer exclusions, but the CREDIT side
// (money in). Reported separately from the `income` table (document-sourced income); the two
// are de-duplicated in a later phase, so credit income is shown as its own section, not folded
// into the headline income total yet.
export const COUNTABLE_INCOME = countableIncome();

// Mirrors positionAmountCents EXACTLY: only confirmed_deductible rows count their apportioned amount;
// everything else (incl. likely_not rows the 0021 backfill stamped with deductible_amount_cents=0)
// keeps gross. `p` is the table-alias prefix ("" for byBucket, "t." for the property join).
export const claimExpr = (p: string) =>
  `CASE WHEN ${p}deductibility = 'confirmed_deductible' AND ${p}deductible_amount_cents IS NOT NULL THEN ${p}deductible_amount_cents ELSE COALESCE(${p}amount_aud_cents, ${p}amount_cents) END`;

// 0031: a property held rent-free for a relative, or off-market while renovating, earns no income
// => its expenses are NOT deductions (s8-1), though CGT cost base still accrues. We MARK such rows
// (a 0/1 flag) rather than removing them, so they stay visible as excluded tracked-spend and every
// surface that lists spend agrees; only the headline classifier drops them. Static string, no extra
// binds; only the genuinely-new use_status values deny and no existing row carries them, so the
// position is byte-identical until a user marks a property. `col` is the txn's property_id column.
export const useStatusDeniedExpr = (col: string) =>
  `(CASE WHEN EXISTS (SELECT 1 FROM properties pp WHERE pp.id = ${col} AND pp.use_status IN ('private_use_rent_free','under_renovation_not_available')) THEN 1 ELSE 0 END)`;

// #254 (Wave 1): a property-bucket expense (property_rented/property_vacant) that can't yet land in an
// income-producing property earns no assessable rent, so it's not a deduction yet (deny-by-default,
// mirroring payg 'undetermined'). It's "undetermined" when EITHER the row has no property_id (it can't
// land in any per-property schedule) OR its property's use_status isn't an income-producing one
// ('rented' / 'genuinely_available_for_rent') — i.e. NULL/undetermined/vacant_land/owner_occupied.
// MARKED 0/1 (kept visible as excluded tracked-spend, like 0030/0031); only the headline + per-property
// classifier drop it. UNLIKE useStatusDeniedExpr this MUST be flag-gated by the caller (return "0" when
// off) because existing data DOES trigger it (the unattributed property spend that over-states the
// position), so the change has to flip deliberately rather than the day the code ships. `bucketCol`/
// `idCol` are the surrounding query's bucket + property_id columns (alias-prefixed as needed).
export const propertyUndeterminedExpr = (bucketCol: string, idCol: string) =>
  `(CASE WHEN ${bucketCol} IN ('property_rented','property_vacant') AND (${idCol} IS NULL OR NOT EXISTS (SELECT 1 FROM properties pp WHERE pp.id = ${idCol} AND pp.use_status IN ('rented','genuinely_available_for_rent'))) THEN 1 ELSE 0 END)`;

// #254: the flag-GATED form — the literal "0" when the flag is off (⇒ byte-identical SQL/grouping),
// the real marker when on. Single source of truth for the gate so report.ts and accountant-schedule.ts
// can never disagree on the flag name or the off-value (mirrors how both share useStatusDeniedExpr).
export const propertyUndeterminedGatedExpr = (env: Env, bucketCol: string, idCol: string) =>
  featureOn(env, "position_excludes_property_undetermined") ? propertyUndeterminedExpr(bucketCol, idCol) : "0";

// Phase B / G2: when the attribution_engine flag is on, a transaction that has explicit
// transaction_attributions is counted via those (attributionTotals) instead of its raw amount — so
// it must be EXCLUDED from the raw byBucket/byPropertyRaw/company/resolved sums to avoid double
// counting. `on` false (or no attribution rows) ⇒ this clause is empty ⇒ byte-identical legacy path.
// `alias` is the surrounding query's transactions alias (or the bare table name); no extra bind. The
// probe pins ta.user_id to the outer row's tenant so it seeks idx_txn_attr_txn (user_id, transaction_id)
// instead of scanning every tenant's attributions per line. Same rows: attributions are same-tenant.
export const notAttributedExpr = (alias: string, on: boolean) =>
  on ? ` AND NOT EXISTS (SELECT 1 FROM transaction_attributions ta WHERE ta.user_id = ${alias}.user_id AND ta.transaction_id = ${alias}.id)` : "";

// Exclude the legacy split rows ONLY for loans the v2 model supersedes (loanInterestV2Context).
// NULL-safe via COALESCE — `NOT (NULL = 'x')` is NULL (falsy) and would wrongly DROP every
// NULL-ato_label row. No superseded loans ⇒ empty clause ⇒ byte-identical legacy path. `p` is the
// alias; the bound `?`s are the loan ids, appended LAST in each query's bind list.
export const excludeSplitInterestExpr = (p: string, supersededLoanIds: string[]) =>
  supersededLoanIds.length
    ? ` AND NOT (COALESCE(${p}ato_label,'') = 'rental:interest' AND ${p}account_id IN (${supersededLoanIds.map(() => "?").join(",")}))`
    : "";
