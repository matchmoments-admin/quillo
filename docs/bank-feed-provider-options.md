# Bank feed provider options, after Basiq

> **Research deliverable, 2026-10-06.** Basiq has declined to onboard Quillo (Young Milton Pty Ltd)
> as a CDR Representative. Stripe Financial Connections covers US bank accounts only. This doc
> covers who else will take a one-founder, pre-revenue startup as a CDR Representative, what it
> would cost to switch the connector, and draft outreach.
>
> **Builds on:** [ADR-0003](adr-0003-bank-feed-cdr-access.md) (access model, PS8, cost model),
> [bank-feed-handoff.md](bank-feed-handoff.md) (what is built), [cdr-ps8-findings.md](cdr-ps8-findings.md)
> (the overseas-recipient analysis). Open issues: #475 (vendor terms), #524 (CDR legal review).
>
> ⚠️ **General information, not legal advice.** Vendor claims come from vendor-published pages and
> must be confirmed in writing. The representative arrangement still needs an Australian CDR/privacy
> lawyer before signing (ADR-0003 §7).

---

## 0 · Recommendation

| | Provider | Why |
|---|---|---|
| **Top pick** | **Fiskil** (`ADRBNK000246`) | It is the only principal that publishes **"no platform fee and no minimum contract term"** on its entry plan. It runs a **free, self-serve sandbox** and has **~130 CDR Representatives**, many of them tiny consumer money apps. Its representative **Redbark publicly lists Cloudflare Workers (and Anthropic via Cloudflare AI Gateway) as subprocessors**, which is the strongest public evidence that a Fiskil arrangement can carry Quillo's hosting. That removes ADR-0003's two largest financial risks (D2 platform fee, D4 12-month minimum). |
| **Backup** | **Adatree** (Fat Zebra, `ADRBNK000071`) | Adatree was the first CDR principal under the representative model and has signed lenders, ADIs and a university as reps. It is an Australian entity with a white-label consent platform. It is sales-led and does not publish prices. Its customer base is lending/ADI-shaped, so expect a higher floor than Fiskil's. |
| Third option | **Envestnet Yodlee** (`ADRBNK000061`) | Yodlee runs an active rep portfolio (Zip, Domino's). It is enterprise-priced, and its CDR sandbox needs the paid "Engage" tier. Its principal is **Yodlee, Inc. (US)**. That doesn't by itself fail PS8 (Quillo is the one disclosing to OSPs), but counsel will ask about it. Contact only if both of the above fall through. |

**Don't contact:** **Skript** (business accounts only: "we only do business bank data"). **Frollo** (its
CDR policy states "Frollo does not currently provide any representative arrangements"). **SISS/ACSISS**
(serves B2B accounting/ERP platforms, no consumer product). **illion/Experian Open Data** (lending/broker
shaped). **Redbark** (its terms prohibit B2B/intermediary use, see ADR-0003 §2).

### A finding that changes ADR-0003's roadmap

The live CDR Register (queried 2026-10-06) lists **no active sponsored-accreditation ADR**. Only one
has ever existed (GREENR GLOBAL, `ADRBNK2021`), and it is `SURRENDERED`. ADR-0003 §3 plans "representative
for the pilot → sponsored before public launch". No one in the market is currently on that path. Ask
the principal whether staying a representative long-term is acceptable, and **don't build the launch plan
on sponsored accreditation.** Fiskil's own page describes "Sponsored access" as distinct from the
Representative model, and that needs clarifying on the first call.

---

## 1 · Comparison

