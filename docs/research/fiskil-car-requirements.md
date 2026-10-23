# What Fiskil will assess before approving Quillo as a CDR Representative

> Research deliverable for [#693](https://github.com/matchmoments-admin/quillo/issues/693), part of map
> [#692](https://github.com/matchmoments-admin/quillo/issues/692). It feeds the OSP message ticket
> [#702](https://github.com/matchmoments-admin/quillo/issues/702) and the readiness epic
> [#633](https://github.com/matchmoments-admin/quillo/issues/633). Researched 2026-10-24 against the
> CDR Rules compilation of 2025-03-04 (F2025C00572), the ACCC/OAIC guidance listed below, Fiskil's
> public site and docs, and `main` at `37117ab`.
>
> **This is engineering input, not legal advice.** Anything marked "counsel" needs the lawyer (owner
> task C7). Nobody at Fiskil or any other third party was contacted for this note.

## 1. The answer in brief

- **Fiskil does not publish a fixed assessment standard for representatives.** Its public material
  names four due-diligence topics: use case, fit and proper persons, any prior information security
  audit, and cyber insurance. On top of those it asks for a Console application, a security
  questionnaire, and a mandatory compliance checklist and developer checklist
  ([go-live checklist](https://docs.fiskil.com/data-api/guides/resources/go-live-checklist),
  [Fiskil blog, 2021](https://blog.fiskil.com/how-to-become-a-cdr-representative)).
- **The legal floor behind that questionnaire is Schedule 2 in full.** Rule 1.10AA(4)(b) makes a
  representative "take the steps in Schedule 2 to protect the service data as if it were the CDR
  representative principal". Rule 1.16A makes Fiskil liable for any breach, "regardless of whether
  the CDR representative principal knew or was aware" of it
  ([ACCC/OAIC representative-principal guidance, Jan 2025](https://www.cdr.gov.au/sites/default/files/2025-01/CDR-guidance-for-CDR-representative-principals-on-ensuring-compliance-of-their-CDR-representatives-published-15-January-2025.pdf), §1.2).
  The regulators tell principals not to rely on a representative's self-assessment alone, and to
  consider asking for "vulnerability and penetration testing reports, internal audit reports, and
  other information security assessments and questionnaires" (same guide, §3.2.1 and §3.2.4.1).
- **No ASAE 3150, SOC 2 or ISO 27001 report is legally required of a representative.** The ASAE 3150
  attestation and assurance cycle (Schedule 1 cl 2.1) binds accredited persons, which means Fiskil.
  The regulators suggest principals use something like the ACCC's sponsored-accreditation
  self-assessment and attestation form for "smaller or newer organisations who may not have existing
  information security certifications" (same guide, §3.2.4.1). That is the most likely format for
  Quillo: a Schedule 2 self-assessment questionnaire with evidence, not a certification.
- **A penetration test is required by the rule text, not only if Fiskil asks.** Schedule 2 Part 2
  control 4 reads: "A formal vulnerability management program is designed and implemented, which
  includes regular vulnerability scanning **and penetration testing** on systems within the CDR data
  environment" ([CDR Rules, Sch 2](https://www.legislation.gov.au/F2020L00094/latest/text)). Through
  r1.10AA(4)(b) this applies to Quillo. The control matrix's current framing (row 4(c): "buy one if
  Fiskil requires it") understates this. An external pen test would also go most of the way to closing
  the cl 1.6(4) independence gap.
- **OSP verdict: Bedrock `au.` and Cloudflare are acceptable in principle, but not yet in fact.** The
  ACCC says "the CDR Rules do not prohibit an accredited person from storing CDR data on
  infrastructure owned by third parties"
  ([Supplementary accreditation guidelines: information security v6](https://www.cdr.gov.au/sites/default/files/2025-04/CDR-Supplementary-Accreditation-Guidelines-Information-Security-version-6-April-2025.pdf), §8.1).
  Approval still turns on four things Quillo has not got yet (§4 below):
  1. Fiskil permits the OSPs in the representative arrangement (r1.10AA(3)(b)).
  2. A **CDR outsourcing arrangement** with each OSP that contains the r1.10(3) required provisions.
  3. A PS8 "reasonable steps" position for US-incorporated providers.
  4. Each OSP named, with its country if overseas, on the consent screen (r4.20E(3)(k)).

  AWS Bedrock in ap-southeast-2 is the stronger case, with live evidence. Cloudflare is the weaker
  one: US-incorporated, a global edge, and a D1 location that has not been confirmed.
- **Timeline: Fiskil says representative onboarding "takes 4-8 weeks"**
  ([Fiskil CDR accreditation page](https://www.fiskil.com/grow/banking-api/open-banking-au/cdr-accreditation)).
  The clock starts when the questionnaire is submitted, and the questionnaire waits on the gaps below.
  The legal hard stop: collection cannot operate "until the details of the CDR representative have been
  entered on the Register of Accredited Persons" (r1.10AA(1)(c)), and Fiskil must notify the
  Accreditor within 5 business days of entering the arrangement (r5.14(3)).

## 2. What Fiskil itself asks for

| Source | What it requires |
|---|---|
| [Go-live checklist](https://docs.fiskil.com/data-api/guides/resources/go-live-checklist) | Live access "is requested and granted entirely through the Fiskil Console". (1) Application and company profile. (2) A security questionnaire, "required for live access". (3) Review the Compliance Checklist. (4) Work through the Developer Checklist. (5) After approval, set up production and run a final end-to-end test. Fiskil "reviews your questionnaire and follows up in the Console". **No timeline given.** |
| Same, compliance checklist (mandatory) | Consent UI: branding, a consent period that fits the use case (up to 12 months), every data-use purpose documented. Data management: a documented minimisation strategy, deletion or de-identification processes, testing procedures for data-management compliance, and identifiable data "stored in compliance with local data sovereignty regulations". |
| Same, developer checklist | Handle every error type; retry on data-holder outages; securely log `end_user_id`, `consent_id`, `session_id` and `error_id`; delete end users who no longer use the product; paginate history; use `categories`. |
| [Fiskil blog (Jul 2021)](https://blog.fiskil.com/how-to-become-a-cdr-representative) | Due-diligence checks cover "your use case", "fit and proper persons", "whether you've ever had an information security audit" and "whether you have cyber security insurance". The post is old, so treat it as the minimum. |
| [Fiskil CDR accreditation page](https://www.fiskil.com/grow/banking-api/open-banking-au/cdr-accreditation) | "CDR Representative onboarding takes 4-8 weeks." Representatives have "reduced or no insurance requirements" because "the principal ADR carries the insurance obligation". |
| [Fiskil CDR policy](https://www.fiskil.com/legal/cdr-policy) | Representatives are listed in Annexure 1. On withdrawal or expiry Fiskil notifies representatives; deletion by them is managed "through contracts and regular attestations", and Fiskil "will audit them from time to time". "Fiskil does not provide CDR data to any outsourced providers"; data "is onshore and only resides in Australia". Complaints go to complaints@fiskil.com.au, then AFCA (member 83521). |
| [Fiskil security page](https://www.fiskil.com/security) | Fiskil holds SOC 2 Type II and ASAE 3150 Type II attestations itself. Nothing is published about what it requires of partners. |

Two consequences for Quillo:

1. **Ongoing deletion attestations are expected after go-live, as well as at onboarding**, and Fiskil
   may audit. `cdr_audit_log` and the PS12 records are the evidence base.
2. **Fiskil's own CDR policy says it uses no OSPs and keeps data in Australia.** Quillo's OSPs will be
   the first in that chain, and Fiskil must list them in its policy (r7.2(4)(f)–(g)). Expect scrutiny
   here: Fiskil carries the liability (r1.16(3)–(4)).

## 3. What the CDR Rules pass down to a representative

All rule references are to the [CDR Rules compilation of 2025-03-04](https://www.legislation.gov.au/F2020L00094/latest/text).

### 3.1 Security assessment

- **Schedule 2, Parts 1 and 2 in full** (r1.10AA(4)(b)): governance, the CDE boundary, capability, a
  controls assessment program, incident management, and the minimum controls 1–6. Two clauses a
  one-person company cannot meet by itself:
  - **cl 1.6(4):** "testing is conducted by appropriately skilled persons who are independent from the
    performance of controls over the CDR data environment";
  - **control 4:** "regular vulnerability scanning and penetration testing".
- **Format:** not set by law for representatives. The regulators expect principals to do their own
  risk assessment. They suggest the sponsored-accreditation self-assessment and attestation form,
  whose sheets C3A and C3B test design, implementation and operating effectiveness, along with pen
  test reports and ad hoc control checks (rep-principal guide §3.2.4.1). They also say the
  principal's assessment need not be "as stringent or the same as the ACCC's assessment of
  accreditation applicants".
- **ISO 27001 / SOC 2:** these count only as partial evidence. "ISO 27001 controls alone do not meet
  the information security obligation in the CDR Rules" (infosec guidelines §3.2). Quillo holds
  neither certification, and neither is required.
- **OSP controls count as Quillo's own controls.** "If a control defined in Schedule 2, Part 2 is or
  will be performed by a third-party service provider, an accredited person must assess this as part
  of its formal controls assessment program". That can use "security questionnaires, formal control
  assessments, site visits or third-party assurance reports (for example, SOC2, ASAE 3402…)", and the
  service contract should include "mandatory reporting of any security incident"
  (infosec guidelines §8.2.2–8.2.3).

### 3.2 Contract terms the arrangement must contain (r1.10AA(3)–(4))

- Only one representative arrangement at a time (3)(a).
- **No OSP for service data "except as provided in the CDR representative arrangement" (3)(b).**
- Comply as if principal with PS2, 4, 6, 7, 11, 12 and 13 (4)(a). Comply with PS8 and PS9 as if an ADR (4)(g).
- Delete service data when directed, provide the deletion records, and make OSPs do the same (4)(e).
- Adopt and comply with Fiskil's CDR policy (4)(f).
- Comply with the **consumer experience data standards** as if an ADR (r1.10AA(1)(d)(ii)).

### 3.3 Consent, dashboard and CX (Division 4.3A, which Fiskil must ensure under r1.16A(3))

- **Consent-time information (r4.20E(3)):**
  - Quillo's name, and the fact that it is a CDR representative whose principal collects the data.
  - The principal's name and **accreditation number** (Fiskil: `ADRBNK000246`).
  - A data-minimisation explanation.
  - A link to Fiskil's CDR policy.
  - **For each OSP: its name, its country if overseas, why it needs the data, and a link to the
    policies** (k).
  - That the consent can be withdrawn at any time.
  - The redundant-data treatment statement (r4.20N).
- **Consent limits:** no more than 12 months (r4.20F(1)); no consent that breaches minimisation (r4.20F(2)).
- **Withdrawal (r4.20J):** through the principal's dashboard, or by a "simple method of communication"
  that **the representative itself must offer** (r4.20J(3)). A withdrawal made that way takes effect
  within 2 business days (r4.20J(6)).
- **Dashboard:** this is Fiskil's obligation (r1.14), but Fiskil "may arrange for the CDR representative
  to provide the consumer dashboard on its behalf" (r1.14(5)). Either way the representative must tell
  the principal promptly when dashboard information changes (r4.20T). If Quillo provides it, r1.14(1)
  applies in full: each consent's details (r1.14(3)), withdrawal with a consequences message under the
  data standards, and the redundant-data deletion election (unless Quillo states a general deletion
  policy at consent, r4.20M(3)).
- **Notifications:**
  - **CDR receipts** after every give, amend or withdraw, in the form the data standards set (r4.20O).
  - **Written notice when a collection consent expires while the use consent is current**, "otherwise
    than through the … consumer dashboard" (r4.20Q).
  - **90-day "still current" notices** (r4.20U).

  Receipts and 90-day notices are binding CX standards for data recipients from 14 July 2025
  ([Consumer Data Standards v1.36.0, CX: Notification standards](https://consumerdatastandardsaustralia.github.io/standards/)).
- **Records:** Fiskil must keep "the processes by which the CDR representative asks CDR consumers for
  their consent … including a video of each process" (r9.3(2A)(k)), and records on Quillo's OSPs
  ((ka)). Records are kept for 6 years. Expect Fiskil to ask Quillo for a consent-flow video.

### 3.4 OSPs

- A provider in a **CDR outsourcing arrangement** must, by written contract with Quillo (r1.10(3)):
  - follow Fiskil's CDR policy on deletion;
  - comply with PS4, 6, 7, 8 and 9 as if it were Quillo;
  - "take the steps in Schedule 2 … as if it were an accredited data recipient";
  - use and disclose only under the contract;
  - delete and return data on direction, including a direction from Fiskil (r1.10(3)(b)(v)(C)).
- **Is hosting a "disclosure"?** OAIC Chapter B says passing data to a cloud provider is a use, not a
  disclosure, "only if the data remains encrypted at all times, and the third party does not hold or
  have access to the decryption keys". Otherwise "a CDR outsourcing arrangement would be required"
  ([OAIC Privacy Safeguard Guidelines, Chapter B v5, "Use"](https://www.oaic.gov.au/__data/assets/pdf_file/0009/111141/V5-Chapter-B-Key-concepts.pdf)).
  Cloudflare Workers and D1 process plaintext, and Bedrock receives plaintext prompts, so **both are
  disclosures and both need CDR outsourcing arrangements.** Neither vendor's standard self-serve
  terms or DPA are written as one. Whether a click-through agreement plus an addendum can carry the
  required provisions is the central counsel question (C7).
- **PS8:** neither provider is accredited, so the usable exception is "reasonable steps" by the
  discloser ([`docs/cdr-ps8-findings.md`](../cdr-ps8-findings.md), #474). The principal is liable for
  an OSP's PS8 breach (rep-principal guide §3.2.4.2, fn 36).
- **Regulator expectations of Fiskil:** require written approval before the representative engages an
  OSP. Consider limiting or banning *indirect* OSPs. Keep its CDR policy listing every OSP (rep-principal
  guide §3.2.2 and §3.2.4.2). **Cloudflare's and AWS's own sub-processors are indirect OSPs.** Expect
  Fiskil to ask about them.

### 3.5 Insurance and attestation

- **Insurance:** no statutory insurance obligation applies to a representative; that obligation
  belongs to the accredited person. But the regulators list "ensuring the CDR representative has
  adequate insurance … (e.g., … some combination of professional indemnity and cyber coverage)" as
  expected due diligence (rep-principal guide §3.2.1), and Fiskil's checks ask for it. **Plan for a
  cyber policy, plus professional indemnity if the broker recommends it.**
- **Fit and proper:** not a rule for representatives (r1.9 does not apply). The regulators still
  "expect CDR representative principals will assess their CDR representatives against similar
  criteria". Suggested checks:
  - ASIC banned and disqualified register;
  - OAIC privacy determinations;
  - AFCA determinations;
  - referee or police checks on directors;
  - an internet red-flag search;
  - **confirmation that Quillo is not already another principal's representative** (rep-principal
    guide §3.2.1). The Basiq attempt never produced an arrangement, but say so explicitly.
- **Attestation:** none is owed to the regulator. Expect Fiskil to require:
  - a signed self-assessment, or attestation of Schedule 2 compliance, at onboarding;
  - "regular attestations" of deletion afterwards (Fiskil CDR policy);
  - periodic compliance reports and audits (rep-principal guide §3.2.4: a program that relies only on
    self-assessment "is unlikely" to be enough).

### 3.6 Timelines

| Step | Time | Source |
|---|---|---|
| Fiskil onboarding after the questionnaire is submitted | 4–8 weeks | Fiskil CDR accreditation page |
| Fiskil notifies the Accreditor that it has entered the arrangement | ≤ 5 business days | r5.14(3)–(4) |
| Collection may start | only after Quillo is entered on the Register | r1.10AA(1)(c) |
| Withdrawal by a method other than the dashboard takes effect | ≤ 2 business days | r4.20J(5)–(6) |
| Consent maximum | 12 months | r4.20F(1), r4.20K(1)(c) |
| "Still current" notice | every 90 days of inactivity | r4.20U |
| ACSC incident report | as soon as practicable, ≤ 30 days | Sch 2 cl 1.7(3)(c) |
| Breach notification to Fiskil | contractual; unknown (the plan assumes 24h) | owner-tasks C9 |

## 4. OSP acceptability: Bedrock `au.` and Cloudflare

| Question | AWS Bedrock `au.` | Cloudflare Workers / DO / D1 / R2 |
|---|---|---|
| Where CDR data is processed | ap-southeast-2 (Sydney); the `au.` profile stays in AU regions. Live 2026-10-22, `npm run probe:bedrock` 5/5 including the CDR-tainted refusal (#641) | Global edge for Workers. D1's primary location was set at creation and is **unconfirmed**. `locationHint: "oc"` is a latency hint, not a residency guarantee ([cdr-data-environment.md](../security/cdr-data-environment.md)) |
| Incorporation (the PS8 entity question) | US parent | US (Cloudflare, Inc.) |
| Is it a disclosure (OAIC Ch B)? | Yes: plaintext prompts | Yes: plaintext processing and storage |
| Assurance Fiskil can be shown | SOC 2, ISO 27001, IRAP via AWS Artifact (not yet downloaded) | SOC 2 Type II, ISO 27001 via dashboard → Compliance (not yet downloaded) |
| Training on inputs | Bedrock does not train on inputs or share them with model providers (osp-register) | n/a |
| CDR outsourcing arrangement terms (r1.10(3)) | Not in place. AWS Customer Agreement + DPA only | Not in place. Self-Serve Subscription Agreement + DPA only |
| Consent-screen disclosure (r4.20E(3)(k)) | Name it, say why; processed in AU | Name it; **United States** if treated as overseas |
| Verdict | **Likely acceptable** once the contract terms and Fiskil's written approval exist. The strongest residency story | **Acceptable in principle** (the ACCC allows third-party infrastructure; another Fiskil representative publicly lists Cloudflare Workers, per [bank-feed-provider-options.md](../bank-feed-provider-options.md), not re-verified here). It needs the D1 location confirmed and recorded, counsel's PS8 position, and the contract terms |

Evidence Fiskil will expect for each OSP:

- the vendor's SOC 2 / ISO 27001 reports;
- a mapping of which Schedule 2 Part 2 controls the vendor performs, assessed under Quillo's controls
  program (infosec guidelines §8.2.2);
- the data location;
- the contract clause for incident reporting;
- the deletion-on-direction mechanism;
- the list of the vendor's own sub-processors (indirect OSPs).

The [OSP register](../security/osp-register.md) already has the shape for this; it needs the
attestation dates, the D1 location and the contract column filled in.

**Clerk and Stripe** receive no CDR data, so they are not CDR OSPs. Disclose them as ordinary
sub-processors (#702).

## 5. Gap table

Status: **met** = live with evidence today · **partial** = built or drafted but needs a switch, a
sign-off or a confirmation · **gap** = not started or not possible yet. Owner: **agent** = code or docs
an agent can do · **owner-off-platform** = only the director can do it (accounts, money, signatures,
third parties, lawyer).

Matrix drift found during this research: PR #686 turned **ON** `cdr_expiry_delete`,
`cdr_inactive_user_delete` and `redact_statement_lines` (`wrangler.toml` `FEATURES`), but
[control-matrix.md](../security/control-matrix.md) (last reviewed 2026-10-17) still lists them as
switches. The rows below use the live state.

### 5.1 Fiskil process

| Requirement | Status | Owner | Evidence link |
|---|---|---|---|
| Console application and company profile | gap | owner-off-platform | [questionnaire-answers.md §1–2](../security/questionnaire-answers.md), [owner-tasks.md C9](../security/owner-tasks.md) |
| Security questionnaire submitted | gap: answer bank drafted (v0.1), not re-fitted to Fiskil's form | owner-off-platform (submit); agent (re-fit once the form arrives) | [questionnaire-answers.md](../security/questionnaire-answers.md) |
| Fit and proper: police check; ASIC, OAIC and AFCA searches; not another principal's representative | gap | owner-off-platform | [owner-tasks.md C4](../security/owner-tasks.md), [training-and-screening-record.md §2](../security/training-and-screening-record.md) |
| Prior information security audit | gap: none; automated scanning only | owner-off-platform (buy) | [questionnaire-answers.md §3](../security/questionnaire-answers.md) |
| Cyber insurance (plus PI per the ACCC guide) | gap | owner-off-platform | [owner-tasks.md C5](../security/owner-tasks.md), [questionnaire-answers.md §4](../security/questionnaire-answers.md) |
| Consent UI: branding, 12 months, purpose text, accounts + transactions only | partial: decided, not configured in the Console | owner-off-platform | [bank-feed-golive-checklist.md §2](../bank-feed-golive-checklist.md) |
| Data minimisation strategy | partial: core built; `bank_minimisation` OFF | agent (flag flip after owner OK) | [control-matrix.md 1.5(1)(b)](../security/control-matrix.md), `src/lib/minimise.ts` |
| Deletion and de-identification processes | partial: withdrawal, expiry and inactive end-user deletion live (#576, PR #686); retention cron OFF; derived leftovers wait on #524 | agent (flag); owner-off-platform (#524 ruling) | `src/lib/bank-consent.ts`, [data-handling.md §5](../security/data-handling.md) |
| Testing of data-management compliance | met | agent | `scripts/check-units.ts` (consent lifecycle, expiry, inactive, non-prod guard, pfts8b, pft10) |
| Data-sovereignty-compliant storage | partial: inference AU-only; D1 location unconfirmed; PS8 needs counsel | owner-off-platform | [osp-register.md §1](../security/osp-register.md), [cdr-ps8-findings.md](../cdr-ps8-findings.md) |
| Developer checklist (errors, retries, IDs, end-user deletion, pagination) | met in code; final production E2E pending | agent (E2E after approval) | `src/lib/fiskil.ts` (PR #631), [bank-feed-golive-checklist.md §3](../bank-feed-golive-checklist.md) |

### 5.2 Schedule 2 (r1.10AA(4)(b))

| Requirement | Status | Owner | Evidence link |
|---|---|---|---|
| Part 1 governance pack adopted (1.3–1.7) | partial: drafted (PR #667), not signed | owner-off-platform | [information-security-policy.md](../security/information-security-policy.md) |
| First cycles run: annual review, boundary review, quarterly access review 1(d), tabletop 1.7(4) | gap | owner-off-platform | [control-matrix.md Part 1](../security/control-matrix.md) |
| cl 1.6(4) independent testing | gap | owner-off-platform (engage a tester) | [vulnerability-management.md §6](../security/vulnerability-management.md) |
| Control 4: regular vulnerability scanning | met: CodeQL, Dependabot, secret scanning, weekly ZAP, `npm audit` | agent | `.github/workflows/zap-baseline.yml`, `.github/workflows/codeql.yml` |
| Control 4: **penetration testing** (required by the rule text) | gap | owner-off-platform (buy); agent (scope and remediate) | [control-matrix.md 4(c)](../security/control-matrix.md) |
| 1(a) MFA on every access path; Clerk production instance | partial: admin MFA gate built, `admin_mfa_required` OFF; prod still on the Clerk development instance | owner-off-platform (C1, cutover); agent (flip flag) | [clerk-production-cutover.md](../security/clerk-production-cutover.md) |
| 1(c) audit logging, retained 6 years | partial: `audit_log` and `cdr_audit_log` live; Workers Logs keep days, not years (no ticket) | agent | `schema.sql`, [control-matrix.md 1(c)](../security/control-matrix.md) |
| 1(i) encryption in transit, 1(g) unique IDs, 2(c) hardening, 4(b) secure coding | met | agent | [control-matrix.md](../security/control-matrix.md) rows 1(i), 1(g), 2(c), 4(b) |
| 2(a) encryption at rest and backups | partial: needs secrets `D1_EXPORT_TOKEN` and `QBO_TOKEN_KEY`, then flags `d1_backups` and `qbo_token_fail_closed` | owner-off-platform (create tokens); agent (flags) | [backup-dr.md](../security/backup-dr.md), [secrets-and-encryption.md](../security/secrets-and-encryption.md) |
| 2(e) data segregation | partial: built and tested; no production CDR data yet | agent | `migrations/0075_bank_connections.sql`, `migrations/0077_profiles_cdr_tainted.sql` |
| 1(e), 2(b), 2(d), 3(a), 5(a)–(c) endpoint hardening | gap | owner-off-platform (C2) | [endpoint-standard.md](../security/endpoint-standard.md) |
| 6(a) training, 6(b) acceptable use, 6(c) police check | gap (6(b) drafted) | owner-off-platform (C3, C4) | [training-and-screening-record.md](../security/training-and-screening-record.md), [acceptable-use.md](../security/acceptable-use.md) |
| 1.7 incident response: Fiskil's notification window, uptime monitor | partial: plan drafted; window unknown; C8 not done | owner-off-platform | [incident-response-plan.md](../security/incident-response-plan.md), [owner-tasks.md C8–C9](../security/owner-tasks.md) |
| 1.6(2) monitoring of controls | partial: dashboard live; `security_monitoring` OFF | agent | `src/lib/security-dashboard.ts` |

### 5.3 OSPs

| Requirement | Status | Owner | Evidence link |
|---|---|---|---|
| OSPs permitted by the representative arrangement, with Fiskil's written approval (r1.10AA(3)(b)) | gap | owner-off-platform (#702) | [osp-register.md](../security/osp-register.md) |
| CDR outsourcing arrangement with Cloudflare and AWS containing the r1.10(3) provisions | gap: standard DPAs only; needs counsel | owner-off-platform (C7) | this note §3.4; [OAIC Ch B "Use"](https://www.oaic.gov.au/__data/assets/pdf_file/0009/111141/V5-Chapter-B-Key-concepts.pdf) |
| OSP assurance reports on file, and OSP-performed controls assessed in Quillo's controls program | gap: attestations not downloaded; no control-to-vendor mapping | owner-off-platform (download); agent (mapping) | [owner-tasks.md "Download attestations"](../security/owner-tasks.md) |
| D1 location confirmed and recorded | gap | owner-off-platform (dashboard check) | [cdr-data-environment.md §4](../security/cdr-data-environment.md) |
| PS8 position for US-incorporated OSPs | partial: Option A analysed; counsel pending | owner-off-platform (C7) | [cdr-ps8-findings.md](../cdr-ps8-findings.md), #474 |
| AU-only inference for CDR data | met: Bedrock `au.` live, probe 5/5, CDR-tainted refusal tested | agent | `src/llm.ts`, #641 |
| Fiskil's CDR policy lists Quillo's OSPs (r7.2(4)(f)–(g)) | gap: wording drafted | owner-off-platform | [osp-register.md §3](../security/osp-register.md) |
| Indirect OSPs (vendor sub-processors) identified | gap | agent (list from vendor pages) | none yet |

### 5.4 Consent, dashboard and CX (Div 4.3A, CX standards)

| Requirement | Status | Owner | Evidence link |
|---|---|---|---|
| r4.20E(3) consent-time information: representative status, Fiskil name and accreditation number, OSPs and countries, redundant-data statement, withdrawal statement | gap: not in Quillo's UI; unknown whether Fiskil's hosted UI shows it | owner-off-platform (confirm with Fiskil); agent (pre-consent screen fallback) | `web/src/components/` (no matches for an accreditation number) |
| Link to Fiskil's CDR policy (r4.20E(3)(j), r7.2(8)) | met | agent | `web/src/components/CdrPolicyLink.tsx` (PR #667) |
| Consumer dashboard (r1.14 via 1.14(5)) and informing the principal of changes (r4.20T) | partial: Settings › Bank connections built (#576); who provides the dashboard not agreed | owner-off-platform (agree with Fiskil); agent (gap-check against r1.14(3)) | `web/src/components/BankConsents.tsx`, [ADR-0003 §6.4](../adr-0003-bank-feed-cdr-access.md) |
| Alternative withdrawal method and 2-business-day effect (r4.20J(3), (6)) | partial: in-app withdrawal is immediate; no stated CDR withdrawal-by-email route or SLA | agent (copy and process) | `src/marketing/legal.ts` (general privacy contact only) |
| CDR receipts (r4.20O, CX standards) | gap: Fiskil sends a consent confirmation email; unconfirmed whether it meets the standard for the representative's consent | owner-off-platform (confirm); agent (fallback) | [fiskil.com/consumers](https://www.fiskil.com/consumers) |
| 90-day "still current" notices (r4.20U) | gap: only a 30-day pre-expiry in-app reminder exists | agent | `src/lib/bank-consent.ts` (`EXPIRY_REMINDER_DAYS = 30`) |
| Written notice when a collection consent expires and the use consent is current (r4.20Q) | gap: expiry deletes data, but no out-of-dashboard notice | agent | `src/lib/bank-consent.ts` (`consentLifecycle`) |
| Consent-flow video for Fiskil's r9.3(2A)(k) records | gap | owner-off-platform (record after the Console UI is configured) | none yet |

### 5.5 Contract and governance

| Requirement | Status | Owner | Evidence link |
|---|---|---|---|
| Representative agreement signed, including adopting Fiskil's CDR policy (r1.10AA(4)(f)) | gap | owner-off-platform (C7) | [control-matrix.md r1.10AA(4)(f)](../security/control-matrix.md) |
| Deletion on the principal's direction, with records (r1.10AA(4)(e)) | met: mechanism live; runbook drafted | agent | [data-handling.md §5.4](../security/data-handling.md) |
| Complaints: first-line handling and timeframes | gap: unknown | owner-off-platform (ask Fiskil) | [questionnaire-answers.md §15](../security/questionnaire-answers.md) |
| Ongoing deletion attestations and compliance reports to Fiskil | gap: no template | agent (template from `cdr_audit_log`) | [Fiskil CDR policy](https://www.fiskil.com/legal/cdr-policy) |

## 6. Top gaps, in order of how likely each is to block approval

1. **OSP contracts and approval:** the CDR outsourcing arrangement terms with Cloudflare and AWS, plus
   Fiskil's written OK. *Owner off-platform, needs counsel.* The OAIC "use vs disclosure" test means
   plaintext hosting needs a real CDR outsourcing arrangement, and click-through terms may not be one.
   This is the hardest item and the subject of #702.
2. **Penetration test and independent testing (cl 1.6(4), control 4).** *Owner off-platform: buy a
   scoped external test of app.quillo.au and the bank-feed paths.* Required by the rule text. One
   engagement can cover both clauses.
3. **Cyber insurance and fit-and-proper evidence.** *Owner off-platform.* Fiskil's checks ask for both
   by name.
4. **Division 4.3A consent-time disclosures and notifications** (OSP names and countries, accreditation
   number, receipts, 90-day and r4.20Q notices). *Mixed:* the owner confirms with Fiskil what the
   hosted UI and emails already cover; an agent builds what is left. This is the only large gap that
   is mostly code.
5. **Owner-only Schedule 2 controls:** MFA everywhere and the Clerk production cutover, laptop
   hardening, training, police check, signing the pack, and running the first access review and
   tabletop. *Owner off-platform.* These are 20+ matrix rows, each cheap but none done.

Smaller agent-side items:

- Update the control matrix for PR #686 and reframe row 4(c).
- Workers Logs retention against the 6-year expectation.
- Flip `bank_minimisation`, `security_monitoring` and `admin_mfa_required` once their preconditions hold.
- List the indirect OSPs.
- Write a deletion-attestation template.

## 7. Open questions for Fiskil (feed #702; the owner sends them)

1. Which questionnaire do you use: your own, the ACCC sponsored self-assessment form, or another?
   Do you require a penetration test report, and of what scope?
2. Will you permit Cloudflare and AWS (ap-southeast-2) as Quillo's OSPs? What contract terms do you
   require us to hold with them? Do you prohibit indirect OSPs?
3. Does your hosted consent UI show the r4.20E(3) items for a representative, including OSPs and their
   countries? Do your emails meet the r4.20O receipt and r4.20U 90-day standards for our consents?
4. Do you provide the consumer dashboard, or do you want Quillo to provide it under r1.14(5)?
5. What is your breach-notification window, and who handles CDR complaints first?
6. What insurance cover and limits do you expect?

## Sources

- CDR Rules, compilation of 2025-03-04: <https://www.legislation.gov.au/F2020L00094/latest/text>. Rules cited: 1.10, 1.10AA, 1.14, 1.16, 1.16A, 4.20B–4.20U, 5.14, 9.3, Sch 1 cl 2.1, Sch 2.
- ACCC/OAIC, *Guidance for CDR representative principals on ensuring compliance of their CDR representatives*, v2, January 2025: <https://www.cdr.gov.au/sites/default/files/2025-01/CDR-guidance-for-CDR-representative-principals-on-ensuring-compliance-of-their-CDR-representatives-published-15-January-2025.pdf>
- ACCC, *Supplementary accreditation guidelines: information security*, v6, April 2025: <https://www.cdr.gov.au/sites/default/files/2025-04/CDR-Supplementary-Accreditation-Guidelines-Information-Security-version-6-April-2025.pdf>
- OAIC, *CDR Privacy Safeguard Guidelines, Chapter B: Key concepts*, v5, November 2023: <https://www.oaic.gov.au/__data/assets/pdf_file/0009/111141/V5-Chapter-B-Key-concepts.pdf>
- OAIC, *CDR representative model: privacy obligations of a CDR representative*: <https://www.oaic.gov.au/consumer-data-right/consumer-data-right-guidance-for-business/privacy-obligations/cdr-representative-model-privacy-obligations-of-a-cdr-representative>
- Consumer Data Standards v1.36.0 (CX notification standards): <https://consumerdatastandardsaustralia.github.io/standards/>
- Fiskil go-live checklist: <https://docs.fiskil.com/data-api/guides/resources/go-live-checklist>
- Fiskil CDR accreditation paths: <https://www.fiskil.com/grow/banking-api/open-banking-au/cdr-accreditation>
- Fiskil CDR policy: <https://www.fiskil.com/legal/cdr-policy>
- Fiskil security: <https://www.fiskil.com/security>
- Fiskil consent management: <https://www.fiskil.com/grow/banking-api/open-banking-au/consent-management>
- Fiskil consumers page: <https://www.fiskil.com/consumers>
- Fiskil blog, *How do I become a CDR representative?* (31 Jul 2021): <https://blog.fiskil.com/how-to-become-a-cdr-representative>

Not found in public sources: Fiskil's actual questionnaire, any minimum insurance limits, a
pen-test scope, and a published approval timeline beyond "4-8 weeks". Those are questions 1–6 in §7.
