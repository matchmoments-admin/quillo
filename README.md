# tax-agent

Self-Improving Tax Agent — a Cloudflare Worker that ingests receipts (web /
mobile), extracts + categorises them with Claude vision into PAYG / company /
property buckets, and logs every correction for a self-improvement loop.

> **Current state (2026-10-24, map #692).** Inference runs on **Bedrock AU** (`au.` profile,
> ap-southeast-2) by default for every tenant. The **receipt mailbox** (`mailbox_retired`) and
> **QuickBooks** (`qbo_retired`) are **retired** behind flags: inbound email bounces and every
> `/api/qbo/*` route returns 404. The QuickBooks and email sections below are history. See
> [CONFIG.md](CONFIG.md).

> **General information only — not tax, financial, or legal advice.** Confirm all
> BAS/company tax treatment and deductibility with a registered tax/BAS agent.

Full design + the critique that shaped this build live in
`../agent-fleet/docs/tax-agent-build-plan.md`.

## QuickBooks integration: reader/reconciler (NOT writer) — retired

> **Retired 2026-10-24** (flag `qbo_retired`, PR #791). Kept as history; undoing it is one flag.

The agent captures and categorises company expenses but **does not auto-create Purchase
objects in QuickBooks Online**. Bank feeds are the source of truth in QBO: if the agent
also creates a Purchase, it produces a duplicate posting once the bank feed brings in the
same transaction. Instead:

- Company-bucket receipts are stored in D1 and a notification is sent for reconciliation.
- `GET /api/qbo/reconcile` surfaces both captured receipts and recent QBO bank-feed
  purchases side-by-side so you can match them manually.
- `QuickBooksAdapter.pushExpense()` is retained in the codebase for genuine cash /
  non-feed expenses (petty cash, etc.) but is NOT called from the extraction hot path.

## Architecture decisions (locked)

| Decision | Choice |
|---|---|
| Deployment | **Separate Worker** (own trust model + residency story) |
| Runtime | Cloudflare **Agents SDK** (`agents` pkg) — one `TaxAgent` Durable Object per tenant |
| Store | D1 (relational system-of-record) + R2 (receipts) + KV (nonces, caches, rule packs) |
| Inference | **Bedrock Sydney (`au.`) by default since 2026-10-24**, behind the `getLLM()` seam; US Anthropic remains selectable per tenant (with APP-8 consent) |
| Tenancy | **Multi-tenant-shaped**; per-tenant ingest key derives identity (you = tenant #1) |
| Ledger | Direct **QuickBooks REST** adapter (not MCP), behind `LedgerAdapter` (retired 2026-10-24, `qbo_retired`) |

## The three seams that make "start simple, switch later" cheap

1. **`src/llm.ts` — inference factory.** Every Claude call goes through `getLLM(profile)`.
   Switching to AU-resident Bedrock is config only: a tenant's `inference_provider`, or
   `DEFAULT_INFERENCE_PROVIDER` for everyone (`bedrock` since 2026-10-24; see CONFIG.md §3 before
   changing it back). No call-site changes. Every model call is fronted by `aiCall`
   (`src/lib/ai-call.ts`), which enforces APP-8 consent and the AI budget in one place.
2. **`src/ingest/auth.ts` — per-tenant keyed HMAC.** Identity is derived from the key
   that verifies the signature, never a client header. One tenant now; add a row + key later.
3. **`src/ledger/*` — `LedgerAdapter`.** Agent logic only calls `pushExpense`/`resolveAccount`.
   QuickBooks today; Xero stub left for later.

## Security/correctness fixes baked in (from the review)

- **B1** tenant identity derived from verified key, not `x-user-id`.
- **B2** corrections restricted to an allowlist → fixed SQL columns (no injection).
- **B3** ingest HMAC covers `timestamp.nonce.body`, ±60s window, single-use nonce (KV).
- **B5** `locationHint:"oc"` documented as latency-only; residency = Bedrock, not the DO.
- **H1** email attachments via `postal-mime`. **H2** chunked base64 (no stack overflow).
- **H3** extraction awaited inside the DO lifetime (no `ctx.waitUntil` no-op).
- **H4** extraction via forced tool-use (schema-enforced), not regex JSON parsing.
- **H5** QBO refresh token rotates → persisted to D1 per tenant, never a static secret.
- **H6** AU GST tax codes resolved per-file/cached, not hardcoded US `TAX`/`NON`.
- **H7** explicit, dated APP-8 consent gate before any US inference call.

## Build status (pilot order)

| Stage | Scope | Status |
|---|---|---|
| 1 | Worker skeleton, DO, schema, per-tenant auth | ✅ done, typechecks |
| 2 | Secure ingest (HMAC ts+nonce, email, chunked b64) | ✅ done |
| 3 | Extraction (Haiku vision, tool-use, redact, consent gate) | ✅ done |
| 4 | Corrections (allowlist), hash-chain audit, eval promotion | ✅ done |
| 5 | QuickBooks REST adapter (token rotation, tax codes) | ⚠️ implemented, **untested** — needs OAuth (Stage 0) |
| 6 | Proactive cron + self-improvement loop | 🟡 minimal scan in place; eval re-run loop TODO |
| — | **Web UI** (review inbox + correct) | ✅ Phase 0+1 in [`web/`](web/) — served from the Worker via `[assets]`, behind Cloudflare Access. Dashboard/settings/QBO/export phases queued |
| — | **Android app** (share-sheet + quick-snap + optional Wallet self-test) | ✅ scaffolded in [`android/`](android/README.md) — build in Android Studio |
| — | iOS Shortcut | client-side, see build plan §4c (no app needed) |

## First-run: create resources, deploy, test

**See [`SETUP.md`](SETUP.md) for the full ordered config checklist** (Cloudflare resources,
secrets, onboarding, consent, Email Routing, QuickBooks, CI). Run `npm run preflight` any
time to see what's still unconfigured.

**Register your situation** (properties, company, employment, novated lease, per-user rules):
copy `situation.example.json`, edit it, then `node scripts/onboard.mjs --file my-situation.json --with-key`.
This is what lets the agent pick the right bucket *and* the right property.

**Stage 0 (you, external):** create the QuickBooks Online + Intuit Developer
accounts and complete OAuth (only needed for Stage 5). Not required to test 1–4.

```bash
npm install

# 1) Create Cloudflare resources, paste the printed IDs into wrangler.toml
wrangler d1 create tax-agent-db
wrangler r2 bucket create tax-agent-receipts
wrangler kv namespace create RULES

# 2) Apply the schema
npm run schema

# 3) Secrets
wrangler secret put ANTHROPIC_API_KEY
# (QBO_CLIENT_ID / QBO_CLIENT_SECRET only when wiring Stage 5)

# 4) Seed yourself as tenant #1 (prints SQL + a key_id/secret to save)
node scripts/seed-tenant.mjs me me web
#   run the three printed INSERTs:  wrangler d1 execute tax-agent-db --command "<stmt>"

# 5) Deploy
wrangler deploy

# 6) Bedrock AU is the default, so no cross-border consent is needed. Only a tenant moved to the
#    US provider must record APP-8 consent first, signed like /ingest.

# 7) Test the ingest → extract loop with a real receipt
node scripts/upload.mjs https://tax-agent.<you>.workers.dev/ingest <keyId> <secret> receipt.jpg image/jpeg
#   then inspect:
wrangler d1 execute tax-agent-db --command \
  "SELECT merchant, amount_cents, bucket, ato_label, confidence, status FROM transactions ORDER BY created_at DESC LIMIT 5"
```

Email ingest is **retired** (`mailbox_retired`, PR #789): the Worker bounces inbound mail. Historically
you enabled Cloudflare Email Routing and routed `receipts+me@<yourdomain>` to this Worker.

## Feeding expenses in bulk (testing)

`scripts/feed-expenses.mjs` is a batch test client over the signed `/ingest` endpoint.
Point it at a **folder of receipts** (vision/OCR path) or a **`.txt` of expense lines**
(typed → Claude categorises each into a bucket), and it prints the resulting
transactions table.

```bash
# pull the signing secret for your key, then feed expenses
SECRET=$(wrangler d1 execute tax-agent-db --remote --json \
  --command "SELECT secret FROM tenant_keys WHERE key_id='<keyId>'" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['results'][0]['secret'])")

# a folder of receipt images/PDFs (jpg/png/webp/gif/pdf):
node scripts/feed-expenses.mjs https://app.quillo.au <keyId> "$SECRET" ~/receipts

# a text file, one expense per line (e.g. "Officeworks 45.00 printer paper"):
node scripts/feed-expenses.mjs https://app.quillo.au <keyId> "$SECRET" expenses.txt

# test the conservative bank-alert parser instead of Claude categorisation:
node scripts/feed-expenses.mjs https://app.quillo.au <keyId> "$SECRET" alerts.txt --alert
```

Ingest paths (all signed; tenant derived from the key, never a client header):

| Input | `content-type` / header | Handler | Result |
|---|---|---|---|
| Receipt image/PDF | `image/*`, `application/pdf` | `ingest` → vision | bucket + ato_label + GST |
| Typed expense | `text/*` | `ingestCategoriseText` → Claude | bucket + ato_label |
| Bank-alert text | `text/*` + `x-parse: alert` | `ingestText` → parser | merchant + amount, `needs_review` |

> **HEIC** (default iPhone format) isn't supported by the vision API — convert first:
> `sips -s format jpeg in.heic --out out.jpg`. The script warns and skips HEIC.

Review/correct in the UI at the app host (`/api/transactions`, `/api/dashboard`,
`POST /api/correct`). Each correction logs to `corrections` + the `audit_log`
hash-chain and feeds the self-improvement loop.

## Handling the messy cases

- **Foreign currency.** Extraction captures the original `currency` + amount; a daily ECB
  rate (`src/lib/fx.ts`, KV-cached) gives an AUD estimate (`amount_aud_cents`). Reports sum
  AUD so currencies never mix. The authoritative AUD is the reconciled QBO bank-feed line.
  Overseas / non-AUD supplies carry **no AU GST** (no more hallucinated 10%).
- **Duplicates.** Identical receipt bytes are detected by `image_hash`; the repeat is marked
  `duplicate` (linked to the original) and skips the model call. Delete it from the inbox.
- **Multi-screenshot / multi-page.** Select several images in one upload → one transaction
  (`ingestImages` → a single multi-image extract). Same path covers multi-page PDFs.
- **Delete.** `DELETE /api/transactions/:id` hard-deletes the row + R2 image(s), keeping an
  `audit_log` breadcrumb.
- **Dates / tax year.** AU FY (Jul–Jun) is derived from `txn_date`; undated receipts are
  surfaced (never silently dropped) and the date is editable so they land in an FY.
- **QuickBooks (reader/reconciler, retired 2026-10-24).** Company expenses on a **connected** account were
  reconciled against the bank feed (never auto-posted — avoids duplicates). For a **non-feed**
  expense (cash, an Amex not in QBO), `POST /api/qbo/push/:txnId` posts a Purchase
  (user-triggered, idempotent, AUD). Connect first via `/api/qbo/connect`.
