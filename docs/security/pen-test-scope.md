# Penetration test scope and request for quote

Wayfinder ticket [#703](https://github.com/matchmoments-admin/quillo/issues/703) on map
[#692](https://github.com/matchmoments-admin/quillo/issues/692). Drafted 2026-10-24 against `main` at
`98758a0`, after the internal sweep ([sweep-2026-10.md](sweep-2026-10.md), #694).

This is what the owner sends to testers. The owner buys the test and signs the engagement. An agent
fixes the findings through the ship workflow in `CLAUDE.md`, one PR per finding, and the tester
retests them. Nobody has been contacted yet.

## 1. Objectives and the CDR basis

The test has to satisfy two clauses of CDR Rules Schedule 2, which applies to Quillo as a CDR
Representative through r1.10AA(4)(b) ([research note](https://github.com/matchmoments-admin/quillo/blob/research/fiskil-requirements/docs/research/fiskil-car-requirements.md), #693, §1 and §5.2; on branch `research/fiskil-requirements`):

| Clause | Text | What the test must show |
|---|---|---|
| Part 2, control 4 | "A formal vulnerability management program is designed and implemented, which includes regular vulnerability scanning **and penetration testing** on systems within the CDR data environment" | A manual test of every system in the CDR data environment ([cdr-data-environment.md](cdr-data-environment.md)). The automated scanners already cover the scanning part ([vulnerability-management.md](vulnerability-management.md#scanners)). This closes [control-matrix.md](control-matrix.md) row 4(c). |
| Part 1, cl 1.6(4) | Testing "is conducted by appropriately skilled persons who are independent from the performance of controls over the CDR data environment" | The tester is a third party with no role in building or running Quillo, and the report says so. This is the independence gap in [vulnerability-management.md](vulnerability-management.md#independence-gap-cl-164). One engagement can cover both clauses. |

The regulators tell principals such as Fiskil to ask representatives for "vulnerability and penetration
testing reports" ([ACCC/OAIC representative-principal guidance, Jan 2025](https://www.cdr.gov.au/sites/default/files/2025-01/CDR-guidance-for-CDR-representative-principals-on-ensuring-compliance-of-their-CDR-representatives-published-15-January-2025.pdf),
§3.2.1, §3.2.4.1). Fiskil hasn't published the scope it expects. Question 1 in the research note §7 asks
them, so **send that question before signing a quote**. If Fiskil asks for more than this scope, add it
to the test before it starts.

The test should answer three questions:

1. Can one tenant read or change another tenant's data, or act as another tenant?
2. Can an unauthenticated outsider get in, or reach a tenant's data or the operator's admin surface?
3. Can content a tenant uploads (a receipt, a statement, an email) make the system do something the
   tenant didn't ask for, such as running script, triggering a tool call, or reaching another tenant?

## 2. In-scope targets

Quillo is one Cloudflare Worker serving the SPA and `/api/*`. Each tenant gets its own `TaxAgent`
Durable Object. The stores are D1 `tax-agent-db`, R2 `tax-agent-receipts` and KV `RULES`
([feature-inventory.md](../architecture/feature-inventory.md#architecture-in-one-paragraph)).
The code is public at <https://github.com/matchmoments-admin/quillo>, so the tester has the source.

| # | Target | Entry points | What to try |
|---|---|---|---|
| T1 | SPA and API | `https://app.quillo.au/` (or the test host in §5); about 88 `/api/<resource>` groups in `src/api.ts` and 9 Worker routes in `src/index.ts` | OWASP Top 10 and API Top 10 across every authenticated route. Mass assignment, IDOR on every id-taking route, input validation, and error responses (S-06 made these generic) |
| T2 | Clerk authentication | Sign-up, sign-in, sign-out, session refresh; JWT verification in `src/auth/clerk.ts` (JWKS, issuer, `azp`, `exp`/`nbf`) | Token forgery, `alg` confusion, replay of an expired or signed-out token, `azp` and origin handling (S-12), account enumeration, the open-signup path (`CLERK_ALLOWED_USERS=""`) |
| T3 | Tenant isolation | Two test tenants, A and B (§6) | From A, read, change or delete B's transactions, receipts, documents, statements, properties, entities, reports and exports, using every id-taking route. Tenant selection from any header, query or body field. The sweep found none ("Checked and clean"), and this target is the one Fiskil cares about most |
| T4 | Uploads and R2 originals | `POST /api/upload`, `POST /api/documents/upload`, `POST /api/statements`, `GET /api/receipt/:txnId`, `GET /api/documents/:id/download` | Content-type and polyglot tricks against the serve-point allowlist (S-01, PR #706). Path or key manipulation in R2 keys (`${userId}/…`). Oversized bodies against the pre-read size caps (#713, PR #728; CSV statements capped at 5 MB, #769). PDF, CSV and image parser abuse. CSV formula injection in exports |
| T5 | Receipt email inbound (**retired**) | Worker `email()` handler, Cloudflare Email Routing, `tenants.email_localpart` | **Verify the retirement holds.** The mailbox is retired behind `mailbox_retired` (ON in prod, PR #789; #711 closed as not planned). Every inbound message must be bounced before the MIME parse, the tenant lookup or any R2/D1/DO write (`src/lib/mailbox-retired.ts`). Confirm forged senders, guessed slugs and oversized or malformed MIME are all refused with the same bounce, nothing reaches a tenant's ledger or AI budget, and the feature can't be re-enabled without a `FEATURES` change and redeploy |
| T6 | Stripe webhook | `POST /api/stripe/webhook` | Signature bypass, replay, timestamp tolerance (PR #707), a forged `checkout.session.completed`, double credit, metadata that points at another tenant |
| T7 | Bank feed (Fiskil) callback | `GET /api/bank/connect`, `GET /api/bank/callback`, `GET /api/bank/connections` (flag `bank_feed_cdr`, Fiskil sandbox) | State forgery, reuse and expiry. Callback for another tenant's state. State is now bound to the browser that started the connect (#712, PR #733): try replaying another browser's state. **There are no Fiskil or Basiq webhooks**: the callback is the only inbound entry from the aggregator |
| T8 | QuickBooks OAuth (**retired**) | `GET /api/qbo/connect`, `GET /api/qbo/callback` and every other `/api/qbo/*` route | **Verify the retirement holds.** QuickBooks is retired for everyone behind `qbo_retired` (ON in prod, PR #791). Every `/api/qbo/*` route, including the public OAuth callback, must answer 404 before touching Intuit, the KV state nonce or the stored tokens (`src/lib/qbo-retired.ts`). Confirm no route, method or path variant reaches the old handlers, and that nothing short of a `FEATURES` change and redeploy re-enables them |
| T9 | Admin endpoints | `/api/admin/*` (spend, tenant roles, referrals, the QBO token backfill, the Security & compliance page) | Reaching admin as a normal tenant. Role self-assignment through `PUT /api/admin/tenants/:id/roles`. The MFA gate with `admin_mfa_required` ON (S-05). Whether a 403/404 leaks that the admin surface exists |
| T10 | Rate limits and cost caps | `API_IP_RATE_LIMITER` (600/min), `API_USER_RATE_LIMITER` (300/min), the per-tenant and global AI spend caps (`MAX_DAILY_COST_CENTS`, `MAX_DAILY_COST_CENTS_GLOBAL`, `MAX_MONTHLY_COST_CENTS_GLOBAL`) | Whether the limits can be bypassed (IP rotation, header spoofing, parallel tenants), and whether one tenant can burn the global AI budget. Prove each limit with a short burst, not a flood (see §4) |
| T11 | Bedrock inference and prompt injection | Every model call: extraction, categorisation, document classification, chat/Ask (`src/llm.ts`, `src/extract.ts`) | Instructions planted in receipts, PDFs, statement lines and emails that try to change the tool call, write to the wrong record, leak another tenant's data or the system prompt, or get a chat `proposed_action` applied that the user didn't confirm. Every call is pinned to one record-only tool, and actions are checked against the tenant's own ids. Try to break that. Also test the residency gate: can a CDR-tainted tenant reach a non-Bedrock provider? |
| T12 | Headers and CSP | Live response headers, `src/lib/security-headers.ts`, `web/public/_headers` | CSP bypasses (`script-src` has no `'unsafe-inline'` and no `*.quillo.au` since #714), clickjacking, CORS on `/api/*`, HSTS, cache headers on authenticated responses |
| T13 | Marketing hosts | `https://quillo.au/`, `https://www.quillo.au/` (waitlist, terms, privacy) | Light coverage only: the waitlist form and any injection. They share the Worker, so a bug there can matter |

## 3. Out of scope

- **Cloudflare, AWS and Clerk themselves.** Don't attack Cloudflare's edge, Workers runtime, D1, R2 or
  KV services; AWS Bedrock or IAM beyond calls Quillo makes; or Clerk's hosted pages and APIs. Each
  vendor has its own terms and bug bounty. Testing *how Quillo uses* them, such as its JWT checks and
  IAM scoping, is in scope.
- **Fiskil, Intuit (QuickBooks) and Stripe systems.** Use their sandboxes only, through Quillo's
  integrations.
- **Denial of service and load testing.** No volumetric, resource-exhaustion or sustained flood
  testing. A short burst to show that a rate limit or size cap works is fine (T4, T10). The scale
  ceiling is a separate map item.
- **Social engineering, phishing and physical attacks** on the owner, and the owner's laptop
  (an endpoint review is separate: [endpoint-standard.md](endpoint-standard.md)).
- **The owner's own tenant and any real customer data** (see §4).
- **The GitHub repository and CI**, beyond reading the public source.

## 4. Test approach

**Grey-box.** The tester gets two tenant accounts, an admin account, the source, this document, the
sweep report and the architecture docs. Black-box discovery of an app whose code is public wastes paid
days.

**Standard:** [OWASP ASVS 4.0.3](https://owasp.org/www-project-application-security-verification-standard/)
**Level 2** as the coverage checklist, with the
[OWASP Web Security Testing Guide](https://owasp.org/www-project-web-security-testing-guide/) as the
method and the [OWASP API Security Top 10](https://owasp.org/API-Security/) for `/api/*`. For T11,
use the [OWASP Top 10 for LLM Applications](https://genai.owasp.org/llm-top-10/) (LLM01 prompt
injection, LLM06 excessive agency). Ask the tester to say which ASVS L2 chapters they covered and which
they didn't, so the report can be read as evidence.

**Manual first.** Automated scanning is already continuous (CodeQL, Dependabot, a weekly ZAP baseline,
`npm audit`). Paid time should go on authorisation logic, tenant isolation and the injection paths.

**Effort.** Ask each firm for its own estimate. A reasonable starting point for T1–T13 is roughly
**5 to 8 tester-days**, plus reporting and one retest. This is our estimate, not a quote.

## 5. Rules of engagement

- **Window:** a fixed window of up to two weeks, agreed in writing. Testing runs on business days,
  08:00–20:00 AEST, unless the tester asks for more. The owner is reachable throughout (contact in
  the engagement letter).
- **Stop conditions:** the tester stops and calls the owner on any of these: a finding that exposes
  real personal data; a critical issue (auth bypass or cross-tenant read); a failure that takes down the
  test environment; or anything that touches the owner's tenant or production data.
- **Critical findings** are reported the same day, not held for the final report. The patch SLAs then
  apply: critical in 48 hours, high in 7 days ([vulnerability-management.md](vulnerability-management.md#patch-slas)).
- **No production customer data.** Prod has exactly one real tenant, which is the owner's own tax
  return (property, income and receipts). No CDR data exists anywhere yet (`bank_feed_cdr` is OFF in
  prod, and Fiskil is in sandbox). The tester must never read, change or try to reach that tenant.
- **Sandbox integrations only:** Stripe test mode and the Fiskil sandbox (data holder 88888).
  QuickBooks is retired (T8), so no Intuit sandbox is needed.
- **Data handling:** the tester holds test data and evidence encrypted, deletes it 90 days after the
  retest, and doesn't keep or reuse any credentials.
- **Disclosure:** the report is confidential. The owner may share it with Fiskil, regulators and
  insurers under NDA. The tester doesn't publish anything about Quillo without written consent.

### Where to test: a preview environment or prod with throwaway tenants

| | **A. Separate preview Worker plus its own D1 (recommended)** | **B. Production with throwaway tenants** |
|---|---|---|
| Setup | A `wrangler deploy --env pentest` Worker with its own D1, R2 bucket, KV namespace and DO namespace, seeded from `schema.sql`. Host on `workers.dev`. A separate Clerk development instance. Sandbox Stripe, Fiskil and QBO keys. Roughly a day of owner and agent work (§6) | No new infrastructure. Create two or three test accounts through open signup |
| Owner's real data | **Physically separate.** A successful cross-tenant or admin exploit reaches synthetic data only | **Same D1 and R2 as the owner's tax data.** A successful cross-tenant exploit (T3) or admin exploit (T9) exposes the owner's real return. That's the exact thing the test is looking for |
| What it proves | The code at the tested commit, with the flags the tester needs (e.g. `bank_feed_cdr` and `admin_mfa_required` ON) | The exact prod config: custom domain, zone settings, live `_headers`, prod secrets and the real Clerk instance |
| Destructive tests | Safe: deleting, bulk-importing, cost-cap and rate-limit bursts, purge | Risky: every write lands in prod D1, every model call is real spend, and a rate-limit burst can block the owner |
| Email inbound (T5) | Needs an Email Routing rule that sends a test address on `quillo.au` to the preview Worker, to prove it bounces | Works as is: every message to the mailbox bounces |
| Fiskil sandbox (T7) | Works. The non-production guard (`isNonProductionDeployment`, `src/lib/bank-feed-core.ts`) permits only the sandbox data holder | Needs `bank_feed_cdr` ON in prod, which is gated on the consent dashboard and Fiskil approval |
| Drift risk | The preview must match prod. Deploy the same commit and copy `FEATURES` from `wrangler.toml` | None |

**Recommendation: A**, plus a short **read-only prod check** on the last day: TLS, headers and CSP
(T12), the unauthenticated surface, the Stripe webhook's refusal of a bad signature (T6), and the
marketing hosts (T13). None of that touches tenant data, and it covers the prod-only config that A
can't. B is cheaper, but the test is designed to find a cross-tenant read, and in prod a successful
one exposes the owner's own return.

Two details for option A:

- **Don't host the preview on a `quillo.au` subdomain.** The prod CSP no longer trusts `*.quillo.au`
  (#714), but cookies and HSTS `includeSubDomains` still span the apex. Use `*.workers.dev`.
- **Mark it as non-production without turning auth off.** Set `DEV_AUTH_BYPASS=1` as a *secret* on the
  preview (never in `wrangler.toml`: `check-units` refuses that), **and** set `CLERK_ISSUER` to the
  preview Clerk instance. The auth bypass only applies when `CLERK_ISSUER` is unset
  (`src/auth/clerk.ts:66-76`), so real Clerk auth stays on, while the CDR non-production guard treats
  the deployment as non-prod and refuses anything except sandbox banks.

**Timing:** ideally after the Clerk production cutover (#519), so the report shows what Fiskil will
actually assess. #712, #713 and #714 are fixed, and #711 is moot because the mailbox is retired. If the
owner wants the report sooner, test now and list the cutover items as known (§8).

## 6. Test-account setup (owner checklist)

Agent tasks are marked *(agent)*. Everything else needs the owner's own accounts.

1. **Send Fiskil question 1** (research note §7): which questionnaire, and what pen-test scope? Adjust
   §2 if needed.
2. *(agent)* Add an `[env.pentest]` block to `wrangler.toml` with its own D1, R2, KV, DO and rate-limiter
   bindings and the prod `FEATURES` list plus `bank_feed_cdr` and `admin_mfa_required`. Keep it free of
   `DEV_AUTH_BYPASS`. Ship it as a small PR.
3. Create the preview resources: `wrangler d1 create tax-agent-pentest-db`, an R2 bucket, a KV
   namespace. Seed with `npx wrangler d1 execute tax-agent-pentest-db --remote --file=schema.sql`, and
   push the rule pack to the new KV.
4. Create a **separate Clerk development instance** for the pentest host. Set `CLERK_ISSUER` and
   `CLERK_AUTHORIZED_PARTIES=https://<pentest-host>` on the preview Worker.
5. Set the preview secrets: `DEV_AUTH_BYPASS=1` (secret, see §5), Stripe **test-mode** keys and a
   test webhook secret, Fiskil **sandbox** keys (`BANK_FEED_PROVIDER=fiskil`), and a
   Bedrock key. Prefer a **separate IAM user** with the same `QuilloBedrockAuInvoke` policy, so the
   tester's traffic is separable in CloudTrail and the key can be deleted afterwards. Set low AI spend
   caps (for example `MAX_DAILY_COST_CENTS_GLOBAL` at A$10 a day).
6. Deploy the commit being tested: `npm run web:build && npx wrangler deploy --env pentest`. Record
   the commit SHA for the report.
7. Add an Email Routing rule that sends `pentest-*@quillo.au` to the preview Worker, so T5 can confirm it bounces.
8. Create three Clerk accounts on the preview, using email addresses the tester controls:
   - **Tenant A** and **Tenant B**: ordinary users. Load each with synthetic data from a persona
     fixture (e.g. P6 Susan & Greg for A, P8 James for B), so every id-taking route has rows to aim at.
     Give each a mailbox slug, so T5 can confirm a known slug still bounces.
   - **Admin**: assign the `admin` role (`PUT /api/admin/tenants/:id/roles`) and enrol TOTP, so the
     MFA gate can be tested both ways.
9. Connect Tenant A to the Fiskil sandbox, so T7 has a live connection. T8 needs no QuickBooks
   connection: it only checks that every `/api/qbo/*` route 404s.
10. Send the tester: the host, the three logins (through a password manager share, never email), this
    document, [sweep-2026-10.md](sweep-2026-10.md) and the repo link.
11. After the retest: delete the three Clerk users, the IAM user and its key, and the preview Worker
    and its stores. Record the deletion in [owner-tasks.md](owner-tasks.md).

## 7. Deliverables the Fiskil questionnaire needs

1. **Full report** with:
   - an executive summary;
   - scope, tested commit SHA, hosts, dates and test window;
   - method (ASVS L2 chapters covered and not covered, WSTG);
   - for each finding: severity, CVSS v3.1 (or v4.0) vector, the affected target (T1–T13), reproduction
     steps, evidence and a fix recommendation;
   - a statement of anything that was out of scope or couldn't be tested.
2. **Severity ratings** on a Critical / High / Medium / Low / Info scale that maps to our patch SLAs.
3. **Retest letter (attestation)** on the firm's letterhead after the retest. It should give the
   status of each finding (fixed, mitigated or accepted), the retest date, and a short statement that
   can go to Fiskil without the full report.
4. **Independence and competence statement** for cl 1.6(4): the firm has no other relationship with
   Quillo, the testers had no role in building or running it, and the testers' qualifications (CREST
   CRT/CCT, OSCP/OSWE or similar). The firm's accreditation (CREST, and which CREST body) and its
   professional indemnity cover.

File the report under `docs/security/` as a link only (not the PDF, because the repo is public). Then
update control-matrix rows 4(c) and 1.6(4) and the questionnaire answers.

## 8. Known issues already tracked (don't re-report)

The tester should confirm these still behave as described and note them as "known". They needn't
spend time proving them again.

| Ref | Issue | State |
|---|---|---|
| [#711](https://github.com/matchmoments-admin/quillo/issues/711) (S-03) | Receipt mailbox accepts mail from any sender, no rate limit | Closed as not planned: the mailbox is retired (`mailbox_retired` ON, PR #789), so every message bounces. T5 checks the retirement holds |
| [#712](https://github.com/matchmoments-admin/quillo/issues/712) (S-04) | OAuth `state` not bound to the starting browser (QBO and bank callbacks) | Fixed: [PR #733](https://github.com/matchmoments-admin/quillo/pull/733) binds state to the starting browser. QuickBooks is also retired (`qbo_retired`, PR #791) |
| [#713](https://github.com/matchmoments-admin/quillo/issues/713) (S-08) | No server-side upload size cap | Fixed: [PR #728](https://github.com/matchmoments-admin/quillo/pull/728) caps uploads before the body is read; CSV statements capped at 5 MB (#769) |
| [#714](https://github.com/matchmoments-admin/quillo/issues/714) (S-09) | CSP `script-src` allows `'unsafe-inline'` and `*.quillo.au` | Fixed: [PR #737](https://github.com/matchmoments-admin/quillo/pull/737), hash-only inline script enforced, exact Clerk FAPI hosts |
| S-02, [#518](https://github.com/matchmoments-admin/quillo/issues/518) | Partly exposed `quillo-setup` IAM key | Owner action |
| S-05, [#519](https://github.com/matchmoments-admin/quillo/issues/519) | Admin routes gated by role only while `admin_mfa_required` is OFF in prod; prod on the Clerk development instance | Owner switch (ON in the preview, so it can be tested) |
| S-12, [#519](https://github.com/matchmoments-admin/quillo/issues/519) | `CLERK_AUTHORIZED_PARTIES` unset in prod, `localhost` in the default list, token without `azp` accepted | Fixed by the cutover runbook |

**Accepted risks** from the sweep (reasons in [sweep-2026-10.md](sweep-2026-10.md#ranked-findings)):

- S-13: dev-only advisories.
- S-14: raw tenant id in some cron logs.
- S-15: rate limiters fail open when the binding errors.
- S-16: non-atomic HMAC nonce on `/ingest` (0 device keys issued).
- S-17: legacy CSV export without formula guard (flag OFF path).
- S-18: delayed Stripe payment methods not credited.
- S-19: long-lived Bedrock access key.
- S-20: gitleaks false positives.
- S-21: read-side joins to `properties` / `entities` not scoped by `user_id`.

A new way to *exploit* an accepted risk, such as a cross-tenant read through S-21, is a new finding
and should be reported.

Fixed in the sweep, worth a retest: S-01 (PR #706), S-06 (PR #710), S-07 (PR #708), S-10 (PR #707),
S-11 (PR #705).

## 9. Request-for-quote email template

> **Subject:** RFQ: grey-box web application and API penetration test (CDR Schedule 2), small AU SaaS
>
> Hi [name],
>
> I run Quillo (app.quillo.au), an Australian tax-records web app. It's a single Cloudflare Worker
> (React SPA plus a JSON API), with Clerk for sign-in, Stripe for top-ups, AWS Bedrock in Sydney for
> document extraction, and a Fiskil open-banking connection. We're applying to become a CDR
> Representative under Fiskil, and Schedule 2 of the CDR Rules requires an independent penetration
> test (control 4 and cl 1.6(4)).
>
> I'd like a quote for a **grey-box test against OWASP ASVS Level 2 / WSTG**, covering:
>
> - the SPA and around 90 API route groups;
> - Clerk auth flows;
> - tenant isolation, with two test tenants;
> - uploads and stored files;
> - inbound receipt email (retired: confirm it stays refused);
> - the Stripe webhook;
> - the bank OAuth callback, and that the retired QuickBooks routes stay closed;
> - admin endpoints;
> - rate limits;
> - prompt injection from uploaded documents into the model's tool calls;
> - headers and CSP.
>
> The source code is public, and I'll provide a scope document, our internal sweep report (21
> findings, with known issues listed so you don't re-report them), test accounts, and a dedicated
> test environment with sandbox integrations. DoS and the Cloudflare, AWS and Clerk platforms are out
> of scope.
>
> Deliverables: a full report with CVSS severities, one retest, and a retest letter I can give to
> Fiskil, plus a short statement of your independence and the testers' qualifications.
>
> Could you tell me:
>
> 1. your fixed price (ex GST) and the number of tester-days, including the retest;
> 2. your earliest available window;
> 3. which accreditation you hold (CREST International or CREST ANZ, and which disciplines) and the
>    testers' certifications;
> 4. whether you've tested multi-tenant SaaS or LLM-backed features before;
> 5. your professional indemnity cover;
> 6. whether you'll sign a mutual NDA, and let me share the report with Fiskil under NDA.
>
> I can send the full scope document on request.
>
> Thanks,
> [owner name]
> [company], [ABN]
> [phone]

## 10. Shortlist of testers

Every firm below has a **CREST Penetration Testing accreditation**, shown on its own CREST Marketplace
profile (checked 2026-10-24), and is based in Australia. The firms were chosen for size and a web-app
focus that suits a one-app SaaS. **None has been contacted.** Before signing, check two things:

- the exact legal entity on the contract shows the accreditation on
  [marketplace.crest.org](https://marketplace.crest.org/);
- which CREST body accredits the firm. CREST International and CREST ANZ are separate organisations
  ([Stingrai, 2026](https://www.stingrai.io/blog/top-penetration-testing-companies-australia-2026),
  a vendor source).

| Firm | Where | Size (CREST profile) | Why it fits | Price signal | Sources |
|---|---|---|---|---|---|
| **Project Black** | Sydney and Melbourne | Fewer than 10 employees | Web apps and APIs are 60% of its technical focus. Information technology is 50% of its sectors. It sells fixed-scope and subscription engagements and includes retest support | Its own site: "Most of the penetration tests we perform fall within the range of $6,000-$10,000 (AUD) depending on scope", smallest from about A$3,600. CREST profile: 90% of projects under £10k | [CREST profile](https://marketplace.crest.org/supplier/project-black/), [pricing page](https://projectblack.io/penetration-testing/) |
| **Dvuln** | Sydney, Melbourne, Brisbane | Fewer than 10 | Specialises in application security, cryptography and secure development; offers agile pentesting and DevSecOps. Also holds the CREST AI Charter, which is relevant to T11 | Not published | [CREST profile](https://marketplace.crest.org/supplier/dvuln-pty-ltd/), [site](https://dvuln.com/) |
| **Mercury Information Security Services** | Australia | 10–49 | An assessment and assurance practice. Web applications and APIs are 20% of its focus | Not published. CREST profile: projects most often £10k–£25k (30%) or £25k–£50k (30%); 20% under £10k | [CREST profile](https://marketplace.crest.org/supplier/mercury-information-security-services-pty-ltd/) |
| **Stratus Security** | Melbourne | Fewer than 10 | Accredited for Penetration Testing and Vulnerability Assessment (March 2026). Offers web application testing | Not published | [CREST profile](https://marketplace.crest.org/supplier/stratus-security/), [CREST announcement](https://www.crest-approved.org/stratus-security-achieves-crest-accreditation-validating-high-assurance-standards-for-penetration-testing/) |
| **Tanto Security** | Melbourne and Sydney | 10–49 | ISO 27001 certified. Financial services is 40% of its sectors, which fits a CDR context. Web apps and APIs are 20% of its focus | Not published. CREST profile: projects most often £100k–£500k (40%) or £50k–£100k (30%), so likely the dearest option here | [CREST profile](https://marketplace.crest.org/supplier/tanto-security-pty-ltd/), [site](https://tantosec.com) |
| **ctrl:cyber** | Australia | 50–99 | Larger and ISO 27001 certified. Offers web and mobile application testing. A fallback if the small firms have no window | Not published | [CREST profile](https://marketplace.crest.org/supplier/ctrlcyber/) |

### Indicative price

Only one shortlisted firm publishes prices: Project Black says A$6,000–10,000 (AUD) for most tests.
Wider market signals:

- **Day rates:** Expert360 says "experienced penetration testers in Australia sit around A$1,000 to
  A$1,800/day" ([Expert360](https://expert360.com/expert-titles/penetration-testers)). At our estimate
  of 5–8 tester-days (§4), that's roughly **A$5,000–14,400 ex GST** before reporting and retest. This is
  arithmetic on a third-party rate, not a quote.
- **Manual tests:** Epic IT, a vendor, puts "manual testing against a defined scope" at $18,000 to
  $45,000, and scan-based tests at $5,000 to $12,000. The currency isn't labelled, and the page's date
  is unclear
  ([Epic IT](https://www.epicit.com.au/penetration-testing-australian-smb-2026/)).
- **GST:** Australian quotes are usually ex GST, so add 10%.

**Working budget:** about **A$6,000–15,000 ex GST**. The low end is Project Black's published range;
the high end is the Expert360 day rate times our upper day estimate. Expect the larger firms to quote
above it. Treat a quote far below A$5,000 with suspicion, because it's likely an automated scan, which
doesn't meet control 4 or cl 1.6(4).

## 11. After the test

1. Each finding becomes a GitHub issue labelled `security`, with a severity and a due date from the
   patch SLAs (cl 1.6(3)).
2. An agent fixes each one through the ship workflow, one PR at a time, then the tester retests.
3. Update [control-matrix.md](control-matrix.md) rows 4(c) and 1.6(4),
   [vulnerability-management.md](vulnerability-management.md#penetration-testing) and
   [questionnaire-answers.md](questionnaire-answers.md), then add the retest letter to the Fiskil
   submission pack (map #692).
4. Book the next test. "Regular" means at least once a year, and again after a material change to the
   CDR data environment, such as turning on `bank_feed_cdr` in prod.