| Provider | Register status | Model offered to us | Startup fit | Published pricing | Free sandbox | API style | Consumer txns | Hosting / OSP signal |
|---|---|---|---|---|---|---|---|---|
| **Fiskil** | Unrestricted, ACTIVE, accredited since 2021; SOC 2 T2 + ASAE 3150 T2 | CDR Representative (claimed 4–8 wks; "accounting platform … bank feed feature in 8 weeks"); also "Sponsored access" | ✅ ~130 reps incl. Billroo, Breadly, Cleer Money, Moneytor, Lucie Money, BankSync, Redbark | **Launch: no platform fee, no minimum term**, priced per **Monthly Active Consent**, no per-call overages; rates not public | ✅ self-serve, "no credit card and no sales call", same base URL as prod | REST + JWT; hosted consent (`auth_url`) or `@fiskil/link` SDK; HMAC webhooks | ✅ banking accounts/transactions, 200+ AU/NZ institutions incl. non-bank lenders from 13 Jul 2026 | Fiskil itself uses no OSPs ("onshore … only resides in Australia"). Rep **Redbark lists Cloudflare Workers, PlanetScale, Clerk, Anthropic/Google via CF AI Gateway, Datadog (US)** |
| **Adatree** (Fat Zebra since Dec 2023) | Unrestricted, ACTIVE | CDR Representative (first principal, "within a matter of weeks"); helps with full accreditation | ➖ reps mostly ADIs, lenders, UNSW | None, demo request | Developer portal exists; sandbox terms unknown | REST, white-label consent | ✅ | Unknown, ask |
| **Yodlee** | Unrestricted, ACTIVE (Yodlee, Inc., US) | CDR Representative | ➖ enterprise | None | Paid "Engage" tier for CDR test bank | REST, configurable white-label flow | ✅ | Unknown, ask |
| Skript | Unrestricted, ACTIVE | Platform API under Skript's accreditation | ❌ business accounts only | Subskript A$99/mo; Superskript from A$1,250/mo; Aggregator from A$2,500/mo | ✅ "Sandbox keys in minutes" | REST | ❌ business consent only | n/a |
| Frollo / NextGen | Unrestricted, ACTIVE | **None:** "does not currently provide any representative arrangements" | ❌ | Sales-led | n/a | Gateway API | ✅ | n/a |
| SISS / ACSISS | Unrestricted, ACTIVE | B2B platform partner | ❌ accounting/ERP platforms | None | Dev portal | REST | ❌ (consumer → trusted-adviser product only) | n/a |
| Experian Open Data (illion) | Unrestricted, ACTIVE | Enterprise | ❌ lending-shaped | Enterprise | Unknown | Hosted | ✅ | n/a |
| Basiq (Cuscal) | Unrestricted, ACTIVE | **Declined Quillo** | n/a | A$0.50/user/mo + undisclosed platform fee, 12-mo min | ✅ (our current build) | REST + hosted consent | ✅ | n/a |
| TrueLayer | **SURRENDERED** | n/a | n/a | n/a | n/a | n/a | n/a | Exited AU CDR |

### Pricing shape matters for Quillo

