# How can a Quillo user get their return lodged?

> Findings for wayfinder research ticket #786 on map #692. Researched 2026-10-24 against primary
> sources: apiportal.ato.gov.au, softwaredevelopers.ato.gov.au, ato.gov.au, my.gov.au, tpb.gov.au
> and the Chrome Web Store policies. Each page was fetched directly unless marked **[snippet]**,
> which means only a search-result summary was seen. This builds on
> [`docs/first-timer/lodgement-routes.md`](../first-timer/lodgement-routes.md) (#530: who can
> lodge, plus the SBR IITR initiating-party table) and
> [`docs/first-timer/standard-journeys.md`](../first-timer/standard-journeys.md) (#533: what
> competitors do), and does not repeat them. General information only. This is not legal or tax
> advice, and the TPB conclusions still need the lawyer review in #524.

## Verdict

**Nothing has changed since #530: no ATO channel lets a non-agent app lodge an individual return.**
The ATO API portal lists six products today, and none of them is an individual return or
individual prefill. The only machine channel for an individual return is SBR IITR, which the
Practitioner Lodgment Service runs on, and it accepts **a registered tax agent** as the only
initiating party. That covers reading prefill as well as submitting.

**Recommendation:**

- **Near term (this tax time onward): make the myTax self-lodge worksheet a "myTax mirror".**
  - Lay out one card per myTax screen, in myTax order, using myTax's own labels.
  - Give every field a copy button, a tick-off checkbox, and a "check this matches prefill" line.
  - Persist progress, so the user can work with Quillo in one window and myTax in the other.
  - This sits entirely inside Quillo. It touches no ATO system and is free to the user. It keeps
    myTax's processing time ("most process in 12 business days").
  - It is mostly built already (Ship it, `web/src/pages/ShipIt.tsx`). This is a UX upgrade, not a
    new route.
- **Long term (paid convenience): a partner registered tax agent lodges through PLS.**
  - Quillo hands the agent a structured pack. The agent verifies the user's identity, reviews the
    return, takes the signed declaration and lodges.
  - The user pays the agent directly, as the owner decided in #542. This is how Etax and H&R Block
    deliver a one-button experience.
  - A later variant: Quillo becomes the agent's SBR-enabled software. This needs DSP OSF
    compliance, likely Category A, with independent ISO 27001 or IRAP certification.
- **Don't build:**
  - **A myTax-filling browser extension.** The myGov terms ban "any software, such as bots or
    scraper tools to access, monitor or copy myGov … or their contents" without written permission.
  - **A paper-return generator.** The official form has to be ordered from the ATO. Paper returns
    take about 50 business days, and the ATO steers business-income filers away from paper.
- **Quillo registering as a tax agent stays out of scope**, as concluded in #530.

## Comparison table

