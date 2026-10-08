# Security pack

Quillo's information-security documents for the **Fiskil CDR Representative** application (epic
[#633](https://github.com/matchmoments-admin/quillo/issues/633)). Schedule 2 of the CDR Rules applies to
Quillo through rule 1.10AA(4)(b). Start with the control matrix: it is the master tracker and links
everything else.

| Document | Purpose |
|---|---|
| [control-matrix.md](control-matrix.md) | **Master tracker**: every Schedule 2 step and control → Quillo control → evidence → status → ticket |
| [information-security-policy.md](information-security-policy.md) | Governance, roles, risk posture, review cadence (cl 1.3–1.6) |
| [cdr-data-environment.md](cdr-data-environment.md) | CDE boundary, data-flow diagram, where CDR data lives, segregation (cl 1.4, 2(e)) |
| [incident-response-plan.md](incident-response-plan.md) | Severity, lifecycle, Fiskil/OAIC/consumer/ACSC notification, playbooks, tabletop (cl 1.7) |
| [access-control-standard.md](access-control-standard.md) | MFA, least privilege, JIT admin, quarterly review, joiners/leavers (control requirement 1) |
| [clerk-production-cutover.md](clerk-production-cutover.md) | Owner runbook: Clerk development → production instance, DNS, keys, admin MFA, test plan, rollback (#638) |
| [vulnerability-management.md](vulnerability-management.md) | Scanners, patch SLAs, triage, secure SDLC (A7, #640), plus the controls assessment program and independence gap (cl 1.6) |
| [secrets-and-encryption.md](secrets-and-encryption.md) | QBO token encryption, CDR credential posture, secrets inventory (A4, #637) |
| [data-handling.md](data-handling.md) | Classification, minimisation, retention, deletion, non-production (control requirement 3) |
| [backup-dr.md](backup-dr.md) | Backups and DR (stub; completed by #635) |
| [endpoint-standard.md](endpoint-standard.md) | macOS hardening (2(d), control requirement 5) |
| [acceptable-use.md](acceptable-use.md) | Acceptable use policy (6(b)) |
| [training-and-screening-record.md](training-and-screening-record.md) | Training and police-check records (6(a), 6(c)) |
| [osp-register.md](osp-register.md) | Every external service, country, data, CDR or not (r7.2(4)(f)–(g)) |
| [questionnaire-answers.md](questionnaire-answers.md) | Answer bank for Fiskil's questionnaire |
| [owner-tasks.md](owner-tasks.md) | Owner checklist C1–C9 |

These are drafts until the director signs the policy. Engineering input, not legal advice.
