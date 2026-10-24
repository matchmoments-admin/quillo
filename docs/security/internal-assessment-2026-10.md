# Internal security assessment, October 2026

**This is an internal assessment, NOT a penetration test.** It was carried out by Quillo's own
engineering (the founder working with AI-assisted code review), not by an independent or
CREST-accredited tester. CDR Rules Schedule 2 requires an independent test of the controls: that
external penetration test is scoped separately in [pen-test-scope.md](pen-test-scope.md)
([#703](https://github.com/matchmoments-admin/quillo/issues/703)) and has not yet been performed. Nothing
in this document replaces it.

| | |
|---|---|
| Date | 2026-10-24 |
| System | Quillo: Cloudflare Worker + per-tenant Durable Object, D1, R2, KV, React SPA (`app.quillo.au`) |
| Code baseline | `main` at `0c42248` (after PR #793) |
| Prepared for | Fiskil CDR Representative / OSP review (epic [#633](https://github.com/matchmoments-admin/quillo/issues/633), map [#692](https://github.com/matchmoments-admin/quillo/issues/692)) |
| Status | Draft for the director's sign-off. Engineering input, not legal advice |

## Summary

- **No CRITICAL or HIGH finding is open.** The October vulnerability sweep found none, and the six-lens
  review run on 2026-10-24 found none in its security lens.
- **The sweep's 21 findings are all dispositioned:** 8 fixed, 1 closed as not planned because the feature
  was retired, 3 owner actions, 9 accepted with a reason ([sweep-2026-10.md](sweep-2026-10.md)).
- **The six-lens review raised 1 MEDIUM and 3 LOW security findings.** Their fixes are landing today
  (PR numbers below are placeholders until they merge).
- **Live checks pass:** HSTS, an enforced CSP with no `'unsafe-inline'` in `script-src`, and no CORS on
  `/api`. The runtime dependency audit shows 0 advisories and Dependabot has 0 open alerts.
- **Residency holds:** inference runs on Bedrock `au.` (ap-southeast-2 / ap-southeast-4) by default, the
  live probe passed 5/5, and a CDR-tainted tenant is refused on the US provider.

## Methodology

What was examined, and how:

| Area | Method | Evidence |
|---|---|---|
| Code review against OWASP ASVS 4.0 areas | Manual and AI-assisted read-only review of `src/**` and `web/src/**`, grouped by ASVS chapter: V1 architecture, V2 authentication, V3 session management, V4 access control (tenant isolation), V5 validation and encoding, V7 errors and logging, V8 data protection, V9 communications, V10 malicious code, V12 files and resources, V13 API, V14 configuration | [sweep-2026-10.md](sweep-2026-10.md) method table; the six-lens review below |
| Tenant isolation | Every `.prepare(` checked for `user_id` scoping; every path where identity reaches `stubFor()` | sweep "Checked and clean" |
| Dependency scanning | `npm audit --omit=dev` (root and `web/`), full-tree audit, Dependabot alerts | this document, [vulnerability-management.md](vulnerability-management.md) |
| Secret scanning | gitleaks over all history and the working tree; a pattern scan of `git log --all -p`; GitHub secret scanning with push protection | sweep S-20; GitHub secret-scanning alerts: 0 open |
| Static analysis | GitHub CodeQL (weekly + on PRs) | `.github/workflows/codeql.yml` |
| HTTP headers and CSP | `curl -sI` against production and a foreign-origin CORS preflight to `/api` | "Live verification" below |
| Dynamic baseline | OWASP ZAP baseline (passive) against production, weekly | `.github/workflows/zap-baseline.yml` |
| Automated browser QA | The new-user browser QA suite (Chromium, 1280px and 390px, journey flags ON, AI stubbed, scratch D1) and a read-only GET smoke of production | `npm run qa:browser` (`.github/workflows/qa.yml`), `npm run qa:smoke-prod` |
| Residency and consent | The single `aiCall` gate (`src/lib/ai-call.ts`), `getLLM`'s CDR-tainted refusal, and a live Bedrock probe | `npm run probe:bedrock`, [CONFIG.md](../../CONFIG.md) §3, [#641](https://github.com/matchmoments-admin/quillo/issues/641) |

## Limitations

- **No independent tester.** Everything here was done by the team that built the system, so it carries
  the blind spots of that team. This is the gap Schedule 2's independent testing requirement exists to
  close, and why the external test in [pen-test-scope.md](pen-test-scope.md) is still required.
- **No dynamic exploitation.** Findings come from code review, configuration checks and passive scanning.
  No attempt was made to exploit a finding against production, and no authenticated active scan was run.
  The ZAP baseline is passive only.
- **No authenticated production testing.** Production sign-in needs Clerk, and prod still runs the Clerk
  development instance ([#519](https://github.com/matchmoments-admin/quillo/issues/519)). Authenticated
  flows were exercised under local `wrangler dev` with `DEV_AUTH_BYPASS`, not on production.
- **Infrastructure outside the repo was not re-verified.** The Bedrock IAM policy was verified live on
  2026-08-03, not in this assessment. Cloudflare account settings, the AWS account and the owner's
  devices were checked only from the documents.
- **Dormant features were reviewed as code only.** Bank feeds (`bank_feed_cdr`) are OFF and sandbox-only.
  The receipt mailbox and QuickBooks are retired behind flags.

## Evidence 1: the October vulnerability sweep

Full report: [sweep-2026-10.md](sweep-2026-10.md) (#694, run 2026-10-24 against `37117ab`). **21 findings,
no CRITICAL or HIGH.**

| ID | Severity | Finding | Status |
|---|---|---|---|
| S-01 | MEDIUM | Stored originals served with the uploader's content type (stored XSS) | Fixed, [PR #706](https://github.com/matchmoments-admin/quillo/pull/706) |
| S-02 | MEDIUM | Part of a setup IAM key's secret appeared in a screenshot | Owner action, [#518](https://github.com/matchmoments-admin/quillo/issues/518) |
| S-03 | MEDIUM | Receipt mailbox had no sender check | Closed, not planned ([#711](https://github.com/matchmoments-admin/quillo/issues/711)): mailbox retired, [PR #789](https://github.com/matchmoments-admin/quillo/pull/789) |
| S-04 | MEDIUM | OAuth `state` not bound to the starting browser | Fixed, [PR #733](https://github.com/matchmoments-admin/quillo/pull/733) (#712) |
| S-05 | MEDIUM | Admin routes gated by role alone, no MFA | Owner switch: `admin_mfa_required` after TOTP enrolment; Clerk cutover [#519](https://github.com/matchmoments-admin/quillo/issues/519) |
| S-06 | LOW | Error bodies leaked D1 and Bedrock messages | Fixed, [PR #710](https://github.com/matchmoments-admin/quillo/pull/710) |
| S-07 | LOW | Foreign ids written without an ownership check | Fixed, [PR #708](https://github.com/matchmoments-admin/quillo/pull/708) |
| S-08 | LOW | No upload size cap before buffering | Fixed, [PR #728](https://github.com/matchmoments-admin/quillo/pull/728) (#713), [PR #769](https://github.com/matchmoments-admin/quillo/pull/769) |
| S-09 | LOW | CSP allowed `'unsafe-inline'` script and `*.quillo.au` | Fixed, [PR #737](https://github.com/matchmoments-admin/quillo/pull/737) (#714) |
| S-10 | LOW | Stripe checked only the last `v1=` signature | Fixed, [PR #707](https://github.com/matchmoments-admin/quillo/pull/707) |
| S-11 | LOW | `ip-address` advisory in the runtime tree | Fixed, [PR #705](https://github.com/matchmoments-admin/quillo/pull/705) |
| S-12 | LOW | Default Clerk authorized parties include localhost | Owner action, [#519](https://github.com/matchmoments-admin/quillo/issues/519) cutover runbook |
| S-13 to S-21 | INFO | Dev-only advisories, pseudonymous ids in logs, fail-open rate limiter, non-atomic HMAC nonce, legacy CSV path, delayed Stripe methods, IAM as designed, gitleaks false positive, unscoped read-side joins | Accepted with a reason (see the sweep) |

## Evidence 2: the six-lens review (2026-10-24)

A review of the whole codebase and docs through six parallel lenses: architecture, correctness,
security, docs, ops and domain design (DDD). The non-security lenses' findings are tracked separately; the
docs and ops findings about stale documentation and an unsafe Bedrock rollback procedure are fixed in the
same PR as this document.

**Security lens: no CRITICAL or HIGH findings.**

| ID | Severity | Finding | Where | Status |
|---|---|---|---|---|
| R-01 | MEDIUM | Unbounded body reads on public (pre-auth) routes when `Content-Length` is absent. The #713 caps check the declared length before buffering, so a chunked request with no `Content-Length` is read in full (for example `/csp-report` reads the whole body before slicing to 8 KB). A memory-amplification risk within one isolate, not a data exposure | `src/index.ts` public POST routes | **Fixed** in PR #799, deployed `e0790b0` (2026-10-24); verified live: oversize chunked bodies to `/csp-report` and the Stripe webhook return 413 |
| R-02 | LOW | CSV formula-guard mismatch. The WFH diary export neutralises a leading `= + - @ \t \r`, but the shared `neutraliseFormula` used by the accountant schedule (CSV and xlsx) covers only `= + - @` | `src/lib/accountant-schedule.ts` `neutraliseFormula`; `src/lib/wfh-diary.ts` | **Fixed** in PR #799, deployed `e0790b0` (2026-10-24) |
| R-03 | LOW | The OAuth binding cookies (`quillo_qbo_bind`, `quillo_bank_bind`) don't use the `__Host-` prefix, so a sibling subdomain could in principle set or shadow them. They carry no identity, and the nonce is useless without its server-side state | `src/lib/oauth-binding.ts` | **Fixed** in PR #799, deployed `e0790b0` (2026-10-24) |
| R-04 | LOW | The `/api` error scrub (`scrubApiErrorResponse`) only rewrites responses with status 400 or higher, so an internal message inside a 200 response's `errors[]` array (a partial-success batch) reaches the client unredacted | `src/lib/security-headers.ts` | **Fixed** in PR #799, deployed `e0790b0` (2026-10-24) |

## Evidence 3: live header and CSP verification

Checked against `https://app.quillo.au` on 2026-10-24 with `curl -sI`:

- `Strict-Transport-Security: max-age=31536000; includeSubDomains`.
- An **enforced** `Content-Security-Policy` with `default-src 'self'`, `object-src 'none'`,
  `frame-ancestors 'none'`, `base-uri 'self'` and `form-action 'self'`. `script-src` allows `'self'`, one
  `sha256-` hash for the single inline script, and named Clerk and Turnstile hosts. **No `'unsafe-inline'`
  in `script-src`.**
  - Honest caveats: `style-src` still allows `'unsafe-inline'`, and the enforced policy still names
    `https://*.clerk.accounts.dev`. A Report-Only policy that pins the exact Clerk host is live alongside
    it, ready to promote once the Clerk production cutover (#519) fixes the host.
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy: camera=(), microphone=(), geolocation=(self), payment=(), usb=()`.
- A foreign-origin `OPTIONS` preflight to `/api/situation` returns **401 with no `Access-Control-*`
  headers**. `/api` authenticates by Bearer header only (no cookies), so CSRF does not apply to it.

## Evidence 4: dependency audit

| Check | Result (2026-10-24) |
|---|---|
| `npm audit --omit=dev` (root) | 0 vulnerabilities |
| `npm audit --omit=dev` (`web/`) | 0 vulnerabilities |
| Dependabot alerts | 0 open |
| Overrides in force | `zod ^4.6.6`; scoped `undici` (via miniflare and promptfoo); `fast-uri ^3.1.9`; `body-parser` (promptfoo-only path). Each is recorded with its reason and removal condition in [vulnerability-management.md](vulnerability-management.md#runtime-dependency-overrides) |
| Full-tree (dev) advisories | Accepted dev-only exceptions, none in the Worker or SPA bundle (sweep S-13) |

## Evidence 5: automated controls

| Control | What it does | State (2026-10-24) |
|---|---|---|
| GitHub CodeQL | Static analysis on PRs and weekly | Running. 7 open alerts, **all in test and QA tooling** (`scripts/check-units.ts`, `scripts/qa/*`), none in `src/` or `web/src/`: 4 stack-trace exposure, 2 missing regex anchors, 1 URL substring check. To be triaged as test-code noise or fixed |
| GitHub secret scanning + push protection | Blocks and alerts on committed secrets | 0 open alerts |
| Dependabot | Dependency advisories and update PRs | 0 open alerts |
| OWASP ZAP baseline | Passive scan of production, weekly | Last two weekly runs passed (2026-10-11, 2026-10-18) |
| `npm test` (`tests.yml`) | Typecheck, unit goldens, persona goldens (11 personas), e2e journeys, schema drift, source guards (for example no raw `getLLM(` outside `aiCall`) | See the CI note below |
| Browser QA (`qa.yml`) | `npm run qa:browser`: the real SPA in Chromium against local `wrangler dev`; only new failures go red (known defects in `scripts/qa/known.ts`) | See the CI note below. Last local run against the prod flag set: 91/91 routes, journeys 259/259 |
| Prod smoke | `npm run qa:smoke-prod`: read-only GET checks of production | Run manually after each deploy |

**CI note (found while preparing this assessment).** Since 2026-10-23 22:28 UTC, the `tests.yml` and
`qa.yml` PR runs fail at `npm ci` ("package.json and package-lock.json … are not in sync: Missing
`undici@7.29.1`"), after the undici override in PR #783. The gates did not run on the PRs merged since
then (#785, #789, #791, #792, #793). Those PRs were checked locally before merge, but the CI evidence is
missing until the lockfile is fixed and the suites re-run on `main`.

## Evidence 6: data residency and consent

- **Bedrock `au.` is the default provider** for every tenant since 2026-10-24
  (`DEFAULT_INFERENCE_PROVIDER = "bedrock"`, PR #745). The `au.` inference profile routes only to
  ap-southeast-2 and ap-southeast-4 (verified 2026-08-03), and that region list is pinned by a golden.
- **Live probe 5/5** (`npm run probe:bedrock`): a receipt image, a statement PDF, an Ask call and a
  prompt-cache repeat through the real extractors on Bedrock `au.`, plus a check that a **CDR-tainted
  tenant is refused on the US provider**. First run 2026-10-22, repeated before the default flip.
- **One enforcement point.** Every model call goes through `aiCall` (`src/lib/ai-call.ts`: consent,
  budget, `getLLM`, audit), and `npm test` fails on a raw `getLLM(` call outside it (#721).
  `getLLM` refuses any non-AU-resident provider for a tenant with `profiles.cdr_tainted = 1` (one-way).
- **IAM backstop.** The Worker's AWS key may only invoke the `au.` profile and the Sydney and Melbourne
  model ARNs, with an explicit Deny outside those regions (a `us-east-1` call was refused, 2026-08-03).
- **Rollback is documented safely.** Reverting the default to the US provider requires pinning
  unconsented and CDR-tainted tenants to Bedrock first ([CONFIG.md](../../CONFIG.md) §3).

## Open items

| Item | Owner | Ticket |
|---|---|---|
| External penetration test by an independent tester (Schedule 2) | Owner (RFQ) | [#703](https://github.com/matchmoments-admin/quillo/issues/703), [pen-test-scope.md](pen-test-scope.md) |
| R-01 to R-04 fixes merged and deployed | Engineering | **Done**: PR #799 (deploy `e0790b0`) |
| CI `npm ci` lockfile failure fixed; suites re-run on `main` | Engineering | **Done**: PR #796; tests, browser QA, CodeQL and audit all green in CI |
| Clerk production cutover and admin MFA (`admin_mfa_required`) | Owner | [#519](https://github.com/matchmoments-admin/quillo/issues/519), [owner-tasks.md](owner-tasks.md) |
| Confirm the leaked setup IAM key is deleted | Owner | [#518](https://github.com/matchmoments-admin/quillo/issues/518) |
| Triage the 7 CodeQL alerts in test tooling | Engineering | none yet |

## Addendum: post-fix verification (2026-10-24)

The fixes above were applied together with the review's other findings. The combined `main` was then re-verified.

**Re-verification of the combined `main`:**

| Check | Result |
|---|---|
| `npm test` units | 2552 passed |
| Persona golden checks | 630, all passing |
| AU report snapshot | Byte-identical |
| Browser QA suite (`qa:browser`), every journey at 1280px and 390px, all personas, the 1,500-line background import | **452 / 452** |
| Read-only production smoke (`qa:smoke-prod`) | Passed on deploy `b375eda1` |
| Dependabot open alerts | 0 |

**Related fixes shipped in the same pass:**
- The WFH diary uses the tenant's local date (#794).
- The diary no longer discards hours recorded before it (#797, migration 0089).
- Large statement imports finish on a background continuation instead of inside the upload request (#798).
- Every deploy is tagged with its commit (#800).

This remains an internal assessment, not a penetration test. The independent external test scoped in `pen-test-scope.md` is still required.