| # | Option | Feasible for Quillo | Effort | Cost | Risk | User experience | TPB / legal boundary |
|---|---|---|---|---|---|---|---|
| 1 | **myTax self-lodge with a "myTax mirror" worksheet** (copy buttons, tick-off, prefill check) | **Yes** (largely built) | S–M: UX work on Ship it | Build only. Free to the user | Low. The worksheet drifts when myTax labels change each year, which is the existing yearly maintenance | Good. Two windows, about 10–30 minutes of copying. The user does the typing and lodging. Most returns process in 12 business days | Inside TPB(GS) 14/2011 if the output stays non-customised and every figure is the user's own confirmed assertion (already analysed in `docs/concept-verdict-findings.md` §d) |
| 2 | **Partner registered agent lodges through PLS** (user pays the agent) | **Conditional**: needs a partner agent and an agreement | M: hand-off pack, consent and data-sharing flow, status back from the agent | The agent's fee to the user (benchmarks: Etax from A$87.49; H&R Block assisted A$109). Quillo takes no fee for the agent service | Medium. A partner dependency, a PII hand-off (APP 8 and the CDR scope if bank data flows), and referral disclosure | Best. One button, the agent reviews, and the user signs a declaration. The user also gets the agent's later lodgment-program due date if they are on the agent's books before 31 October | The agent provides the tax agent service. The agent must verify the client's identity (TPB(PN) 5/2022) and hold a signed declaration. Any referral commission must be disclosed (Code item 5). Lawyer review in #524 |
| 2b | **Quillo as the agent's SBR/PLS software** (the agent is the initiating party, Quillo is the DSP) | **Conditional**, long term | L: SBR IITR build and ATO conformance testing, plus every annual spec | DSP OSF: probably Category A, which means **independent ISO 27001 or IRAP certification**, onshore hosting, MFA, 12-month audit logs and annual review | Medium–high. Certification cost, yearly IITR schema churn, and becoming critical tax infrastructure | Same as 2, with the hand-off friction gone | Same as 2 (the agent lodges). Quillo becomes a DSP bound by the OSF and the ATO wholesale conditions of use |
| 3 | **Quillo lodges directly via an ATO API** as a self-lodger app | **No** | n/a | n/a | n/a | n/a | No such channel exists. The API portal has no individual return product, and SBR IITR is Tax agent: Y, everyone else: N |
| 4 | **Export file the user uploads to myTax** | **No** | n/a | n/a | n/a | n/a | myTax's only imports are ATO prefill and the ATO app's own myDeductions upload. No third-party file import exists |
| 5 | **Paper return**: Quillo produces a NAT 2541 item-by-item transcription sheet for the official form the user orders | **Conditional**: possible as a transcription sheet, but not a substitute form | S | Build only. The form is free from the ATO Publications Ordering Service | Medium. A mis-keyed paper form gets slow correction, and the user pays postage | Poor. The form must be ordered from the ATO (no current-year download). Most paper returns process in 50 business days. The ATO asks business/PSI/trust filers (Q13–16) to lodge online | Same as option 1. Quillo should **not** render a look-alike ATO form (risk of impersonating a government form; the scanned-form rules are unverified) |
| 6 | **Browser extension that fills myTax** while the user watches (no credentials, no submit) | **No** (not without written permission from Services Australia/ATO) | M to build, then ongoing work every time myTax's DOM changes | Build and maintenance. Chrome Web Store review | **High.** It breaches the myGov terms. The ATO can lock or suspend accounts "for any reason". It is liable for mis-mapped fields because the user is deemed responsible for "everything that is done" on the account. It is fragile against DOM changes. ATO usage monitoring | Slick when it works. When it silently breaks, the user lodges wrong figures | It adds "preparing the return" inside the ATO system, so the TPB question gets sharper (lawyer). It also needs Chrome's Limited Use and disclosure policies for financial data |
| 7 | **Quillo registers as a company tax agent** | Not now (out of scope in #530) | XL | Supervising registered agents on payroll, PI insurance, Code compliance, DSP OSF | High: Quillo becomes a tax practice | Best | Removes the boundary, but every output then carries agent liability |

## Findings by question

### 1. The ATO API portal and software-developer requirements

**What the API portal offers.** The [API products page](https://apiportal.ato.gov.au/api-products)
lists six Active products:

- SMSF Alias Lookup
- Health Check
- Stapled Super Fund
- OAuth Dynamic Client Registration
- Global and Domestic Minimum Tax (lodging a multinational's return)
- Property Settlement Service (GST property settlement forms)

**None of them is an individual income tax return or individual prefill.** The portal's roadmap
points at entities, not individuals. The ATO's options paper says it "will offer a
**non-individual** prefill API via the API Portal, with delivery targeted for Tax Time 2027",
covering company, trust and partnership returns
([Non-individual prefill API options, June 2026](https://softwaredevelopers.ato.gov.au/sites/default/files/2026-06/Non-individual_prefill_API_options.pdf)).

**The onboarding steps.** The [Getting started](https://apiportal.ato.gov.au/getting-started) page
lists four:

1. Register a portal account, a Team and a Team application.
2. Complete the security questionnaire.
3. Develop and test.
4. Request production access.

Transport must be "TLS 1.3 to securely transact with ATO systems".

**Individual returns run on SBR, not the API portal.** The SBR IITR service accepts a **Tax agent**
as the only initiating party for `IITR.get` (prefill), `IITR.validate` and `IITR.submit`. BAS
agents, businesses and intermediaries are all *N*. It also states: "The tax practitioner to
taxpayer relationship is a fundamental precondition to interacting with SBR for all IITR
interactions"
([ATO_IITR.0012 2025 BIG](https://www.sbr.gov.au/sites/default/files/2025-04/ATO_IITR.0012_2025_Business_Implementation_Guide.docx),
verified in #530).

**PLS is the agents' channel.** The ATO describes the Practitioner Lodgment Service as "our main
electronic lodgment channel for tax and BAS agents". To use it, an agent must:

- buy SBR-enabled software from a DSP;
- "add new clients to your client list before lodging", or "your software will be unable to
  verify your link to the client";
- authenticate through the DSP's hosted credential (cloud software) or a RAM machine credential
  ([ATO: Practitioner lodgment service](https://www.ato.gov.au/tax-and-super-professionals/digital-services/practitioner-lodgment-service)).

The ATO doesn't comment on DSP pricing. I found no ATO access fee for DSPs.

**Self-lodgment through software is not possible.** The ATO's own list of ways to lodge
([How to lodge your tax return](https://www.ato.gov.au/individuals-and-families/your-tax-return/how-to-lodge-your-tax-return))
has three: myTax ("most process in 12 business days"), a registered tax agent ("they are the only
people that can charge a fee") and paper. It offers no software self-lodge route.

**DSP Operational Security Framework.** This is what Quillo would face under option 2b, as DSP to a
partner agent. Source: [Requirements for products and services](https://softwaredevelopers.ato.gov.au/RequirementsforDSPs)
and [Further guidance on requirements](https://softwaredevelopers.ato.gov.au/operational_framework/further-guidance-requirements).

The requirements depend on the category:

- **Category A**: DSP-controlled SaaS with more than 10,000 unique client records on low-to-high
  risk APIs, or a sending service provider.
- **Category B**: medium-to-high risk APIs with fewer than 10,000 records.
- **Category C**: low risk APIs with fewer than 10,000 records, or no-risk APIs.
- Categories D and E cover client-controlled and in-house software.

A cloud product serving a partner agent's IITR lodgments would be **A** at scale, or **B** at
launch. I didn't find the IITR service's risk rating, so this is inferred.

| Control | Category A | Category B | Category C |
|---|---|---|---|
| Certification | "Independent certification against either iRAP (ISM) or ISO/IEC 27001" | Independent certification **or self-assessment** against ISM, ISO 27001/27002/27017 or NIST CSF | Independent certification or self-assessment against the above, plus SOC 2 or **OWASP ASVS** |
| Data hosting | "onshore by default, offshore hosting arrangements, including redundant systems are managed by exception only" | Same | Same |
| MFA | Mandatory for all staff and end users with access to tax information. "MFA must be permanent and cannot be disabled by the client". Inactive-session timeout of 30 minutes at most (15 preferred). "Remember me" under 24 hours. Lockout after 5 or fewer failed attempts. No shared logins. Social-media logins not accepted for MFA (authenticator apps are) | Same | Same |
| Audit logging | Logs of access and events, including privilege changes. Each user and session uniquely identifiable. Kept "a minimum of 12 months" | Same | Same |
| Encryption | At rest (disk, container, application or database level) and in transit (TLS 1.3 minimum), per the ISM cryptography guidelines. Key-management/PKI policy | Same | Same |
| Other | Entity validation ("users … are legitimate businesses"), personnel security, security monitoring at the network, application and transaction layers, a supply-chain overview, controls on third-party add-ons, and an **annual review** (a self-assessment stays current for 2 years) | Same | Same |

Compared with where Quillo is today:

- **Already met or partly met:**
  - D1/R2 are in the AU region, and Bedrock runs on the `au.` profile.
  - The hash-chained audit log exists.
  - Encryption at rest is Cloudflare's default.
- **Gaps:**
  - Clerk and Stripe are offshore sub-processors, which needs an OSF exception.
  - MFA would have to be permanent for every user. Today Quillo enforces MFA only on admin routes
    (`admin_mfa_required`, `src/api.ts`).
  - ISO 27001 or IRAP certification. Typical first-year cost is several tens of thousands of AUD.
    That is a market estimate, not from an ATO source.
  - The pen test scoped in `docs/security/pen-test-scope.md` (ASVS L2) would support a Category C
    self-assessment, but not Category A.

**Prefill/report APIs:** none exist for individuals outside the agent-only IITR (`IITR.get`). The
user's own prefill is visible only inside myTax.

### 2. Partnering with a registered tax agent who lodges through PLS

**How the market does it** (detail in `standard-journeys.md`; re-checked 2026-10-24 **[snippet]**):

- **Etax.** Etax Accountants Pty Ltd is itself the registered agent (TPB 69399005). It prefills
  from the ATO under its agent link, and "a registered tax agent reviews it before lodging, usually
  within one business day" ([about Etax](https://www.etax.com.au/about-etax/)).
- **H&R Block online.** DIY tiers, with escalation to an expert. H&R Block lodges as the agent.
- **Hnry.** The agent is the product (sole traders only).
- **AusTax AI.** Now a directory; its A$129 agent offer is withdrawn.
- **Taxopia and Tax Rabbit.** No current Australian consumer lodging product found under either
  name. The only Taxopia hit was a 2016 small-business forum post.
- **Taxfox and TaxTank.** Stay non-agents. They stop at a record pack and the user lodges.

Every app that lodges does it because the app **is**, or is owned by, a registered agent. No
pure-software app lodges.

**What a compliant partner model needs:**

1. **Identity verification by the agent.** Agents must verify a client's identity before providing
   services and on an ongoing basis, under TPB(PN) 5/2022 and the ATO's client verification
   methods (visual, source via ATO systems, or the DVS). Linking a client "does not override your
   obligations to undertake client proof of identity"
   ([TPB: client verification](https://www.tpb.gov.au/client-verification-process-tax-practitioners);
   [ATO: Agent client verification methods](https://www.ato.gov.au/tax-and-super-professionals/for-tax-professionals/your-practice/tax-and-bas-agents/agent-client-verification-methods))
   **[snippet]**. Quillo's Clerk identity can't stand in for this.
2. **Client list link.** The agent adds the user to their client list before lodging (PLS page,
   above). The user is then on the agent's books, which gives them the lodgment-program due date
   if this happens before 31 October.
3. **Signed declaration.** "Taxpayers must sign a declaration before you can file their tax
   return". PLS software may block lodgment until the declaration is recorded. Declarations can be
   stored electronically, and the client keeps a copy for up to 5 years
   ([ATO: Declarations required](https://www.ato.gov.au/tax-and-super-professionals/digital-services/practitioner-lodgment-service/practitioner-lodgment-service-user-guide/before-you-start-to-lodge/declarations-required-you-and-your-clients);
   [Client declarations and lodgment online](https://www.ato.gov.au/tax-and-super-professionals/for-tax-professionals/prepare-and-lodge/managing-your-lodgment-program/client-declarations-and-lodgment-online))
   **[snippet]**. E-signing can happen in the agent's portal, or in Quillo on the agent's behalf.
4. **Review and sign-off.** The agent is responsible for the return. Quillo's pack is input to the
   agent's own work, and the agent re-pulls prefill through `IITR.get`.
5. **Commercial terms.** Under the owner's #542 rule, **the user pays the agent directly**, so
   Quillo takes no fee tied to the tax agent service (TPB(GS) 45/2023: a fee "can be indirect or
   bundled"). A referral fee from the agent to Quillo is possible but must be disclosed by the
   agent under Code item 5 (TPB(GS) 24/2014), and it raises the open #524 question of whether
   Quillo's own service then becomes "for a fee or reward".
6. **Privacy and data flow.** Sending the pack is a disclosure of personal information. It needs
   explicit consent, and CDR-derived data has its own rules (Fiskil/CDR scope, #633). The cleanest
   v1 is a **user-downloaded or user-sent pack**: the user shares it with the agent themselves.

### 3. Export and paper paths

- **myTax import.** myTax takes only ATO prefill and the ATO app's **myDeductions** upload. That
  upload is made from the ATO app, once per financial year, and is final. Inside myTax the user
  picks *Get myDeductions* on Personalise return. myDeductions can also email a CSV *to a tax
  agent*, which is an export, not an import
  ([ATO: How to upload myDeductions data](https://www.ato.gov.au/online-services/online-services-for-individuals-and-sole-traders/ato-app/mydeductions/using-mydeductions/how-to-upload-mydeductions-data);
  [Tax professionals using myDeductions](https://www.ato.gov.au/online-services/online-services-for-individuals-and-sole-traders/ato-app/mydeductions/using-mydeductions/tax-professionals-using-mydeductions))
  **[snippet]**. I found no documented way for third-party software to write into myDeductions. So
  there is **no file a user can upload to myTax** that Quillo could produce.
- **The paper return.** You need the *Individual tax return instructions* plus the *Tax return for
  individuals* (NAT 2541), "or order a pack that includes the instructions and 2 copies of the tax
  return form" through the Publications Ordering Service. The supplementary section is needed for
  partnership or trust distributions, capital gains, foreign income and rent. A separate Business
  and professional items schedule is needed for PSI or business income. The return is mailed to
  GPO Box 9845 in your capital city. "most refunds issue within **50 business days**", against
  myTax's "generally within 2 weeks"
  ([ATO: Lodge a paper tax return](https://www.ato.gov.au/individuals-and-families/your-tax-return/how-to-lodge-your-tax-return/lodge-a-paper-tax-return),
  updated 15 June 2026).
- **The current form can't be downloaded.** For 2023 the ATO said "download a copy of the form,
  print it and complete your tax return by paper". From 2024 the form page only points to ordering
  from iorder.com.au
  ([2023 form](https://www.ato.gov.au/forms-and-instructions/tax-return-for-individuals-2023);
  [2024 form](https://www.ato.gov.au/forms-and-instructions/tax-return-for-individuals-2024);
  [How to get the 2026 form](https://www.ato.gov.au/forms-and-instructions/individual-tax-return-2026-instructions/how-to-get-the-individual-tax-return-2026)).
  So **Quillo can't lawfully hand over a completed official form**. A Quillo-rendered look-alike
  would be an imitation government form.
- **The ATO steers business filers off paper.** For supplementary questions 13–16 (partnerships
  and trusts, PSI, business income, deferred non-commercial losses), "lodge online through myTax or
  a registered tax agent". Paper comes only on request
  ([How to get the supplementary return 2026](https://www.ato.gov.au/forms-and-instructions/individual-supplementary-tax-return-2026-instructions/how-to-get-the-individual-supplementary-tax-return-2026))
  **[snippet]**.
- **What Quillo could do.** Add a *paper* variant of the worksheet, keyed to NAT 2541 item numbers,
  that the user copies onto the ordered form, signs and posts. It is cheap, because
  `accountant-schedule.ts` already maps to D-labels. But it only helps people who can't use myGov,
  and Tax Help or an agent serves them better. **Low priority.**

### 4. A browser extension that fills myTax

- **The myGov terms of use (updated April 2026)** ([my.gov.au/en/about/terms](https://my.gov.au/en/about/terms)):
  - "You are not allowed to use any software, such as bots or scraper tools to access, monitor or
    copy myGov, the app or their contents. You may do this only if we give you written permission."
  - "You must not allow someone else to sign in or use your myGov account".
  - "You are responsible for everything that is done with and on your myGov account … We'll assume
    that any transaction on the account was undertaken by you."
  - "We may lock, suspend or terminate your myGov account or myGov access at any time and for any
    reason."
  - Linked services such as the ATO "may have their own terms of use".
- **What that means for an extension.** A content script that reads myTax's DOM to find fields and
  writes values into them is software that *accesses* and *monitors* myGov-hosted content. Without
  written permission it is at best a grey area, and on a plain reading it's prohibited. That holds
  even when the user drives it, never sees a credential, and never presses submit.
- **The ATO's business and agent terms** say ATO digital services are "designed and intended for
  human interaction only". They ban unapproved "screen-scrapers, bots, spiders" and say the ATO
  monitors usage for abnormal patterns
  ([Online services for agents T&Cs](https://www.ato.gov.au/Tax-professionals/Digital-services/In-detail/ATO-Online-services-for-agents-terms-and-conditions/);
  [Online services for business T&Cs](https://www.ato.gov.au/online-services/businesses-and-organisations-online-services/logging-in-to-online-services-to-business/ato-online-services-for-business-terms-and-conditions))
  **[snippet]**. The ATO's individuals' terms page
  ([ATO access to myGov terms](https://www.ato.gov.au/online-services/online-services-for-individuals-and-sole-traders/ato-online-services-and-mygov/ato-access-to-mygov-terms-and-conditions-and-privacy-notices))
  has no bot clause of its own. It records device, IP and authentication data, and uses it to
  "identify and respond to issues that may indicate authentication integrity is at risk".
- **The myGov security model.** myGov must be reached by a natural person ("You cannot be … a
  robot, or a software program"), with MFA or myID. **Quillo must never handle myGov or myID
  credentials**: the terms forbid sharing them, and doing so would make Quillo a de facto
  unregistered intermediary.
- **Risks, beyond the terms:**
  - **DOM fragility.** myTax changes every tax time. A silent mis-map puts a wrong figure into a
    lodged return.
  - **Liability.** The user is deemed responsible for what happens on their account, so Quillo's
    error becomes the user's false statement.
  - **ATO detection.** Very fast field entry, or the extension's injected script, could trip the
    integrity monitoring.
  - **The TPB boundary.** Writing the figures *into* the return pushes Quillo closer to "preparing
    a return" than a worksheet does. That's a lawyer question for #524.
  - **Brand.** Being cut off by Services Australia would be fatal to Quillo's trust positioning.
- **The Chrome Web Store** ([Program policies](https://developer.chrome.com/docs/webstore/program-policies/policies)):
  - "An extension must have a single purpose that is narrow and easy to understand".
  - "Request access to the narrowest permissions necessary". Host permission on the myTax domain
    gets heightened review.
  - "Extensions may only collect, use, or transmit user data that is necessary for the extension's
    disclosed single purpose", with prominent disclosure.
  - "Don't publicly disclose financial or payment information".
  - "Do not facilitate unauthorized access to content on websites, such as circumventing … login
    restrictions".
  - These policies don't bar an autofill tool in principle. But a listing that admits it automates
    a government tax portal against that portal's terms is exposed to takedown.
- **Verdict: don't build it unless Services Australia and the ATO give written permission.**
  Asking for that permission is an outward-facing action the owner would take, and the reply is
  uncertain. The safe 80% of the value comes from option 1's copy buttons, which leave every
  keystroke inside myTax to the user.

### 5. Other things worth knowing

- **Prefill already does most of the income side.** Income statements, interest, dividends,
  government payments, private health and HELP all prefill. Data starts arriving on 1 July and
  most of it is finalised by late July (see `ato-lodgement-process.md`). Quillo's value at lodge
  time is therefore **deductions, ABN/business, foreign income, the evidence behind each figure,
  and a "check this matches prefill" list**, not retyping income. The worksheet already follows
  this (#538).
- **myTax processing.** "Most process in 12 business days" (current ATO wording), against about 50
  for paper.
- **The "myTax mirror" UX:**
  - Same section order and labels as myTax, starting with Contact & bank details → Personalise.
  - One copy button per field, with figures copied as plain digits and no `$` or commas. myTax
    fields reject formatting, which needs a quick check in myTax.
  - A tick-off state saved per FY.
  - A side-by-side hint on desktop, and a "send to my laptop" link on phones.
  - A final "did myTax's estimate surprise you?" checkpoint that sends the user to Review or an
    agent. It shows no refund figure, which keeps Quillo within the GENERAL-INFO rule.
- **Free help exists.** ATO Tax Help (income up to about $70k, simple affairs) is the free assisted
  option for people who can't self-lodge, and Ship it should keep naming it.

## Owner decisions needed

1. **Confirm the near-term path:** invest in the myTax-mirror worksheet (copy buttons, tick-off,
   prefill check) as the lodging experience for this and next tax time? (Recommended: yes.)
2. **The browser extension:** drop it, or ask Services Australia and the ATO for written
   permission? (Recommended: drop it. If you want to try, that's your outward-facing ask. Don't
   build anything before a written yes.)
3. **When to start the partner-agent path**, and whether its v1 is a **user-carried pack** (the
   user sends Quillo's pack to any agent; no data sharing or commercial deal) or an **integrated
   partner** (a consented data hand-off, an agreed SLA, and status back to Quillo). Both keep the
   #542 rule that the user pays the agent directly.
4. **Referral fee or none.** Whether Quillo takes any referral fee from a partner agent. If it
   does, it goes to the lawyer in #524 together with the GS 14/2011 mapping.
5. **Option 2b (Quillo as SBR/PLS software for agents).** This is a strategic fork, because it
   means ISO 27001/IRAP, permanent MFA and the offshore Clerk/Stripe exceptions. Park it until the
   partner volume justifies it?
6. **Paper worksheet variant.** Build a NAT 2541-keyed transcription sheet for people who can't use
   myGov, or just point them at Tax Help and agents? (Recommended: point them elsewhere.)

## Not verified

- **The IITR service's DSP OSF risk rating** ("high" is inferred), and so whether option 2b is
  Category A or B at launch.
- **The ISO 27001/IRAP cost.** It's a market estimate, not an ATO figure.
- **Whether a printout of an earlier downloadable NAT 2541 is still accepted by the ATO's scanning
  process.** It doesn't change the recommendation.
- **The individuals' terms for ATO online services**, beyond the myGov terms and the ATO-access
  privacy page. I found no separate individual T&C page with a bot clause. The myGov clause is the
  operative one.
- **Pages marked [snippet]**, plus current Etax and H&R Block pricing, which was carried from #533.
