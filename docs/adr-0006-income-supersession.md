# ADR-0006 — Income supersession: the covering document wins, and a NULL person is the taxpayer

**Status:** Accepted · **Date:** 2026-10-28 · **Context:** the owner-statements end-to-end run

## Context

Income that comes from a periodic document (an ATO income statement, a managing agent's statement) is often
uploaded more than once or in overlapping forms: an income statement is re-printed once it's "Tax ready", and an
agent sends monthly ownership statements and then an annual income and expenditure summary covering the same
months. Each upload recorded its own income row, so on the owner's own FY2025-26 documents Lodge showed salary
twice and rent about 8% too high.

An older salary supersede existed, but it matched only rows whose `person_id` was NULL. Since the persons model
(0006), `recordIncome` stamps every row with `person_self_<uid>`, so that guard never fired. Several other modules
read "the primary taxpayer" each in their own way (NULL only, NULL or self, exact id).

## Decision

1. **One rule decides supersession** (`src/lib/income-supersession.ts`, flag `income_supersession`). An
   incoming row from a document is compared with rows on file for the same taxpayer:
   - **Salary:** the same employer (ABN when both rows carry one, otherwise the name) and FY, from another
     document ⇒ the incoming statement replaces them.
   - **Rent:** with the same property on both rows and the same FY, a statement whose period covers a row's
     period replaces it, and a statement covered by a row records nothing. Everything weaker is **held for
     review, never deleted**: a partial overlap, an overlap across FYs, or a match on the statement address alone.
2. **The covering document wins; the covered one stays as evidence.** A replaced document is kept with its
   original and marked `superseded_by`. Its income row and the transactions it created are removed, and the
   Documents page shows it as "kept as a record · not counted". This was owner decision (a), 2026-10-28.
3. **Write first, then retire.** The replacing row is written before anything is removed, so a failure part-way
   leaves a double count, which is visible, rather than a lost one. A bank credit linked to a replaced row moves
   to the replacement. Every income delete goes through `deleteIncomeRow` (`src/lib/situation-write.ts`).
4. **A NULL person is the primary taxpayer.** `src/lib/self-person.ts` is the only place that builds or
   compares the self id; a check-units guard rejects inline copies.

## Consequences

- Re-uploads and annual-over-monthly rent count once. The order of upload doesn't matter.
- Rows recorded before the flag carry no period or address, so they never take part. Statements uploaded
  after the flip do.
- Supersession only acts on its own when the property is known. Attributing a statement to a property at
  ingest (`property_from_statement`) is what lets rent supersession apply without review.
- The strict `person_id = ?` readers (`ledger-totals.ts`, `queries.ts`) still drop NULL-person rows. Aligning
  them changes output, so it is tracked separately with ADR-0004's person scope.
