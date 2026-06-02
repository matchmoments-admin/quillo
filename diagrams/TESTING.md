# Quillo — testing plan (per process)

Companion to `diagrams/quillo-test-arch.excalidraw` (open in Excalidraw; each test card is
clickable). This file holds the longer guidance the diagram cards summarise.

**Environments**

| What | URL / path |
|---|---|
| Live app (gated) | https://app.quillo.au |
| Public site | https://quillo.au |
| Worker | https://tax-agent.matchmoments.workers.dev |
| Offline test net | `npm test` (units + statements) |

**Two kinds of test**
- **Offline gates** — deterministic, run anywhere, no Claude/worker: `npm test`. These are the
  CI safety net.
- **Live click-throughs** — need your Clerk login (single-user lockdown). macOS 12.6 can't run
  `workerd` locally, so **deploy is the live test path**: `unset CLOUDFLARE_API_TOKEN && npx wrangler deploy`.

---

## 1. Auth — single-user lockdown
**What:** Clerk JWT verified via JWKS (`jose`); only `CLERK_ALLOWED_USERS` reach `/api/*`. Public apex is open.
**Test**
- `curl -s -o /dev/null -w '%{http_code}\n' https://tax-agent.matchmoments.workers.dev/api/usage` → **401**.
- Sign in at https://app.quillo.au with your Clerk user → `/api/*` works.
- Open https://quillo.au in a private window → public, no auth wall.

## 2. Receipt capture + extract
**What:** Photo → R2 → Claude vision → merchant·amount·GST·date·bucket; confidence gates auto-file vs review.
**Test**
- Phone: https://app.quillo.au → **+ Add receipt** → snap. Expect merchant/amount/GST in ~5s.
- Bulk/offline: `node scripts/feed-expenses.mjs <folder|file>`.
- Inbox → tap the row → fields + receipt image + confidence score.

## 3. Edge cases — multi-shot · USD · duplicates
**What:** Several screenshots = one receipt; foreign currency → `amount_aud_cents` via fx; re-upload de-duped.
**Test**
- Share 2–3 screenshots together → **one** transaction.
- Upload a USD receipt (e.g. Anthropic) → `currency=USD` + AUD amount shown.
- Re-upload the same file → flagged **duplicate**, not double-counted.

## 4. Categorise + correction learning
**What:** Deterministic rule pack (KV) first, Claude fallback; a correction writes a per-user rule.
**Test**
- Inbox → correct a bucket/ATO label → `corrections` + `audit_log` rows.
- Upload a similar merchant → now auto-categorised (rule learned).
- https://app.quillo.au/settings → Per-user rules: confirm it; edit/delete works.

## 5. Statement import + reconciliation
**What:** CSV/PDF → parsed lines → **opening + Σsigned == closing** proof. ✓ balances, or ⚠ off-by-$X with the first bad line.
**Test**
- https://app.quillo.au/accounts → add account → **Upload statement (CSV/PDF)**.
- Expect green ✓ *Balances* OR red ⚠ with the exact diff + bad line index.
- Offline: `npm run eval:statements` (westpac-sample ✓, mismatch-sample ✗).

## 6. Receipt ↔ bank-line matching
**What:** Unmatched receipts vs unmatched bank lines; linking hides the receipt from counting (no double-count).
**Test**
- https://app.quillo.au/reconcile → pick a receipt + its bank line → **Link**.
- Linked receipt leaves *needs review*; **Unlink** restores it.
- Dashboard total unchanged after linking (counted once).

## 7. QBO feed sync — no double-count
**What:** Sync registers QBO bank/card accounts as `source=qbo_feed`; those refuse statement uploads and are excluded from reconcile.
**Test**
- Connect QuickBooks (https://app.quillo.au/quickbooks), then Accounts → **Sync accounts from QuickBooks**.
- A `qbo_feed` account shows **no** *Upload statement* button (guard active).
- QuickBooks reconcile lists only receipt expenses (`kind=receipt`), never bank lines.

## 8. Async batch categorisation + failure handling
**What:** Statements >60 lines → Message Batches API (50% off). Zombie-proof: all-errored→`failed`, >24h submitted→`failed`+notify.
**Test**
- Import a big statement → account shows *categorising…* then *imported (n)*.
- Status polls every 5s while categorising; failure → red **failed** + alert.
- Unit guard: `npm run test:units` (`batchStatementStatus` / `isStaleBatch`).

## 9. Cost / budget meter
**What:** Per-call usage + `$` logged; `MAX_DAILY_COST_CENTS` caps spend; Batch API halves async cost.
**Test**
- `GET /api/usage` → today/month cents + by-feature breakdown.
- Reference costs: 1 receipt ≈ $0.0028; 300-row statement ≈ 2.9¢.
- Set `MAX_DAILY_COST_CENTS` low → confirm the cap blocks further calls.

## 10. Offline regression net
**What:** Deterministic guards on the invariants we keep re-learning — no worker/Claude needed.
**Test**
- `npm test` → 25 unit assertions + 2 statement cases, exit 0.
- `npm run test:units` → reconcile off-by-exact, transfer-conservatism (BPAY/Osko **not** dropped), fingerprint stability, batch transitions.
- `npm run eval:statements` → line accuracy + reconcile pass-rate.

## 11. Dashboard + Reports
**What:** Aggregates by bucket/property; FY report + CSV export for your registered agent.
**Test**
- https://app.quillo.au → Dashboard totals match the ledger.
- https://app.quillo.au/reports → pick FY → company quarters, rental schedule, GST credits.
- Export CSV → hand to your tax/BAS agent (Quillo never lodges).

---

## Known tooling blocker (promptfoo eval gate)
`npm run eval` / `eval:gate` (the promptfoo categorisation eval) currently **cannot run** in this
environment:
- `npx promptfoo@latest` fails with npm cache `EACCES` (`~/.npm/_cacache` permission) and a node
  engine mismatch (promptfoo wants `node ^20.20 || >=22.22`; env has `22.15.1`).
- **Mitigation:** the deterministic `npm test` (units + `eval:statements`) is the live regression
  gate. To restore promptfoo later: fix npm cache perms (`sudo chown -R $(whoami) ~/.npm`) and use
  a node ≥ 22.22, then `npm run eval`.

## Regenerate the diagram
`python3 diagrams/gen_test_arch.py` (rewrites `quillo-test-arch.excalidraw`).
