# Fiskil security questionnaire: answer bank

> Pre-drafted answers for Fiskil's CDR Representative onboarding (application, company profile, security
> questionnaire, compliance checklist). Organised by the topics Fiskil's published due diligence names
> (use case, fit and proper persons, prior security audit, cyber insurance) plus the Schedule 2 areas.
> **Re-fit to the actual form once Fiskil sends it.** Every answer is honest about gaps; status refers to
> [control-matrix.md](control-matrix.md). Bracketed items are for the owner to fill. Version 0.1,
> 2026-10-08.

## 1. Business and use case

**Legal entity:** Young Milton Pty Ltd, trading as Quillo. ABN [ABN]. Registered office [address].
Contact: brendan@quillo.au. Website: https://quillo.au; app: https://app.quillo.au.

**What the product does:** Quillo helps first-time and everyday Australian taxpayers keep evidence for
their own individual tax return: receipts, income records, work-related expenses and property records. It
categorises transactions and shows what may be claimable. It is **general information only**: Quillo is
not a registered tax or BAS agent, does not lodge returns, and never holds or moves money.

**Why CDR data:** read-only bank **accounts and transactions** so the consumer does not have to upload
statements, to find work-related deductions and keep records for the tax year being lodged.

**Data requested:** accounts and transactions only (banking). Not customer name or contact details, not
payees, not direct debits. Consent period 12 months; history up to 24 months, clamped to the year being
lodged.

**Not:** lending, credit assessment, payments, action initiation, marketing, data sale, research,
de-identification for other uses.

**Consumers:** individual Australian taxpayers; self-service sign-up. [Current user count].

**Consent UI:** Fiskil's hosted consent flow, with Quillo branding and the purpose text: "Help you find
what you may be able to claim and keep records for your own tax return. Quillo is general information
only, not a registered tax agent." Consent dashboard in Settings › Bank connections shows each consent,
scope, expiry and history, and lets the consumer withdraw (which stops collection, ends Fiskil's access
and deletes the imported transactions).

## 2. Fit and proper persons

**Directors and key people:** [Director full name], sole director and only staff member.

**Declarations (owner to confirm each):**
- No criminal convictions relevant to fraud or dishonesty: [confirm]. National police check through an
  ACIC-accredited body: [date / pending] ([training-and-screening-record.md](training-and-screening-record.md)).
- Not bankrupt or insolvent (AFSA NPII search [date]).
- Not disqualified from managing corporations (ASIC register search [date]).
- No adverse findings by ASIC, the ACCC, the OAIC or any other regulator; no CDR accreditation refused or
  revoked.

## 3. Prior information security audit

