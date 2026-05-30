# tax-agent

Self-Improving Tax Agent — a Cloudflare Worker that ingests receipts (email / web /
mobile), extracts + categorises them with Claude vision into PAYG / company /
property buckets, writes the company bucket to a swappable ledger (QuickBooks), and
logs every correction for a self-improvement loop.

> **General information only — not tax, financial, or legal advice.** Confirm all
> BAS/company tax treatment and deductibility with a registered tax/BAS agent.

Full design + the critique that shaped this build live in
`../agent-fleet/docs/tax-agent-build-plan.md`.

## Architecture decisions (locked)

| Decision | Choice |
|---|---|
| Deployment | **Separate Worker** (own trust model + residency story) |
| Runtime | Cloudflare **Agents SDK** (`agents` pkg) — one `TaxAgent` Durable Object per tenant |
| Store | D1 (relational system-of-record) + R2 (receipts) + KV (nonces, caches, rule packs) |
| Inference | **US Anthropic now**, behind the `getLLM()` seam → flip to **Bedrock Sydney** later per-tenant |
| Tenancy | **Multi-tenant-shaped**; per-tenant ingest key derives identity (you = tenant #1) |
| Ledger | Direct **QuickBooks REST** adapter (not MCP), behind `LedgerAdapter` |

## The three seams that make "start simple, switch later" cheap

1. **`src/llm.ts` — inference factory.** Every Claude call goes through `getLLM(profile)`.
   Switching a tenant to AU-resident Bedrock is a config field + ~10 lines (the seam is
   written, commented, and throws until wired). No call-site changes.
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
| — | **Android app** (share-sheet + quick-snap + optional Wallet self-test) | ✅ scaffolded in [`android/`](android/README.md) — build in Android Studio |
| — | iOS Shortcut | client-side, see build plan §4c (no app needed) |

## First-run: create resources, deploy, test

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

# 6) Record cross-border consent (US inference path), signed like /ingest — or set
#    profiles.inference_provider='bedrock' to avoid US processing entirely.

# 7) Test the ingest → extract loop with a real receipt
node scripts/upload.mjs https://tax-agent.<you>.workers.dev/ingest <keyId> <secret> receipt.jpg image/jpeg
#   then inspect:
wrangler d1 execute tax-agent-db --command \
  "SELECT merchant, amount_cents, bucket, ato_label, confidence, status FROM transactions ORDER BY created_at DESC LIMIT 5"
```

Email ingest: enable Cloudflare Email Routing on your domain and route
`receipts+me@<yourdomain>` to this Worker (see build plan §4a).