Fiskil bills per **Monthly Active Consent**. Basiq billed per *user*. A CDR consent is per *institution*, so a
user with two banks is likely two consents. Our usage is seasonal: one bounded backfill, a few top-ups
in tax season, then idle. Whether an idle-but-unexpired consent counts as "active" in a month decides
whether Quillo pays ~3 months or 12 per consent per year. **Ask for the definition.** If idle consents count,
a short consent duration (Fiskil's consent UI lets the client configure the consent period) is the lever.

---

## 2 · Non-CDR fallbacks (brief)

| Option | Legal in AU today? | Direction | Verdict |
|---|---|---|---|
| **Statement upload** (built) | ✅ | Permanent first-class path (24-month wall, late filers, non-CDR institutions) | **Keep as the default.** It is the only path that works with zero vendor dependency |
| Credential-sharing "digital data capture" (illion BankStatements, CashDeck, Yodlee non-CDR) | ✅ not banned | Treasury (Aug 2023 discussion paper): screen scraping "will not survive in its current form". The Statutory Review recommends a ban where CDR is viable, the consultation closed Oct 2023, and **no government response has been published** as of Oct 2026 | ❌ Asking consumers for bank passwords contradicts ADR-0003's non-negotiable ("Quillo never sees a banking credential") and carries ePayments Code liability risk for the user. Don't build on it |
| Bank-approved direct feeds (SISS-style) | ✅ | Business accounts for accounting platforms | ❌ Not consumer |
| Consumer exports a CDR-sourced file (e.g. their own Redbark/Frollo CSV) and uploads it | ✅ (it's the consumer's data once disclosed to them) | — | ➖ Works today through the statement path *if* the parser accepts the format. No arrangement needed. Cheap stopgap; check Redbark's terms on onward use first |

Watch: Treasury is consulting on **third-party disclosure consent** and simpler **nominated representatives**
(FinTech Australia modelling). Either would widen non-representative routes later. Non-bank lenders joined
CDR from 13 Jul 2026.

---

## 3 · Switching the connector: what's Basiq-specific

| File | Basiq-specific | Already generic |
|---|---|---|
| `src/lib/basiq.ts` (541 lines) | Everything: Basic-auth token + SERVER/CLIENT scopes, `consent.basiq.io` URL, `/users` create/delete, `/users/{id}/connections/{id}` delete, consents/accounts shapes, `postDateFilter` grammar, `links.next` + `safeNextUrl`, `BasiqError`, `BASIQ_ENV`/`BASIQ_API_KEY` | `toCents`, `last4Of`, `feedFingerprint`, `AccessType`, the `TransactionPageResult` contract, and the posted-only / window re-check / per-account defences (move these to a shared module) |
| `src/lib/bank-sync.ts` (474) | Imports `BasiqError` only for `correlationId` | **Fully generic.** `FeedTransport` is already the seam; tests use a fake transport |
| `src/lib/bank-consent.ts` (471) | `basiqUpstream()` factory | **`BankUpstream` interface already exists**; withdraw/PS12/audit/lifecycle are provider-neutral and log `provider` |
| `src/lib/bank-connect.ts` (104) | `parseJobIds` (Basiq's `jobIds` callback param) | KV state handle, `syncWindow` |
| `src/agent.ts` (~1590–1760, ~1938, ~1992, ~2095, ~2187–2228, ~2333–2343) | `basiqUserFor`, `bankConnectUrl`, `bankCallback`: `'basiq'` hard-coded in 5 SQL statements and 3 audit calls; `BasiqConsent` types; `basiqConfigured` gating; sync transport closure | The upsert/audit/account-selection logic itself |
| `src/lib/retention.ts` | `basiqConfigured` / `basiqUpstream` default; `"basiq"` fallback provider | Purge ordering (upstream delete → abort on failure) |
| `src/env.ts`, `wrangler.toml` | `BASIQ_ENV`, `BASIQ_API_KEY` | — |

**No migration needed.** `bank_connections.provider`, `profiles.bank_provider` and
`cdr_audit_log.provider` already exist. The `UNIQUE(user_id, provider, provider_connection_id)` key
already namespaces per provider.

### Adapter interface (proposed `src/lib/bank-provider.ts`)

```ts
export type BankProviderId = "basiq" | "fiskil";

export interface BankFeedProvider {
  readonly id: BankProviderId;
  configured(env: Env): boolean;
  environment(env: Env): "sandbox" | "production";        // drives requiresAuResidency
  createUser(identity: { email: string; name?: string }): Promise<string>;
  /** Hosted consent URL. `state` must round-trip to our callback (query param or path). */
  consentUrl(providerUserId: string, opts: { state: string; redirectUri: string; cancelUri: string;
    action?: "connect" | "manage" | "extend"; existingConnectionId?: string }): Promise<string>;
  /** Callback → consents (one per institution) + accounts, normalised. */
  listConsents(providerUserId: string): Promise<ProviderConsent[]>;     // {connectionId, institutionId, status, grantedAt, expiresAt, permissions}
  listAccounts(providerUserId: string): Promise<ProviderAccount[]>;     // {id, connectionId, institutionId, name, last4, type, currency}
  /** One page of POSTED, in-window transactions for ONE account (the FeedTransport contract). */
  fetchTransactionPage(providerUserId: string, q: { accountId: string; from: string; to: string; next: string | null }): Promise<TransactionPageResult>;
  revokeConnection(providerUserId: string, connectionId: string): Promise<void>;  // 404 = done
  deleteUser(providerUserId: string): Promise<void>;                              // 404 = done
}
export function bankProvider(env: Env, id?: BankProviderId): BankFeedProvider;  // default from BANK_FEED_PROVIDER
```

`BankUpstream` becomes `Pick<BankFeedProvider, "revokeConnection" | "deleteUser">`. `FeedTransport`
stays as is (bound from the provider). `ProviderError { status, code, correlationId }` replaces `BasiqError` in
`bank-sync.ts`.

### Per-provider mapping

| Operation | Basiq (built) | Fiskil (from its OpenAPI, `https://api.fiskil.com`) |
|---|---|---|
| Auth | `POST /token` Basic key, SERVER/CLIENT scope, 60 min | `POST /v1/token` JSON `{client_id, client_secret}` → JWT, **15 min, no refresh**. Cache in-isolate with a ~2-min margin. No client-scoped token |
| Create user | `POST /users {email}` | `POST /end-users {email, name, phone}` → `end_user_id` |
| Consent URL | client token → `consent.basiq.io/home?token&action&state` | `POST /auth/session {end_user_id, redirect_uri, cancel_uri, institution_id?, arrangement_id?}` → `auth_url` (+`expires_at`). Server-side, so no bearer reaches the browser |
| Callback | `?state&jobIds` | **Unverified** which params Fiskil appends. Put our `state` in `redirect_uri`'s query and verify it survives in the sandbox. Fall back to a per-session KV row keyed by `session_id` |
| "Connection" | Basiq connection (per institution) | **CDR arrangement** (`arrangement_id`, per institution) |
| Consents | `GET /users/{id}/consents` | `GET /consent?end_user_id=` → `arrangement_id, institution_id, active, created_at, expires_at, permissions, account_ids` |
| Accounts | `GET /users/{id}/accounts` | `GET /v1/banking/accounts?end_user_id=` → `fiskil_id, account_id, arrangement_id, institution_id, display_name, masked_number, account_number (**unmasked**), product_category`. Derive `last4` from `masked_number`. **Never read `account_number`/`bsb` past the boundary** (ADR-0003 S11) |
| Transactions | `filter=` grammar, `links.next`, 500/page | `GET /v1/banking/transactions?end_user_id&account_id&from&to&status=POSTED&page[size]=1000&page[after]=`. `amount` is a signed string (reuse `toCents`), `posting_date_time`, `status`, `fiskil_id`, `transaction_id`. Keep the local window + posted + account re-checks. **Verify** whether the `account_id` filter takes `fiskil_id` or the bank's `account_id`, and whether `fiskil_id` is stable across pending→posted |
| Fingerprint | `feed|<basiq id>` | `feed|fiskil:<fiskil_id>`. No production Basiq data exists, so no compatibility constraint; the prefix keeps the two id spaces apart |
| Cursor safety | `safeNextUrl` (origin + `/users/{id}/transactions`) | Store only the opaque `page[after]` token, never a URL, so there is no SSRF/cross-tenant surface |
| Revoke one | `DELETE /users/{u}/connections/{c}` | `DELETE /consent/{arrangement_id}` (204) |
| Delete user | `DELETE /users/{id}` | `DELETE /end-users/{id}` (204/404). **Confirm** it revokes remaining arrangements and deletes Fiskil-held data (PS12) |
| Environment | `BASIQ_ENV` | Sandbox and prod share a base URL; keys decide. Needs an explicit `FISKIL_ENV`, failing closed to `sandbox`, for `requiresAuResidency` |
| Webhooks (v2) | — | `consent.received`, `banking.transactions.sync.completed`; HMAC-SHA256 `X-Fiskil-Signature` |

### Effort estimate

| PR | Scope | Size |
|---|---|---|
| 1 | Extract `BankFeedProvider` and wrap Basiq in it; de-literal `'basiq'` in `agent.ts` SQL/audits (bind `provider.id`); `ProviderError`; `BANK_FEED_PROVIDER` env (default `basiq`). Behaviour-identical, flag stays OFF, units green | ~1 day |
| 2 | `src/lib/fiskil.ts` adapter + `FISKIL_CLIENT_ID/SECRET/ENV` secrets + unit tests with a fake fetch (amount sign, posted-only, window, account filter, unmasked-number stripping, cursor) | ~1–2 days |
| 3 | Sandbox E2E via `wrangler dev` (callback params, `account_id` filter semantics, id stability), consent-dashboard copy, ADR-0003 status update | ~0.5–1 day |

Total ≈ **3–4 focused days**. No migration and no money-math change. Flag OFF ⇒ byte-identical.

> **Status (2026-10-06):** PRs 1 and 2 have landed together. The seam is `src/lib/bank-provider.ts`
> (`BankFeedProvider`, `bankProvider(env, id?)`). The shared helpers and the PS8 decision are in
> `src/lib/bank-feed-core.ts`. Basiq is wrapped as `basiqProvider` with its behaviour unchanged, and
> `src/lib/fiskil.ts` is `fiskilProvider`. Every SQL `'basiq'` literal in the DO now binds the row's
> provider. No migration was needed. PR 3 (the human sandbox consent run) is what remains; see §7.

---

## 4 · Onboarding checklist: Fiskil

**Before the first call (can start today, free):**
- [ ] Sign up at `console.fiskil.com`, generate sandbox `client_id`/`client_secret`, and run the connect → accounts → transactions flow by curl.
- [ ] Prepare the evidence pack Fiskil's rep due diligence asks for: **use case**, **fit-and-proper** declarations for the director, **infosec audit history** (honest answer: none, plus SOC-2-style controls summary from ADR-0003 §10), and a **cyber insurance** quote. Get the quote now, since it's the likeliest gating item for a pre-revenue company.
- [ ] One-page data-flow diagram: Fiskil (AU) → Cloudflare Worker/D1/R2 → Bedrock `au.` (ap-southeast-2/-4 only), with the residency guard and `cdr_tainted` described.

**Commercial call:**
- [ ] Representative vs "Sponsored access": which one, and is a long-term representative position acceptable?
- [ ] Launch plan per-MAC rate. Definition of "active" (accessed that month vs unexpired). Any first-year minimum.
- [ ] **OSPs:** will the arrangement permit Quillo to engage Cloudflare (hosting/compute/storage) and AWS Bedrock ap-southeast-2 (inference) as OSPs for *use/disclosure* (not collection)? Get it in writing. (Ask how Redbark's Cloudflare setup was approved, without naming them.)
- [ ] PS8 posture: what "reasonable steps" evidence does Fiskil require for US-incorporated OSPs? This feeds the #524 legal review.
- [ ] Consent period limits and data-history window configurable in the consent UI (we want ≤12 months and up to 24 months of history).
- [ ] Does `DELETE /end-users/{id}` revoke all arrangements and delete Fiskil-held data?
- [ ] Their CDR policy template, and whether Quillo is listed in Fiskil's CDR policy Annexure.

**Contract and go-live (Fiskil's published checklist):**
- [ ] Application + company profile; security questionnaire.
- [ ] Compliance checklist: branded consent UI, consent period, documented data uses, data-minimisation strategy, deletion/de-identification process, data-sovereignty compliance.
- [ ] Developer checklist: error handling + retries, log `end_user_id`/`consent_id`/`session_id`/`error_id`, delete unused end users, pagination.
- [ ] Lawyer review of the representative agreement (#524) **before signing**.
- [ ] Bedrock Anthropic use-case form submitted (handoff §7.1). Still blocks any production CDR inference.
- [ ] Flip `FISKIL_ENV=production` only after all of the above. `bank_feed_cdr` stays OFF until #524 clears.

---

## 5 · Draft outreach

### 5.1 Short web-form message: Fiskil (≤500 chars)

> Hi Fiskil team. I'm the founder of Quillo (Young Milton Pty Ltd), a tax-records app for first-time Australian taxpayers. We'd like read-only transaction access as a CDR Representative of Fiskil; our sandbox integration is already built, so we can move quickly. Could you share: onboarding steps/timeline, Launch pricing (and a ramped first year), whether we can name Cloudflare and AWS (AU regions) as OSPs, and sandbox access? Thanks, Brendan

### 5.2 Short web-form message: Adatree (≤500 chars)

> Hi Adatree team. I'm the founder of Quillo (Young Milton Pty Ltd), a tax-records app for first-time Australian taxpayers. We're looking for a CDR principal so we can offer read-only bank transaction feeds as a CDR Representative. A working sandbox integration is already built. Could you share onboarding steps and timeline, pricing/minimums (a ramped first year?), whether Cloudflare and AWS (AU regions) can be named OSPs, and sandbox access? Thanks, Brendan

### 5.3 Short web-form message: Yodlee AU (≤500 chars)

> Hi Yodlee AU team. I'm the founder of Quillo (Young Milton Pty Ltd), an Australian tax-records app for first-time taxpayers. We'd like read-only CDR transaction data as a CDR Representative of Yodlee. Our sandbox integration is already built. Could you share onboarding steps/timeline, pricing and minimums for an early-stage company (ramped first year?), whether Cloudflare and AWS (AU regions) can be named OSPs, and CDR sandbox access? Thanks, Brendan

### 5.4 Longer email (Fiskil; swap the name for Adatree/Yodlee)

> **Subject:** CDR Representative enquiry: Quillo, read-only transactions for a tax-records app
>
> Hi Fiskil team,
>
> I'm Brendan Milton, founder of Quillo (Young Milton Pty Ltd), an Australian app that helps
> first-time taxpayers keep the records and evidence they need for their tax return. Today users
> upload bank statements. We'd like to replace that with a consented, read-only CDR feed, and we're
> looking to do it as a CDR Representative of Fiskil.
>
> **What we need:** read-only banking data (accounts and transaction detail) only. No payments, no
> action initiation. Usage is seasonal: a bounded historical backfill (up to 24 months) when a user
> prepares their return, then occasional top-ups. Consumers choose accounts on the consent screen,
> and we fetch only those accounts.
>
> **Where we are:** the connector is already built and tested end-to-end against an aggregator
> sandbox. It covers hosted consent, account mapping, paginated backfill with resumable cursors,
> posted-only ingestion, and a consent dashboard with withdrawal. Withdrawal triggers an upstream
> revoke and deletion of CDR-derived data (PS12), with a CDR audit log. Inference on CDR data is
> restricted in code to AWS Bedrock in Australian regions. Hosting is Cloudflare (Workers, D1, R2).
>
> **Questions:**
> 1. What are the onboarding steps and a realistic timeline to go live as a representative? What
>    does your due diligence need from a one-founder company (insurance, security questionnaire)?
> 2. Pricing on the Launch plan: the per-Monthly-Active-Consent rate, how "active" is defined for a
>    consent that is unexpired but not accessed that month, and any minimums. Is a ramped first year
>    possible while we're pre-revenue?
> 3. Will the representative arrangement permit us to engage Cloudflare (hosting/storage/compute)
>    and AWS (Bedrock, ap-southeast-2) as outsourced service providers for use of CDR data? What
>    evidence would you need on Privacy Safeguard 8 for those providers?
> 4. Is there anything beyond the self-serve sandbox we should test first (consent period settings,
>    history window, end-user deletion behaviour)?
> 5. You describe both a Representative model and "Sponsored access". Which fits our case?
>
> Happy to send a data-flow diagram and our security summary, and to do a call at your convenience.
>
> Thanks,
> Brendan Milton
> Founder, Quillo, Young Milton Pty Ltd
> <your email>

---

## 6 · Key unknowns (resolve on the first call or in the sandbox)

1. **Fiskil's per-MAC rate and the definition of "active"**, which decides the cost model in ADR-0003 §8.
2. **Written OSP permission for Cloudflare + AWS** under Quillo's own arrangement. Redbark is evidence, not a promise.
3. **Representative vs "Sponsored access"** on Fiskil's terms, and whether long-term representative status is OK given no sponsored ADR is active on the Register.
4. **Callback parameters** on Fiskil's redirect, and whether a query string on `redirect_uri` survives. *Partly resolved, see §7: still needs the human consent click.*
5. **`account_id` filter semantics** and **transaction id stability** pending→posted. *Still open, see §7: needs consented sandbox data.*
6. **`DELETE /end-users` scope**: does it revoke arrangements and delete Fiskil-held data? *Partly resolved, see §7: the API contract is verified, the data-deletion scope is a question for Fiskil.*
7. **Cyber insurance** cost for a pre-revenue sole-director company. It's the likeliest due-diligence blocker.

---

## 7 · Sandbox verification (2026-10-06, the connector PR)

The `FiskilProvider` (`src/lib/fiskil.ts`, behind `BANK_FEED_PROVIDER=fiskil`) was built against the live
sandbox by direct API calls. Probe end users were created and then deleted.

**Verified:**

| Question | Answer |
|---|---|
| Token | `POST /v1/token {client_id, client_secret}` returns `{token, expires_in: 900}`. The JWT claims are `org_id, key_id, scope, exp, iat, jti`, with scope `api:banking api:user.read api:user.write`. **Nothing in the token says sandbox or production**, so `FISKIL_ENV` can't be checked against the keys. |
| API version | Responses carry `x-fiskil-version: v3`, the Console default. The adapter pins `X-Fiskil-Version: v3` so a Console change can't reshape responses. `/v1/` in the path is a namespace, not the version. |
| End users | `POST /v1/end-users {email}` returns `{end_user_id: "eu_…"}`. **There is no uniqueness check**: the same email twice gives two end users. `profiles.bank_provider_user_id` is the only 1:1 guard, and end-user create is never retried. |
| Auth session | `POST /v1/auth/session {end_user_id, redirect_uri, cancel_uri}` returns `{id, session_id, expires_at (epoch s, +5 days), auth_url: "https://auth.fiskil.com?sess_id=…"}`. The redirect URI is held server-side (it isn't in `auth_url`), and a query string on it was accepted. Arbitrary redirect hosts were also accepted at session creation, so whether the Console allowlist is enforced at redirect time is unknown. |
| Institutions | `GET /v1/institutions?client_id=` lists the real banks (NAB, CBA, ANZ, …) plus **`88888` "Banking Sandbox Data Holder"**. With sandbox keys, `88888` is the only `is_accessible: true` institution. |
| Transactions filter | `from`/`to` must be RFC3339 instants: a bare `2025-07-01` gets `400 invalid from datetime: not in RFC3339 format`. Offsets like `+10:00` are accepted. `status` is validated (`PENDING | POSTED`). `page[size]` above 1000 is accepted and capped. |
| Pagination | `links.next` is a full URL that carries `page[after]=<token>`. The adapter stores only the token and rebuilds each page from its own base URL. A garbage `page[after]` gets a **503** "temporarily unavailable", not a 400, so a bad cursor burns the retry budget and then fails the run. |
| Errors | Front-door endpoints return `{name, id, message, temporary, timeout, fault}`. Data endpoints return `{id, name, message}`. `id` is the support `error_id`. |
| Delete end user | `DELETE /v1/end-users/{id}` returns 204, then **404 `end_user_not_found` on a repeat** (treated as done). After a delete, `GET /banking/accounts?end_user_id=<deleted>` returns **200 with an empty list**, not 404. |
| Revoke | `DELETE /v1/consent/{arrangement_id}` returns **204 even for an id that doesn't exist**, so a 204 means "accepted" and doesn't prove a consent existed. |
| Consents | `GET /v1/consent?end_user_id=` returns `{consents: [], links: {}}` (the v3 envelope). |

**How the adapter answers the remaining risks:**

- **PS8 with a shared base URL:** the sandbox carve-out in `requiresAuResidency` needs `FISKIL_ENV=sandbox` **and** the connection's institution to be `88888`. Production keys left on `FISKIL_ENV=sandbox` therefore can't make a real bank's data look synthetic.
- **Callback params (#4):** `state` is put in `redirect_uri`'s query. As a fallback, the auth `session_id` is mapped to the state in KV, and the callback accepts `state`, else `sess_id`/`session_id`. The cancel/error redirect goes to `cancel_uri` (`…&outcome=cancel`). The callback records the attempt with `error_type`/`error`/`error_id`/`session_id`, reduced to safe id characters. Fiskil's docs say only that "error details will be included in the query parameters".
- **Account id space (#5):** the adapter stores the bank's `account_id`, which is also what `transactions[].account_id` carries, and sends it as the `account_id` filter. Every row is still re-checked locally against the selected account.
- **Dates:** the window is sent as Sydney-local day bounds (DST-aware), and each row's ledger date is its Sydney-local date, so the provider filter and the local re-check use the same rule.

**Still open:** these need a human to click through consent at `auth.fiskil.com`:

1. Which query params Fiskil appends on success and cancel, and whether `?state=` survives. Check the Worker log for the callback line: a `state` hit is the primary path, and a `sess_id` hit means the fallback was needed.
2. Whether the `account_id` filter takes the bank `account_id` (as built) or `fiskil_id`. Symptom if wrong: the consented account has transactions in the Fiskil Console but the sync imports 0, or other accounts' rows show up as dropped by the re-check.
3. Whether `fiskil_id` is stable across re-fetches. A second sync should import 0 and count every row as a duplicate.
4. Whether accounts are listed **immediately** after the callback. Fiskil fetches data asynchronously and recommends waiting for the `consent.received` webhook. If the callback shows `accounts=0`, wait a minute and connect again: the callback re-lists every live arrangement.
5. Whether `posting_date_time` uses a local offset or UTC (it affects the FY edge only).
6. For Fiskil, outside the API: does `DELETE /end-users` revoke the arrangements and delete Fiskil-held CDR data (PS12)? Does the Console enforce a redirect-URI allowlist? Fiskil emails consent notices to the end user's email, so is the synthetic `tenant-…@users.quillo.au` address acceptable for CDR receipts? This is a compliance question for #524.

---

## Sources (accessed 2026-10-06)

- CDR Register, live data-recipient list: `https://api.cdr.gov.au/cdr-register/v1/all/data-recipients` (header `x-v: 3`). Statuses and accreditation numbers above come from it.
- Fiskil `llms.txt` (pricing, sandbox, rep model): https://www.fiskil.com/llms.txt
- Fiskil CDR policy (rep Annexure, "onshore", no OSPs): https://www.fiskil.com/legal/cdr-policy
- Fiskil, CDR accreditation paths (rep 8 weeks, sponsored ~3 weeks): https://www.fiskil.com/grow/banking-api/open-banking-au/cdr-accreditation
- Fiskil, How do I become a CDR representative?: https://blog.fiskil.com/how-to-become-a-cdr-representative
- Fiskil docs: quick start https://docs.fiskil.com/data-api/guides/getting-started/quick-start · auth https://docs.fiskil.com/data-api/guides/getting-started/authentication · testing https://docs.fiskil.com/data-api/guides/core-concepts/testing · go-live https://docs.fiskil.com/data-api/guides/resources/go-live-checklist · OpenAPI https://docs.fiskil.com/openapi/data-api-front-door.json and https://docs.fiskil.com/openapi/data-api-data-services.json
- Fiskil security (SOC 2 T2, ASAE 3150 T2): https://www.fiskil.com/security
- Redbark compliance (Fiskil rep; Cloudflare Workers + subprocessors): https://redbark.com/compliance
- Skript pricing ("we only do business bank data"): https://www.skript.com.au/pricing
- Frollo CDR policy ("does not currently provide any representative arrangements"): https://frollo.com.au/cdr-policy/
- Adatree: https://www.adatree.com.au · first principal: https://www.brokerdaily.au/innovation/16428-adatree-becomes-first-open-banking-principal · Fat Zebra acquisition: https://www.fatzebra.com/blog/fat-zebra-steps-into-open-banking-with-adatree-acquisition
- Yodlee AU open banking developer docs: https://developer.yodlee.com/products/yodlee/au-open-banking/docs
- ACSISS (SISS): https://www.acsiss.com.au/
- Treasury screen-scraping consultation (closed Oct 2023, no response published): https://treasury.gov.au/consultation/c2023-436961 · Banking Day, "Screen scraping to be reined in" (31 Aug 2023): https://www.bankingday.com/screen-scraping-to-be-reined-in
- CDR reform modelling (TPDC, nominated reps): https://ecommercenews.com.au/story/cdr-reforms-could-add-aud-1-2-billion-study-says
