# Incident response plan (CDR data security response plan)

> Schedule 2, cl 1.7. Privacy Act 1988 Part IIIC (Notifiable Data Breaches), extended to CDR data by
> s56ES of the Competition and Consumer Act. Version 0.1, 2026-10-08. Owner: the director.
> Keep a printed or offline copy (password manager secure note) so this plan is usable if app.quillo.au,
> GitHub or the laptop is unavailable.

## 1. Scope and definitions

- **Information security incident:** any event that compromises, or could compromise, the confidentiality,
  integrity or availability of Quillo's systems or data. Examples: a leaked API key, an account takeover,
  a bug that showed one user another user's data, a lost laptop, a provider breach, a sustained outage.
- **Data breach:** unauthorised access to, unauthorised disclosure of, or loss of personal information or
  CDR data.
- **Eligible data breach (NDB):** a data breach likely to result in **serious harm** to any individual,
  where remedial action has not removed that likelihood (Privacy Act s26WE).
- **CDR data security breach:** a data breach involving CDR data (service data held by Quillo).

All incidents are recorded in the incident register (§8), however small.

## 2. Roles (solo founder)

| Role | Who | Notes |
|---|---|---|
| Incident lead and decision-maker | Director | Runs every stage; decides on notification |
| Privacy officer | Director | NDB assessment and notifications |
| Technical responder | Director (with AI coding agents for analysis only — never given production credentials or CDR data) | Containment, eradication, recovery |
| Backup contact | ⬜ To be named ([information-security-policy.md §3](information-security-policy.md#3-roles-and-responsibilities)) | Holds break-glass instructions: notify Fiskil and pause the feed if the director is unreachable for 24h during an incident |
| External: Fiskil | CDR principal | **Notify first** for anything touching CDR data (§5.1) |
| External: lawyer | ⬜ To be named (owner task C7) | NDB and CDR obligations; regulator correspondence |
| External: providers | Cloudflare, AWS, Clerk, Stripe support | For provider-side containment and logs |

Contacts (fill in, keep a copy offline):

| Party | Contact | Verified on |
|---|---|---|
| Fiskil incident/security contact | [confirm with Fiskil] | |
| Fiskil breach-notification window | **[confirm with Fiskil, assume 24h]** from becoming aware | |
| OAIC NDB form | https://www.oaic.gov.au/privacy/notifiable-data-breaches/report-a-data-breach | |
| ACSC ReportCyber | https://www.cyber.gov.au/report-and-recover/report · hotline 1300 CYBER1 (1300 292 371) | |
| Cloudflare support | Dashboard → Support | |
| AWS support | Console → Support Center | |
| Lawyer | [name, phone, email] | |
| Backup contact | [name, phone] | |

## 3. Severity levels

| Level | Definition | Examples | Response target |
|---|---|---|---|
| **SEV-1 Critical** | Confirmed or likely unauthorised access to, disclosure or loss of **CDR data**, or compromise of an administrative account with access to it | Cross-tenant data shown; Cloudflare account takeover; CDR-derived text sent to a non-AU model; D1 export leaked | Start immediately; contain within 4h; **notify Fiskil within [confirm with Fiskil, assume 24h]** |
| **SEV-2 High** | Confirmed breach of non-CDR personal information, or a credible threat to CDR data not yet realised | Receipts exposed; a leaked secret with no evidence of use; critical vulnerability on the CDR path | Start within 4h; contain within 24h; tell Fiskil if CDR could be affected |
| **SEV-3 Medium** | Security weakness or contained event with no data exposure | Phishing attempt; failed brute-force; high-severity dependency alert; lost laptop with FileVault on | Within 2 business days |
| **SEV-4 Low** | Minor policy deviation, near miss, availability blip | Uptime alert that self-recovers; misconfigured flag caught in review | Within 10 business days |

When unsure, pick the higher level. Escalate as facts change.

## 4. Lifecycle

### 4.1 Detect and record
Sources: external uptime monitor on `/healthz` (owner task C8); the admin Security & compliance dashboard
(#636): `cost_errors` counter, bank sync failures, purge failures, cost-cap hits; Workers Logs; GitHub
security alerts (Dependabot, secret scanning, CodeQL); Clerk and Cloudflare security emails; Fiskil or a
consumer reporting something; hello@quillo.au.

- [ ] Open an incident entry (§8) with time of awareness. **The 30-day ACSC clock and the NDB assessment
      clock start at awareness.**
- [ ] Assign a severity.

### 4.2 Triage
- [ ] What happened, which systems, which data, which tenants, since when?
- [ ] Is CDR data involved? (Tenants with `profiles.cdr_tainted = 1`; rows with `source='cdr_feed'`.)
- [ ] Is it ongoing?

### 4.3 Contain
Pick what fits; record each action and time.
- [ ] Turn off the bank feed: remove `bank_feed_cdr` from `FEATURES` and redeploy (stops new connects and
      UI). To stop collection immediately, also revoke or rotate `FISKIL_CLIENT_SECRET` in the Fiskil
      Console.
- [ ] Re-lock access: set `CLERK_ALLOWED_USERS` to the founder's sub (kill-switch, no code change).
- [ ] Rotate exposed secrets (`wrangler secret put …`), Cloudflare API tokens, GitHub tokens, AWS keys.
- [ ] Revoke sessions in Clerk; force sign-out of the affected user(s).
- [ ] Roll back the Worker to the last good version (`wrangler rollback`) if a deploy caused it.
- [ ] Disable the affected route or flag.

### 4.4 Preserve evidence
Do this before eradication wherever possible.
- [ ] Do **not** delete logs, rows or the affected tenant's data, even if asked, until the evidence is
      captured (a deletion obligation can be met after preservation; record why it was delayed).
- [ ] Export the relevant Workers Logs window (they expire in days).
- [ ] Snapshot D1: note the current Time Travel bookmark (`wrangler d1 time-travel info tax-agent-db`) and
      take an export to the restricted backup bucket.
- [ ] Export the relevant `audit_log` and `cdr_audit_log` rows (ids and counts only).
- [ ] Record the deployed Worker version id and the git commit.
- [ ] Save provider notices and emails as PDFs.
- [ ] Store evidence in a restricted, encrypted location (not a shared drive), named by incident id.
      Evidence containing CDR data stays inside the CDE.

### 4.5 Assess (NDB)
See §5.2. Complete within **30 days** of awareness at the latest; aim for 72 hours.

### 4.6 Eradicate and recover
- [ ] Fix the root cause through the normal ship workflow (branch, gates, adversarial review, PR).
- [ ] Restore data if needed ([backup-dr.md](backup-dr.md)).
- [ ] Re-enable the feed only when the fix is deployed and verified.

### 4.7 Post-incident review (within 10 business days of closure)
- [ ] Timeline, root cause, what worked, what didn't.
- [ ] Update the control matrix, this plan and any standard affected.
- [ ] Record lessons in `memory/MEMORY.md` if durable.
- [ ] Confirm all notifications were made and recorded.

## 5. Notifications

### 5.1 Fiskil (the CDR principal)
For any SEV-1, and any SEV-2 that could affect CDR data: notify Fiskil **within [confirm with Fiskil,
assume 24h]** of becoming aware, even if facts are incomplete. Fiskil is liable for our breaches (rule
1.16A) and holds the regulatory relationship, so it must hear from us first and before consumers or
regulators where timing allows. Include: what happened, when we became aware, data and consumer counts
(by Fiskil end-user id), containment so far, next update time. Follow Fiskil's direction on who notifies
the OAIC and consumers for CDR data, and on deletion (rule 1.10AA(4)(e)).

### 5.2 NDB assessment (Privacy Act Part IIIC)
- If there are reasonable grounds to **suspect** an eligible data breach, carry out a reasonable and
  expeditious assessment, completed within **30 days** (s26WH).
- Serious-harm factors: kind and sensitivity of the data (transaction histories reveal health, location,
  relationships, finances); whether it was protected (encryption, masking); who obtained it; likelihood of
  misuse; remedial action taken.
- If remedial action means serious harm is no longer likely, it is not notifiable; record the reasoning.
- Whether Quillo itself is an APP entity for non-CDR data (small business exemption) is a question for
  the lawyer (C7). **This plan treats every breach as if Part IIIC applies.**

### 5.3 OAIC and affected consumers
If it is an eligible data breach (and, for CDR data, as agreed with Fiskil):
- [ ] Prepare a statement: Quillo's identity and contact details, a description of the breach, the kinds
      of information concerned, and recommended steps for individuals (s26WK).
- [ ] Lodge it with the OAIC as soon as practicable (online form above).
- [ ] Notify affected individuals as soon as practicable: directly (email to their sign-in address) where
      practicable, otherwise publish on quillo.au and take reasonable steps to publicise it (s26WL).
- [ ] Record dates, recipients and copies in the register.

### 5.4 Australian Cyber Security Centre (ACSC)
Schedule 2 cl 1.7(3)(c): notify **information security incidents** to the ACSC **as soon as practicable,
and in any case no later than 30 days** after becoming aware.
- [ ] Report through ReportCyber (https://www.cyber.gov.au/report-and-recover/report).
- [ ] Record the report reference and date in the register.
- [ ] Report SEV-1 and SEV-2 incidents always; report SEV-3 when it is an actual incident rather than a
      blocked attempt (when unsure, report).

### 5.5 Others
- Providers whose systems were involved (Cloudflare, AWS, Clerk).
- Police (ReportCyber routes to them) if a crime is suspected.
- Cyber insurer, once a policy exists (C5).

## 6. Communication rules
- One voice: the director. Factual, no speculation, no blame.
- Never include CDR data or personal information in an email to a third party unless required; refer to
  Fiskil end-user ids and counts.
- Keep consumer messages plain-English and general-information framed.

## 7. Playbooks

| # | Scenario | First actions |
|---|---|---|
| P1 | **Admin account takeover** (Cloudflare, GitHub, AWS, Clerk, Fiskil) | Reset password and MFA from a clean device; revoke sessions and API tokens; review the account audit log; rotate every secret that account could read; check recent deploys and D1 queries |
| P2 | **Cross-tenant exposure bug** | Disable the route/flag or roll back; identify affected tenants from logs and `audit_log`; preserve; fix with a regression test; notify per §5 |
| P3 | **CDR-derived data sent to a non-AU model** (PS8) | Confirm via `llm_usage`/`traces` provider and model; disable the path; tell Fiskil (SEV-1); request deletion from the provider; fix the residency seam with a test |
| P4 | **Provider breach** (Fiskil, Cloudflare, AWS, Clerk, Stripe) | Get the provider's scope statement; rotate our credentials at that provider; assess our data exposure; coordinate notifications with Fiskil |
| P5 | **Data loss or corruption** | Stop writes if needed (pause the feed, maintenance flag); restore via Time Travel or export ([backup-dr.md](backup-dr.md)); verify row counts |
| P6 | **Lost or stolen laptop** | Find My → lock/erase; revoke the laptop's sessions (Cloudflare, GitHub, AWS, Clerk, Google); rotate `wrangler` OAuth and any local tokens; confirm FileVault was on |
| P7 | **Leaked secret** (repo, log, screenshot) | Rotate immediately; check provider logs for use since exposure; purge from git history if committed; GitHub push protection review |
| P8 | **Malicious dependency** | Pin/revert; `npm ci` from clean lockfile; check outbound calls (CSP reports, Workers Logs); rotate secrets the Worker holds |

## 8. Incident register

| Id | Aware (date/time) | Severity | Summary | CDR data? | Fiskil notified | NDB assessment done / outcome | OAIC / consumers notified | ACSC reported (≤30 days) | Closed | PIR link |
|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | |

## 9. Annual tabletop test

Schedule 2 cl 1.7(4): review and test the plan **at least annually** and after material change. Run a
60–90 minute tabletop each October with the backup contact (or the lawyer) playing Fiskil/regulator.

**Template**

| Field | Record |
|---|---|
| Date | |
| Participants | |
| Scenario | e.g. "A user reports seeing another person's bank transactions on the Review page" (rotate scenarios: P1–P8) |
| Injects | t+0 report arrives · t+30m logs show 3 tenants affected · t+2h Fiskil asks for an update · t+1d a journalist emails |
| Questions | Who is told first and when? How do we stop collection? How do we preserve evidence before Workers Logs expire? Is it an eligible data breach? What goes in the OAIC statement? When is the ACSC deadline? |
| Timings achieved | Containment: ___ · Fiskil notified: ___ · NDB decision: ___ |
| Gaps found | |
| Actions (ticket #) | |
| Plan updated? | Yes / No — version |
| Sign-off | Director: ______ Date: ______ |

**Record of tests**

| Date | Scenario | Outcome | Actions raised |
|---|---|---|---|
| ⬜ not yet run | | | |
