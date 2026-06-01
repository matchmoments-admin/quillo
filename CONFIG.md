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
   ```
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
gives genuine AU residency (Sydney). The dependency is installed and the seam is written;
activation is deferred because the AWS SDK doesn't bundle cleanly into a Worker (see
`src/llm.ts`).

1. **AWS account** with **Amazon Bedrock** access in **`ap-southeast-2` (Sydney)**;
   request access to **Claude Haiku 4.5** in the Bedrock console (Model access). Confirm the
   exact model id for the region.
2. **IAM user** with `bedrock:InvokeModel` on that model; create an access key pair:
   ```bash
   npx wrangler secret put AWS_ACCESS_KEY_ID
   npx wrangler secret put AWS_SECRET_ACCESS_KEY
   ```
3. **Activate the seam** in `src/llm.ts` (bedrock branch) — either resolve the AWS-SDK
   Worker bundling (wrangler `alias`/`nodejs_compat`) or sign InvokeModel calls directly
   with WebCrypto SigV4. Same `.messages.create` surface, so call sites don't change.
4. **Flip per tenant** (keeps the default Claude for everyone else):
   ```sql
   UPDATE profiles SET inference_provider='bedrock', inference_region='ap-southeast-2'
    WHERE user_id='me';
   ```
   With Bedrock, cross-border (US) consent is no longer required for that tenant.

---

## Other env knobs
- `MAX_EXTRACTIONS_PER_DAY` (`wrangler.toml`, default 200) — per-user daily cap on model
  extractions; raise/lower as needed (0 = unlimited).
- Rule pack — after editing `src/rulepacks/au-v1.json`, push it: `npm run rulepack:push`.
- Clerk — production launch needs a **production Clerk instance** on `clerk.quillo.au`
  (current keys are `pk_test`); `CLERK_ALLOWED_USERS` gates `/api` to the founder until then.
