# tax-agent — setup & configuration checklist

Run `npm run preflight` at any point to see what's still unconfigured (it never prints
secret values). Items are ordered; **[now]** = needed to run the core agent, **[later]** =
only for a specific track.

## 1. Local tooling [now]
- Node 20+, then `npm install`.
- `npm install -g wrangler` (or use `npx wrangler`), then `wrangler login`.

## 2. Cloudflare account + resources [now]
- A Cloudflare account on the **Workers Paid** plan ($5/mo — Durable Objects + cron need it).
- Create the three stores and paste the returned IDs into `wrangler.toml`:
  ```bash
  wrangler d1 create tax-agent-db          # -> [[d1_databases]].database_id
  wrangler kv namespace create RULES       # -> [[kv_namespaces]].id
  wrangler r2 bucket create tax-agent-receipts
  ```
- Apply the schema: `npm run schema` (or `npm run schema:local` for the local dev DB).

## 3. Inference credentials [now — pick one]
- **US Anthropic (simplest):** `wrangler secret put ANTHROPIC_API_KEY`. Requires an APP-8
  cross-border consent record per tenant before the first receipt is read (see step 5).
- **AU-resident (Bedrock Sydney):** set the tenant's `inference_provider='bedrock'` and add
  AWS creds (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`); wire the Bedrock branch in
  `src/llm.ts` and confirm Haiku 4.5 is enabled in `ap-southeast-2`. Required for any
  CDR-sourced data (Privacy Safeguard 8).

## 4. Onboard yourself (register your situation) [now]
- Copy `situation.example.json`, edit it for your real employment / novated lease / company
  (ABN, GST) / properties / per-user rules, then:
  ```bash
  node scripts/onboard.mjs --file my-situation.json --with-key      # add --local for the dev DB
  ```
- Save the printed `KEY_ID` / `SECRET` — they go into the Android app and `scripts/upload.mjs`.

## 5. Consent (US inference path) [now, unless using Bedrock]
- Record APP-8 cross-border consent (signed like `/ingest`):
  `POST /consent {"text":"<what you consented to>","method":"web"}`. Until then, receipts
  are held with status `blocked_consent`.

## 6. Deploy [now]
- `npm run deploy`. Smoke-test: `node scripts/upload.mjs https://<worker>/ingest <KEY_ID> <SECRET> receipt.jpg`,
  then check the `transactions` table.

## 7. Email Routing [now-ish]
- Cloudflare dashboard → Email → Email Routing → enable on your domain → route
  `receipts+<localpart>@yourdomain` to the `tax-agent` Worker. The `<localpart>` must match
  your tenant's `email_localpart`.

## 8. QuickBooks (company-bucket track) [later]
- A **QuickBooks Online subscription** (Simple Start now; $5 Ledger later via an accountant).
- A free **Intuit Developer** account → create an app → copy **Client ID / Secret**:
  `wrangler secret put QBO_CLIENT_ID` / `QBO_CLIENT_SECRET`. Build against the **sandbox** base
  URL (already the default in `wrangler.toml`); flip to production when ready.
- Run the OAuth connect to capture the realm + rotating tokens into `qbo_connections`
  (the agent reads/reconciles — it does **not** write duplicate purchases).

## 9. Eval CI gate [later]
- Add `ANTHROPIC_API_KEY` to **GitHub repo secrets** so `.github/workflows/evals.yml` can run.
- After the first `npm run eval`, set the real `passRate` in `evals/baseline.json`.

---
**General information only — not tax advice.** Confirm BAS / company treatment, deductibility,
and any CDR/privacy obligations with a registered tax/BAS agent and a privacy specialist.
