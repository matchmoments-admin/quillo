# Secrets and token encryption (security A4, #637)

Evidence for CDR Rules Schedule 2 (cryptographic key management, encryption of data at rest) and for
the privacy policy's §6 Security claim. Last checked 2026-10-08.

## 1. QuickBooks token encryption

QuickBooks OAuth tokens (`qbo_connections.access_token` / `refresh_token`) are the only third-party
credentials stored per user. Cloudflare encrypts D1 at rest. On top of that, `src/lib/token-crypto.ts`
seals both tokens with **AES-256-GCM** under the `QBO_TOKEN_KEY` Worker secret. Each value gets a
fresh 12-byte IV, stored as `base64(iv ++ ciphertext+tag)`. `enc_ver` on the row records the format:
0 = legacy plaintext, 1 = sealed.

| Control | Where | Test |
|---|---|---|
| One write path for tokens (connect + refresh) | `sealTokenPair` in `src/lib/token-crypto.ts`, called by `src/lib/qbo-oauth.ts` and `src/ledger/qbo.ts` | `npm run test:units`, section "token-crypto fail-closed + QBO token backfill (#637)" |
| Fail closed: no key means no token is stored | flag `qbo_token_fail_closed`. Connect returns 503 before the user is sent to Intuit, the callback refuses before the code exchange, and a refresh refuses before Intuit rotates the token | same section |
| Plaintext detection | `enc_ver` column. The backfill double-checks with the GCM authentication tag (`looksSealedWith`); a plaintext value never authenticates | same section |
| Re-encrypt legacy rows | `POST /api/admin/qbo-token-backfill` (`src/lib/qbo-token-backfill.ts`), admin-only, idempotent, outputs counts only | same section (dry run, no-key refusal, seal, relabel, idempotent re-run, concurrent-refresh skip) |
| Tokens never leave the server | `qboStatus` returns no tokens; data export redacts them (`SECRET_COLUMNS` in `src/lib/retention.ts`); tokens are never logged | existing `redactSecrets` unit test |
| Disconnect deletes and revokes | `revokeAndDisconnect` in `src/lib/qbo-oauth.ts` | — |

**State on 2026-10-08:** `QBO_TOKEN_KEY` is **not set** in production, and prod `qbo_connections` has
**0 rows** (read-only query). Nothing is stored in plaintext today, but the next QuickBooks connect would be.

### Activation order (coordinator runs these; this order matters)

1. **Set the secret.** Generate a 32-byte key and store it only in Cloudflare (and a password manager
   for recovery; losing it means every user has to reconnect QuickBooks):
   ```sh
   openssl rand -base64 32          # copy the output
   npx wrangler secret put QBO_TOKEN_KEY   # paste it at the prompt
   ```
   From this point every new connect or refresh is sealed (enc_ver=1).
2. **Run the backfill.** Admin-only, so call it with a Clerk session token from a signed-in admin.
   In the browser console on app.quillo.au run `await Clerk.session.getToken()`, then:
   ```sh
   TOKEN='<paste>'
   curl -s -X POST -H "Authorization: Bearer $TOKEN" 'https://app.quillo.au/api/admin/qbo-token-backfill?dry_run=1'
   curl -s -X POST -H "Authorization: Bearer $TOKEN" 'https://app.quillo.au/api/admin/qbo-token-backfill'
   curl -s -X POST -H "Authorization: Bearer $TOKEN" 'https://app.quillo.au/api/admin/qbo-token-backfill?dry_run=1'   # expect plaintext: 0
   ```
   Output is counts only: `total, plaintext, sealed_now, relabelled, skipped_concurrent, sealed_ok,
   sealed_undecryptable, errors`. A real run without the key returns 409. Re-running is a no-op.
   Cross-check with a read-only query:
   `npx wrangler d1 execute tax-agent-db --remote --command "SELECT enc_ver, COUNT(*) FROM qbo_connections GROUP BY enc_ver"`.
3. **Enable fail-closed.** Add `qbo_token_fail_closed` to `FEATURES` in `wrangler.toml` and deploy.
   From then on, if the key ever disappears, QuickBooks connect fails with a clear error instead of
   storing plaintext.

Key rotation is not automated. To rotate, set a new key; rows sealed under the old key then show as
`sealed_undecryptable` and those users must reconnect. With 0 connections that costs nothing today.

## 2. CDR bank feeds store no per-user credentials

Confirmed from the code on 2026-10-08:

- **Fiskil** (`src/lib/fiskil.ts`): `FISKIL_CLIENT_ID`/`FISKIL_CLIENT_SECRET` are exchanged for a
  15-minute, **app-scoped** JWT that is cached only in isolate memory (`tokenCache`) and never written to
  D1 or KV. The browser sees only Fiskil's hosted `auth_url`.
- **Basiq** (`src/lib/basiq.ts`, declined, kept dark): the app-scoped `SERVER_ACCESS` token is cached
  in isolate memory only. The per-consumer `CLIENT_ACCESS` token is minted per consent screen and is
  never cached, stored or logged.
- **What D1 does store** (`bank_connections`, `bank_connection_accounts`, `bank_sync_runs`, `profiles.bank_provider_user_id`):
  provider user, connection and account ids, the last four digits of an account number, consent scope
  and dates, and an opaque paging cursor. None of these can authenticate to a bank or to the aggregator
  without our server-side keys.
- No token column exists in any bank table (`migrations/0075`, `0076`, `0085`, `0086`).

## 3. Secrets inventory

Sources: `src/env.ts` and its uses in `src/`, the `wrangler.toml` secrets comment, and
`npx wrangler secret list` (read-only, run 2026-10-08).

| Secret | Read in code | In wrangler.toml notes | Set in prod | Action |
|---|---|---|---|---|
| ANTHROPIC_API_KEY | `src/llm.ts` | yes | yes | keep |
| AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY | `src/llm.ts` | yes | yes | keep |
| AWS_*_AU / AWS_*_UK | `src/llm.ts` (per-jurisdiction override) | AU added | no | optional; unsuffixed pair is the fallback |
| QBO_CLIENT_ID / QBO_CLIENT_SECRET | `src/lib/qbo-oauth.ts`, `src/ledger/qbo.ts` | yes | yes | keep |
| **QBO_TOKEN_KEY** | `src/lib/token-crypto.ts` | added | **no** | **set it** (§1) |
| STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET | `src/lib/stripe.ts`, `src/index.ts` | yes | yes | keep |
| GOOGLE_PLACES_KEY | `src/lib/phi-providers.ts` | added | yes | keep |
| MAPS_EMBED_KEY | `src/api.ts` (public by design) | added | yes | keep; restrict by HTTP referrer |
| FISKIL_CLIENT_ID / FISKIL_CLIENT_SECRET | `src/lib/fiskil.ts` | yes | no | set when going live with Fiskil |
| BASIQ_API_KEY | `src/lib/basiq.ts` (adapter kept, provider declined) | yes | yes | delete once the Basiq adapter is removed, or now if no Basiq sandbox use is planned |
| **GEOAPIFY_KEY** | **nothing** (declaration removed in #637) | no | yes | **delete** |

Commands for the coordinator (not run by the agent):

```sh
npx wrangler secret delete GEOAPIFY_KEY
# optional, only once Basiq is definitely abandoned (code still reads it; the bank-feed route stays dark without it):
# npx wrangler secret delete BASIQ_API_KEY
```
