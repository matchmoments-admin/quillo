# ADR-0003 — Bank feeds via CDR / Open Banking: access model, vendor, build, cost

**Status:** **Accepted — build in progress, SANDBOX ONLY.** Flag `bank_feed_cdr` is **OFF** and must
stay off until the consent dashboard lands (§6.4 makes it a shipping requirement, and it is the one
piece not built). Shipped so far: #502 foundation (migration 0075) · #506 connect + account picker
(0076) · #507 sync (0077 via #509) · #508/#509 the review remediation. Outstanding: PR5 (consent
dashboard, disconnect, PS12/audit) and R3 (bounded backfill). D1 below is resolved — the build
started before FY25/26 filed, deliberately; **D2/D4 (vendor terms, 12-month minimum) remain open**
on [#475](https://github.com/matchmoments-admin/quillo/issues/475), and no production access exists.
**Date:** 2026-07-26 (status updated 2026-08-07)
**Supersedes:** the "Redbark seasonal bank-feed" draft spec (that design is **not viable** — see §2)
**Related:** [ADR-0002 canonical sources](adr-0002-canonical-sources.md), APP-8 consent gate, `docs/personas.md`

---

## 0 · TL;DR

| Question | Answer |
|---|---|
| Best vendor | **Basiq (Cuscal)** as primary, **Fiskil** as the challenger quote. Get quotes from both + Skript. |
| Access model | **CDR Representative** of an unrestricted ADR for the pilot → **Sponsored/Affiliate accreditation** before public launch. |
| Redbark | **Cannot be used.** Their terms explicitly prohibit B2B / third-party / intermediary use. Consumer-only. |
| Cost floor | Per-user is trivial (~A$0.50/user/mo). The **undisclosed platform access fee + 12-month minimum** is the real cost, and it dominates below ~500 users. |
| On-charge | A$19–29 one-off per tax year as a "Connect my bank" add-on. Below ~500 connected users this is a deliberate subsidy, not a margin line. |
| For YOUR FY25/26 return (now) | **Use statement upload.** It already works, costs nothing, and carries zero compliance surface. Do the CDR work as a Q4 program, not a blocker. |
| Biggest hidden blocker | CDR **Privacy Safeguard 8** + the OSP rules make sending CDR-derived transaction text to a US model a compliance breach. **Bedrock `ap-southeast-2` stops being a nice-to-have and becomes mandatory.** |

---

## 1 · Why this matters

Statement upload is the single biggest onboarding drop-off and the largest data-quality risk (parse errors, missing months, wrong account). A live read-only bank feed removes it. Australia's Consumer Data Right (CDR) is the only legitimate, regulated way to do it — and screen-scraping alternatives are on a legislated path to being banned outright.

**Bank feeds are READ-ONLY.** CDR data sharing is read-only by design; write/payment initiation ("action initiation") is a separate designation Quillo will never seek.

---

## 2 · The Redbark design is dead — here is the evidence

The draft spec proposed either (A) one Quillo-held Redbark account holding all users' bank connections, or (B) each user holding their own Redbark subscription with Quillo as a destination. **Both are prohibited by Redbark's own terms.**

Redbark (SKINT AI Pty Ltd, ACN 685 364 729) is a **CDR Representative of Fiskil Pty Ltd** (ADR accreditation `ADRBNK000246`). Their compliance page states the service:

- "must not be used to access, collect, store, process, or disclose banking data on behalf of any other person, your customers, your employer, or any third party";
- prohibits "Sharing accounts or API keys with anyone other than the account holder";
- does not support "B2B, embedded, white-label, hosted-consent, intermediary, or data-broker access";
- violation ⇒ "immediate account suspension, API key revocation, and consent withdrawal".

So Option A is a compliance breach *and* a terms breach; Option B ("Quillo as a destination using the user's own key") is explicitly named and banned. The spec's own "get written confirmation before build" gate resolves to **no**.

The useful lesson from Redbark: it is a **working proof that a two-person app can operate as a CDR Representative of Fiskil.** That is the model Quillo should copy — directly, with its own principal arrangement.

---

## 3 · The four ways to legitimately access CDR data

| Model | ACCC accreditation | Infosec assurance | Can engage subcontractors (OSPs)? | Time to live | Fit for Quillo |
|---|---|---|---|---|---|
| **CDR Representative** | None — contract with an unrestricted ADR ("principal"), who is liable | Adopt principal's controls; onboarding due-diligence (fit & proper, infosec history, cyber insurance) | **Restricted** — must not engage an OSP to *collect*; may engage one to *use/disclose* only if the arrangement permits | ~1–4 weeks (Basiq quotes "as little as a week") | ✅ Pilot |
| **Sponsored / Affiliate** | Yes, own accreditation number; sponsor provides training + framework | **Self-assess and attest** — no ASAE 3150 audit | Yes | ~1–3 months | ✅ Public launch |
| **Unrestricted ADR** | Yes | **ASAE 3150 Type 1 reasonable-assurance report** by a registered CAANZ/CPA audit firm | Yes | 6–12 months, six figures | ❌ Not now |
| **Trusted Adviser** | N/A — consumer nominates a registered tax agent/accountant, ADR discloses to them | None (TAs are not CDR participants) | N/A | N/A | ❌ Quillo is not a registered tax agent |

**Recommendation: start as a CDR Representative, plan the move to Sponsored/Affiliate before opening the feed to the public.** The step up is the ACCC application plus a self-attestation, not an audit — a meaningful but manageable jump, and it unlocks the OSP freedom Quillo's architecture needs (see §7).

---

## 4 · Vendor landscape (all realistic AU options, July 2026)

| Provider | Status | Coverage | Rep model? | Pricing transparency | Verdict |
|---|---|---|---|---|---|
| **Basiq** (owned by **Cuscal**) | Active unrestricted ADR | 135+ AU institutions (≈180 incl. NZ) | ✅ Principal/Representative, Sponsor/Affiliate, and ADR models all documented | **Only vendor with published per-user pricing**: A$0.50/user/mo (Data) + undisclosed platform access fee; 12-mo minimum | ⭐ **Primary.** Largest representative portfolio, per-*user* not per-*connection* pricing, corporate parent. |
| **Fiskil** | Active unrestricted ADR (`ADRBNK000246`) | 115+ banks, 20+ energy | ✅ Documented rep onboarding | None published — sales-led | ⭐ **Challenger.** API-first DX; Redbark proves it works at micro-scale. Get a quote. |
| **Skript** | Active unrestricted ADR (`ADRBNK2010`) | AU | ✅ | None published, but has a **self-serve "Test for Free" portal** | ✅ Worth a third quote — the self-serve portal is the cheapest way to see real data. |
| **Frollo** (NextGen) | First fintech ADR | AU | ✅ | Sales-led; some services free via NextGen | ➖ Strong, but lending/broker-shaped. Secondary. |
| **Adatree** (Fat Zebra) | ADR | AU | ✅ | Sales-led, positions as "premium" | ➖ Has a useful "CDR Statements" product. Secondary. |
| **Biza.io** | ADR | AU | Partial | Sales-led | ➖ Primarily data-**holder** infrastructure. |
| **Experian / illion** | ADR | AU/NZ | Enterprise | Enterprise | ❌ Credit-bureau shaped, wrong scale. |
| **Envestnet Yodlee** | ADR + large rep portfolio | Global | ✅ | Enterprise | ❌ Screen-scraping heritage; Treasury is legislating a **full ban on screen scraping**. Avoid. |
| **Redbark** | CDR Representative of Fiskil | 100+ | ❌ **Prohibited** | A$10 / A$16 / A$24 per month, 7-day trial | ❌ Consumer-only. See §2. |
| illion BankStatements / Credit Sense | Screen scraping | AU | N/A | — | ❌ Legislated ban incoming. |

**Why Basiq wins:** it is the only vendor that prices per **unique consumer regardless of how many banks they connect** — which is exactly Quillo's shape ("users, sometimes with multiple banks"). Their own FAQ: *"We understand your users may bank with 1 institution while others may have multiple banking relationships."* Under Fiskil/Skript-style per-connection pricing (unconfirmed), a user with four accounts costs 4×.

---

## 5 · The 24-month wall — a hard design constraint

**Data holders are not required to share transactions older than 24 months from the request date.**

Consequences:

- Today (26 Jul 2026) a fresh consent reaches back to ~26 Jul 2024 — **FY25/26 (1 Jul 2025 – 30 Jun 2026) is fully covered.**
- A user connecting in, say, March 2028 to do a late FY25/26 return will get **nothing before March 2026** — three-quarters of the year missing.
- Therefore: **pull once, store permanently, never treat the feed as the system of record.** Quillo's D1 copy is the archive.
- Therefore: **statement upload stays a first-class path forever** — for late filers, foreign accounts, Amex products, brokerage, and any non-CDR institution.
- Product rule to surface in the UI: *"Connect your bank before 30 June two years after the financial year starts, or we'll need statements instead."*

CDR consents are also **time-limited (12 months maximum)** and must be trivially withdrawable — which suits the seasonal model in the original spec, and makes it a requirement rather than a design choice.

---

## 6 · Recommended build

### 6.1 Principles

- **Additive + feature-flag gated.** New flag `bank_feed_cdr`; OFF ⇒ byte-identical output. Persona goldens stay green.
- **Canonical-source invariant holds (ADR-0002).** An account's money comes from exactly one of `cdr_feed` | `statement` | `qbo_feed`. Never two.
- **Quillo never sees a bank credential.** Consent and authentication happen on the **data holder's own site** via the ADR's hosted flow. Quillo never receives, stores, or proxies a banking password, and never holds an OAuth token that could re-authenticate to a bank.
- **Read-only, forever.** No payment initiation, no action initiation.

### 6.2 Schema (additive)

> **Number corrected 2026-08-01.** This ADR originally reserved `0070_`. The capital tranche has since
> taken 0070–0074, so allocate at write time — **`0075_` or later**. Referred to below as `00NN_`.

```sql
CREATE TABLE IF NOT EXISTS bank_connections (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  provider            TEXT NOT NULL,              -- 'basiq' | 'fiskil' | ...
  provider_user_id    TEXT,                       -- ADR-side consumer id (NOT a credential)
  institution         TEXT,
  status              TEXT NOT NULL DEFAULT 'pending', -- pending|active|expired|revoked|error
  consent_id          TEXT,
  consent_scope       TEXT,                       -- JSON: the data clusters consented
  consent_granted_at  TEXT,
  consent_expires_at  TEXT,                       -- CDR: <= 12 months
  last_sync_at        TEXT,
  last_error          TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bank_connection_accounts (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  connection_id       TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  account_id          TEXT,                       -- accounts.id, NULL until the user maps it
  masked_number       TEXT,                       -- last4 only — never a full account number
  name                TEXT,
  type                TEXT,
  selected            INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, connection_id, provider_account_id)
);

CREATE TABLE IF NOT EXISTS bank_sync_runs (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  from_date     TEXT, to_date TEXT,
  fetched       INTEGER, imported INTEGER, skipped INTEGER,
  status        TEXT NOT NULL,                    -- ok|partial|failed
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- `accounts.source` gains `'cdr_feed'`.
- **`bank_connections.access_type`** (`'cdr' | 'web'`, default `'cdr'`) — **as built, and it is the
  load-bearing column this section originally omitted.** The same aggregator serves the same account
  shape over CDR and non-CDR web connectors, and only the former attracts the Privacy Safeguards.
  It drives `requiresAuResidency` (`src/lib/basiq.ts`). Defaulting to `'cdr'` is fail-closed.
  Also as built and not listed here originally: `provider_connection_id`, `institution_id`,
  `bank_connection_accounts.currency`, and `profiles.bank_provider_user_id` / `bank_provider` (0076)
  plus `profiles.cdr_tainted` (0077).
- **No change to `transactions`.** CDR lines land as the existing `kind='bank_line'` shape. Idempotency reuses the existing unique index by setting **`line_fingerprint = sha256("feed|" + provider_txn_id)`** — so a re-pull is a no-op via `ON CONFLICT … DO NOTHING`. (This ADR originally specified a `cdr|` prefix; the code uses `feed|` because `access_type` may be `'web'`, which is *not* CDR data, so the prefix would be a lie for half the rows. Anyone re-implementing from this section — a second provider, a repair script — must use `feed|` or they will silently re-import every line.) Only `status = POSTED` transactions are ingested (pending ids are unstable — Basiq documents that an id refreshes on the pending→posted transition).
- **All three tables MUST be added to `PURGE_TABLES` in `src/lib/retention.ts`** in the same PR — this is both an existing invariant and a CDR Privacy Safeguard 12 obligation.

### 6.3 Flow

1. `POST /api/bank/connect` → Worker creates/reuses the ADR-side consumer, requests a consent URL, returns it. State param is signed and held in KV with a short TTL.
2. User completes consent **on the ADR's hosted flow and their own bank's site**. Quillo is never in the credential path.
3. `GET /api/bank/callback` → store `consent_id` + expiry, fetch the account list.
4. **Account picker** — user chooses which accounts count and maps each to a Quillo account/entity (personal / business / property). Unselected accounts are never pulled. This is data minimisation, and it is a CDR obligation, not a nicety.
5. `POST /api/bank/sync` → DO-coordinated paginated backfill for `max(FY start, now − 24mo) .. min(FY end, today)`, into the existing Inbox/Sort pipeline. Confident rows auto-categorise; low-confidence lands in the Inbox, exactly as statement lines do today.
6. `POST /webhooks/cdr` (v2 only) → HMAC-SHA256-verified, for late-posting items during active prep.
7. `POST /api/bank/disconnect` → revoke the consent with the ADR, mark `revoked`, and run the PS12 delete/de-identify path.

**Ship REST backfill first. Webhooks are v2.** A tax product needs a correct snapshot far more than it needs real-time.

### 6.4 Consent dashboard (mandatory, not optional)

CDR requires the consumer to be able to see and withdraw consents. Build a `/settings/connections` surface showing: which institution, which accounts, what data clusters, granted-at, expires-at, last sync, and a one-click **Withdraw** that actually revokes upstream. Plus an expiry reminder notification. **This is a hard requirement — the feature is not shippable without it.**

### 6.5 Engine ✓ + UI ✓ + display ✓

Per the CLAUDE.md contract, "done" means the persona can connect a bank, pick accounts, see lines flow into the Inbox, and see the result in their position. An API-only landing does not count as shipped.

---

## 7 · The compliance blocker you must resolve first

**CDR data stays CDR data.** Once transactions arrive via CDR they remain subject to the Privacy Safeguards for their whole life inside Quillo — they do not become "ordinary" data after categorisation.

Two rules collide with Quillo's current architecture:

1. **A CDR Representative must not engage an outsourced service provider to *collect* CDR data, and may only engage one to *use or disclose* it where the representative arrangement expressly permits.** Cloudflare (hosting) and Anthropic/AWS (categorisation) are OSPs handling service data.
2. **Privacy Safeguard 8** prohibits disclosing CDR data to an overseas recipient unless that recipient is itself accredited, or the discloser takes reasonable steps to ensure no breach of the safeguards. The OSP-chain principal is liable for PS8 failures.

**Therefore:**

- Sending CDR-derived transaction descriptions to `anthropic` (US) is **not** cured by Quillo's existing APP-8 consent gate. APP-8 is Privacy Act; PS8 is a different, stricter regime with penalty provisions. **Consent is not the exemption here.**
- **Bedrock `ap-southeast-2` (Sydney) moves from launch blocker to hard prerequisite.** The AU residency guard already on the backlog (see the AU launch audit) gates this feature.
- The CDR representative arrangement with the principal **must expressly permit engaging OSPs for the use of service data**, and must name Cloudflare and AWS. Put this in writing before signing.
- If a principal will not permit that, the answer is **sponsored/affiliate accreditation**, where Quillo is an accredited person in its own right and can engage OSPs properly.

**Recommended posture for the pilot:** operate as a representative, route *all* CDR-derived inference through Bedrock AU with a hard code-level guard, and start the sponsored-accreditation application in parallel.

---

## 8 · Cost model and what to on-charge

### 8.1 Known numbers

- **Basiq Data:** A$0.50 per user per month. A user becomes billable for the *full month* once created, regardless of activity or number of connections.
- **Basiq Insights (enrichment):** A$0.25/user/mo — **skip it.** Quillo does its own ATO-rule categorisation; the vendor `category` field may seed but must never override it.
- **Platform access fee:** not published. Model it.
- **Minimum term:** 12 months.
- Fiskil / Skript / Frollo / Adatree: quote-only. Confirm whether they price per *connection* rather than per *user* — that changes the model materially for multi-bank households.

### 8.2 Seasonal assumption

A tax user is active ~3 months per year ⇒ **A$1.50/user/year** in per-user fees. Per-user cost is a rounding error. **The platform fee is the whole game.**

### 8.3 All-in cost per connected user per year

| Connected users | Platform fee A$0/mo | A$500/mo | A$1,000/mo | A$1,500/mo |
|---|---|---|---|---|
| 50 | A$1.50 | A$121.50 | A$241.50 | A$361.50 |
| 500 | A$1.50 | A$13.50 | A$25.50 | A$37.50 |
| 5,000 | A$1.50 | A$2.70 | A$3.90 | A$5.10 |

### 8.4 Recommendation

- **On-charge: A$19–29 one-off per financial year**, as a "Connect my bank" add-on (or folded into a paid tier). It is a per-year purchase, which matches both the seasonal usage and the 12-month consent ceiling.
- **Break-even sits near 500 connected users** at a A$1,000/mo platform fee. Below that, this is a **deliberate acquisition subsidy** — which can be the right call, because removing statement upload is the conversion unlock. But it must be a conscious decision, not a surprise.
- **Do not attempt to resell the vendor relationship.** Any markup must sit on Quillo's own service value; Quillo pays the ADR under its own representative arrangement, and the consumer's CDR consent runs to Quillo (as representative) — not through a shared account.
- **Negotiating lever:** ask every vendor for a ramped or usage-only first year. The 12-month minimum on a pre-revenue user base is the single largest financial risk in this feature.

---

## 9 · What to do about YOUR FY25/26 return, right now

Nothing in §3–§8 completes before October. For the 25/26 return today:

1. **Use the existing statement upload path.** It works, it is free, and the 24-month window means nothing is lost by waiting.
2. **In parallel, validate the data shape** with a sandbox account from Basiq, Fiskil, or Skript (Skript's self-serve "Test for Free" portal is the fastest). Compare a pulled FY against a statement you already have.
3. **Do not** use a personal Redbark subscription as a back door into Quillo — their terms prohibit routing data to a third-party product, and Quillo is a multi-user product regardless of whose data is flowing.

---

## 10 · Security review — current system, through the lens of holding bank data

Assessed by reading the auth, tenancy, secrets, retention, and ingest surfaces. **This is a targeted pass, not an adversarial audit** — run `/local-ultrareview` or `/security-review` for the deep sweep before the feed goes live.

### What is already good

- **Tenancy.** Every table carries `user_id`; identity is derived server-side from a verified Clerk JWT or an HMAC-verified tenant key — never a client header. `src/ingest/auth.ts` correctly derives `user_id` from the key row that the signature validated against, with ±60s skew and KV single-use nonces. R2 keys are `${userId}/…` prefixed and read through `receiptKeyFor(env, uid, …)`.
- **Fail-closed tenant isolation.** Only the founder's Clerk `sub` maps to the legacy `"me"` tenant, with a hard-coded default so a missing env var cannot merge two humans.
- **Envelope encryption exists.** `src/lib/token-crypto.ts` — AES-256-GCM, per-value IV, non-extractable derived key, `enc_ver` versioning, tokens never logged.
- **Retention.** `purgeTenant` covers `PURGE_TABLES` + R2 + KV, and there is an APP-12 export path.
- **PII redaction** before free text reaches a model, and an APP-8 consent gate that runs *before* any model call.
- No CORS wildcards; CSP, `nosniff` and `Referrer-Policy` on the HTML shell.

### Findings to fix before a bank feed goes live

| # | Severity | Finding |
|---|---|---|
| S1 | **High** | **Auth fails OPEN on missing config.** `src/auth/clerk.ts` returns tenant `"me"` unauthenticated when `CLERK_ISSUER` is unset; `src/auth/access.ts` does the same when `CF_ACCESS_AUD` is unset. A config regression or a new environment silently disables authentication entirely. Gate the dev fallback on an explicit `DEV_AUTH_BYPASS=1`, and make production **fail closed**. |
| S2 | **High** | **Clerk is still on a DEV instance** (`*.clerk.accounts.dev` in the CSP and the `azp` allowlist) with **open self-service signup**. Dev instances carry weaker guarantees and shared domains. Move to a production Clerk instance before any real bank data lands. |
| S3 | **High** | **Token encryption degrades to plaintext.** `token-crypto` writes `enc_ver=0` plaintext when `QBO_TOKEN_KEY` is unset. Acceptable for a QBO pilot; **not** acceptable for anything CDR-adjacent. The new CDR secret must be a **separate key** (`CDR_TOKEN_KEY`) and must **fail closed** — refuse to write rather than write plaintext. |
| S4 | **High** | **PS8 / OSP exposure** — see §7. US inference on CDR data is a penalty-provision breach, not an APP-8 consent question. Needs a hard code-level residency guard, not a flag. |
| S5 | Medium | **CSP is Report-Only.** Flip to enforcing once prod reports are clean. A page that can be script-injected is a page that can exfiltrate a session token. |
| S6 | Medium | **No general API rate limiting.** Only chat and the waitlist are limited. Add per-tenant limits on the bank-connect/sync endpoints specifically — they are both expensive and abuse-attractive. |
| S7 | Medium | **No HSTS header.** Confirm it is set at the Cloudflare edge; if not, add `Strict-Transport-Security` with a preload-eligible max-age. |
| S8a | ✅ Done (#507) | **Redaction on the FEED path.** `redact()` is applied to the merchant before categorisation for `source='cdr_feed'` lines. |
| S8b | Medium — **open** | **Statement-sourced `kind='bank_line'` rows still reach the model verbatim.** Deliberately *not* fixed with S8a: `redact()` matches any 6+ digit run (`"UBER *TRIP 123456"` would be redacted), so extending it changes what the model sees, hence categorisation, hence the tax position. That is a money-output change and needs its own flag + persona golden. |
| S9 | Medium | New CDR tables must land in `PURGE_TABLES` **and** gain an explicit PS12 "delete or de-identify redundant data" path with a deletion record. This is an obligation with a regulator attached, unlike ordinary retention. |
| S10 | Low | Audit logging exists (`audit_log`, hash-chained) but must be extended to record every CDR consent grant, sync, disclosure and withdrawal — CDR requires records and periodic ACCC/OAIC reporting. |
| S11 | Low | Store `last4` only. Never persist a full account number, and never log a raw CDR payload. |

### Non-negotiables for the feed itself

- Quillo never sees, stores or proxies a banking credential — consent happens on the data holder's site.
- The ADR API key is a Worker secret, rotated on schedule, never in `wrangler.toml`.
- Webhook payloads are HMAC-verified before parsing, with replay protection reusing the existing nonce pattern.
- Read-only scopes only; no payment or action-initiation scope is ever requested.

---

## 11 · Decision log — what the owner needs to choose

| # | Decision | Recommendation |
|---|---|---|
| D1 | Build now or after FY25/26? | **After.** Use statements for this year's return; start vendor conversations now. |
| D2 | Which vendor? | Quote **Basiq, Fiskil and Skript**. Default to Basiq on per-user pricing + stability. |
| D3 | Representative or sponsored? | **Representative for the pilot, sponsored before public launch.** |
| D4 | Accept a 12-month minimum? | Only with a ramped or usage-only first year. Otherwise negotiate or defer. |
| D5 | On-charge model? | A$19–29/FY add-on; accept it as a subsidy below ~500 users. |
| D6 | Bedrock AU first? | **Yes — prerequisite, not parallel work.** §7 makes it non-optional. |

---

*General information only. Vendor claims and regulatory positions in this document must be independently verified — and the CDR representative arrangement reviewed by a lawyer — before build. Quillo remains non-custodial, is not a registered tax agent, and does not lodge returns.*
