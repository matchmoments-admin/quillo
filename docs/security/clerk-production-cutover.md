# Clerk production cutover (owner runbook)

> #638 (A5, epic #633). Schedule 2 controls 1(a), 1(b), 1(h). Version 0.1, 2026-10-08.
> **Owner-run.** Nothing here has been switched in production. The code side is ready: see §0.

Today `app.quillo.au` authenticates against a Clerk **development** instance
(`CLERK_ISSUER = https://obliging-eel-28.clerk.accounts.dev` in `wrangler.toml`), with open
self-service signup. Development instances use shared OAuth credentials, carry a "development" banner,
have relaxed limits and are not meant for real users. This runbook moves Quillo to a **production**
instance on `quillo.au`, turns on MFA for the admin, and keeps a one-edit rollback.

**Blast radius (checked 2026-10-08, read-only query on remote D1):** 1 tenant in `profiles` — the
founder's (`user_id = 'me'`, holds `admin`). No other Clerk-keyed tenants exist. Clerk user ids are
per instance, so the founder gets a **new** `sub` on the production instance; the only data mapping to
fix is `CLERK_FOUNDER_SUB` (step 5). Re-run the query in step 0 on the day — if other `user_…` tenants
have appeared, **stop**: their data is keyed by their development-instance id and needs a planned id
migration (a data rewrite, so an explicit go + reverse plan).

## 0. What the code already supports (no change needed on the day)

| Need | Where | State |
|---|---|---|
| Issuer is config, not code | `CLERK_ISSUER` in `wrangler.toml` `[vars]`; JWKS fetched from `${CLERK_ISSUER}/.well-known/jwks.json` | ready |
| Lock `azp` to the real origin | `CLERK_AUTHORIZED_PARTIES` (comma list) replaces the default list (`app.quillo.au` + two localhost dev origins) — `authorizedParties()` in `src/auth/clerk.ts` | ready, unset |
| Founder ↔ legacy tenant `me` | `CLERK_FOUNDER_SUB` in `wrangler.toml` | must be updated (step 5) |
| Publishable key | `VITE_CLERK_PUBLISHABLE_KEY` in `web/.env` (gitignored), baked in at `npm run web:build` | must be swapped (step 5) |
| CSP allows the production Frontend API | `src/lib/security-headers.ts` allowlists `https://*.quillo.au` (covers `clerk.quillo.au`) | ready |
| Admin MFA enforcement | flag `admin_mfa_required` — `/api/admin/*` needs a verified second factor (`fva` claim) | built, OFF (step 6) |
| General API rate limiting | flag `api_rate_limit` + `[[ratelimits]]` bindings | built, OFF (step 7) |
| Dashboard evidence | Security & compliance → Access control panel shows Clerk instance + both flags (KV `security:source:mfa`, refreshed by the 10-minute cron) | live |
| `CLERK_SECRET_KEY` | **Not used by the Worker** (it only verifies JWTs against the public JWKS). Store `sk_live_…` in the password manager; don't add it as a Worker secret until code needs the Backend API | n/a |

Pre-check query (run the day before and on the day):

```bash
npx wrangler d1 execute tax-agent-db --remote --json --command \
  "SELECT COUNT(*) AS tenants, SUM(user_id='me') AS founder, SUM(user_id LIKE 'user_%') AS clerk_subs, SUM(roles LIKE '%admin%') AS admins FROM profiles"
```

Expected: `tenants=1, founder=1, clerk_subs=0, admins=1`.

## 1. Create the production instance (Clerk dashboard)

1. Clerk dashboard → the Quillo application → instance switcher **Development** → **Create production instance**.
2. Choose **Clone development settings** (copies sign-in methods, appearance, session settings). SSO
   connections, integrations and **Paths** do *not* copy — set Paths to the embedded routes:
   sign-in `https://app.quillo.au/sign-in`, sign-up `https://app.quillo.au/sign-up`,
   after sign-out `/sign-in`.
3. **Application domain:** `quillo.au` (root). Clerk's Frontend API becomes `https://clerk.quillo.au` and
   its session cookies cover `app.quillo.au`. (If Clerk insists on the app subdomain instead, the FAPI is
   `https://clerk.app.quillo.au` — also covered by the CSP; use that value in step 5.)
4. Record the instance id and the `pk_live_…` / `sk_live_…` keys in the password manager.

## 2. DNS records (Cloudflare → quillo.au → DNS)

Copy the exact targets from Clerk dashboard → **Configure → Domains**; the instance-specific parts
(`<id>`) come from there. Typical set:

