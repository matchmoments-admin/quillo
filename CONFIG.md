# Quillo — activation config (founder checklist)

The code for these three integrations is **done and deployed**. Each needs an external
account + a few config values you provide. Do them in any order.

> General information only — not tax/financial/legal advice.

---

## 1. QuickBooks (reconcile + push) — Stage 5

The agent is a **reader/reconciler**: company expenses reconcile against your QBO bank
feed; only *non-feed* expenses (cash, an Amex not in QBO) are pushed (user-triggered).

1. **Intuit Developer app** — create one at <https://developer.intuit.com> → an app with
   the **Accounting** scope.
2. **Redirect URI** — in the app's *Keys & Credentials*, add exactly:
   `https://app.quillo.au/api/qbo/callback`
3. **Secrets** (from Keys & Credentials):
   ```bash
   npx wrangler secret put QBO_CLIENT_ID
   npx wrangler secret put QBO_CLIENT_SECRET
   # Optional but recommended — envelope-encrypts the stored OAuth tokens at rest in D1
   # (AES-256-GCM, app-held key). Any high-entropy string; rotating it makes existing rows
   # unreadable until each tenant reconnects, so set it once before connecting.
   npx wrangler secret put QBO_TOKEN_KEY
   ```
   Without `QBO_TOKEN_KEY` set, tokens are stored plaintext (still encrypted at rest by
   Cloudflare); setting it switches new writes to app-layer encryption transparently, and the
   next token refresh upgrades each existing row.
4. **Sandbox vs production** — `wrangler.toml` `QBO_BASE_URL` defaults to the **sandbox**.
   Test against a sandbox company first; flip to `https://quickbooks.api.intuit.com` for prod.
5. **Connect** — sign in to the app → open `https://app.quillo.au/api/qbo/connect` →
   Intuit consent → you're returned to the QuickBooks page. Tokens persist + auto-rotate.
6. **Verify** — QuickBooks page (or `GET /api/qbo/reconcile`) shows your company receipts
   beside the QBO bank feed; the "Push to QuickBooks (non-feed)" button works on a
   company expense.

---

## 2. Email-forward ingestion — forward a receipt by email

Snap → share → email a receipt; it lands in your inbox, no app needed.

1. **Enable Cloudflare Email Routing** on `quillo.au` (Cloudflare dashboard → the
   `quillo.au` zone → **Email** → **Email Routing** → enable; it adds the MX/SPF/DKIM
   records automatically — verify they go green).
2. **Route to the Worker** — Email Routing → **Routes** → add a custom address (or
   catch-all) `receipts+*@quillo.au` (or `receipts@quillo.au`) with action
   **Send to a Worker → `tax-agent`**.
3. **Your mailbox is already mapped** — the seeded tenant has `email_localpart = 'me'`, so
   `receipts+me@quillo.au` routes to you. (For a different localpart, update
   `tenants.email_localpart`.)
4. **Verify** — forward a receipt (with the image attached) to `receipts+me@quillo.au`;
   it appears in the inbox within a few seconds. Bodies with no attachment go through the
   bank-alert parser.

---

## 3. Bedrock AU data residency — keep Claude until this is set up

