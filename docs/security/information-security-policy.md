# Information security policy

> Young Milton Pty Ltd, trading as **Quillo** (app.quillo.au). Schedule 2, Part 1, clauses 1.3–1.6 of the
> CDR Rules. Version 0.1 (draft, 2026-10-08). Owner: the director. Status: **draft until signed in §7**.
> Master tracker: [control-matrix.md](control-matrix.md).

## 1. Purpose and scope

This policy sets the governance framework Quillo uses to manage information-security risk, including
risk to **CDR data** that Quillo receives as a **CDR representative of Fiskil** (rule 1.10AA). It covers:

- the CDR data environment as defined in [cdr-data-environment.md](cdr-data-environment.md);
- all other personal information Quillo holds (receipts, income records, tax situation, identity);
- every system, service provider, device and person that can reach that data.

Quillo provides **general information only**, not tax advice, and is not a registered tax agent. That
framing does not change any security obligation.

## 2. Policy statements

1. **Protect by design.** Tenant isolation (`user_id` on every table, identity derived server-side, never
   from a client header), a single write-coordinator per tenant, and a consent gate before any model call
   are invariants. They are listed in [CLAUDE.md](../../CLAUDE.md) and enforced by tests.
2. **Hold the least data.** Collect accounts and transactions only; never full account numbers, names,
   contact details or payees from a bank feed. Shrink and delete on schedule ([data-handling.md](data-handling.md)).
3. **Keep CDR data in Australia for processing.** Tenants holding CDR data are refused any inference path
   outside Australia (`getLLM` residency seam, [`src/llm.ts`](../../src/llm.ts)).
4. **Strong identity everywhere.** MFA on every administrative account, least privilege, just-in-time admin
   ([access-control-standard.md](access-control-standard.md)).
5. **Change safely.** Every change follows the ship workflow with automated gates and risk-proportional
   review ([vulnerability-management.md](vulnerability-management.md)).
6. **Detect, respond, report.** Incidents follow [incident-response-plan.md](incident-response-plan.md),
   including notifying Fiskil, the OAIC, affected consumers and the ACSC.
7. **Only approved service providers.** Data goes only to services in the [OSP register](osp-register.md);
   CDR data goes only to those Fiskil has approved.
8. **Evidence over assertion.** A control counts only when there is evidence for it in the control matrix.

## 3. Roles and responsibilities

Quillo has **one person**: the director. That person holds every role below. Schedule 2 defines "senior
management" as the directors, so the director is senior management for cl 1.3(2) and 1.6(3).

| Role | Held by | Responsibilities |
|---|---|---|
| Senior management / accountable executive | Director | Approves this policy and the pack; accepts residual risk; allocates budget (cl 1.2 "information security capability"); receives every testing deficiency (cl 1.6(3)) |
| Security owner | Director | Maintains the control matrix; runs the quarterly access review and annual review; owns the vulnerability program |
| Privacy officer | Director | NDB assessments; consumer requests (access, correction, deletion); liaison with Fiskil and the OAIC |
| Incident lead | Director | Runs the incident response plan end to end |
| Engineering | Director, assisted by AI coding agents | Builds and ships changes through the ship workflow; agents never hold production credentials beyond the deploy tooling on the director's laptop and never act on production data |

**Separation of duties with one person.** True segregation is impossible. Compensating controls:

- every production change goes through a pull request with automated CI gates that the author cannot skip
  without leaving a record;
- risky changes (auth, money, ingest, CDR) get an adversarial multi-agent review that does not share the
  author's context;
- audit logs (`audit_log`, `cdr_audit_log`) are append-only, hash-chained (`audit_log`) and excluded from
  tenant purge, so actions remain traceable;
