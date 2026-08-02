# Can `/reconcile` fold into an FY-scoped Sort queue?

> **Research deliverable for [#437](https://github.com/matchmoments-admin/quillo/issues/437)**, map
> [#432](https://github.com/matchmoments-admin/quillo/issues/432). Produced 2026-08-02. No code changed.
>
> The original review asserted "`/reconcile` becomes the 'Match receipts' view of this queue" **without
> reading Reconcile**. This is that reading.

---

## 0 · The answer

**Yes — but not as a fold, and not as it stands.** A straight merge fails for the reasons the
completeness critic gave. But the blocker isn't the scope or the caps; it's the **interaction shape**:
a queue row is *one decision*, and Reconcile is a *pairing* — pick A, then pick B from a scored list.

The unlock is that **Quillo already has a scorer and has never used it to propose anything.** Move it
server-side and reconciliation becomes "confirm this suggested match" — one decision, one row, foldable.
The two-pane screen survives as the disambiguation fallback, not the primary surface.

## 1 · What Reconcile actually is

| | Verified |
|---|---|
| `reconcilePairs` (`queries.ts:265-284`) | **No `fy` predicate.** `LIMIT 100` receipts, `LIMIT 200` lines. Lines filtered to `direction = 'debit'` |
| `Reconcile.tsx` | **128 lines.** Two-pane pick-then-Link, with a client-side scorer at `:110-119` |
| The scorer | `amount × 0.7 + date × 0.3`; amount tolerance `max($50, 1%)`, date window 7 days |
| **Who writes `matched_txn_id`** | **`agent.ts:1357` — and nothing else.** The manual Link action |

**That last row is the finding.** There is **no auto-match anywhere** — not on statement import, not on
receipt extraction. Every match in Quillo's history was made by hand on a two-pane screen. The scorer
exists **only to sort candidates for display**; it has never proposed or confirmed anything.

So the question "can Reconcile fold into the queue?" has been asking about the wrong thing. Reconcile
isn't a triage surface that happens to look different — it's **the absence of a matcher**, with a manual
UI standing in for one.

## 2 · The critic's three objections, re-examined

### 2.1 · All-time scope — **not fatal, and not a feature**

The objection: FY-scoping drops prior-year receipts (Susan & Greg's rental substantiation, Lukas's and
Tom's cash receipts).

**But a receipt and its bank line are the same event, within the scorer's own 7-day window.** So an
unmatched receipt from FY2024-25 is not waiting for an FY2025-26 line — it's waiting for a line that was
never imported, or it has no line at all (cash). The all-time scope isn't serving cross-year matching;
it's **the absence of a filter**.

**Resolution:** scope by the **bank line's** FY (money decides the year, not evidence), and give
leftovers an explicit home — *"receipts with no matching line in this year"* — rather than silently
dropping or silently including them. Cash receipts with no line at all are **not a reconciliation
problem**; they're a substantiation one, and they belong wherever substantiation lives, not in a
matching queue that can never resolve them.

### 2.2 · The caps — **a live silent-truncation bug, worse than the fold question**

`LIMIT 100` receipts / `LIMIT 200` lines, ordered by recency, with **no pagination and no "show more"
beyond the client's local `limit`**.

FY2024-25 has ~2,355 transactions. A taxpayer with 2,400 unmatched debit lines sees **the most recent
200** and cannot reach the rest — and nothing on screen says so.

**This is the same disease as `ClaimsCard`'s `slice(0, 6)`** (fixed in #482): a hard cap with the true
count nowhere in sight. It should be filed and fixed **independently of any IA decision** — it is broken
today, on a page that ships.

Ordering by recency is also the wrong key. Ordered by **match score**, the first screen would carry the
matches most likely to be right.

### 2.3 · `direction = 'debit'` — a real, silent exclusion

A refund receipt (a credit) can **never** be matched, because credits are filtered out of the candidate
list entirely. With `refund_netting_v2` ON — which nets a refund against the specific expense it
reverses via `refund_for_txn_id` — this is the exact pairing the position most wants evidence for, and
Reconcile cannot express it.

## 3 · The interaction problem — the actual blocker

A Sort-queue row asks **one question** and takes **one action**. Reconcile asks the user to hold two
lists in their head and construct a pair. There is no design anywhere for how that becomes a triage row,
and the review never proposed one.

**Two shapes are available:**

| | Shape | Assessment |
|---|---|---|
| **A** | Each unmatched receipt is a queue row; its action opens a candidate picker | Preserves today's semantics but keeps the pairing burden — it just relocates the two-pane into a drawer |
| **B** | **Score server-side, propose the best candidate, one-tap confirm.** Only genuinely ambiguous receipts (no candidate above threshold, or two within a margin) fall through to the two-pane | ⭐ **Recommended** |

**B is the Xero pattern** the journey research already documents — statement line on the left, best guess
on the right, one green OK. It is also the pattern `docs/ux/journey-research-248.md` warns about: Xero's
own forum shows users going "trigger happy" and mis-coding. **So the confirm must be confidence-gated** —
propose only above a threshold, and never bulk-confirm proposals the way `bulk_confirm` handles
categorisation.

Quillo is unusually well placed for B because **the scorer already exists and is already tuned** — it
just runs in the wrong place and its output is thrown away.

## 4 · `documents.needs_review` — absorb or orphan, decide explicitly

`Documents.tsx:120` renders a `review` pill on every held-for-review document **with no action attached**.
A user can see that something needs review and can do nothing about it from that surface.

`Documents.tsx:49-62` is also the **only** delete path for a mis-routed document, and it **cascades** —
the response reports `income_removed` and `txns_removed`, and the copy says so. That capability must
survive any consolidation. **This is exactly the `ClaimsCard` finding's shape** (the only surface
carrying an action), and it was missed the same way.

**Recommendation:** the pill becomes a queue row (*"this document needs review"*) whose action opens the
document, and the cascading delete stays on Documents as the destructive path — a queue is the wrong
place for an action that silently removes income rows.

## 5 · Recommendation

1. **Reconcile does not fold as-is.** It becomes a **proposer** (shape B), and *that* folds — because a
   proposal is one decision.
2. **Ship the matcher before the IA change.** Server-side scoring + confirm is valuable on the existing
   two-pane page and doesn't depend on any queue decision. It also de-risks the fold: once matches are
   proposed, the residual ambiguous set is small enough that scope and caps stop mattering.
3. **File the caps as a defect now** — independent of this map. `LIMIT 100/200` with no pagination is a
   live silent truncation on a shipped page.
4. **FY-scope by the bank line**, with an explicit "no line this year" bucket. Never silently drop.
5. **Lift `direction = 'debit'`** so refund receipts can be matched.
6. **`needs_review` becomes a queue row; the cascading delete stays on Documents.**

## 6 · What this changes on the map

- **#437 is answerable without #434** (the Position/File fold) — they were never coupled.
- The **"Check" stop does not disappear**, contrary to the review's assertion. It shrinks to
  disambiguation. Whether a shrunken Check still earns a numbered stop is an IA question for
  [#442](https://github.com/matchmoments-admin/quillo/issues/442), now with a concrete answer to reason
  about instead of an assumption.
- **New fog:** what the confidence threshold is, and whether a proposed match auto-confirms above some
  level. That is a money-adjacent tuning question — a wrong match attaches the wrong evidence to a claim
  — and it needs its own decision, not a constant picked in a PR.
