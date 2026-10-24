# Quillo — activation config (founder checklist)

The code for these three integrations is **done and deployed**. Each needs an external
account + a few config values you provide. Do them in any order.

> **Status (2026-10-24, map #692):** QuickBooks (§1) and the email mailbox (§2) are **retired** behind
> the `qbo_retired` and `mailbox_retired` flags, and Bedrock AU (§3) is the **default** provider. §1 and §2
> are kept for history and for undoing a retirement.

> General information only — not tax/financial/legal advice.

---

## 1. QuickBooks (reconcile + push) — Stage 5

> **Retired 2026-10-24** (flag `qbo_retired`, PR #791, map #692). Every `/api/qbo/*` route, including
> the public OAuth callback, answers 404 before touching Intuit, KV state or stored tokens, and the SPA
> hides every QuickBooks surface. Stored `qbo_connections`, `qbo_feed` accounts and ledger refs are kept,
> and account erasure still revokes. Undo: remove `qbo_retired` from `FEATURES` and deploy. The steps
> below only apply if that is ever done.

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

> **Retired 2026-10-24** (flag `mailbox_retired`, PR #789, map #692; the sender-check issue #711 closed as
> not planned). The Worker's `email()` handler bounces every message ("upload receipts and documents in
> the Quillo app instead") before the MIME parse, the tenant lookup or any write, logging only the byte
> size (`src/lib/mailbox-retired.ts`). The ingest code and `tenants.email_localpart` are kept. Undo:
> remove `mailbox_retired` from `FEATURES` and deploy, but only after the #711 sender check is built.

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

## 3. Bedrock AU data residency (the default since 2026-10-24)

**Since 2026-10-24 the default is Bedrock** (`DEFAULT_INFERENCE_PROVIDER = "bedrock"`, map #692, PR #745):
every tenant without an explicit override runs on the `au.` profile in ap-southeast-2, with no cross-border
consent. **Do not roll back by just setting the var to `"anthropic"`**: follow
[Rolling back to Anthropic (US)](#rolling-back-to-anthropic-us) below.

**History.** Bedrock gives genuine AU residency (Sydney). The seam (WebCrypto SigV4 in `src/llm.ts` +
`src/lib/sigv4.ts`, no `@aws-sdk/*`) was first built inert: until 2026-10-24 Claude (US) was the default
and a tenant only moved to Bedrock when its row (or the var) said `bedrock` and the AWS secrets below
were set. A tenant on Bedrock without secrets fails loudly (it never silently uses the US provider). The
setup steps below are kept for a fresh account or a new jurisdiction.

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
   Production today has only the unsuffixed fallback pair (`AWS_ACCESS_KEY_ID` /
   `AWS_SECRET_ACCESS_KEY`, checked 2026-10-24), which is fine while AU is the only jurisdiction; set
   the suffixed pair before adding a second one.

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
6. **Flip per tenant** (historical: how the owner tenant moved before the default flipped):
   ```sql
   UPDATE profiles SET inference_provider='bedrock', inference_region='ap-southeast-2'
    WHERE user_id='me';
   ```
   With Bedrock, cross-border (US) consent is not required for that tenant (the consent gate in
   `aiCall`, `src/lib/ai-call.ts`, only applies to the `anthropic` provider), and Settings shows
   "Processed in Australia". The owner row `me` still carries this explicit value today.
7. **Flip the default** (done 2026-10-24): `DEFAULT_INFERENCE_PROVIDER = "bedrock"` in `wrangler.toml`,
   then deploy. Every tenant without an explicit `profiles.inference_provider` moves to Bedrock. Today
   every `getLLM` call site passes the AU descriptor, so that means the `au.` profile. `/api/situation`
   sends the *resolved* provider, so the SPA skips the US-consent step without writing the column.
   Before flipping, `SELECT COUNT(*) FROM batch_jobs WHERE status='submitted'` must be 0: an in-flight
   Anthropic batch can't be polled through a Bedrock client and would end up `failed` after 24h.

### Rolling back to Anthropic (US)

This is the only supported rollback. Setting the var back on its own is **unsafe**:

- Every tenant who signed up after the flip has `inference_provider IS NULL` and
  `consent_xborder = 0` (they were never asked). With the default back on `anthropic`, `aiCall` would put
  the US-consent wall in front of every one of them on their next AI action.
- A CDR-tainted tenant (`profiles.cdr_tainted = 1`, one-way) resolving to `anthropic` is refused by
  `getLLM` (Privacy Safeguard 8), so their AI would stop working rather than fall back.
- The owner tenant has an explicit `inference_provider = 'bedrock'` (step 6), and `resolveProvider`
  lets the row beat the var, so the var change would not move it at all.

Steps, in order:

1. **Pin the tenants who never consented** to Bedrock, so they keep working with no consent wall:
   ```sql
   UPDATE profiles SET inference_provider='bedrock'
    WHERE COALESCE(consent_xborder,0)=0 AND inference_provider IS NULL;
   ```
2. **Keep CDR-tainted tenants on Bedrock**, including any that did give US consent:
   ```sql
   UPDATE profiles SET inference_provider='bedrock'
    WHERE cdr_tainted=1 AND inference_provider IS NULL;
   ```
   Check none is explicitly on the US path: `SELECT COUNT(*) FROM profiles WHERE cdr_tainted=1 AND
   inference_provider='anthropic'` must be 0.
3. **Flip the var**: set `DEFAULT_INFERENCE_PROVIDER = "anthropic"` in `wrangler.toml` and run
   `npm run deploy`. A dashboard edit is overwritten by the next deploy. Only tenants left with a NULL
   provider (those who had recorded US consent and hold no CDR data) move to the US.
4. **The owner row** stays on Bedrock because of its explicit value. To move it too, the owner must
   have recorded US consent first; then `UPDATE profiles SET inference_provider=NULL WHERE user_id='me'`
   (or `'anthropic'`).
5. Verify: `SELECT inference_provider, COALESCE(consent_xborder,0) c, cdr_tainted, COUNT(*) FROM profiles
   GROUP BY 1,2,3`: no row may resolve to `anthropic` with `c = 0` or `cdr_tainted = 1`.

Rolling forward again later is the step 7 flip; the pinned rows keep `bedrock` either way.

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