- the independence gap in testing (cl 1.6(4)) is disclosed, not hidden: see
  [vulnerability-management.md §6](vulnerability-management.md#independence-gap-cl-164).

**Backup person.** ⬜ Not yet named. The director should nominate a trusted person (for example, the
lawyer or an accountant) who holds sealed break-glass instructions to notify Fiskil and consumers if the
director is incapacitated during an incident. Recorded in [owner-tasks.md](owner-tasks.md).

When Quillo engages anyone else (employee or contractor), the joiner steps in
[access-control-standard.md §6](access-control-standard.md#6-joiners-and-leavers) apply before any access,
and this section is updated.

## 4. Risk posture

Information assets: CDR data (bank accounts and transactions), other personal and tax information,
receipts and documents in R2, credentials and secrets, and the source code and deploy pipeline.

Quillo's risk appetite for CDR data is **low**: we accept availability risk (the feed can be paused and
statement upload is a fallback) far more readily than confidentiality risk.

| # | Risk to CDR data | Likelihood | Impact | Main controls | Residual |
|---|---|---|---|---|---|
| R1 | **Cross-tenant exposure**: a code bug returns one consumer's transactions to another | Low | High | `user_id` on every query; identity server-side; one DO per tenant; persona and e2e tests; adversarial review on data-path changes | Low |
| R2 | **Offshore disclosure**: CDR-derived text sent to a US model (PS8) | Low | High | `getLLM` refuses non-AU inference for `cdr_tainted` tenants (one-way flag); unit tests; Bedrock `au.` profile only | Low once #641 verified |
| R3 | **Administrator credential compromise** (Cloudflare, GitHub, AWS, Clerk, Fiskil) | Medium | High | MFA (passkeys or authenticator), password manager, scoped tokens, JIT admin, laptop hardening | Medium until C1/C2 done |
| R4 | **Supply chain**: malicious or vulnerable npm package | Medium | High | Lockfiles, `npm ci`, Dependabot, `npm audit`, CodeQL, CSP restricting outbound browser calls | Low–Medium (scanners live, #640) |
| R5 | **Data loss**: accidental deletion or corruption of D1 | Low | Medium | D1 Time Travel (30 days); daily export to R2 (#635); idempotent migrations only | Medium until #635 |
| R6 | **Over-retention**: CDR data kept after it is needed | Medium | Medium | Withdrawal deletion (#576), minimisation (#581), retention cron and inactive end-user deletion (#639) | Medium until #639 |
| R7 | **Web attack** (XSS, injection, CSRF) on the SPA or API | Low | High | Parameterised D1 queries; React escaping; CSP; same-origin API; ZAP baseline | Low–Medium until #634/#640 |
| R8 | **Lost or stolen laptop** | Low | Medium | FileVault, screen lock, no CDR data stored locally, remote wipe via Find My | Low once C2 done |
| R9 | **Provider breach** (Fiskil, Cloudflare, AWS, Clerk) | Low | High | Contracts and attestations; incident playbook P4; minimal data held | Medium (outside our control) |
| R10 | **Key-person risk**: the only operator is unavailable during an incident | Medium | Medium | Written runbooks (this pack); backup person with break-glass instructions | Medium until named |

Potential harm to consumers if CDR data were misused or disclosed: transaction history reveals spending
patterns, employer, health providers, location and relationships. It does not include full account
numbers, credentials or the ability to move money (Quillo has read-only access and never holds or moves
money).

## 5. Supporting standards

| Document | Schedule 2 coverage |
|---|---|
| [control-matrix.md](control-matrix.md) | Every Part 1 step and Part 2 control |
| [cdr-data-environment.md](cdr-data-environment.md) | cl 1.4; control 2(e) |
| [access-control-standard.md](access-control-standard.md) | Control requirement 1 |
| [vulnerability-management.md](vulnerability-management.md) | cl 1.6; control requirement 4 |
| [data-handling.md](data-handling.md) | Control requirement 3 |
| [backup-dr.md](backup-dr.md) | 2(a), 3(c) backups |
| [endpoint-standard.md](endpoint-standard.md) | 1(e), 2(b), 2(d), control requirement 5 |
| [incident-response-plan.md](incident-response-plan.md) | cl 1.7 |
| [acceptable-use.md](acceptable-use.md) | 6(b), 3(a) |
| [training-and-screening-record.md](training-and-screening-record.md) | 6(a), 6(c) |
| [osp-register.md](osp-register.md) | r7.2(4)(f)–(g), r1.10AA(3)(b), PS8 |
| [questionnaire-answers.md](questionnaire-answers.md) | Fiskil due diligence |
| [owner-tasks.md](owner-tasks.md) | Owner actions C1–C9 |

## 6. Review cadence

Reviews of this policy (cl 1.3(4)), the CDE boundary (cl 1.4(2)), the capability (cl 1.5(2)) and the
testing program (cl 1.6(5)) happen together:

- **annually in October** (before peak tax season), and
- **as soon as practicable** after any trigger: a new OSP or data type; a change to how CDR data flows; a
  security incident; a material new threat (for example a critical vulnerability in a dependency on the
  CDR path); a change in Fiskil's or the regulator's requirements; anyone else gaining access.

Each review updates the control matrix and is logged below.

| Date | Trigger (annual / event) | Reviewed by | Changes made | Next review due |
|---|---|---|---|---|
| 2026-10-08 | Initial draft (#642) | Drafted by Claude Code for the director | Pack created | Director adoption; then 2027-10 |
| | | | | |

## 7. Approval

I have read and adopt this policy and the standards listed in §5 for Young Milton Pty Ltd.

Name: ______________________ Role: Director Signature: ______________ Date: ____________