**Have you ever had an information security audit?** No third-party information security audit or
penetration test has been done yet. What we do have:
- free automated scanning: GitHub CodeQL (SAST), Dependabot, secret scanning with push protection,
  `npm audit` in CI, and a weekly OWASP ZAP baseline scan against the production app (live since 2026-10-08, #640);
- adversarial internal reviews of every change touching auth, data, ingest or CDR paths, using multiple
  independent review agents that check architecture, correctness, security and operations; these have
  caught and fixed real defects before release;
- automated test gates on every pull request (tenant isolation, consent lifecycle, residency guard,
  deletion, schema drift).

We will commission an independent review or penetration test if Fiskil requires one, and we disclose the
independence gap against Schedule 2 cl 1.6(4) in our control matrix.

## 4. Cyber insurance

[Pending. A quote has been requested from [insurer/broker] on [date].] (Owner task C5.)

## 5. Governance

- Information security policy adopted by the director [date]; reviewed annually (October) and on
  material change ([information-security-policy.md](information-security-policy.md)).
- Schedule 2 control matrix maintained as the master tracker, every control mapped to evidence.
- Roles: the director is senior management, security owner, privacy officer and incident lead.
  Compensating controls for a one-person company: mandatory PR + CI gates, adversarial review,
  append-only/hash-chained audit logs, written runbooks, a named backup contact [name].
- CDR data environment boundary and data-flow diagram documented
  ([cdr-data-environment.md](cdr-data-environment.md)).

## 6. Access control

- MFA on every administrative account (Cloudflare, GitHub, AWS, Clerk, Fiskil Console, Stripe, Google,
  registrar) [status: being completed, C1].
- Consumer authentication by Clerk (production instance, MFA available; enforced for the admin role)
  [status: #638].
- Least privilege: one cross-tenant `admin` role, held only by the founder, server-enforced; admin views
  show aggregates, not consumer transactions. Just-in-time rule for any further admin grants.
- Tenant isolation: every table keyed by `user_id`; identity derived server-side from the verified
  session, never from client input; one Durable Object per tenant.
- Quarterly access review with a log ([access-control-standard.md](access-control-standard.md)).
- No shared accounts.

## 7. Encryption

- In transit: TLS 1.2+ everywhere (Cloudflare edge, Fiskil API, AWS SigV4-signed HTTPS). HSTS
  [status: #634].
- At rest: Cloudflare D1 and R2 encrypt at rest (AES-256). QuickBooks OAuth tokens additionally sealed
  with AES-256-GCM under an app-held key [status: key being set, #637]. No Fiskil access tokens are
  stored (server-side client credentials only).
- Secrets in Cloudflare Worker secrets; never in source control (secret scanning with push protection).
- Admin laptop: FileVault full-disk encryption [C2].

## 8. Vulnerability management and secure development

- Patch SLAs: critical 48h, high 7 days, medium 30 days on the CDR path
  ([vulnerability-management.md](vulnerability-management.md)).
- Serverless: no servers or OS to patch; runtime patched by Cloudflare/AWS.
- Every change by pull request with CI gates (typecheck, lint, full test suite including 10 persona
  goldens and the residency unit checks) and risk-proportional review.
- Scanners as in §3.

## 9. Logging and monitoring

- Hash-chained audit log of every tenant data change; a CDR audit log of every consent request, grant,
  collection, expiry, withdrawal, upstream revoke and deletion (ids and counts only, never CDR content);
  both retained after account deletion as evidence.
- Fiskil identifiers logged: end-user id, consent id, session id (including abandoned attempts), error id.
- Workers Logs for runtime errors; email addresses and raw CSP reports removed from logs [#634].
- Admin Security & compliance dashboard (backups, scans, headers, errors, CDR activity, residency) [#636];
  external uptime monitor on `/healthz` [C8].

## 10. Incident response

- Written plan covering detection to post-incident review, severity levels and playbooks
  ([incident-response-plan.md](incident-response-plan.md)).
- Notify Fiskil within [the window Fiskil specifies; we have assumed 24 hours] of becoming aware of any
  incident affecting CDR data.
- NDB assessment within 30 days; OAIC and consumer notification under Privacy Act Part IIIC as directed
  with Fiskil.
- ACSC report as soon as practicable and within 30 days (Schedule 2 cl 1.7(3)(c)).
- Evidence preservation steps; annual tabletop test [first test date].
- Kill switches: feature flag to stop the bank feed, Fiskil credential rotation, sign-up lock.

## 11. Business continuity and disaster recovery

- D1 point-in-time restore (Time Travel, 30 days).
- Daily export to an access-restricted, encrypted R2 bucket, 35 daily + 12 monthly; tested restore
  (2026-10-08: a production export restored into a scratch DB with every table's row count matching;
  [backup-dr.md](backup-dr.md) §6).
- Statement upload remains available if the feed is paused; rule pack and code are rebuildable from git.
- Key-person risk mitigated by written runbooks and a named backup contact.

## 12. Outsourced service providers and data location

- CDR data OSPs: **Cloudflare** (hosting, database, backups; US-incorporated, global infrastructure) and
  **AWS Bedrock** (AI processing in Sydney/Melbourne only). Full register:
  [osp-register.md](osp-register.md).
- AI processing of CDR data is technically restricted to Australia: the application refuses any
  non-Australian model for a consumer whose data includes CDR data (unit-tested; live evidence #641).
- Anthropic's US API is used only for consumers without CDR data and only after APP-8 consent.
- Data-at-rest location and the PS8 position for US-incorporated providers are being confirmed with
  counsel ([`docs/cdr-ps8-findings.md`](../cdr-ps8-findings.md)) [C7]. We request Fiskil's written
  acceptance of Cloudflare and AWS as OSPs.

## 13. Data lifecycle

- Minimisation: consented and selected accounts only; masked account numbers; accounts + transactions
  scopes only; irrelevant debits reduced to per-account totals after the year is lodged.
- Withdrawal: collection stops immediately, Fiskil access is revoked, and imported CDR transactions are
  deleted; recorded in the CDR audit log.
- Account deletion: Fiskil end user deleted first, then all tenant data.
- Expiry, scheduled retention and inactive end-user deletion (30 days after last consent ends)
  [status: #639].
- No CDR data in non-production: development uses Fiskil sandbox only.
- We will delete service data and provide deletion records when Fiskil directs (rule 1.10AA(4)(e)).
- We adopt Fiskil's CDR policy and link it from the Connect page, Settings › Bank connections and the app
  footer (rule 7.2(8)).

## 14. Staff and training

- One person (the director). Security and privacy training (ACSC small-business, OAIC CDR and NDB)
  [date]; annual refresher.
- Acceptable use policy signed [date].
- Police check [date].
- Hardened, encrypted admin laptop; standard (non-admin) daily account; password manager
  ([endpoint-standard.md](endpoint-standard.md)).
- Joiner/leaver procedure ready for the first hire.

## 15. Complaints and disputes

Quillo is not an AFCA member and adopts Fiskil's CDR policy, including its complaints process. [Confirm
with Fiskil whether Quillo handles first-line CDR complaints, and the timeframes.] Contact for Quillo
support: hello@quillo.au.