| Type | Name | Target | Proxy |
|---|---|---|---|
| CNAME | `clerk` | `frontend-api.clerk.services` | **DNS only (grey cloud)** |
| CNAME | `accounts` | `accounts.clerk.services` | **DNS only** |
| CNAME | `clkmail` | `mail.<id>.clerk.services` | **DNS only** |
| CNAME | `clk._domainkey` | `dkim1.<id>.clerk.services` | **DNS only** |
| CNAME | `clk2._domainkey` | `dkim2.<id>.clerk.services` | **DNS only** |

- Proxied (orange cloud) records break Clerk's verification and certificate issuance — every Clerk record
  must be **DNS only**.
- These names don't collide with existing records (`app`, apex, `www`, the email-routing MX/TXT for
  `brendan@` / `hello@`). Check before adding; don't touch the existing MX/SPF/DMARC records.
- Wait for every record to show **Verified** in Clerk (minutes, up to 48 h), then press
  **Deploy certificates** on the Clerk dashboard home.

## 3. Social sign-in credentials

Development uses Clerk's shared OAuth credentials; production requires your own. For each social provider
enabled in development (check **User & authentication → SSO connections**):
- **Google:** Google Cloud console → APIs & Services → Credentials → OAuth client (Web). Authorised
  redirect URI = the one Clerk shows for the production instance. Paste client id/secret into Clerk.
- Any provider you don't want to support: **disable it** rather than leave it half-configured.

## 4. Security settings on the production instance (screenshot each for the evidence pack)

1. **Multi-factor:** User & authentication → Multi-factor → enable **Authenticator application (TOTP)**
   and **Backup codes**. Leave SMS off. (Optional: Passkeys under User & authentication → Passkeys — but
   see the passkey note in step 6.)
2. **Do not** turn on Clerk's "require MFA for all users" — consumer MFA is optional (Schedule 2 1(a)
   excludes consumer access); the *admin* requirement is enforced by Quillo's server (step 6).
3. **Passwords:** confirm breached-password protection (Have I Been Pwned check) and the minimum length are
   on; confirm the lockout / brute-force protection setting (Attack protection). Screenshot both —
   this is the evidence for control 1(h).
4. **Session:** session lifetime and inactivity timeout per the information-security policy (suggest
   7-day max lifetime, 24 h inactivity). Confirm **session token version 2** (it carries the `fva` claim
   the MFA gate reads; new instances default to v2).
5. **Sign-up mode — explicit decision required (owner):** Restrictions → Sign-up mode.
   - *Public* — what development does today (open signup; each user gets their own isolated tenant,
     bounded by the cost caps). The current product decision (memory: open signup shipped 2026-07).
   - *Restricted* / *Waitlist* — until the Fiskil approval and the paid launch.
   Record the choice here: **Sign-up mode chosen: ________ (date ____ , by ____)**.
   Independently, `CLERK_ALLOWED_USERS` in `wrangler.toml` remains the server-side kill-switch.
6. **Allowed origins / redirect URLs:** only `https://app.quillo.au` (plus `https://quillo.au` if Clerk
   requires the root). No localhost on the production instance.

## 5. Switch Quillo to the production instance (one PR + deploy)

1. **Create the founder** on the production instance *before* the app points at it: Clerk dashboard →
   (production) Users → **Create user** with **the same email and sign-in method you will actually use**
   (brendan@quillo.au + password). No sign-in is needed yet — just copy the new user id (`user_…`).
   - If you later sign in with Google under a *different* email, Clerk creates a second user with a new
     `sub`, which lands in a stray empty tenant and makes the `me` data look missing. Use the same
     identity, or link the Google account to this user in the dashboard first.
   - Don't sign up through app.quillo.au after the switch before `CLERK_FOUNDER_SUB` is updated — same
     stray-tenant effect. Nothing is lost either way: fix the var and redeploy.
2. **Branch + edit** (`security/clerk-production`):
   - `wrangler.toml` `[vars]`:
     ```toml
     CLERK_ISSUER = "https://clerk.quillo.au"
     CLERK_FOUNDER_SUB = "user_<new production id>"
     CLERK_AUTHORIZED_PARTIES = "https://app.quillo.au"
     ```
     (keep the old dev values in the PR description for rollback.)
   - `src/auth/clerk.ts`: update `FOUNDER_SUB_DEFAULT` to the new id too (it's the hard fallback if the
     var is ever emptied).
   - Local, not committed: `web/.env` → `VITE_CLERK_PUBLISHABLE_KEY=pk_live_…`.
3. Gates (`npm run typecheck`, web tsc + lint, `npm test`), PR, merge.
4. **Deploy:** `npm run web:build && npm run deploy`. Note that the SPA build and the Worker vars must
   move together — a `pk_live` SPA against a dev `CLERK_ISSUER` (or the reverse) fails every request with
   401.

