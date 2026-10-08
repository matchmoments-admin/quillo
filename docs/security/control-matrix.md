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
> **Status legend:** ✅ in place, with evidence we can point to · 🟡 partly in place, or built but not
> yet evidenced · ⬜ not started · 👤 needs the owner (not code). **Exit criterion:** every row ✅ before
> the owner submits the Fiskil security questionnaire ([owner-tasks.md](owner-tasks.md) C9).
>
> **Honesty rule:** a row is ✅ only when the evidence column points at something that exists today.
> Planned work is 🟡 or ⬜ with its ticket. Last full review: **2026-10-08** (initial draft, #642).
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

| Area | Rows | ✅ | 🟡 | ⬜ |
|---|---|---|---|---|
| Part 1 — steps 1–5 (cl 1.3–1.7) | 21 | 0 | 19 | 2 |
| Part 2 — control requirement 1 (access) | 9 | 1 | 6 | 2 |
| Part 2 — control requirement 2 (network and systems) | 5 | 1 | 3 | 1 |
| Part 2 — control requirement 3 (asset lifecycle) | 3 | 0 | 3 | 0 |
| Part 2 — control requirement 4 (vulnerabilities) | 3 | 1 | 2 | 0 |
| Part 2 — control requirement 5 (malware) | 3 | 0 | 1 | 2 |
| Part 2 — control requirement 6 (people) | 3 | 0 | 1 | 2 |
| Representative-specific obligations | 8 | 2 | 5 | 1 |
| **Total** | **55** | **5** | **40** | **10** |

Most Part 1 rows are 🟡 rather than ✅ because the documents now exist (this pack) but have not yet been
**reviewed and adopted by the owner** (sign-off line in each document) and their first cycle (access
review, tabletop test, annual review) has not yet run.

## Part 1 — Steps for privacy safeguard 12

| ID | Control | Quillo's control | Evidence | Status | Owner / ticket |
|---|---|---|---|---|---|
| 1.3(1) | Formal governance framework for information-security risk to CDR data: policies, processes, roles, responsibilities | This pack. The information security policy sets the framework; each standard below covers one area; this matrix tracks it | [information-security-policy.md](information-security-policy.md), this file | 🟡 drafted; owner adoption pending | 👤 owner sign-off · #642 |
| 1.3(2) | Documented practices and procedures for information security and CDR data, including senior management's responsibilities | Roles table (director = senior management, security owner, privacy officer, incident lead) and the standards in this pack | [information-security-policy.md §3](information-security-policy.md#3-roles-and-responsibilities) | 🟡 drafted; adoption pending | 👤 · #642 |
| 1.3(3)(a) | Information security policy states the risk posture: exposure and potential harm to information assets, including CDR data | Risk register with the top risks to CDR data (tenant isolation, offshore disclosure, credential compromise, supply chain, data loss) | [information-security-policy.md §4](information-security-policy.md#4-risk-posture) | 🟡 drafted | 👤 · #642 |
| 1.3(3)(b) | Policy explains how practices, procedures and controls mitigate those risks | Each risk maps to controls in this matrix | [information-security-policy.md §4](information-security-policy.md#4-risk-posture) | 🟡 drafted | 👤 · #642 |
| 1.3(4) | Review and update the framework on material change, or at least annually | Annual review in October each year, plus a trigger list (new OSP, new data type, incident, Fiskil requirement change) | [information-security-policy.md §6](information-security-policy.md#6-review-cadence) (review log) | 🟡 cadence defined; first review not yet recorded | 👤 · #642 |
| 1.4(1) | Assess, define and document the boundaries of the CDR data environment | Boundary, data inventory and data-flow diagram | [cdr-data-environment.md](cdr-data-environment.md) | 🟡 drafted; owner confirmation pending | 👤 · #642 |
| 1.4(2) | Review the boundary on material change, or at least annually | Same annual review and triggers; boundary review log in the CDE document | [cdr-data-environment.md §7](cdr-data-environment.md#7-boundary-review-log) | 🟡 | 👤 |
| 1.5(1)(a) | Information security capability complies with the Part 2 controls | Part 2 rows below | This file, Part 2 | 🟡 see Part 2 | #634–#641 |
| 1.5(1)(b) | Capability is appropriate to the threats, the CDR data held, and potential consumer harm | Data held is minimised to transactions and masked accounts (no name, contact, payees, full account numbers); risk-based controls | [cdr-data-environment.md §3](cdr-data-environment.md#3-what-cdr-data-quillo-holds), [information-security-policy.md §4](information-security-policy.md#4-risk-posture) | 🟡 | #642 |
| 1.5(2) | Review and adjust capability on material change, or at least annually | Part of the annual review | [information-security-policy.md §6](information-security-policy.md#6-review-cadence) | 🟡 | 👤 |
| 1.6(1) | Testing program to assess the effectiveness of the capability, at a risk-appropriate frequency | Controls assessment program: automated per-PR tests, weekly scans, quarterly access review, annual tabletop and policy review | [vulnerability-management.md](vulnerability-management.md#controls-assessment-program-cl-16) | 🟡 scanners live (#640, closed); first quarterly/annual cycle not yet run | #636 · 👤 |
| 1.6(2) | Monitor and evaluate design, implementation and operating effectiveness of controls | Admin-only Security & compliance page (`/admin/security`) shows control status (parsed from this file), scan results, headers, backups, errors, CDR activity and residency; on-demand checks behind `security_monitoring` | [`src/lib/security-dashboard.ts`](../../src/lib/security-dashboard.ts), #636 (closed) | 🟡 dashboard live; regular monthly review not yet practised | 👤 |
| 1.6(3) | Escalate testing deficiencies to senior management | Senior management is the owner; every failed test becomes a GitHub issue labelled `security` with a severity, and is recorded in this matrix | [vulnerability-management.md §5](vulnerability-management.md#controls-assessment-program-cl-16) | 🟡 process defined | 👤 |
| 1.6(4) | Testing conducted by appropriately skilled persons **independent** of performing the controls | **Gap.** A one-person company cannot be independent of itself. Partial mitigation: automated third-party tooling (CodeQL, Dependabot, GitHub secret scanning, OWASP ZAP) and adversarial multi-agent code reviews that do not share the author's context. No independent human tester or third-party audit yet | [vulnerability-management.md §6](vulnerability-management.md#independence-gap-cl-164) | ⬜ owner decision: independent reviewer (annual) vs. accept and disclose | 👤 decision · #640 |
| 1.6(5) | Review sufficiency of the testing program on material change, or at least annually | Annual review | [vulnerability-management.md §5](vulnerability-management.md#controls-assessment-program-cl-16) | 🟡 | 👤 |
| 1.7(1) | Procedures to detect, record and respond to incidents as soon as practicable | Incident response plan; incident register; detection sources (Workers Logs, cost-error counter, sync-failure rows, external uptime monitor, provider notices) | [incident-response-plan.md](incident-response-plan.md) | 🟡 plan drafted; detection tooling partly built (#636), uptime monitor ⬜ (C8) | #636 · 👤 C8 |
| 1.7(2) | Response plans for plausible incidents | Playbooks: credential compromise, tenant-isolation bug, offshore inference of CDR data, provider breach, data loss, lost laptop | [incident-response-plan.md §7](incident-response-plan.md#7-playbooks) | 🟡 drafted | #642 |
| 1.7(3)(a) | Plans cover all stages, detection to post-incident review | Seven-stage lifecycle with checklists | [incident-response-plan.md §4](incident-response-plan.md#4-lifecycle) | 🟡 drafted | #642 |
| 1.7(3)(b) | Notify the Information Commissioner and consumers under Privacy Act Part IIIC | NDB assessment (30 days max) and notification steps; notify Fiskil first (principal) | [incident-response-plan.md §5](incident-response-plan.md#5-notifications) | 🟡 drafted; Fiskil window to confirm | 👤 C9 |
| 1.7(3)(c) | Notify the ACSC as soon as practicable, no later than 30 days after becoming aware | ReportCyber step with the 30-day deadline in the register | [incident-response-plan.md §5.4](incident-response-plan.md#54-australian-cyber-security-centre-acsc) | 🟡 drafted | #642 |
| 1.7(4) | Review and test response plans on material change, or at least annually | Annual tabletop exercise, template and record | [incident-response-plan.md §9](incident-response-plan.md#9-annual-tabletop-test) | ⬜ first tabletop not yet run | 👤 |

## Part 2 — Minimum information security controls (cl 2.2)

### Control requirement 1 — limit the risk of inappropriate or unauthorised access to the CDR data environment

| ID | Control | Quillo's control | Evidence | Status | Owner / ticket |
|---|---|---|---|---|---|
| 1(a) | MFA: MFA or equivalent for all access to CDR data (consumer access excluded) | Staff access paths to CDR data are the Cloudflare dashboard/API (D1, R2, Workers Logs), GitHub (deploy pipeline, secrets), AWS (Bedrock) and the in-app admin role. MFA on every one; admin role in Clerk production requires MFA | [access-control-standard.md §2](access-control-standard.md#2-multi-factor-authentication), §8; admin MFA gate [`src/lib/access-control.ts`](../../src/lib/access-control.ts) (`fva` claim, flag `admin_mfa_required`); [clerk-production-cutover.md](clerk-production-cutover.md) | 🟡 server-side admin MFA gate built (flag OFF until the owner enrols TOTP); MFA not yet on all accounts; Clerk still a development instance | 👤 C1 · cutover runbook |
| 1(b) | Restrict admin privileges: Admin rights only as needed and only for as long as needed; ongoing grants reviewed | Just-in-time rule for the in-app `admin` role and for Cloudflare API tokens; scoped tokens; quarterly review | [access-control-standard.md §4](access-control-standard.md#4-administrative-privileges-just-in-time), [`src/lib/roles.ts`](../../src/lib/roles.ts), admin gate [`src/api.ts`](../../src/api.ts) (`resource === "admin"`) | 🟡 server-enforced role gate + MFA gate (flag `admin_mfa_required`); JIT rule written (§4); first quarterly review not yet recorded | 👤 quarterly review |
| 1(c) | Audit logging and monitoring: Critical events logged, retained (r9.3: 6 years) and reviewed regularly | Hash-chained `audit_log` for every tenant write; `cdr_audit_log` (0085) for every consent, collection, withdrawal, deletion and purge (ids and counts only, never CDR content); both are **excluded from purge** so they outlive the data; Workers Logs for runtime errors | [`schema.sql`](../../schema.sql) (`audit_log`, `cdr_audit_log`), [`src/lib/bank-consent.ts`](../../src/lib/bank-consent.ts), [`src/lib/retention.ts`](../../src/lib/retention.ts) (`PURGE_TABLES` comment) | 🟡 logging in place; regular review (#636 dashboard) and long-term retention of platform logs (Workers Logs keeps days, not years) not yet | #636 · #634 |
| 1(d) | Access security: Timely provisioning and revocation; review of user access at least quarterly | Joiner/leaver steps; quarterly access review log | [access-control-standard.md §5–6](access-control-standard.md#5-quarterly-access-review) | ⬜ first quarterly review not yet run | 👤 |
| 1(e) | Limit physical access: Physical access to facilities where CDR data is stored, hosted or accessed restricted to authorised people | Hosting: Cloudflare and AWS data centres (inherited, their SOC 2 / ISO 27001 controls). Access: one laptop in the owner's home office, FileVault, screen lock, never left unlocked in public | [endpoint-standard.md](endpoint-standard.md), [osp-register.md](osp-register.md) | 🟡 inherited for hosting; OSP attestations not yet downloaded; laptop hardening is C2 | 👤 C2 |
| 1(f) | Role-based access: Least privilege and segregation of duties | App: roles `individual/admin/accountant/bookkeeper/support/partner`, server-side checks; tenant isolation by `user_id` on every table and identity derived server-side (never a client header). Infra: scoped Cloudflare API tokens | [`src/lib/roles.ts`](../../src/lib/roles.ts), [CLAUDE.md](../../CLAUDE.md) "Multi-tenant" invariant, [access-control-standard.md §3](access-control-standard.md#3-least-privilege-and-role-based-access) | 🟡 app RBAC in place; infra token scoping not yet audited; segregation of duties impossible for one person (see policy §3) | #638 |
| 1(g) | Unique IDs: Generic/shared/default accounts only where necessary; their actions monitored and logged | No shared human accounts. Service identities: the Worker itself, the GitHub Actions runner (no prod credentials today), the AWS IAM user for Bedrock (invoke-only), Fiskil API client | [access-control-standard.md §7](access-control-standard.md#7-service-accounts-and-api-keys) | ✅ | — |
| 1(h) | Password authentication: Strong authentication, complexity, lockout, history, ageing | Consumers: Clerk (breached-password checks, lockout, rate limiting). Staff: password manager, unique 20+ character passwords, MFA. Ageing replaced by NIST 800-63B / ASD guidance (change on suspicion of compromise) | [access-control-standard.md §2](access-control-standard.md#2-multi-factor-authentication), §8; general API rate limiting [`src/lib/access-control.ts`](../../src/lib/access-control.ts) (flag `api_rate_limit`) | 🟡 Clerk production instance not yet configured ([cutover runbook](clerk-production-cutover.md)); API rate limiting built, flag OFF | 👤 C1 · cutover runbook |
| 1(i) | Encryption in transit: Encrypt data in transit, authenticate access, audit access and use, verify the identity of communications | TLS everywhere (Cloudflare edge, Fiskil API over HTTPS with OAuth client credentials, Bedrock SigV4-signed HTTPS). HSTS to be added. Session JWTs verified against Clerk JWKS | [`src/index.ts`](../../src/index.ts) (security headers), [`src/auth/clerk.ts`](../../src/auth/clerk.ts), [`src/lib/sigv4.ts`](../../src/lib/sigv4.ts) | 🟡 TLS in place; HSTS and enforcing CSP pending | #634 |

### Control requirement 2 — secure the network and systems within the CDR data environment

| ID | Control | Quillo's control | Evidence | Status | Owner / ticket |
|---|---|---|---|---|---|
| 2(a) | Encryption: Encrypt CDR data at rest (file systems, devices, portable media, backups); keys secured; access to keys authenticated | D1 and R2 are encrypted at rest by Cloudflare (AES-256). QuickBooks tokens additionally sealed with AES-256-GCM (`QBO_TOKEN_KEY`). Laptop: FileVault. Backups: daily D1 export to the private R2 bucket `tax-agent-backups` (encrypted at rest) | [`src/lib/token-crypto.ts`](../../src/lib/token-crypto.ts), [secrets-and-encryption.md](secrets-and-encryption.md), [backup-dr.md](backup-dr.md) | 🟡 fail-closed sealing + backfill shipped (#637, closed) but `QBO_TOKEN_KEY` not yet set in prod (0 QBO rows, so nothing stored in plaintext today); FileVault unconfirmed; backup export built and restore-tested (#635), live once the bucket + token exist and `d1_backups` is ON | coordinator (set key) · #635 · 👤 C2 |
| 2(b) | Firewalls: Limit traffic from untrusted sources; deny unnecessary traffic; restrict and review firewall configuration | No servers or open ports: the Worker only answers HTTPS at Cloudflare's edge (DDoS protection, TLS termination). D1, R2, KV and the Durable Object are not internet-reachable except through the Worker bindings or the authenticated Cloudflare API. Laptop: macOS firewall on | [cdr-data-environment.md §5](cdr-data-environment.md#5-network-boundary), [endpoint-standard.md](endpoint-standard.md) | 🟡 edge in place by design; laptop firewall is C2 | 👤 C2 |
| 2(c) | Server hardening: Harden servers, databases and OSes to industry standards | Serverless: Cloudflare runs and hardens the runtime (V8 isolates); we manage no OS or database server. Our part: minimal bindings, pinned `compatibility_date`, secrets only via `wrangler secret` | [`wrangler.toml`](../../wrangler.toml), [osp-register.md](osp-register.md) | ✅ by architecture (Cloudflare attestations to be filed, C9) | — |
| 2(d) | End-user devices: End-user devices (including BYOD) hardened to industry standards | Endpoint standard (FileVault, auto-updates, firewall, screen lock, standard account, password manager, XProtect) | [endpoint-standard.md](endpoint-standard.md) | ⬜ owner to apply and record | 👤 C2 |
| 2(e) | Data segregation: CDR data held for a representative is segregated, accessible only by the right recipient and attributable to it | Per-tenant isolation (`user_id` on every row, server-side identity, one Durable Object per tenant). CDR rows marked `source='cdr_feed'` (`kind='bank_line'`) and connections recorded per provider; tenant flagged `profiles.cdr_tainted=1` (one-way); every CDR row attributable to its Fiskil consent via `bank_connections` | [cdr-data-environment.md §6](cdr-data-environment.md#6-segregation), [`migrations/0075_bank_connections.sql`](../../migrations/0075_bank_connections.sql), [`migrations/0077_profiles_cdr_tainted.sql`](../../migrations/0077_profiles_cdr_tainted.sql) | 🟡 built and unit-tested; not yet exercised with production data | #639 |

### Control requirement 3 — securely manage information assets over their lifecycle

| ID | Control | Quillo's control | Evidence | Status | Owner / ticket |
|---|---|---|---|---|---|
| 3(a) | Data loss prevention: Prevent data leaving the CDE: block unapproved cloud services, monitor outbound email, block email containing CDR data, block writes to portable media | Architectural: the app has no CDR export or email path (the APP-12 export is the consumer's own data, to the consumer). Staff rule: CDR data never leaves production (no D1 exports to the laptop, no screenshots, no email, no USB). Outbound integrations are allow-listed (OSP register) and enforced by CSP `connect-src` in the browser | [acceptable-use.md](acceptable-use.md), [data-handling.md §6](data-handling.md#6-masking-and-non-production), [osp-register.md](osp-register.md) | 🟡 policy-based; no technical blocking of USB/email on the laptop (no MDM) — residual risk | 👤 C2 · #634 |
| 3(b) | CDR data in non-production: Mask CDR data before it reaches non-production | Non-production uses Fiskil **sandbox** only (synthetic data from institution `88888`); production CDR data is never copied to local or preview. In code, a non-production deployment (`DEV_AUTH_BYPASS=1`) refuses a connect on production credentials, drops a real bank's connection at the callback before anything is stored, and fails a sync before the first fetch — only the sandbox test banks on sandbox credentials pass (Fiskil `88888`, Basiq `AU00000`) | [`src/lib/bank-feed-core.ts`](../../src/lib/bank-feed-core.ts) (`cdrBlockedInThisDeployment`, `requiresAuResidency`), unit checks "non-prod:" / "PS8: production env" in [`scripts/check-units.ts`](../../scripts/check-units.ts), [data-handling.md §6](data-handling.md#6-masking-and-non-production) | 🟡 guard in code at connect, callback (refused consents revoked upstream) and sync; unit-tested (#639). Residual: the non-prod marker is `DEV_AUTH_BYPASS=1`, so a non-prod run without it is treated as production — staff rule in data-handling.md §6 covers it | #639 |
| 3(c) | Information asset lifecycle: Classification and handling policy; backup, retention, deletion and de-identification (r7.12, r7.13) | Classification, minimisation (#534 / #581), retention schedule (#594), PS12 deletion on withdrawal (#576), purge on account deletion (#623) | [data-handling.md](data-handling.md), [`src/lib/bank-consent.ts`](../../src/lib/bank-consent.ts), [`src/lib/retention.ts`](../../src/lib/retention.ts), [`src/lib/minimise.ts`](../../src/lib/minimise.ts), [`src/lib/retention-schedule.ts`](../../src/lib/retention-schedule.ts) | 🟡 retention cron, expiry deletion and inactive end-user deletion built and tested (#639) behind `bank_minimisation` / `cdr_expiry_delete` / `cdr_inactive_user_delete`, OFF until the owner flips them; backups built + restore-tested ([backup-dr.md](backup-dr.md)), awaiting bucket/token/flag | 👤 flip flags · #635 |

### Control requirement 4 — formal vulnerability management program

| ID | Control | Quillo's control | Evidence | Status | Owner / ticket |
|---|---|---|---|---|---|
| 4(a) | Security patching: Identify, risk-assess and apply security patches to applications and OSes as soon as practicable | Patch SLAs (critical 48h, high 7 days, medium 30 days); Dependabot for npm (root + `web/`); macOS automatic updates; runtime patched by Cloudflare | [vulnerability-management.md](vulnerability-management.md#patch-slas), [`.github/dependabot.yml`](../../.github/dependabot.yml) | 🟡 SLAs + Dependabot live (#640); laptop auto-updates not yet confirmed | 👤 C2 |
| 4(b) | Secure coding: Changes designed and developed to secure-coding practice and tested before production | Ship workflow: branch → typecheck + SPA tsc + hooks lint + `npm test` (units, 10 personas, e2e, schema drift) → review proportional to risk (adversarial multi-agent review for auth/data/ingest) → PR → CI → merge → deploy. Invariants: tenant isolation, one canonical money source, consent gate before any model call | [CLAUDE.md](../../CLAUDE.md) "Ship workflow", [`.github/workflows/tests.yml`](../../.github/workflows/tests.yml), [`.github/workflows/web-lint.yml`](../../.github/workflows/web-lint.yml), [vulnerability-management.md](vulnerability-management.md#secure-sdlc), [`.github/workflows/codeql.yml`](../../.github/workflows/codeql.yml) | ✅ CI gates, `npm audit` gate and CodeQL SAST live (#640) | — |
| 4(c) | Vulnerability management: Formal program with regular vulnerability scanning **and penetration testing** | Weekly OWASP ZAP baseline scan against app.quillo.au, CodeQL, Dependabot alerts, secret scanning with push protection, `npm audit --audit-level=high` in CI. **No penetration test** — owner chose free automated scanning; buy one if Fiskil requires it | [vulnerability-management.md](vulnerability-management.md#scanners), [`.github/workflows/zap-baseline.yml`](../../.github/workflows/zap-baseline.yml) | 🟡 scanning live (#640); **no penetration test** — open owner decision | 👤 |

### Control requirement 5 — prevent, detect and remove malware

| ID | Control | Quillo's control | Evidence | Status | Owner / ticket |
|---|---|---|---|---|---|
| 5(a) | Anti-malware / anti-virus: AV/anti-malware on endpoints and servers, kept current; compliance reported and actioned | Laptop: macOS XProtect + XProtect Remediator (auto-updating), Gatekeeper, optional Malwarebytes. Servers: none we operate (serverless). Uploaded receipts are stored as bytes in R2 and only ever read by the model or rendered as images; never executed | [endpoint-standard.md](endpoint-standard.md) | ⬜ owner to confirm and record | 👤 C2 |
| 5(b) | Web and email content filtering: Identify, quarantine and block suspicious content from email and the web | Owner mailbox: Gmail spam/phishing filtering (brendan@quillo.au forwards via Cloudflare Email Routing). Browser: Safe Browsing. App inbound email (receipt forwarding) is parsed as data, never executed. CSP restricts what the SPA loads | [endpoint-standard.md](endpoint-standard.md), [`src/lib/email.ts`](../../src/lib/email.ts) | 🟡 | 👤 C2 · #634 |
| 5(c) | Application whitelisting: Only authorised software installed or executed on infrastructure and end-user devices | Laptop: Gatekeeper set to App Store and identified developers; daily work in a **standard (non-admin)** account so installs need the admin password. No infrastructure hosts to install on | [endpoint-standard.md](endpoint-standard.md) | ⬜ owner to apply | 👤 C2 |

### Control requirement 6 — security training and awareness

| ID | Control | Quillo's control | Evidence | Status | Owner / ticket |
|---|---|---|---|---|---|
| 6(a) | Training and awareness: Mandatory security and privacy training before access to the CDE, refreshed at least annually | ACSC / cyber.gov.au small-business training and OAIC CDR privacy material; completion recorded annually | [training-and-screening-record.md §1](training-and-screening-record.md#1-security-and-privacy-training) | ⬜ | 👤 C3 |
| 6(b) | Acceptable use: Acceptable use policy agreed by all personnel before access, regularly re-communicated | Acceptable use policy with signature block; re-signed at each annual review | [acceptable-use.md](acceptable-use.md) | 🟡 drafted; not yet signed | 👤 |
| 6(c) | Human resource security: Background checks (reference, police) before access | National police check through an ACIC-accredited provider; recorded with date | [training-and-screening-record.md §2](training-and-screening-record.md#2-background-screening) | ⬜ | 👤 C4 |

## Representative-specific obligations (not Schedule 2, tracked here so nothing is missed)

| ID | Control | Quillo's control | Evidence | Status | Owner / ticket |
|---|---|---|---|---|---|
| r1.10AA(4)(f) | Adopt and comply with the principal's CDR policy | Quillo adopts Fiskil's CDR policy; no separate Quillo CDR policy | This row; [questionnaire-answers.md](questionnaire-answers.md) | 🟡 adopt formally in the representative agreement | 👤 C7 |
| r7.2(8) | CDR policy readily available through each online service where consumers are dealt with | Link to [Fiskil's CDR policy](https://www.fiskil.com/legal/cdr-policy) on the Connect page bank section, Settings › Bank connections, the Accounts bank-feed card and the app footer, behind `bank_feed_cdr` | [`web/src/components/CdrPolicyLink.tsx`](../../web/src/components/CdrPolicyLink.tsx) | ✅ (#642) | — |
| r7.2(4)(f)–(g) | Principal's CDR policy lists our OSPs, their services and the CDR data they receive | OSP register supplied to Fiskil | [osp-register.md](osp-register.md) | 🟡 Fiskil to list them; written approval needed | 👤 C9 · C7 |
| r1.10AA(3)(b) | No OSP for service data except as the representative arrangement provides | Cloudflare and AWS named as OSPs in the representative agreement; nothing else receives CDR data (Anthropic is refused for CDR-tainted tenants) | [osp-register.md](osp-register.md), [`src/llm.ts`](../../src/llm.ts) (`getLLM` residency seam) | 🟡 needs Fiskil's written acceptance | 👤 C7 · C9 |
| PS8 (s56EK) via r1.10AA(4)(g) | No overseas disclosure of CDR data except under an exception | CDR-tainted tenants forced to Bedrock `ap-southeast-2/-4`; any other provider throws. Storage position per PS8 findings (Option A, reasonable steps by contract) | [`src/llm.ts`](../../src/llm.ts), unit checks in [`scripts/check-units.ts`](../../scripts/check-units.ts) ("PS8:"), [`docs/cdr-ps8-findings.md`](../cdr-ps8-findings.md) | 🟡 guard in code and unit-tested; Bedrock not yet enabled (use-case form); storage position needs counsel | #641 · 👤 C6 · C7 |
| PS12 / r7.12–7.13 | Delete or de-identify redundant CDR data | Withdrawal → local stop → upstream revoke → delete `cdr_feed` lines and the feed's minimisation totals/tombstones; **expiry runs the same delete** (`consent_expired` + `data_deleted` records); aggregator end user deleted 30 days after the last consent ends (`end_user_deleted`); minimisation shrink after lodging (weekly cron) | [`src/lib/bank-consent.ts`](../../src/lib/bank-consent.ts) (`consentLifecycle`, `inactiveEndUserSweep`), unit checks "expiry (ON)" / "inactive:" in [`scripts/check-units.ts`](../../scripts/check-units.ts), [data-handling.md §5](data-handling.md#5-deletion) | 🟡 withdrawal deletion live (#576); expiry deletion, inactive end-user deletion and the retention cron built (#639) behind flags OFF until the owner flips them; derived leftovers not keyed to a line (clarify samples, learned rules, recurring bills, noticed-signal evidence, audit_log totals) await the #524 legal ruling | 👤 flip flags · #524 |
| r1.10AA(4)(e) | Delete service data when the principal directs, and give deletion records | Admin runbook: delete by Fiskil end-user id → `purgeTenant` / per-connection PS12 delete; export the matching `cdr_audit_log` rows as the record | [data-handling.md §5.4](data-handling.md#54-deletion-directed-by-fiskil) | ✅ mechanism exists; runbook drafted | — |
| Div 4.3 consent | Consent rules (r4.20B–U, via Fiskil): consent flow, receipts, notifications, 12-month maximum | Fiskil's hosted consent UI; Quillo asks for accounts + transactions only, 12 months | [`docs/bank-feed-golive-checklist.md`](../bank-feed-golive-checklist.md) §2 | ⬜ confirm with Fiskil that its hosted UI covers r4.20B–U | 👤 C9 |

## Workstream tickets

| Ticket | Work | Rows it closes |
|---|---|---|
| [#634] A1 | HSTS, enforcing CSP, no PII in logs | 1(c) partly, 1(i), 3(a) partly, 5(b) partly |
| [#635] A2 | Daily D1 export, restore runbook and tested restore | 2(a) backups, 3(c) backups |
| [#636] A3 ✅ closed | Admin Security & compliance dashboard, flag-gated health checks | 1.6(2), 1.7(1), 1(c) review |
| [#637] A4 ✅ closed | `QBO_TOKEN_KEY` fail-closed + re-encrypt, secrets inventory ([secrets-and-encryption.md](secrets-and-encryption.md)) | 2(a) (key still to be set) |
| [#638] A5 | Clerk production + admin MFA, API rate limiting, JIT rule | 1(a), 1(b), 1(f), 1(h) |
| [#639] A6 | Retention cron, inactive end-user deletion, S8b redaction, no CDR in non-prod | 2(e), 3(b), 3(c), PS12 |
| [#640] A7 ✅ closed | Dependabot, CodeQL, secret scanning, npm audit, ZAP baseline | 1.6(1), 4(a), 4(b), 4(c) |
| [#641] A8 | Bedrock `au.` live + CDR-tainted refusal evidence | PS8 |
| [#642] B | This pack + Fiskil CDR policy link | Part 1 documents, 6(b), r7.2(8) |
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