Today inference runs on **Claude (US Anthropic)** with your recorded APP-8 consent. Bedrock
gives genuine AU residency (Sydney). **The seam is now fully built** (WebCrypto SigV4 in
`src/llm.ts` + `src/lib/sigv4.ts`, no `@aws-sdk/*`) and is **flag-gated/inert**: it stays off
until a tenant (or `DEFAULT_INFERENCE_PROVIDER`) is set to `bedrock` AND the AWS secrets below are set. Claude (US) remains the
default; flipping a tenant without secrets fails loudly (it won't silently use the US provider).

1. **AWS account** with **Amazon Bedrock** access. Request **Claude Haiku 4.5** under Model access
   in **both `ap-southeast-2` (Sydney) and `ap-southeast-4` (Melbourne)** — the `au.` profile routes
   across both, so enabling only Sydney produces *intermittent* failures. Anthropic models also
   require submitting the **use-case details form** before the first call, or InvokeModel returns
   `ResourceNotFoundException: Model use case details have not been submitted`.

   **Each Anthropic model also needs an AWS Marketplace agreement**, created the first time someone
   with `aws-marketplace:Subscribe` calls it. The cleanest way is one message in the Bedrock
   **Playground** as root, in Sydney, per model. Until then every InvokeModel returns *"Model access is
   denied … not authorized to perform the required AWS Marketplace actions"*, even for root.
   **Gotcha (2026-10-22):** if root gets that error too, check *Billing → Payment preferences →
   Payment currency*. Marketplace can't complete the agreement while it says "No currency selected"
   (an AWS Australia account offers only AUD). Check progress with
   `aws bedrock get-foundation-model-availability --region ap-southeast-2 --model-id anthropic.claude-haiku-4-5-20251001-v1:0`:
   `agreementAvailability.status` goes from `NOT_AVAILABLE` to `AVAILABLE`. Haiku 4.5 was accepted
   2026-10-22; Sonnet models are not yet.

   **Pricing:** the `au.` geographic profile bills at **+10%** over the global rate (Haiku 4.5: $1.10 in,
   $5.50 out, $0.11 cache read, $1.375 cache write per million tokens), through AWS Marketplace in AUD on
   the account's card. Promotional credits likely don't cover it. `PRICING` in `src/lib/usage.ts` uses
   the geo rate.

   **Verified against the live account 2026-08-03** (`aws bedrock get-inference-profile`): the id is
   `au.anthropic.claude-haiku-4-5-20251001-v1:0`, status ACTIVE, and it *"routes requests to Claude
   Haiku 4.5 in ap-southeast-2, ap-southeast-4"* — Australia only, **no New Zealand**. That region
   list is mirrored in `AU_DESCRIPTOR.residency.regions` and pinned by a golden. If AWS ever widens
   the `au.` geography to ANZ, the list must **not** silently follow: "ANZ" is not "Australia" for a
   Privacy Safeguard 8 claim.

   The model id is derived per jurisdiction (`bedrockModelIdFor`), not hardcoded. Adding a
   jurisdiction requires a matching `PRICING` entry in `src/lib/usage.ts` or `npm test` fails (#80).
2. **IAM user PER JURISDICTION.** Credentials are suffixed with the jurisdiction code
   (`JurisdictionDescriptor.residency.credentialSuffix`), and the unsuffixed pair is the fallback
   for a single-jurisdiction deployment:
   ```bash
   npx wrangler secret put AWS_ACCESS_KEY_ID_AU
   npx wrangler secret put AWS_SECRET_ACCESS_KEY_AU
   ```
   **Why per jurisdiction:** each key's policy denies Bedrock outside its own regions, so an
   application bug cannot route one country's data into another's Bedrock. A single key allowed in
   every supported region would make IAM permit both, leaving the guarantee resting entirely on
   application correctness — which is what IAM exists to backstop.
3. **Enforce residency in IAM.** The deployed policy is **`QuilloBedrockAuInvoke`** (account
   `417755753627`): `bedrock:InvokeModel` allowed ONLY on the `au.` inference-profile ARN plus the
   Sydney and Melbourne foundation-model ARNs, with an **explicit Deny** on `bedrock:*` wherever
   `aws:RequestedRegion` is outside `ap-southeast-2` / `ap-southeast-4`.
   > Earlier revisions of this file recommended an **SCP**. SCPs require AWS Organizations; this is
   > a standalone account, so the identity-based Deny above is the equivalent control. Verified
   > 2026-08-03: a `us-east-1` invoke was refused with
   > *"explicit deny in an identity-based policy: QuilloBedrockAuInvoke"*.

   Verify ongoing via CloudTrail (`additionalEventData.inferenceRegion`).
4. **Per-locale region.** `DEFAULT_INFERENCE_REGION` is deliberately **unset** in `wrangler.toml`, so a
   tenant's region comes from its jurisdiction descriptor (AU ⇒ `ap-southeast-2`, UK ⇒ `eu-west-2`).
   Setting it is a global override, and a region outside a tenant's jurisdiction fails closed.
5. **Prove it live:**
   - `npm run probe:bedrock` sends a receipt image, a statement PDF, an Ask call and a prompt-cache
     repeat through the real extractors, and checks a CDR-tainted tenant is refused on the US provider.
   - `npm run eval:bedrock` runs the categorisation eval on the `au.` profile, comparable with `npm run eval`.

   First run on 2026-10-22: probe 5/5, and the eval scored 9/12 on Bedrock and on Anthropic with the
   same three failures.
6. **Flip per tenant** (keeps the default Claude for everyone else):
   ```sql
   UPDATE profiles SET inference_provider='bedrock', inference_region='ap-southeast-2'
    WHERE user_id='me';
   ```
   With Bedrock, cross-border (US) consent is no longer required for that tenant (the consent gate
   already exempts the bedrock path), and Settings shows "Processed in Australia 🇦🇺".
7. **Or flip the default:** `DEFAULT_INFERENCE_PROVIDER = "bedrock"` in `wrangler.toml`, then deploy.
   Every tenant without an explicit override moves to Bedrock. Today every `getLLM` call site passes
   the AU descriptor, so that means the `au.` profile. `/api/situation` sends the *resolved* provider,
   so the SPA skips the US-consent step without writing the column.
   - **Before flipping**, check `SELECT COUNT(*) FROM batch_jobs WHERE status='submitted'` is 0. An
     in-flight Anthropic batch can't be polled through a Bedrock client and would end up `failed` after 24h.
   - **To revert**, first pin the tenants who never gave US consent, so they don't hit a consent wall
     (or, if CDR-tainted, a residency refusal):
     `UPDATE profiles SET inference_provider='bedrock' WHERE inference_provider IS NULL AND (cdr_tainted=1 OR consent_xborder IS NOT 1);`
     Then set the var back to `anthropic` and run `npm run deploy`. A dashboard edit is overwritten by the next deploy.

> **Retries:** Bedrock calls retry 429/500/502/503/504 up to twice, with jittered backoff, on the
> **same** region and profile; they never reroute. Each retry logs `bedrock_retry` to Workers Logs. Each
> attempt has a 300s timeout, and a timeout is not retried (the first request may still be billing).
>
> **Large imports:** with no Batch API, a Bedrock statement import categorises live in the upload
> request, three 40-line chunks at a time. Moving very large imports (1,000+ lines) onto a DO-alarm
> continuation is tracked separately.
>
> **Currency:** the spend caps and `daily_cost` are in USD at the rate card, but AWS invoices Bedrock in
> AUD, so the invoice reads about 1.5× the dashboard figure. The user's wallet is AUD too, so each debit
> converts first: cost × `USD_TO_AUD_RATE` (1.55, wrangler.toml) × (1 + `COST_MARKUP_PCT`/100). The rate
> is fixed; update it if AUD/USD moves about 5% or more.

> **Note:** Bedrock has no Anthropic Batch API, so Bedrock tenants always categorise in **live**
> mode (sequential per-chunk) — large imports run synchronously rather than via the async batch.

---

## Other env knobs
- `MAX_EXTRACTIONS_PER_DAY` (`wrangler.toml`, default 200) — per-user daily cap on model
  extractions; raise/lower as needed (0 = unlimited).
- Rule pack — after editing `src/rulepacks/au-v1.json`, push it: `npm run rulepack:push`.
- Clerk — production launch needs a **production Clerk instance** on `clerk.quillo.au`
  (current keys are `pk_test`); `CLERK_ALLOWED_USERS` gates `/api` to the founder until then.