Order matters: the founder's production user id must exist **before** the deploy, or the founder signs in
as a fresh tenant and the legacy `me` data looks empty (nothing is lost — fix `CLERK_FOUNDER_SUB` and
redeploy).

## 6. Turn on admin MFA enforcement

1. After the step-5 deploy, sign in at app.quillo.au as the founder and **enrol TOTP** in-app (account
   menu → Manage account → Security → Add two-step verification). Save the backup codes in the password
   manager. Sign out and sign back in with password + TOTP. (The flag is still OFF, so there is no
   lockout risk while you do this.)
2. Add `admin_mfa_required` to `FEATURES` in `wrangler.toml`, PR, deploy.
3. Sign out, sign in with password + TOTP, open **Admin** and **Security & compliance** — both load.
4. Negative test: in a private window sign in *without* completing a second factor (e.g. a second test
   admin with no TOTP, or temporarily remove TOTP from a test account) → the admin page shows
   "Admin access needs multi-factor authentication…" (HTTP 403 `admin_mfa_required`).
5. **Freshness:** the second factor must have been verified within the last **12 hours**
   (`ADMIN_MFA_MAX_AGE_MIN`, default 720) — otherwise 403 `admin_mfa_stale` ("sign out and sign back
   in"). This stops a long-lived session cookie from carrying admin for days after one MFA.
6. **Passkey note:** a passkey-only sign-in may report no second factor (`fva[1] = -1`); if the gate
   refuses it, use password + TOTP for admin work.

## 7. Turn on API rate limiting

Add `api_rate_limit` to `FEATURES`, deploy. Limits: 600 req/min per IP before auth, 300 req/min per
tenant after auth (`[[ratelimits]]` in `wrangler.toml`). Smoke: normal browsing, a bulk "confirm all" in
Review, a statement upload — no 429s. Over-limit response: 429 `rate_limited`, `Retry-After: 60`.
Limits are per Cloudflare location and keyed per IP address, so an attacker rotating IPv6 addresses can
spread load; it is an abuse brake, with the AI spend caps and per-operation limits as the hard ceilings.

## 8. Test plan (record results in the table)

| # | Test | Expected | Result / date |
|---|---|---|---|
| T1 | `curl -s https://app.quillo.au/healthz` | `{"ok":true}` | |
| T2 | Cold load `https://app.quillo.au` signed out | Clerk sign-in renders, no "development mode" badge, no CSP violations in the console | |
| T3 | Founder signs in (password + TOTP) | Dashboard shows the existing FY data (tenant `me`) | |
| T4 | Decode the session token in the console: `JSON.parse(atob((await Clerk.session.getToken()).split('.')[1]))` | `iss = https://clerk.quillo.au`, `azp = https://app.quillo.au`, `v = 2`, `fva[1] ≥ 0` | |
| T5 | Admin + Security & compliance pages | Load; Access-control panel shows *Clerk production instance*, MFA required, rate limiting on | |
| T6 | Admin without second factor (flag ON) | 403 with the MFA message | |
| T6b | Set `ADMIN_MFA_MAX_AGE_MIN = "1"` temporarily, wait 2 min, open Admin | 403 `admin_mfa_stale`; remove the var after | |
| T7 | New test user signs up (if sign-up is Public) | Gets an empty isolated tenant; `/api/admin/*` → 403 forbidden | |
| T8 | Token from the old dev instance (saved before cutover) sent as Bearer | 401 | |
| T9 | Sign out, sign back in on a second device | Works; no cross-device leakage | |
| T10 | Clerk dashboard screenshots (MFA settings, password/attack protection, sign-up mode, domains verified) | Saved to the evidence folder | |

Then update `docs/security/control-matrix.md` rows 1(a), 1(b), 1(h) to ✅ with the evidence.

## 9. Rollback

Instant, config-only — no data is touched by the cutover:
1. Revert the step-5 PR (restores the dev `CLERK_ISSUER`, `CLERK_FOUNDER_SUB`, removes
   `CLERK_AUTHORIZED_PARTIES`) and set `web/.env` back to the `pk_test_…` key.
2. `npm run web:build && npm run deploy`.
3. If only the admin gate misbehaves (owner locked out of /admin): remove `admin_mfa_required` from
   `FEATURES` and deploy — the rest of the app is unaffected by that flag.
4. If rate limiting causes false 429s: remove `api_rate_limit` and deploy.
5. Leave the Clerk DNS records in place (harmless) and the production instance idle until the retry.

Users who signed up on the production instance during a failed cutover keep their Clerk accounts on that
instance; their Quillo tenants (keyed by the production `sub`) reappear when production is re-enabled.
