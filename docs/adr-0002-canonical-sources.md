# ADR-0002 — One canonical source per fact (and how delete/FX/multi-company protect it)

**Status:** Accepted · **Date:** 2026-06-12 · **Context:** DB-foundation review (H1/H2/H3 + model-coherence)

## Context

The schema has **no foreign keys** — every relationship is an unenforced TEXT id reference, and
several facts have more than one possible representation. A multi-agent review confirmed there are
**no duplicate tables**, but the correctness of every money figure rests on the engine picking exactly
**one** representation per fact, enforced only by convention. This ADR records the canonical source per
fact and the guards (now backed by goldens in `scripts/check-personas.ts`) that keep the others from
double-counting or silently dropping money.

## Decision — canonical source per fact

| Fact | Canonical source | How the alternatives are reconciled | Guard / golden |
|---|---|---|---|
| **Income** | the `income` table | A bank **credit** confirmed to duplicate a documented income row is excluded from the income-by-bucket section via `matched_income_id IS NULL` (`report.ts:325`, flag `income_dedupe`). On income delete, the credit's `matched_income_id` is cleared first (`api.ts:705`) so it never stays excluded with no row to unlink it. `income_activities` is the source-of-income **spine** (provenance), never a second income total. | "Canonical income" goldens |
| **Deductible / claimable amount** | the `transaction_attributions` snapshot when `attribution_engine` is ON; otherwise the raw transaction | Raw `byBucket`/`byPropertyRaw`/company sums exclude attributed rows via `notAttributedExpr` (`report.ts`), so a dollar is counted once — either as a raw row **or** as its attribution, never both. | persona tie-back goldens (position == sum-of-lines, p1–p11) |
| **AUD value of a foreign amount** | `amount_aud_cents` (only when actually converted) | On an FX-rate-lookup failure we store `amount_aud_cents = NULL` (never the raw foreign cents) + flag the row `needs_review`; every money sum excludes `currency<>'AUD' AND amount_aud_cents IS NULL` via the `FX_CONVERTED` predicate (`queries.ts`), and the excluded count is surfaced as a readiness finding. **H2** | "H2" goldens + migration `0050` |
| **Whether a parent row may be deleted** | RESTRICT — a parent (account/property/entity/person/asset) cannot be hard-deleted while financial children reference it | `deleteRow` runs `assertNoBlockingChildren` (one batched EXISTS sweep) and throws `DeleteBlockedError` → **409**; accounts/entities offer **archive** (`active=0`) instead. `deleteTransaction` un-matches receipts + clears attributions so a leaf delete leaves no reverse-orphan. **H1** | "H1" goldens |
| **Company-bucket spend with 2+ companies** | only attributed (entity-tagged) spend enters a company position | A bare `bucket='company'` row carries no `entity_id`; with multiple companies it is **surfaced as unattributed** (`company_unattributed_*` + readiness finding), never dropped or pinned to `companies[0]`. Single-company behaviour is byte-identical. **H3** | "H3" goldens |
| **Asset identity (depreciation vs CGT)** | `assets` (Div 40/43 decline-in-value) and `cgt_assets` (CGT cost base) are **intentionally separate** — a depreciating asset is not a CGT parcel | No shared link today; correct by design (financial assets never live in `assets`). Revisit only if a single economic asset must carry both a decline-in-value and a CGT cost base. | — (documented, not enforced) |

## Reserved / dark tables (no drop in this slice)

`blackhole_costs` (no reads, no writes), `shareholder_loans` (written by `attribution-write.ts`, balance
read inline rather than from the table), and `company_tax_positions` / `rd_claims` (read-only inputs with
no in-app writer yet) are **retained**. Dropping a table is non-additive/destructive and needs an explicit
go + reverse plan (working-agreement STOP-and-ask); they're tracked as defer-to-agent / future-UI (issue
#126), not silently-wrong — the engines treat empty inputs as zero.

## Consequences

- New per-row tax facts go to **satellite tables keyed by `transaction_id`** (the attribution-table
  pattern), not new columns on the `transactions` god-table.
- Any new money sum MUST filter by `COUNTABLE`/`COUNTABLE_INCOME` (which now embed `FX_CONVERTED`) or add
  the FX exclusion explicitly for `income`-table sums.
- Any new deletable parent MUST be added to `CHILD_REFS` in `situation-write.ts` (mirrors the
  `PURGE_TABLES` discipline for retention).
- These invariants are enforced by goldens in `scripts/check-personas.ts` (run in `npm test`), turning
  "defended in comments" into "enforced by test."
