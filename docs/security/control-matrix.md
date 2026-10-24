# Schedule 2 control matrix (master tracker)

> **This is the master tracker for Fiskil CDR Representative readiness** (epic [#633]). Every step in
> Part 1 and every control in Part 2 of **Schedule 2 of the Competition and Consumer (Consumer Data
> Right) Rules 2020** has a row. Schedule 2 applies to Quillo through the representative arrangement:
> **r1.10AA(4)(b)** requires a CDR representative to "take the steps in Schedule 2 to protect the
> service data as if it were the CDR representative principal". Rule 1.16A makes Fiskil liable for our
> failures, so Fiskil checks this strictly.
>
> Source text: [CDR Rules, F2020L00094 (compilation of 2025-03-04)](https://www.legislation.gov.au/F2020L00094/latest/text),
> Schedule 2. OAIC guidance: [CDR representative model: privacy obligations](https://www.oaic.gov.au/consumer-data-right/consumer-data-right-guidance-for-business/privacy-obligations/cdr-representative-model-privacy-obligations-of-a-cdr-representative)
> and [Privacy Safeguard Guidelines ch. 12](https://www.oaic.gov.au/consumer-data-right/cdr-privacy-safeguard-guidelines/chapter-12-privacy-safeguard-12-security-of-cdr-data-and-destruction-or-de-identification-of-redundant-cdr-data).
>
> **Status legend:** ✅ control live in production, with evidence we can point to · 🟡 built or
> drafted, but needs a flag flip, a secret or an owner action before it counts (the row says which) ·
> ⬜ not started · 👤 needs the owner (not code). **Exit criterion:** every row ✅ before the owner
> submits the Fiskil security questionnaire ([owner-tasks.md](owner-tasks.md) C9).
>
> **Honesty rule:** a row is ✅ only when the evidence column points at something that exists today.
> Planned work is 🟡 or ⬜ with its ticket. Last full review: **2026-10-17**, every row re-checked
> against `main` (a5f1af0) and the deployed Worker (version `39c7df14`), the live response headers,
> `wrangler.toml` `FEATURES`, the prod secret list and the GitHub security settings. Previous review:
> 2026-10-08 (initial draft, #642). Partial update **2026-10-24** (map #692 review fixes): the switch
> list, 2(a), 4(b), 4(c) and 5(b) re-checked against `wrangler.toml` `FEATURES` and the prod secret list
> after the mailbox and QuickBooks retirements, the Bedrock default and the sweep fixes. Row counts
> unchanged.
>
> **Format contract:** the admin Security & compliance page (#636) parses this file at deploy
> (`npm run security:push-docs`). Keep each control table's header as `| ID | Control | … | Status | …`,
> keep ids unique, and start every Status cell with exactly one glyph (✅ / 🟡 / ⬜). Do not put another
> ✅ or the words "done", "met" or "complete" later in a Status cell: the parser would count the row as
> met. `npm run test:units` ("security pack") guards this.

Context for every row: Quillo is operated by **one person** (the director of Young Milton Pty Ltd,
trading as Quillo). "Senior management", "personnel" and "users" in Schedule 2 all mean that one person
today; [information-security-policy.md](information-security-policy.md) §3 explains how separation of
duties is handled with one person.

## Summary

**55 rows: 6 ✅ live · 40 🟡 built, needs a switch or the owner · 9 ⬜ not started** (2026-10-17;
was 5 / 41 / 9 on 2026-10-08. The old summary table said 5 / 40 / 10, which was a miscount).

**Live** (in production now, evidence in the row):

- 1(i) encryption in transit: TLS, HSTS and enforcing CSP on every response (PR #666; header check
  blocking in CI since PR #670). This is the row that moved to ✅ in this review.
- 1(g) unique IDs, no shared accounts.
- 2(c) server hardening, by architecture (serverless).
- 4(b) secure coding: CI gates, `npm audit` gate, CodeQL (PR #644).
- r7.2(8) Fiskil CDR policy link (PR #667).
- r1.10AA(4)(e) deletion on the principal's direction (purge reseat PR #623).
- Also live, inside rows that stay 🟡 for other reasons: API rate limiting (`api_rate_limit` ON,
  PR #678) in 1(h); PII out of runtime logs (PR #666) in 1(c); the Security & compliance page
  (PR #665) in 1.6(2); Dependabot, CodeQL, secret scanning with push protection, weekly ZAP and 0 open
  alerts (PRs #644, #670, #671, #677) in 1.6(1), 4(a), 4(c); the no-CDR-in-non-prod guard (PR #679)
  in 3(b); PS12 deletion on withdrawal (#576); the Fiskil adapter's `error_id` / `session_id` logging
  (PR #631); consent-expiry deletion, inactive end-user deletion and S8b statement redaction
  (`cdr_expiry_delete`, `cdr_inactive_user_delete`, `redact_statement_lines` ON, PR #686) in 3(c), PS12;
  the October sweep fixes, including OAuth state bound to the starting browser (PR #733), upload size
  caps before the body is read (PR #728) and a hash-only CSP `script-src` (PR #737), in 4(c); one
  `aiCall` gate (`src/lib/ai-call.ts`, #721) that enforces APP-8 consent and the budget before every
  model call, with Bedrock `au.` the default provider since 2026-10-24 (#745), in PS8.
- **Retired surfaces** (smaller attack surface, each one flag away from undone): the receipt mailbox
  (`mailbox_retired` ON, PR #789: every inbound message bounces before parsing; #711 closed as not
  planned) in 5(b), and QuickBooks (`qbo_retired` ON, PR #791: every `/api/qbo/*` route returns 404)
  in 2(a).

**Built, needs a switch** (code is on `main` and deployed; it does nothing until this is set):

- Secret `D1_EXPORT_TOKEN` (Account · D1 · Read), then flag `d1_backups`: daily D1 export to
  `tax-agent-backups` (PR #674; the bucket exists, both restore tests passed). Rows 2(a), 3(c).
- QuickBooks token sealing (PR #643): **not needed while `qbo_retired` is ON**, since no route can
  store a token and prod has 0 `qbo_connections` rows. Only if QuickBooks is un-retired: secret
  `QBO_TOKEN_KEY`, then `POST /api/admin/qbo-token-backfill`, then flag `qbo_token_fail_closed`, all
  before that redeploy (order in [secrets-and-encryption.md](secrets-and-encryption.md)). Row 2(a).
- Flag `admin_mfa_required`, only after the owner has enrolled TOTP (PR #673). Rows 1(a), 1(b).
- Flag `bank_minimisation` (PR #679): the retention and minimisation cron. Stays OFF until a FY is
  marked lodged and the notice copy is reviewed. Rows 1.5(1)(b), 3(c), PS12. (`cdr_expiry_delete`,
  `cdr_inactive_user_delete` and `redact_statement_lines` are ON since PR #686.)
- Flag `security_monitoring`: live checks on the Security & compliance page (PR #665). Row 1.6(2).
- Flag `bank_feed_cdr`, last, after Fiskil approval and production `FISKIL_CLIENT_ID/SECRET`. Row 2(e).
- (The `GEOAPIFY_KEY` clean-up is finished: it is absent from the 2026-10-24 prod secret list.)

**Owner action** (not code; [owner-tasks.md](owner-tasks.md)):

- Clerk production cutover ([runbook](clerk-production-cutover.md)) and MFA on every account (C1):
  1(a), 1(h). Prod still runs the Clerk development instance.
- Laptop hardening (C2): 1(e), 2(a) FileVault, 2(b), 2(d), 3(a), 4(a), 5(a)–(c).
- Training (C3) and police check (C4): 6(a), 6(c). Sign acceptable use: 6(b).
- ~~Bedrock use-case form (C6)~~ done 2026-10-22; AU inference is live 2026-10-22: `npm run probe:bedrock` 5/5 (receipt image, statement PDF, Ask, prompt cache, CDR-tainted refusal) on `au.anthropic.claude-haiku-4-5-20251001-v1:0` in ap-southeast-2.
- Lawyer (C7) and Fiskil (C9): r1.10AA(4)(f), r7.2(4)(f)–(g), r1.10AA(3)(b), PS8 storage, Div 4.3
  consent, 1.7(3)(b) notification window, OSP attestations for 1(e).
- Adopt and sign the Part 1 documents (1.3–1.7), then run the first cycles: quarterly access review
  1(d), monthly dashboard review 1(c)/1.6(2), annual review 1.3(4)/1.5(2)/1.6(5), tabletop 1.7(4).
- Uptime monitor (C8): 1.7(1).
- Decisions: an independent tester 1.6(4); a penetration test 4(c); the #524 ruling on derived
  leftovers (PS12).

| Area | Rows | ✅ | 🟡 | ⬜ |
|---|---|---|---|---|
| Part 1 — steps 1–5 (cl 1.3–1.7) | 21 | 0 | 19 | 2 |
| Part 2 — control requirement 1 (access) | 9 | 2 | 6 | 1 |
| Part 2 — control requirement 2 (network and systems) | 5 | 1 | 3 | 1 |
| Part 2 — control requirement 3 (asset lifecycle) | 3 | 0 | 3 | 0 |
| Part 2 — control requirement 4 (vulnerabilities) | 3 | 1 | 2 | 0 |
| Part 2 — control requirement 5 (malware) | 3 | 0 | 1 | 2 |
| Part 2 — control requirement 6 (people) | 3 | 0 | 1 | 2 |
| Representative-specific obligations | 8 | 2 | 5 | 1 |
| **Total** | **55** | **6** | **40** | **9** |

Most Part 1 rows are 🟡 rather than ✅ because the documents exist (this pack) but have not yet been
**reviewed and adopted by the owner** (sign-off line in each document) and their first cycle (access
review, tabletop test, annual review) has not yet run.

## Part 1 — Steps for privacy safeguard 12

| ID | Control | Quillo's control | Evidence | Status | Owner / ticket |
|---|---|---|---|---|---|
| 1.3(1) | Formal governance framework for information-security risk to CDR data: policies, processes, roles, responsibilities | This pack. The information security policy sets the framework; each standard below covers one area; this matrix tracks it | [information-security-policy.md](information-security-policy.md), this file | 🟡 drafted (PR #667); owner action: review and sign the adoption line | 👤 sign-off |
| 1.3(2) | Documented practices and procedures for information security and CDR data, including senior management's responsibilities | Roles table (director = senior management, security owner, privacy officer, incident lead) and the standards in this pack | [information-security-policy.md §3](information-security-policy.md#3-roles-and-responsibilities) | 🟡 drafted (PR #667); owner action: adopt | 👤 sign-off |
| 1.3(3)(a) | Information security policy states the risk posture: exposure and potential harm to information assets, including CDR data | Risk register with the top risks to CDR data (tenant isolation, offshore disclosure, credential compromise, supply chain, data loss) | [information-security-policy.md §4](information-security-policy.md#4-risk-posture) | 🟡 drafted (PR #667); owner action: adopt | 👤 sign-off |
| 1.3(3)(b) | Policy explains how practices, procedures and controls mitigate those risks | Each risk maps to controls in this matrix | [information-security-policy.md §4](information-security-policy.md#4-risk-posture) | 🟡 drafted (PR #667); owner action: adopt | 👤 sign-off |
| 1.3(4) | Review and update the framework on material change, or at least annually | Annual review in October each year, plus a trigger list (new OSP, new data type, incident, Fiskil requirement change) | [information-security-policy.md §6](information-security-policy.md#6-review-cadence) (review log) | 🟡 cadence defined; owner action: record the first annual review (October) | 👤 |
| 1.4(1) | Assess, define and document the boundaries of the CDR data environment | Boundary, data inventory and data-flow diagram | [cdr-data-environment.md](cdr-data-environment.md) | 🟡 drafted (PR #667); owner action: confirm the boundary | 👤 |
| 1.4(2) | Review the boundary on material change, or at least annually | Same annual review and triggers; boundary review log in the CDE document | [cdr-data-environment.md §7](cdr-data-environment.md#7-boundary-review-log) | 🟡 review log in place; owner action: first boundary review | 👤 |
| 1.5(1)(a) | Information security capability complies with the Part 2 controls | Part 2 rows below | This file, Part 2 | 🟡 follows the Part 2 rows below | see Part 2 |
| 1.5(1)(b) | Capability is appropriate to the threats, the CDR data held, and potential consumer harm | Data held is minimised to transactions and masked accounts (no name, contact, payees, full account numbers); risk-based controls | [cdr-data-environment.md §3](cdr-data-environment.md#3-what-cdr-data-quillo-holds), [information-security-policy.md §4](information-security-policy.md#4-risk-posture) | 🟡 minimisation core built (PR #679); switch: `bank_minimisation`; owner action: adopt the risk posture | 👤 flip flag |
| 1.5(2) | Review and adjust capability on material change, or at least annually | Part of the annual review | [information-security-policy.md §6](information-security-policy.md#6-review-cadence) | 🟡 owner action: part of the first annual review | 👤 |
| 1.6(1) | Testing program to assess the effectiveness of the capability, at a risk-appropriate frequency | Controls assessment program: automated per-PR tests, weekly scans, quarterly access review, annual tabletop and policy review | [vulnerability-management.md](vulnerability-management.md#controls-assessment-program-cl-16), [`.github/workflows/tests.yml`](../../.github/workflows/tests.yml), [`.github/workflows/codeql.yml`](../../.github/workflows/codeql.yml), [`.github/workflows/zap-baseline.yml`](../../.github/workflows/zap-baseline.yml) | 🟡 automated layer live (PRs #644, #670: per-PR tests + `npm audit`, weekly CodeQL and ZAP, last runs green 2026-10-12); owner action: run and record the first quarterly access review and annual tabletop | 👤 |
| 1.6(2) | Monitor and evaluate design, implementation and operating effectiveness of controls | Admin-only Security & compliance page (`/admin/security`) shows control status (parsed from this file), scan results, headers, backups, errors, CDR activity and residency; on-demand checks behind `security_monitoring` | [`src/lib/security-dashboard.ts`](../../src/lib/security-dashboard.ts) (PR #665); `npm run deploy` runs `security:push-docs`, which republishes this file to the page | 🟡 dashboard live (PR #665); switch: `security_monitoring` for the live checks; owner action: start the monthly review | 👤 flip flag |
| 1.6(3) | Escalate testing deficiencies to senior management | Senior management is the owner; every failed test becomes a GitHub issue labelled `security` with a severity, and is recorded in this matrix | [vulnerability-management.md §5](vulnerability-management.md#controls-assessment-program-cl-16) | 🟡 process defined; owner action: record the first escalation when a test fails | 👤 |
| 1.6(4) | Testing conducted by appropriately skilled persons **independent** of performing the controls | **Gap.** A one-person company cannot be independent of itself. Partial mitigation: automated third-party tooling (CodeQL, Dependabot, GitHub secret scanning, OWASP ZAP) and adversarial multi-agent code reviews that do not share the author's context. No independent human tester or third-party audit yet | [vulnerability-management.md §6](vulnerability-management.md#independence-gap-cl-164) | ⬜ owner decision: independent reviewer (annual) vs. accept and disclose | 👤 decision · #640 |
| 1.6(5) | Review sufficiency of the testing program on material change, or at least annually | Annual review | [vulnerability-management.md §5](vulnerability-management.md#controls-assessment-program-cl-16) | 🟡 owner action: part of the first annual review | 👤 |
| 1.7(1) | Procedures to detect, record and respond to incidents as soon as practicable | Incident response plan; incident register; detection sources (Workers Logs, cost-error counter, sync-failure rows, external uptime monitor, provider notices) | [incident-response-plan.md](incident-response-plan.md) | 🟡 plan drafted; detection partly live (dashboard PR #665, stale-backup warning PR #674); owner action: external uptime monitor (C8) | 👤 C8 |
| 1.7(2) | Response plans for plausible incidents | Playbooks: credential compromise, tenant-isolation bug, offshore inference of CDR data, provider breach, data loss, lost laptop | [incident-response-plan.md §7](incident-response-plan.md#7-playbooks) | 🟡 drafted (PR #667); owner action: adopt | 👤 |
| 1.7(3)(a) | Plans cover all stages, detection to post-incident review | Seven-stage lifecycle with checklists | [incident-response-plan.md §4](incident-response-plan.md#4-lifecycle) | 🟡 drafted (PR #667); owner action: adopt | 👤 |
| 1.7(3)(b) | Notify the Information Commissioner and consumers under Privacy Act Part IIIC | NDB assessment (30 days max) and notification steps; notify Fiskil first (principal) | [incident-response-plan.md §5](incident-response-plan.md#5-notifications) | 🟡 drafted; owner action: confirm Fiskil's notification window | 👤 C9 |
| 1.7(3)(c) | Notify the ACSC as soon as practicable, no later than 30 days after becoming aware | ReportCyber step with the 30-day deadline in the register | [incident-response-plan.md §5.4](incident-response-plan.md#54-australian-cyber-security-centre-acsc) | 🟡 drafted (PR #667); owner action: adopt | 👤 |
| 1.7(4) | Review and test response plans on material change, or at least annually | Annual tabletop exercise, template and record | [incident-response-plan.md §9](incident-response-plan.md#9-annual-tabletop-test) | ⬜ first tabletop not yet run | 👤 |

## Part 2 — Minimum information security controls (cl 2.2)

### Control requirement 1 — limit the risk of inappropriate or unauthorised access to the CDR data environment

| ID | Control | Quillo's control | Evidence | Status | Owner / ticket |
|---|---|---|---|---|---|
| 1(a) | MFA: MFA or equivalent for all access to CDR data (consumer access excluded) | Staff access paths to CDR data are the Cloudflare dashboard/API (D1, R2, Workers Logs), GitHub (deploy pipeline, secrets), AWS (Bedrock) and the in-app admin role. MFA on every one; admin role in Clerk production requires MFA | [access-control-standard.md §2](access-control-standard.md#2-multi-factor-authentication), §8; admin MFA gate [`src/lib/access-control.ts`](../../src/lib/access-control.ts) (`fva` claim, flag `admin_mfa_required`); [clerk-production-cutover.md](clerk-production-cutover.md) | 🟡 server-side admin MFA gate built (PR #673); switch: `admin_mfa_required` after the owner enrols TOTP; owner action: MFA on every account (C1) and the Clerk production cutover (prod still runs the Clerk development instance) | 👤 C1 · flip flag |
| 1(b) | Restrict admin privileges: Admin rights only as needed and only for as long as needed; ongoing grants reviewed | Just-in-time rule for the in-app `admin` role and for Cloudflare API tokens; scoped tokens; quarterly review | [access-control-standard.md §4](access-control-standard.md#4-administrative-privileges-just-in-time), [`src/lib/roles.ts`](../../src/lib/roles.ts), admin gate [`src/api.ts`](../../src/api.ts) (`resource === "admin"`) | 🟡 server-enforced role gate live; MFA gate built (PR #673), switch: `admin_mfa_required`; JIT rule written (§4); owner action: record the first quarterly review | 👤 flip flag · quarterly review |
| 1(c) | Audit logging and monitoring: Critical events logged, retained (r9.3: 6 years) and reviewed regularly | Hash-chained `audit_log` for every tenant write; `cdr_audit_log` (0085) for every consent, collection, withdrawal, deletion and purge (ids and counts only, never CDR content); both are **excluded from purge** so they outlive the data; Workers Logs for runtime errors | [`schema.sql`](../../schema.sql) (`audit_log`, `cdr_audit_log`), [`src/lib/bank-consent.ts`](../../src/lib/bank-consent.ts), [`src/lib/retention.ts`](../../src/lib/retention.ts) (`PURGE_TABLES` comment), no-PII-in-console lint in [`scripts/check-units.ts`](../../scripts/check-units.ts) (PR #666) | 🟡 audit logs live; PII taken out of runtime logs and lint-guarded (PR #666); owner action: monthly review on the dashboard. Gap: Workers Logs keep days, not the 6 years r9.3 asks (no ticket yet) | 👤 monthly review |
| 1(d) | Access security: Timely provisioning and revocation; review of user access at least quarterly | Joiner/leaver steps; quarterly access review log | [access-control-standard.md §5–6](access-control-standard.md#5-quarterly-access-review) | ⬜ first quarterly review not yet run | 👤 |
| 1(e) | Limit physical access: Physical access to facilities where CDR data is stored, hosted or accessed restricted to authorised people | Hosting: Cloudflare and AWS data centres (inherited, their SOC 2 / ISO 27001 controls). Access: one laptop in the owner's home office, FileVault, screen lock, never left unlocked in public | [endpoint-standard.md](endpoint-standard.md), [osp-register.md](osp-register.md) | 🟡 inherited for hosting; owner action: download the OSP attestations (C9) and harden the laptop (C2) | 👤 C2 · C9 |
| 1(f) | Role-based access: Least privilege and segregation of duties | App: roles `individual/admin/accountant/bookkeeper/support/partner`, server-side checks; tenant isolation by `user_id` on every table and identity derived server-side (never a client header). Infra: scoped Cloudflare API tokens | [`src/lib/roles.ts`](../../src/lib/roles.ts), [CLAUDE.md](../../CLAUDE.md) "Multi-tenant" invariant, [access-control-standard.md §3](access-control-standard.md#3-least-privilege-and-role-based-access) | 🟡 app RBAC live; owner action: audit infra token scoping. Segregation of duties impossible for one person (see policy §3) | 👤 |
| 1(g) | Unique IDs: Generic/shared/default accounts only where necessary; their actions monitored and logged | No shared human accounts. Service identities: the Worker itself, the GitHub Actions runner (no prod credentials today), the AWS IAM user for Bedrock (invoke-only), Fiskil API client | [access-control-standard.md §7](access-control-standard.md#7-service-accounts-and-api-keys) | ✅ | — |
| 1(h) | Password authentication: Strong authentication, complexity, lockout, history, ageing | Consumers: Clerk (breached-password checks, lockout, rate limiting). Staff: password manager, unique 20+ character passwords, MFA. Ageing replaced by NIST 800-63B / ASD guidance (change on suspicion of compromise) | [access-control-standard.md §2](access-control-standard.md#2-multi-factor-authentication), §8; API rate limiting [`src/lib/access-control.ts`](../../src/lib/access-control.ts), bindings `API_IP_RATE_LIMITER` / `API_USER_RATE_LIMITER` in [`wrangler.toml`](../../wrangler.toml) | 🟡 API rate limiting live in prod (flag `api_rate_limit` ON, PRs #673 + #678: 600/min per IP, 300/min per tenant); owner action: Clerk production instance ([cutover runbook](clerk-production-cutover.md)) | 👤 C1 · cutover runbook |
| 1(i) | Encryption in transit: Encrypt data in transit, authenticate access, audit access and use, verify the identity of communications | TLS everywhere (Cloudflare edge, Fiskil API over HTTPS with OAuth client credentials, Bedrock SigV4-signed HTTPS). HSTS (1 year, `includeSubDomains`) and an enforcing CSP on every response, asset-served SPA routes included (`web/public/_headers`). Session JWTs verified against Clerk JWKS | [`src/lib/security-headers.ts`](../../src/lib/security-headers.ts), [`web/public/_headers`](../../web/public/_headers), [`src/auth/clerk.ts`](../../src/auth/clerk.ts), [`src/lib/sigv4.ts`](../../src/lib/sigv4.ts), header check in [`.github/workflows/zap-baseline.yml`](../../.github/workflows/zap-baseline.yml) | ✅ live (PR #666; header check blocking since PR #670); HSTS + CSP seen on app.quillo.au 2026-10-17 | — |

### Control requirement 2 — secure the network and systems within the CDR data environment

| ID | Control | Quillo's control | Evidence | Status | Owner / ticket |
|---|---|---|---|---|---|
| 2(a) | Encryption: Encrypt CDR data at rest (file systems, devices, portable media, backups); keys secured; access to keys authenticated | D1 and R2 are encrypted at rest by Cloudflare (AES-256). No per-user third-party credentials are stored: QuickBooks is retired (`qbo_retired` ON, PR #791, every `/api/qbo/*` route 404s before touching tokens) and prod has 0 `qbo_connections` rows; the AES-256-GCM sealing (`QBO_TOKEN_KEY`, PR #643) stays built for an un-retire. CDR feeds store no tokens. Laptop: FileVault. Backups: daily D1 export to the private R2 bucket `tax-agent-backups` (encrypted at rest) | [`src/lib/token-crypto.ts`](../../src/lib/token-crypto.ts), [`src/lib/qbo-retired.ts`](../../src/lib/qbo-retired.ts), [secrets-and-encryption.md](secrets-and-encryption.md), [backup-dr.md](backup-dr.md) | 🟡 at-rest encryption inherited and no stored tokens (QuickBooks retired, 0 rows); `QBO_TOKEN_KEY` + `qbo_token_fail_closed` only needed before any QuickBooks un-retire. Backups built and restore-tested twice (PR #674); switch: secret `D1_EXPORT_TOKEN` + flag `d1_backups` (bucket `tax-agent-backups` exists). Owner action: confirm FileVault (C2) | 👤 set secret · flip flag · C2 |
| 2(b) | Firewalls: Limit traffic from untrusted sources; deny unnecessary traffic; restrict and review firewall configuration | No servers or open ports: the Worker only answers HTTPS at Cloudflare's edge (DDoS protection, TLS termination). D1, R2, KV and the Durable Object are not internet-reachable except through the Worker bindings or the authenticated Cloudflare API. Laptop: macOS firewall on | [cdr-data-environment.md §5](cdr-data-environment.md#5-network-boundary), [endpoint-standard.md](endpoint-standard.md) | 🟡 edge in place by design; owner action: laptop firewall (C2) | 👤 C2 |
| 2(c) | Server hardening: Harden servers, databases and OSes to industry standards | Serverless: Cloudflare runs and hardens the runtime (V8 isolates); we manage no OS or database server. Our part: minimal bindings, pinned `compatibility_date`, secrets only via `wrangler secret` | [`wrangler.toml`](../../wrangler.toml), [osp-register.md](osp-register.md) | ✅ by architecture (Cloudflare attestations to be filed, C9) | — |
| 2(d) | End-user devices: End-user devices (including BYOD) hardened to industry standards | Endpoint standard (FileVault, auto-updates, firewall, screen lock, standard account, password manager, XProtect) | [endpoint-standard.md](endpoint-standard.md) | ⬜ owner to apply and record | 👤 C2 |
| 2(e) | Data segregation: CDR data held for a representative is segregated, accessible only by the right recipient and attributable to it | Per-tenant isolation (`user_id` on every row, server-side identity, one Durable Object per tenant). CDR rows marked `source='cdr_feed'` (`kind='bank_line'`) and connections recorded per provider; tenant flagged `profiles.cdr_tainted=1` (one-way); every CDR row attributable to its Fiskil consent via `bank_connections` | [cdr-data-environment.md §6](cdr-data-environment.md#6-segregation), [`migrations/0075_bank_connections.sql`](../../migrations/0075_bank_connections.sql), [`migrations/0077_profiles_cdr_tainted.sql`](../../migrations/0077_profiles_cdr_tainted.sql) | 🟡 built and unit-tested; no production CDR data yet; switch: `bank_feed_cdr` after Fiskil approval and production keys | 👤 C9 · flip flag |

### Control requirement 3 — securely manage information assets over their lifecycle

| ID | Control | Quillo's control | Evidence | Status | Owner / ticket |
|---|---|---|---|---|---|
| 3(a) | Data loss prevention: Prevent data leaving the CDE: block unapproved cloud services, monitor outbound email, block email containing CDR data, block writes to portable media | Architectural: the app has no CDR export or email path (the APP-12 export is the consumer's own data, to the consumer). Staff rule: CDR data never leaves production (no D1 exports to the laptop, no screenshots, no email, no USB). Outbound integrations are allow-listed (OSP register) and enforced by CSP `connect-src` in the browser | [acceptable-use.md](acceptable-use.md), [data-handling.md §6](data-handling.md#6-masking-and-non-production), [osp-register.md](osp-register.md) | 🟡 policy-based, browser side enforced by CSP `connect-src` (PR #666); no technical blocking of USB/email on the laptop (no MDM), residual risk; owner action: adopt acceptable-use.md and harden the laptop (C2) | 👤 C2 |
| 3(b) | CDR data in non-production: Mask CDR data before it reaches non-production | Non-production uses Fiskil **sandbox** only (synthetic data from institution `88888`); production CDR data is never copied to local or preview. In code, a non-production deployment (`DEV_AUTH_BYPASS=1`) refuses a connect on production credentials, drops a real bank's connection at the callback before anything is stored, and fails a sync before the first fetch — only the sandbox test banks on sandbox credentials pass (Fiskil `88888`, Basiq `AU00000`) | [`src/lib/bank-feed-core.ts`](../../src/lib/bank-feed-core.ts) (`cdrBlockedInThisDeployment`, `requiresAuResidency`), unit checks "non-prod:" / "PS8: production env" in [`scripts/check-units.ts`](../../scripts/check-units.ts), [data-handling.md §6](data-handling.md#6-masking-and-non-production) | 🟡 guard live in code at connect, callback (refused consents revoked upstream) and sync, unit-tested (PR #679). Residual: the non-prod marker is `DEV_AUTH_BYPASS=1`; owner action: adopt the data-handling.md §6 staff rule that covers it | 👤 adopt §6 |
| 3(c) | Information asset lifecycle: Classification and handling policy; backup, retention, deletion and de-identification (r7.12, r7.13) | Classification, minimisation (#534 / #581), retention schedule (#594), PS12 deletion on withdrawal (#576), purge on account deletion (#623) | [data-handling.md](data-handling.md), [`src/lib/bank-consent.ts`](../../src/lib/bank-consent.ts), [`src/lib/retention.ts`](../../src/lib/retention.ts), [`src/lib/minimise.ts`](../../src/lib/minimise.ts), [`src/lib/retention-schedule.ts`](../../src/lib/retention-schedule.ts) | 🟡 expiry deletion and inactive end-user deletion **live** (`cdr_expiry_delete`, `cdr_inactive_user_delete` ON, PR #686); retention cron built, switch `bank_minimisation` still OFF. Purge on account deletion live (PR #623). Backups: switch `D1_EXPORT_TOKEN` + `d1_backups` (PR #674) | 👤 `bank_minimisation` · set secret |

### Control requirement 4 — formal vulnerability management program

| ID | Control | Quillo's control | Evidence | Status | Owner / ticket |
|---|---|---|---|---|---|
| 4(a) | Security patching: Identify, risk-assess and apply security patches to applications and OSes as soon as practicable | Patch SLAs (critical 48h, high 7 days, medium 30 days); Dependabot for npm (root + `web/`); macOS automatic updates; runtime patched by Cloudflare | [vulnerability-management.md](vulnerability-management.md#patch-slas), [`.github/dependabot.yml`](../../.github/dependabot.yml) | 🟡 SLAs + Dependabot live (PR #644; runtime alerts cleared in PRs #671, #677; 0 open alerts 2026-10-17); owner action: confirm laptop auto-updates (C2) | 👤 C2 |
| 4(b) | Secure coding: Changes designed and developed to secure-coding practice and tested before production | Ship workflow: branch → typecheck + SPA tsc + hooks lint + `npm test` (units, all 11 personas incl. P11 novated lease, e2e, first-timer e2e, schema drift) → automated browser QA (`npm run qa:browser`: Chromium against local `wrangler dev`, 1280 and 390 px, journey flags ON, AI stubbed; run in CI by `qa.yml`) → review proportional to risk (adversarial multi-agent review for auth/data/ingest) → PR → CI → merge → deploy → read-only prod smoke (`npm run qa:smoke-prod`). Invariants: tenant isolation, one canonical money source, APP-8 consent gate before any model call, enforced in one place (`aiCall`, `src/lib/ai-call.ts`, #721; a raw `getLLM(` fails check-units) | [CLAUDE.md](../../CLAUDE.md) "Ship workflow", [`.github/workflows/tests.yml`](../../.github/workflows/tests.yml), [`.github/workflows/web-lint.yml`](../../.github/workflows/web-lint.yml), [`.github/workflows/qa.yml`](../../.github/workflows/qa.yml), [`docs/personas.md`](../personas.md), [vulnerability-management.md](vulnerability-management.md#secure-sdlc), [`.github/workflows/codeql.yml`](../../.github/workflows/codeql.yml) | ✅ CI gates, `npm audit` gate and CodeQL SAST live (PR #644); browser QA suite and prod smoke live (#699, PR #767; `qa.yml`); 0 open CodeQL alerts 2026-10-17 | — |
| 4(c) | Vulnerability management: Formal program with regular vulnerability scanning **and penetration testing** | Weekly OWASP ZAP baseline scan against app.quillo.au, CodeQL, Dependabot alerts, secret scanning with push protection, `npm audit --audit-level=high` in CI. **No penetration test yet. The rule text requires one** ("regular vulnerability scanning and penetration testing"; Fiskil requirements research #693), so it is not optional. Internal sweep done 2026-10-24 (no CRITICAL/HIGH; [sweep-2026-10.md](sweep-2026-10.md)); scope + RFQ in #703 | [vulnerability-management.md](vulnerability-management.md#scanners), [`.github/workflows/zap-baseline.yml`](../../.github/workflows/zap-baseline.yml), [`.github/workflows/codeql.yml`](../../.github/workflows/codeql.yml); secret scanning + push protection on in the repo settings | 🟡 scanning live (PRs #644, #670); 0 open Dependabot alerts after the zod 4, body-parser, undici and fast-uri fixes (#719, #781, #783, 2026-10-24); internal sweep fixes live (#705–#708, #710, #728, #733, #737; #711 moot, mailbox retired) | 👤 buy the pen test (#703) |

### Control requirement 5 — prevent, detect and remove malware

| ID | Control | Quillo's control | Evidence | Status | Owner / ticket |
|---|---|---|---|---|---|
| 5(a) | Anti-malware / anti-virus: AV/anti-malware on endpoints and servers, kept current; compliance reported and actioned | Laptop: macOS XProtect + XProtect Remediator (auto-updating), Gatekeeper, optional Malwarebytes. Servers: none we operate (serverless). Uploaded receipts are stored as bytes in R2 and only ever read by the model or rendered as images; never executed | [endpoint-standard.md](endpoint-standard.md) | ⬜ owner to confirm and record | 👤 C2 |
| 5(b) | Web and email content filtering: Identify, quarantine and block suspicious content from email and the web | Owner mailbox: Gmail spam/phishing filtering (brendan@quillo.au forwards via Cloudflare Email Routing). Browser: Safe Browsing. App inbound email: the receipt mailbox is **retired** (`mailbox_retired` ON, PR #789; #711 closed as not planned), so the Worker's `email()` handler bounces every message before the MIME parse, the tenant lookup or any R2/D1/DO write, logging only the byte size. Uploaded originals are served only as an allowlisted content type (PR #706). The enforcing CSP restricts what the SPA loads, with a hash-only `script-src` (no `'unsafe-inline'`, no `*.quillo.au`; PR #737) | [endpoint-standard.md](endpoint-standard.md), [`src/lib/mailbox-retired.ts`](../../src/lib/mailbox-retired.ts), [`src/lib/security-headers.ts`](../../src/lib/security-headers.ts) | 🟡 app side live (mailbox bounces, PR #789; CSP enforcing and hash-only, PRs #666, #737); owner action: confirm mailbox and browser filtering (C2) | 👤 C2 |
| 5(c) | Application whitelisting: Only authorised software installed or executed on infrastructure and end-user devices | Laptop: Gatekeeper set to App Store and identified developers; daily work in a **standard (non-admin)** account so installs need the admin password. No infrastructure hosts to install on | [endpoint-standard.md](endpoint-standard.md) | ⬜ owner to apply | 👤 C2 |

### Control requirement 6 — security training and awareness

| ID | Control | Quillo's control | Evidence | Status | Owner / ticket |
|---|---|---|---|---|---|
| 6(a) | Training and awareness: Mandatory security and privacy training before access to the CDE, refreshed at least annually | ACSC / cyber.gov.au small-business training and OAIC CDR privacy material; completion recorded annually | [training-and-screening-record.md §1](training-and-screening-record.md#1-security-and-privacy-training) | ⬜ | 👤 C3 |
| 6(b) | Acceptable use: Acceptable use policy agreed by all personnel before access, regularly re-communicated | Acceptable use policy with signature block; re-signed at each annual review | [acceptable-use.md](acceptable-use.md) | 🟡 drafted (PR #667); owner action: sign | 👤 |
| 6(c) | Human resource security: Background checks (reference, police) before access | National police check through an ACIC-accredited provider; recorded with date | [training-and-screening-record.md §2](training-and-screening-record.md#2-background-screening) | ⬜ | 👤 C4 |

## Representative-specific obligations (not Schedule 2, tracked here so nothing is missed)

| ID | Control | Quillo's control | Evidence | Status | Owner / ticket |
|---|---|---|---|---|---|
| r1.10AA(4)(f) | Adopt and comply with the principal's CDR policy | Quillo adopts Fiskil's CDR policy; no separate Quillo CDR policy | This row; [questionnaire-answers.md](questionnaire-answers.md) | 🟡 owner action: adopt formally in the representative agreement | 👤 C7 |
| r7.2(8) | CDR policy readily available through each online service where consumers are dealt with | Link to [Fiskil's CDR policy](https://www.fiskil.com/legal/cdr-policy) on the Connect page bank section, Settings › Bank connections, the Accounts bank-feed card and the app footer, behind `bank_feed_cdr` | [`web/src/components/CdrPolicyLink.tsx`](../../web/src/components/CdrPolicyLink.tsx) | ✅ (PR #667); shows wherever the CDR service is offered, which is behind `bank_feed_cdr` | — |
| r7.2(4)(f)–(g) | Principal's CDR policy lists our OSPs, their services and the CDR data they receive | OSP register supplied to Fiskil | [osp-register.md](osp-register.md) | 🟡 owner action: Fiskil to list our OSPs; written approval needed | 👤 C9 · C7 |
| r1.10AA(3)(b) | No OSP for service data except as the representative arrangement provides | Cloudflare and AWS named as OSPs in the representative agreement; nothing else receives CDR data (Anthropic is refused for CDR-tainted tenants) | [osp-register.md](osp-register.md), [`src/llm.ts`](../../src/llm.ts) (`getLLM` residency seam) | 🟡 owner action: Fiskil's written acceptance of Cloudflare and AWS as OSPs | 👤 C7 · C9 |
| PS8 (s56EK) via r1.10AA(4)(g) | No overseas disclosure of CDR data except under an exception | CDR-tainted tenants forced to Bedrock `ap-southeast-2/-4`; any other provider throws. Storage position per PS8 findings (Option A, reasonable steps by contract) | [`src/llm.ts`](../../src/llm.ts), unit checks in [`scripts/check-units.ts`](../../scripts/check-units.ts) ("PS8:"), [`docs/cdr-ps8-findings.md`](../cdr-ps8-findings.md) | 🟡 guard in code and unit-tested; AU inference live 2026-10-22: `npm run probe:bedrock` 5/5 (receipt image, statement PDF, Ask, prompt cache, CDR-tainted refusal) on `au.anthropic.claude-haiku-4-5-20251001-v1:0` in ap-southeast-2; owner action: counsel on the storage position (C7) | #641 · C7 |
| PS12 / r7.12–7.13 | Delete or de-identify redundant CDR data | Withdrawal → local stop → upstream revoke → delete `cdr_feed` lines and the feed's minimisation totals/tombstones; **expiry runs the same delete** (`consent_expired` + `data_deleted` records); aggregator end user deleted 30 days after the last consent ends (`end_user_deleted`); minimisation shrink after lodging (weekly cron) | [`src/lib/bank-consent.ts`](../../src/lib/bank-consent.ts) (`consentLifecycle`, `inactiveEndUserSweep`), unit checks "expiry (ON)" / "inactive:" in [`scripts/check-units.ts`](../../scripts/check-units.ts), [data-handling.md §5](data-handling.md#5-deletion) | 🟡 withdrawal deletion live (#576); expiry deletion and inactive end-user deletion **live** (PR #686); retention cron built, switch `bank_minimisation` still OFF. Derived leftovers not keyed to a line (clarify samples, learned rules, recurring bills, noticed-signal evidence, audit_log totals) await the #524 legal ruling | 👤 `bank_minimisation` · #524 |
| r1.10AA(4)(e) | Delete service data when the principal directs, and give deletion records | Admin runbook: delete by Fiskil end-user id → `purgeTenant` / per-connection PS12 delete; export the matching `cdr_audit_log` rows as the record | [data-handling.md §5.4](data-handling.md#54-deletion-directed-by-fiskil) | ✅ mechanism live (purge reseat PR #623, per-connection PS12 delete); runbook drafted | — |
| Div 4.3 consent | Consent rules (r4.20B–U, via Fiskil): consent flow, receipts, notifications, 12-month maximum | Fiskil's hosted consent UI; Quillo asks for accounts + transactions only, 12 months | [`docs/bank-feed-golive-checklist.md`](../bank-feed-golive-checklist.md) §2 | ⬜ confirm with Fiskil that its hosted UI covers r4.20B–U | 👤 C9 |

## Workstream tickets

| Ticket | Work | Rows it closes |
|---|---|---|
| [#634] A1 · closed | HSTS, enforcing CSP, no PII in logs. PR #666 (live), header check blocking PR #670 | 1(i) (now live), 1(c) partly, 3(a) partly, 5(b) partly |
| [#635] A2 · closed | Daily D1 export, restore runbook, two passing restore tests. PR #674; waits on `D1_EXPORT_TOKEN` + `d1_backups` | 2(a) backups, 3(c) backups |
| [#636] A3 · closed | Admin Security & compliance dashboard, flag-gated health checks. PR #665 (live); live checks wait on `security_monitoring` | 1.6(2), 1.7(1), 1(c) review |
| [#637] A4 · closed | `QBO_TOKEN_KEY` fail-closed + re-encrypt, secrets inventory ([secrets-and-encryption.md](secrets-and-encryption.md)). PR #643; not needed while QuickBooks is retired (`qbo_retired`, PR #791), only before an un-retire | 2(a) |
| [#638] A5 · closed | Admin MFA gate, API rate limiting, JIT rule, Clerk cutover runbook. PRs #673, #678 (rate limiting live); MFA waits on `admin_mfa_required`; Clerk production cutover is the owner's | 1(a), 1(b), 1(f), 1(h) |
| [#639] A6 · closed | Retention cron, expiry and inactive end-user deletion, S8b redaction, no CDR in non-prod. PR #679; expiry, inactive and redaction flags ON (PR #686); waits on `bank_minimisation` | 2(e), 3(b), 3(c), PS12 |
| [#640] A7 · closed | Dependabot, CodeQL, secret scanning + push protection, npm audit, weekly ZAP. PRs #644, #670, #671, #677 (live, 0 open alerts) | 1.6(1), 4(a), 4(b), 4(c) |
| [#641] A8 · evidence in | Bedrock `au.` live 2026-10-22: `npm run probe:bedrock` 5/5 (receipt image, statement PDF, Ask, prompt cache, CDR-tainted refusal) on `au.anthropic.claude-haiku-4-5-20251001-v1:0` in ap-southeast-2. Close once posted on #641 | PS8 |
| [#642] B · closed | This pack + Fiskil CDR policy link. PR #667 | Part 1 documents, 6(b), r7.2(8) |
| [owner-tasks.md](owner-tasks.md) C1–C9 | Owner actions | 1(a), 1(d), 1(e), 2(d), 5(a)–(c), 6(a), 6(c), C7/C9 rows |

[#633]: https://github.com/matchmoments-admin/quillo/issues/633
[#634]: https://github.com/matchmoments-admin/quillo/issues/634
[#635]: https://github.com/matchmoments-admin/quillo/issues/635
[#636]: https://github.com/matchmoments-admin/quillo/issues/636
[#637]: https://github.com/matchmoments-admin/quillo/issues/637
[#638]: https://github.com/matchmoments-admin/quillo/issues/638
[#639]: https://github.com/matchmoments-admin/quillo/issues/639
[#640]: https://github.com/matchmoments-admin/quillo/issues/640
[#641]: https://github.com/matchmoments-admin/quillo/issues/641
[#642]: https://github.com/matchmoments-admin/quillo/issues/642
