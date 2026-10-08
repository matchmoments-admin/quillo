# Owner tasks (Workstream C)

> Things only the director can do. Each closes rows in [control-matrix.md](control-matrix.md). Tick the box,
> write the date, and update the matrix row's status. Order follows the plan's sequencing: **week 1** C1,
> C2, C3, C6, C8 and the C9 questions; **week 3** C4, C5, C7; **exit** C9 submission once every matrix row
> is ✅. Version 0.1, 2026-10-08.

## C1 — MFA on every account (control 1(a), 1(h))

Use a **passkey** or hardware key where offered, otherwise an authenticator app (1Password, Google
Authenticator, Authy). Save recovery codes in the password manager. Record each in
[access-control-standard.md §2](access-control-standard.md#2-multi-factor-authentication).

- [ ] **Cloudflare:** dash.cloudflare.com → My Profile → Authentication → Two-Factor Authentication / Security keys. Then Manage Account → Members: confirm you are the only member. — date: ____
- [ ] **GitHub:** github.com/settings/security → Two-factor authentication (+ Passkeys). Then org/repo settings: require 2FA. — date: ____
- [ ] **AWS root:** console → account menu → Security credentials → Assign MFA device (passkey/security key). Then stop using root. — date: ____
- [ ] **AWS IAM user(s):** IAM → Users → (you) → Security credentials → Assign MFA. Delete unused access keys. — date: ____
- [ ] **Clerk dashboard:** dashboard.clerk.com → user menu → Manage account → Security → Two-step verification. — date: ____
- [ ] **Fiskil Console:** console.fiskil.com → profile/security → enable MFA (ask Fiskil if not visible). — date: ____
- [ ] **Stripe:** dashboard.stripe.com → Settings → Personal details → Two-step authentication (passkey). — date: ____
- [ ] **Google / Gmail:** myaccount.google.com/security → Passkeys and 2-Step Verification. — date: ____
- [ ] **Domain registrar (quillo.au):** registrar account security → 2FA; also turn on registrar lock. — date: ____
- [ ] **Basiq dashboard** (sandbox): enable 2FA, or delete the account and the `BASIQ_API_KEY` secret now Basiq has declined. — date: ____
- [ ] Also: Intuit Developer, Anthropic Console, Google Cloud, password manager. — date: ____

## C2 — Laptop hardening (controls 1(e), 2(a), 2(b), 2(d), 5(a), 5(c))

Follow [endpoint-standard.md](endpoint-standard.md) items E1–E13 and fill in its verification record.
Quick version:
- [ ] FileVault on; recovery key in password manager (`fdesetup status`).
- [ ] Automatic updates all on, including Security Responses.
- [ ] Firewall on, stealth mode.
- [ ] Screen lock immediately; display off ≤ 5 min.
- [ ] Create a separate admin account; make your daily account **Standard**.
- [ ] Password manager holds every Quillo credential and recovery code.
- [ ] XProtect up to date (comes with updates); optional Malwarebytes free scan.
- [ ] Gatekeeper: App Store and identified developers.
- [ ] Find My Mac on.
- [ ] Delete any local copies of production data (Downloads, Desktop, exports).

## C3 — Security training (control 6(a))

- [ ] Work through the ACSC small-business material: https://www.cyber.gov.au/small-business-hub and the
      Small Business Cyber Security Handbook.
- [ ] Read OAIC: Notifiable Data Breaches (https://www.oaic.gov.au/privacy/notifiable-data-breaches) and CDR
      Privacy Safeguard Guidelines ch. 8 and 12.
- [ ] Read this pack end to end; sign the policy (§7) and the acceptable use policy.
- [ ] Record dates in [training-and-screening-record.md §1](training-and-screening-record.md#1-security-and-privacy-training).

## C4 — National police check (control 6(c))

- [ ] Order a national police check from an ACIC-accredited body (list via
      https://www.acic.gov.au/services/national-police-checking-service). Typical cost A$40–50, 1–3 days.
- [ ] Optional for "fit and proper": AFSA NPII bankruptcy search; ASIC banned/disqualified register.
- [ ] Record date and reference (not the certificate) in [training-and-screening-record.md §2](training-and-screening-record.md#2-background-screening).

## C5 — Cyber-insurance quote (Fiskil asks)

- [ ] Ask a broker or insurer for small-business cyber cover (first-party incident response, data
      restoration, business interruption, third-party privacy liability, regulatory defence). Mention CDR
      data, ~[N] users, read-only bank data, Cloudflare/AWS hosting.
- [ ] Record the quote/policy in [questionnaire-answers.md §4](questionnaire-answers.md#4-cyber-insurance) and
      add the insurer's breach hotline to the incident plan contacts.

## C6 — Bedrock use-case form (Sydney + Melbourne)

- [ ] AWS console → Amazon Bedrock (region **ap-southeast-2**) → Model access / model catalog → Anthropic
      → submit the use-case details form. Repeat in **ap-southeast-4**.
- [ ] Enable the Claude Haiku model used by `bedrockModelIdFor` (`au.` inference profile).
- [ ] Tell the coordinator so #641 (live residency verification) can run.

## C7 — Lawyer

Book an Australian privacy/CDR lawyer for:
- [ ] The CDR representative agreement with Fiskil (incl. adopting Fiskil's CDR policy, deletion
      directions, OSPs permitted under r1.10AA(3)(b)).
- [ ] The PS8 position for Cloudflare and AWS ([`docs/cdr-ps8-findings.md`](../cdr-ps8-findings.md)
      Option A) and the D1 data location.
- [ ] Written OSP approvals from Fiskil (Cloudflare, AWS).
- [ ] Review of the privacy policy and terms pages (`src/marketing/legal.ts`), including the APP-entity /
      small-business-exemption question for NDB.
- [ ] Name the lawyer as incident contact in [incident-response-plan.md §2](incident-response-plan.md#2-roles-solo-founder).

## C8 — Uptime monitor

- [ ] Create a free UptimeRobot (or Better Stack) HTTP monitor for `https://app.quillo.au/healthz`, 5-minute
      interval, alert contact **brendan@quillo.au**.
- [ ] Record it in the incident plan detection sources.

## C9 — Fiskil Console

- [ ] Complete the application and company profile (answers in
      [questionnaire-answers.md §1–2](questionnaire-answers.md#1-business-and-use-case)).
- [ ] Customize UI: Quillo branding (production look), **12-month** consent, **accounts + transactions**
      only, purpose text from [`docs/bank-feed-golive-checklist.md`](../bank-feed-golive-checklist.md) §2.
- [ ] Ask Fiskil:
  - [ ] for the security questionnaire (to fit [questionnaire-answers.md](questionnaire-answers.md));
  - [ ] the **breach-notification window** (plan assumes 24h; update the incident plan);
  - [ ] the incident/security contact;
  - [ ] acceptance of **Cloudflare and AWS as OSPs** (in writing);
  - [ ] whether CDR complaints are first-line Quillo's or Fiskil's;
  - [ ] confirmation that Fiskil's hosted consent UI covers the rule 4.20B–4.20U consent, receipt and
        notification obligations.
- [ ] Submit the questionnaire **after** Workstreams A and B are green (every matrix row ✅).

## Other owner decisions raised by this pack

- [ ] **Independence (cl 1.6(4)):** annual independent reviewer, a pen test, or accept and disclose
      ([vulnerability-management.md §6](vulnerability-management.md#independence-gap-cl-164)).
- [ ] **Penetration test (control 4(c)):** buy one only if Fiskil requires it.
- [ ] **Backup contact:** name a trusted person and give them sealed break-glass instructions
      ([information-security-policy.md §3](information-security-policy.md#3-roles-and-responsibilities)).
- [ ] **Confirm the D1 location** in the Cloudflare dashboard and record it in
      [cdr-data-environment.md §4](cdr-data-environment.md#4-boundary) and [osp-register.md](osp-register.md).
- [ ] **Download attestations:** Cloudflare SOC 2 / ISO 27001 (dashboard → Compliance documents) and AWS
      (AWS Artifact) into a private folder; note the dates in the OSP register.
- [ ] **Adopt the pack:** sign [information-security-policy.md §7](information-security-policy.md#7-approval)
      and [acceptable-use.md](acceptable-use.md); run the first quarterly access review and the first
      tabletop test.
