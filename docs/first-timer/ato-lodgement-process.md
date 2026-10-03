# How does the ATO say an individual lodges their own return, and does Quillo's journey match?

> Research for the first-timer map (#529), checking the owner-approved journey (spec A2, A3, A7–A10)
> against the ATO's own self-lodgement process. Researched 2026-10-03 against ato.gov.au primary
> pages, fetched directly (the pages were read in full with `curl` unless marked **[snippet]**, which
> means only a search-result snippet was seen). Builds on [`lodgement-routes.md`](lodgement-routes.md)
> (who can lodge) and [`standard-journeys.md`](standard-journeys.md) (what competitors do), and
> doesn't repeat them. General information only. Quillo is not a registered tax agent, and nothing
> here is tax advice.

## Verdict

**The journey's spine matches the ATO's.** myTax runs *Personalise return* (residency with dates →
spouse → tick what applies) → *Prepare return* (Income → Deductions → Losses → Offsets →
Adjustments → Medicare and private health → Spouse and income tests) → *Calculate* (estimate only)
→ declaration → *Lodge* → notice of assessment in the myGov Inbox. About you already copies the
Personalise order, and the "check this matches / type these in" worksheet is exactly what the ATO
asks a self-lodger to do ("review the information we pre-fill and add any missing details").

**The gaps are at the edges of the journey.** Quillo is thinnest before the user opens myTax and
after they lodge:

1. **Getting into myTax.** Nothing checks that the user has myGov linked to the ATO. That is the
   step first-timers most often get stuck on, because the ATO confirms identity with questions about
   records a first-timer may not have.
2. **"Tax ready", not "late July".** The ATO's rule is to wait until the employer marks the income
   statement **tax ready**. The ATO sends a myGov Inbox notice when every statement is tax ready.
   "Late July" is only the usual timing.
3. **The worksheet's section order drifts from myTax.** Business income sits under *Income* in myTax,
   not after Deductions. The worksheet also has no *Personalise* section (the first thing myTax asks)
   and no Adjustments (WHM), Spouse or Income-tests lines. The pack also marks managed fund
   distributions "not prefilled", but the ATO prefills them.
4. **After lodging there's no amendment path or 5-year records anchor.** The NOA → next-year loop
   exists. "I found a mistake" (amend online after processing, generally within 2 years) and "keep
   records 5 years *from the date you lodge*" do not.

None of these conflict with the TPB position or the general-information framing. All of them are
copy, pack or worksheet changes inside tickets that are already open (#584, #585, #586, #588, #590).

## (a) The official process, step by step

### 1. Before you start: do you need to lodge, and do you have what you need?

1. **Work out whether you need to lodge.** Use the *Do I need to lodge a tax return?* tool. There is
   a web version (2012–13 onwards) and a signed-in version in ATO online services (2018–19 onwards)
   that "uses information we already know about you" ([ATO-need]). The reasons list for 2025–26
   includes: tax was withheld from your pay (Reason 1), taxable income over $18,200 for a full-year
   resident (Reason 4), you **carried on a business**, you had a reportable fringe benefit or RESC
   amount, and a WHM earned $45,001 or more ([ATO-need26]).
2. **If you don't need to lodge, tell the ATO anyway.** "If you don't need to lodge, you still need
   to lodge a non-lodgment advice" ([ATO-first]). The quickest way is online through ATO online
   services ([ATO-need]).
3. **Have a TFN.** It's free to apply. Australian citizens aged 15 or over with a **Strong** Digital
   ID can apply online. There are separate routes for residents, migrants and visitors with work
   rights, and people overseas ([ATO-tfn]).
4. **Create a myGov account and link it to the ATO.** myTax is only reached through "a myGov
   account with an active link to the ATO" ([ATO-mytax]). Linking takes 4 steps: sign in → follow
   the prompts → confirm your personal details → **answer questions to confirm your identity**
   ([ATO-link]).
   - **Sign-in options for linking:** myID (recommended) at **Strong or Standard** identity strength,
     a passkey, an authenticator app, or an SMS code to an Australian mobile. "Answer a secret
     question" can't be used, and switching to it unlinks the ATO ([ATO-link]).
   - **myID sets the "online access strength"** (Strong, Standard or Not set). After that, the user
     must keep signing in with a myID of the same or higher strength ([ATO-myid]).
   - **The identity questions draw on ATO records.** They may ask about bank account details, super,
     a NOA, a Centrelink or PAYG payment summary, a dividend statement, the travel document used
     for a TFN application, the **TFN application receipt number**, or a **recent payslip**.
     Skipping every question counts as a failed attempt ([ATO-linkinfo]). Someone who can't confirm
     online is told what to do next ([ATO-link]). In the ATO's own first-timer guidance that meant
     phoning for a linking code (2021 article, [ATO-ft2021]). Tax Help volunteers get a hotline for
     "myGov linking support … if they're new to the tax system" ([ATO-taxhelp-train]).
5. **Gather documents:** the income statement ("wait until your employer marks your income statement
   as tax ready"), receipts for deductions, and the private health insurance statement
   ([ATO-first]).
6. **Free help is available.** Tax Help volunteers (July–October) help people on about $70,000 or
   less with simple affairs. It excludes contractors, sole traders, rental, CGT and foreign income
   ([ATO-taxhelp]).

### 2. Timing

7. **Prefill data starts arriving 1 July**, "with most data finalised by the end of July". Some data
   comes later, such as trust distributions and TPAR ([ATO-prefill]). The ATO's advice is "Why you
   may want to wait until late July". You *can* lodge from 1 July, but then "you'll need all your
   records and statements to enter information yourself" ([ATO-byb]).
8. **Wait for "tax ready".** Employers have until **14 July** to finalise their STP data. "You need
   to wait until your employer marks your income statement as 'Tax ready' before you prepare and
   lodge … If you lodge before the statement is 'Tax ready', you may have to amend." The ATO "will
   send a notification to your myGov inbox when all your income statements are 'Tax ready'". If a
   statement still isn't tax ready **after 31 July**, speak to the employer ([ATO-incstmt]).
9. **Due date:** self-lodgers have **1 July to 31 October** ([ATO-first]; [ATO-mytax]). Registered
   agents run a lodgment program with later dates, but the person must be on the agent's books
   **before 31 October** ([ATO-agent]).
10. **Paying a tax bill:** if you lodge on time, it's due on the later of **21 November** or 21 days
    after the NOA. If you lodge late, it's due 21 November ([ATO-estimate]).
11. **Late lodgment:** the failure-to-lodge penalty is one penalty unit per 28 days late, up to 5
    units ($364 a unit for infringements on or after 1 July 2026). The ATO generally doesn't apply
    it to "isolated cases", warns before applying it, and **generally doesn't issue it when the
    return results in a refund or nil**, unless it was applied before lodgment ([ATO-ftl];
    [ATO-pu]).
12. **Leaving Australia:** a WHM or temporary resident who leaves permanently before 30 June can
    lodge early ([ATO-whm]; [ATO-temp]).

### 3. The myTax flow (2025–26)

13. **Open the return:** myGov → ATO → *Manage tax returns* → Lodge for the year ([ATO-mytax];
    [ATO-taxhelp-train]).
14. **Contact details, then financial institution details** (both prefilled from ATO records). The
    refund goes to the account given at "Step 2 Financial institution details" ([ATO-sd] PDF,
    [ATO-estimate]).
15. **Personalise return** ([ATO-pers26]):
    1. "Were you an Australian resident for tax purposes from 1 July 2025 to 30 June 2026?" If you
       were a resident for only part of the year, you give the **dates** you were a resident. If you
       were never a resident, you leave the dates blank.
    2. "Did you have a spouse at any time between 1 July 2025 and 30 June 2026?"
    3. You then tick the items that apply: salary/wages/government payments/FHSS; Australian
       super/annuities; interest or other investment/property income (including CGT and rent);
       managed fund/trust distributions; sole trader/business/partnership (including PSI); foreign
       income; other income; deductions; tax losses; offsets or adjustments.
    - **myTax ticks some items itself** from prefill, last year's return or a myDeductions upload,
      and "**you can't remove any selections we make for you**". You can come back to Personalise
      at any point.
    - **Always shown, no tick needed:** gifts, interest, dividend and tax-affairs deductions;
      Medicare and private health insurance; income tests.
    - **Calculated for you, no tick:** low income tax offset, PAYG instalments, and **HELP/VSL/AASL
      and other study-loan repayments**.
    - **Salary ticks Work-related expenses automatically.** That shows D1 car, D2 travel, D3
      clothing, D4 self-education and D5 other work-related expenses ("includes working from home
      expenses").
    - **Shown when your situation needs it:** Under 18 and Part-year tax-free threshold appear
      automatically. WHM net income needs the user to tick *Offsets or adjustments › Working
      holiday maker net income* ([ATO-whm-adj]).
    - **Sharing economy:** for ride-sourcing and delivery, tick *Business/Sole trader income*. For
      short-term renting of a home, tick *Rent*. Platform employees tick salary; non-business
      services go to *Other income*. **Cash income** must be declared.
16. **Prepare return.** Sections come in this order (the order of the ATO's own instruction set,
    [ATO-ins26]):
    1. **Income** (banner order per [ATO-inc26]): income statements and payment summaries (salary,
       allowances, government payments, ETPs, FHSS) → Australian super/annuities → investments or
       property (interest, dividends, capital gains, **rent**) → managed fund/trust distributions →
       **sole trader and business** (business and professional items, net income or loss, PSI,
       partnerships) → foreign income → other income → taxable payments and grants (TPAR, new
       prefilled section).
    2. **Deductions**: work-related D1–D5, then gifts/interest/dividends/cost of managing tax
       affairs, then other deductions ([ATO-ded26]).
    3. **Tax losses of earlier income years.**
    4. **Tax offsets**: small business income tax offset, seniors and pensioners, FITO, other.
    5. **Adjustments**: part-year tax-free threshold, **working holiday maker net income**,
       government super contributions ([ATO-adj26]).
    6. **Medicare and private health insurance**: always displayed. It covers the levy reduction
       (number of dependent children), the exemption (full or half exemption days, and "Were you a
       temporary resident for Medicare purposes and have a **Medicare entitlement statement**?"),
       the Medicare levy surcharge (private patient hospital cover), and the private health
       insurance policy lines and tax claim code ([ATO-mlre]; [ATO-phi]).
    7. **Other: spouse details and income tests** ([ATO-other26]).
17. **What the salary banner asks:** the **occupation where you earned most income**. For each
    statement that hasn't prefilled you add the gross, tax withheld, and the payer's **ABN or WPN**.
    WHM visa holders must also complete WHM net income ([ATO-sal26]).
18. **Calculate.** "Your myTax estimate is an estimate only … may differ from the final balance of
    your assessment", for example when pre-fill wasn't complete when you lodged ([ATO-estimate]).
19. **Declaration and lodge.** Review the declaration, tick it, then select **Lodge**. This exact
    wording is from the parallel *refund of franking credits* flow in myTax ([ATO-rfc26]). For the
    tax return itself it was seen only in a snippet **[snippet]**. Under self-assessment the person
    is responsible for the prefilled figures too ([ATO-byb]). A lodgment receipt arrives by email
    ([ATO-mytax]).

Label numbers: **myTax screens use banner names, not question numbers.** The numbers belong to the
paper *Individual tax return 2026*: 1 Salary or wages, 2 Allowances/earnings/tips, 3 Employer lump
sums, 4 ETPs, 5 Australian Government allowances and payments, 6 pensions and allowances, 7
annuities/super income streams, 8 super lump sums, 9 attributed PSI, 10 Gross interest, 11
Dividends, 12 Employee share schemes ([ATO-q1-12]). The D-labels are D1–D10 for the main deductions.
Supplementary item numbers (13 partnerships/trusts, 15 business income, 20 foreign source, 21 rent,
24 other, D11–D15) match the pack's existing map but were not re-fetched this session (see Not
verified).

### 4. What myTax prefills and what the person types

20. **Prefilled when reported** ([ATO-byb]): government allowances and payments; salary, wages,
    foreign employment and other amounts on income statements; super income streams, annuities and
    lump sums; bank interest (including ATO interest); public company dividends; **managed fund
    distributions**; **trust distributions (from myTax 26)**; employee share schemes;
    business/PSI amounts on income statements (voluntary agreements, labour hire); **TPAR
    payments** (building, cleaning, courier, road freight, IT, security); CGT *reminders* (shares,
    property, crypto); private health insurance policies (target mid-July, [ATO-phi]); spouse
    details from last year; myDeductions uploads.
21. **Typed by the person:** everything else. That means deductions, business income not on a TPAR
    or income statement, foreign income, rent, and any statement that hasn't prefilled.
22. **"Don't rely solely on pre-fill".** It can be incomplete. If you change it, the ATO may ask for
    a reason, amend the return, or contact you. If prefill looks wrong, **contact the organisation
    that supplied it** so they correct it with the ATO ([ATO-prefill]). Some prefilled records
    can't be deleted ([ATO-sal-govt]; [ATO-int26]).
23. **Sharing-economy platforms** report sellers' income to the ATO twice a year (31 January and
    31 July). Reporting started 1 July 2023 for ride-sourcing and short-term accommodation and was
    extended to all other reportable transactions from 1 July 2024 ([ATO-serr]). The ATO pages
    seen don't say this data **prefills** myTax (see Not verified).

### 5. After lodging

24. **Processing:** myTax returns "aim for processing within 12 business days" (about 2 weeks).
    Paper takes 50 business days ([ATO-noa]; [ATO-first]). Progress is shown in *Manage tax
    returns* ([ATO-progress]).
25. **NOA:** "your NOA and tax receipt are sent to your myGov Inbox", with an email or SMS from
    myGov. A **statement of account** comes too when the balance differs from the assessment, for
    example when a refund is offset against a debt. The ATO's review period is normally 2 years
    (4 in some cases) ([ATO-noa]).
26. **Refund or bill:** a refund goes to the nominated account. A bill's payment advice is on the
    NOA ([ATO-estimate]).
27. **Amend:** wait until the original has processed. Then go to myGov → ATO → *Manage tax
    returns* → **Amend**. New income types are ticked on Personalise; extra records go through
    Add/Edit on Prepare. It takes about 20 days ([ATO-amend]). There is no fee. The time limit is
    **2 years from the day after the NOA** for people with simple affairs ([ATO-taxhelp-train]).
    An increase is generally treated as a voluntary disclosure **[snippet]**.
28. **Records:** keep written evidence for **5 years from the date you lodge**. If total
    work-related expenses are $300 or less you don't need full written evidence. A bank statement
    alone isn't written evidence ([ATO-records]; [ATO-sal26]).
29. **myDeductions** (ATO app) keeps WFH hours, expenses, car trips and (for sole traders) income
    on the device. You upload it at tax time and it prefills ([ATO-mydeductions]; [ATO-pers26]).

### 6. Residents, non-residents, WHMs and temporary residents

30. **Residency is the first Personalise question, and a part-year resident gives dates.** A
    part-year resident gets the part-year tax-free threshold adjustment automatically
    ([ATO-pers26]).
31. **Foreign residents:** no tax-free threshold. They claim a Medicare levy exemption for their
    foreign-resident days. They don't declare Australian interest or dividends that had withholding
    tax taken ([ATO-temp]). A foreign resident with a HELP/VSL/AASL debt must declare worldwide
    income **electronically** or lodge a non-lodgment advice ([ATO-temp]; [ATO-need26] Reason 5).
32. **Temporary residents** declare Australian-sourced income only, plus some overseas employment
    income ([ATO-temp]). A Medicare levy exemption for someone not entitled to Medicare needs a
    **Medicare entitlement statement from Services Australia** ([ATO-mlre]).
33. **WHMs (417/462):**
    - Most are foreign residents. The WHM rates apply either way, except for residents who are
      nationals of the NDA countries (Chile, Finland, Germany, Israel, Japan, Norway, Turkey, UK)
      ([ATO-whm-adj]).
    - A WHM doesn't need to lodge (nor lodge a non-lodgment advice) if all income was WHM salary
      or wages **and** taxable income was under $45,001. They must lodge to claim deductions.
    - DASP applies on departure ([ATO-whm]).
    - In myTax, the WHM net income adjustment asks for home country, whether all income relates to
      the visa, WHM gross income, and related deductions ([ATO-whm-adj]).
34. **HELP:** no Personalise tick. The repayment is calculated and shows on the NOA
    ([ATO-pers26]; [ATO-estimate]).

### 7. Sole trader / ABN first-timers

35. **You must lodge if you carried on a business**, even below the threshold ([ATO-need26]).
36. **In myTax:** tick *Sole trader or business income › Business income or loss* (or PSI). That
    shows **Business and professional items**: the PSI tests, main business activity, number of
    activities, business status, and ABN/name/address prefilled from an active ABN. It also shows
    **Net income or loss from business**, all under *Income* ([ATO-bpi26]; [ATO-inc26]).
    TPAR-reported contractor payments prefill under *Taxable payments and grants* ([ATO-byb]).
37. **PAYG instalments:** an individual is entered automatically after a return showing instalment
    income of $4,000 or more, tax payable on the latest NOA of $1,000 or more, **and** notional
    tax of $500 or more. The letter goes to the myGov Inbox. New businesses can also enter
    voluntarily ([ATO-paygi]). Instalments paid are credited on the next return ([ATO-estimate]).
38. **Sharing-economy income is assessable** whether or not it's a business. Platforms report it
    (SERR, step 23) ([ATO-pers26]; [ATO-serr]).

## (b) Alignment: ATO step ↔ Quillo journey step

Legend: ✅ aligned · ⚠️ gap (missing, fixable inside the step) · ❌ conflict (Quillo says or orders
something differently from the ATO).

| # | ATO step | Quillo step (spec / ticket) | Status | Recommended change |
|---|---|---|---|---|
| 1 | Do I need to lodge? tool | Before you start (A10, **#584**) | ✅ | Keep linking to the tool and never give a verdict. Prefer the ATO's **signed-in** version once myGov is linked ("more accurate") |
| 2 | Non-lodgment advice if not required | Before you start (#584) | ⚠️ | Add one line: "If you don't need to lodge, the ATO usually still asks you to lodge a **non-lodgment advice** (online in ATO online services)." For WHMs, quote the ATO's exception as information (salary only and under $45,001 → no return and no non-lodgment advice, but lodging is needed to claim deductions) |
| 3 | TFN | Before you start (#584) | ✅ | The link exists. Add "free; citizens 15+ with a Strong myID can apply online" |
| 4 | myGov + **link to the ATO** + identity strength | Before you start (#584); Ship it (#590) | ⚠️ **largest gap** | Add a "Get into myTax" checklist on Before you start and repeat it at the top of Ship it: (1) a myGov account; (2) sign in with **myID at Standard or Strong** (recommended; or passkey, authenticator or SMS; not a secret question); (3) **link the ATO**. You'll answer questions from ATO records, and a first-timer can use a recent payslip or the TFN application receipt number. If you can't confirm online, the ATO tells you what to do next. Then a self-attest tick ("my myGov is linked to the ATO") on Ship it. Quillo never touches myGov credentials. Link [ATO-link] and [ATO-linkinfo] |
| 5 | Gather documents (income statement, receipts, PHI statement) | Bring in (A3, **#586**); Records (A7, **#588**) | ✅ | No change |
| 6 | Tax Help (free, about $70k, simple affairs) | Before you start escalation ladder (#584); Ship it agent line (#590) | ⚠️ | Name Tax Help as the ATO's free option beside "take this pack to a registered agent". State the ATO's exclusions (sole traders, contractors, rental, CGT, foreign income) as information |
| 7 | Prefill from 1 July, mostly by late July | Ship it header (#590; pack `lodgement.prefill_ready_hint`) | ✅ | Keep it, but make it secondary to row 8 |
| 8 | **Wait for "Tax ready"**; myGov Inbox notice when all statements are ready; ask the employer if not ready after 31 July | Ship it header (#590); Bring in income-statement prompt (#586) | ⚠️ | Change the Ship it header to: "Wait until your income statement says **Tax ready** in myGov (employers have until 14 July; the ATO sends a myGov Inbox message when all of them are ready). That's usually by late July." Add a per-employer tick on Ship it, "Tax ready in myGov?". On #586, when wages are detected, ask for the statement once it's tax ready, and add a 31 July nudge to contact the employer. New pack keys: `lodgement.employer_finalise_by` ("14 July"), `lodgement.tax_ready_chase_after` ("31 July") |
| 9 | Self-lodger due 31 October; agent program only if on the agent's books before 31 October | Ship it (#590) | ⚠️ | The agent line must add "**contact them before 31 October** to be part of their lodgment program". **After 31 October**, change the copy (today is 3 Oct 2026, so this applies to FY2025-26 this month): "The self-lodger date has passed. You can still lodge in myTax. The ATO generally doesn't apply a late penalty when the return results in a refund or nil, and it warns before applying one." Show it as quoted ATO information, never a promise. Pack: `lodgement.after_due_note` |
| 10 | Early lodgment for people leaving Australia | Ship it gating (#590) | ⚠️ | Don't hard-gate Ship it on late July. If the profile has a residency period ending before 30 June (departure), show "Leaving Australia? The ATO lets you lodge early", and list everything as **type in**, because prefill may be incomplete |
| 11 | Contact details + **financial institution details** (refund account) | Ship it worksheet (#590) | ⚠️ | Add a **"Before Personalise"** answer section: "Check your contact details and the bank account for any refund." No figures |
| 12 | **Personalise**: residency (+ dates) → spouse → tick items | About you (A2, **#585**) | ✅ | Question order already matches. Keep the residency **dates**, because myTax asks for them |
| 13 | Personalise ticks are made in myTax by the user | Ship it worksheet (#590) | ❌ **missing section** | The worksheet starts at Income, but myTax starts at Personalise. Add a first section, **"Personalise return: what to tick"**, built from the profile: the residency answer + dates; spouse yes/no; the items to tick (salary/government payments; interest; business income or loss / PSI; foreign income; rent; deductions; **Offsets or adjustments › Working holiday maker net income** for WHMs). Add a note: "myTax may pre-tick some items you can't untick; that's normal." Pack: add `personalise` as the first `mytax_sections` entry |
| 14 | HELP needs no tick and is calculated by the ATO | About you study/HELP chip (#585); worksheet | ✅ | Keep the HELP chip for education only. **Never** put a HELP line or figure on the worksheet. Copy: "myTax works out any HELP repayment; there's nothing to enter" |
| 15 | WFH and car sit under Work-related expenses (auto-ticked with salary) | About you chips (#585); Records (#588) | ✅ | The chips are Quillo's lens, not myTax ticks. The worksheet already maps WFH → D5 and car → D1 |
| 16 | Prepare order: **Income** (… investments/property incl. **rent** → managed fund/trust → **sole trader/business** → foreign → other → TPAR) → **Deductions** → Losses → Offsets → **Adjustments** → **Medicare & PHI** → **Spouse / income tests** | Worksheet sections (pack `mytax_sections`, #575 shipped; page #590) | ❌ | Reorder the pack to: `personalise` → `income_check` → `income_type_in` (rent within Income, foreign after business) → `business` (**move before deductions**: business income and expenses are under Income in myTax) → `deductions` → `adjustments` (WHM net income; part-year threshold note) → `medicare` → `spouse_income_tests`. Inside `income_type_in`, order lines as myTax does (rent before business, foreign after). This is a rule-pack edit plus a `pft12` golden update, which keeps tie-back unchanged |
| 17 | Salary banner asks **occupation where you earned most income**; a statement that hasn't prefilled needs the payer's **ABN/WPN** | Worksheet income section (#590) | ⚠️ | Add an `answer` line with the occupation from About you. For any employer flagged "add your income statement", note "myTax will ask for the employer's ABN (on the payslip or income statement)" |
| 18 | Item numbers are paper-return numbers; myTax uses banner names | Worksheet labels (#575/#590) | ⚠️ | Lead each line with the **myTax banner name** ("Salary, wages, allowances, tips, bonuses etc.", "Interest", "Other work-related expenses") and show the paper number or D-label as secondary. D-labels do appear in myTax work-related headings, but question numbers like "1" or "10" don't |
| 19 | Managed fund distributions **prefill**; trust distributions prefill from myTax 26; TPAR payments prefill | Pack `mytax_income_items` | ❌ | Set `managed_fund_distribution.prefilled: true` (it moves to "check this matches"). For an ABN tenant in a TPAR industry, add a `check` note: "myTax may prefill payments businesses reported for you (Taxable payments and grants); check they match your records" |
| 20 | "Don't rely solely on pre-fill"; if prefill is wrong, contact the payer | Worksheet "check this matches" (#590) | ⚠️ | The worksheet already says "check tax ready". Add "if it still doesn't match, contact the employer or payer to correct it with the ATO (changing prefill in myTax can trigger an ATO query)". That is ATO wording, not advice |
| 21 | Medicare & PHI: dependants, exemption days, **Medicare entitlement statement** (temporary residents), MLS hospital cover, PHI policy lines | Worksheet `medicare` (one line today) | ⚠️ | Keep "no levy figure". Add `answer` lines when they apply: "Number of dependent children" (always asked); for foreign-resident periods or `whm`/`temporary` periods, "myTax asks about exemption days, and whether you have a Medicare entitlement statement from Services Australia"; PHI: "check your policy lines prefilled (insurers aim for mid-July)" |
| 22 | Spouse details + income tests (always shown) | Worksheet (absent); About you spouse (#585) | ⚠️ | When spouse = yes, add an `answer` line: "myTax will ask for your spouse's details and income; have an estimate ready". Income tests: one note line |
| 23 | Calculate = **estimate only** | Check (A8/A9, **#589**) | ✅ | Quillo shows no refund figure. Keep pointing at myTax's estimate: "myTax shows its own estimate when you select Calculate" |
| 24 | Declaration: the person is responsible for every figure, prefill included | Ship it (#590) | ✅ | Add a pre-lodge line: "When you tick myTax's declaration, you're confirming every figure, including prefill, is right and that you hold the records" |
| 25 | Lodgment receipt by email; processing about 12 business days | Mark as lodged (#590) | ⚠️ | Mark-as-lodged copy: "The ATO emails a receipt. Most myTax returns process in about 12 business days, and your notice of assessment arrives in your **myGov Inbox**" |
| 26 | NOA in the myGov Inbox (and maybe a statement of account) → check it against the return | After you lodge panel / NOA capture (#590) | ✅ | Already designed. Add: "If a statement of account came with it, the amount paid may differ (for example, offset against a debt)." A bill is due as shown on the NOA (usually 21 November when lodged on time) |
| 27 | **Amend** online after processing, generally within 2 years | After you lodge (#590) | ⚠️ **missing loop** | Add "Found something you missed?" to the After-you-lodge panel: wait for the NOA, then myGov → ATO → Manage tax returns → **Amend**. A new type of income or deduction is ticked on Personalise, and the worksheet's lines still apply. Undoing "mark as lodged" stays separate. A full amend flow (diff since lodged) would be a **new ticket**, not created here |
| 28 | Keep records **5 years from the date you lodge**; the $300 rule; a bank statement alone isn't written evidence | Records (#588); retention notice (`src/lib/retention.ts`) | ⚠️ | Records copy already follows the $300 rule (#588). **Retention anchor mismatch:** `retention.ts` measures 5 years from the FY end (30 June), but the ATO measures from lodgment. Use `fy_signoff.lodged_at` when present (and FY end + backstop otherwise), so the "past your retention window" notice never fires before the ATO's 5 years. It only nudges and deletes nothing, so this is low severity. Fold it into #594 (retention) or a small follow-up |
| 29 | myDeductions: an ATO record keeper that uploads and prefills | Records (#588) | ✅ | Optional: one education line, "Using the ATO app's myDeductions? That's fine too", so users don't keep double records unknowingly |
| 30 | NOA → next year | After you lodge (#590, A1 lodged) | ✅ | Already designed (active FY advances, 1 July reminder). For ABN users, add "you may receive a **PAYG instalment** letter in your myGov Inbox if your return shows business income over the ATO's thresholds" as information |
| 31 | Foreign resident with HELP must declare worldwide income electronically | About you newcomer branch (#585, A10 cards) | ⚠️ | Add to the newcomer card text: "foreign residents with a HELP/VSL debt have extra reporting (declare worldwide income or lodge a non-lodgment advice)". Link [ATO-temp] |
| 32 | WHM: NDA-country exception; WHM net income adjustment; DASP | About you WHM branch (#585); worksheet `adjustments` (row 16) | ⚠️ | Newcomer card: "Most WHMs pay WHM rates whatever their residency. Residents from certain treaty countries may be taxed as residents. myTax asks your home country." No rate figures. Add a worksheet `answer` line: "Working holiday maker net income: home country; is all your income from your WHM visa?" |
| 33 | Sole trader must lodge; Business and professional items + net income under Income; PSI questions | Grow › Business (A11, **#592**); worksheet `business` | ⚠️ | Reorder (row 16). Add `answer` lines: main business activity, number of activities, status (commenced/continuing/ceased), "did you receive personal services income?" (link the ATO PSI tool; never answer for the user) |
| 34 | Platforms report payouts (SERR) | Bring in 'we noticed' platform signals (#577/#586) | ⚠️ | When a platform payout is noticed: "Platforms report seller payouts to the ATO twice a year, so the total you enter should match the platform's annual summary." That is information, not a claim about prefill |

## (c) Wording rules (from the ATO's process and Quillo's TPB boundary)

1. **Never "lodge with Quillo", "Quillo lodges" or "submit to the ATO".** Use "lodge **in myTax**"
   and "you lodge; Quillo helps you get ready". Only a registered tax agent can charge to prepare
   and lodge ([ATO-agent]: "they are the only people that can charge a fee").
2. **Call it a checklist or worksheet, never "your tax return".** The ATO's "your tax return" is
   what the user lodges in myTax.
3. **Quote the ATO, don't paraphrase it into a verdict.** "The ATO says you need to wait until your
   income statement is tax ready" is fine. "You don't need to lodge" and "you won't get a penalty"
   are never fine. Use "The ATO generally doesn't apply…" with the link.
4. **No figures the ATO calculates.** That means refund, tax payable, Medicare levy/surcharge, HELP
   repayment, LITO and WHM tax. myTax computes them ("estimate only"). Quillo can say "myTax works
   this out".
5. **Use the myTax vocabulary:** *Personalise return*, *Prepare return*, *Calculate*, *Tax ready*,
   *notice of assessment*, *myGov Inbox*, *Manage tax returns*, *Amend*, *non-lodgment advice*.
   Add them to the glossary (A10 already lists most; add *tax ready*, *non-lodgment advice*,
   *myID*, *online access strength*, *amendment*).
6. **Identity and credentials are the user's alone.** Quillo never asks for myGov or myID details or
   the linking answers, and never offers to "connect to myGov".
7. **Every step keeps the footer:** "General information only. Quillo isn't a registered tax agent."
   Wherever there's a judgement (PSI, residency unsure, dependants), add "confirm with a registered
   tax agent".
8. **Dates come from the pack, never hard-coded:** 14 July, 31 July, late July, 31 October,
   21 November.

## (d) Not verified

- **The tax-return declaration and Lodge screen wording.** The tick-then-Lodge sequence was read on
  the myTax 2026 *refund of franking credits* page. For the tax return it was seen only as a search
  snippet. The exact screen names of the steps around Personalise ("Step 1 Contact details" etc.)
  were inferred from "Step 2 Financial institution details" on the 2026 estimate page and the
  supporting-documents PDF.
- **The on-screen order of the Prepare sections.** It was taken from the order of the ATO's 2026
  myTax instruction index (and the banner order on the Income index), not from a live myTax session
  or screenshot. The ATO online services simulator could confirm it.
- **Supplementary paper item numbers** (13, 15, 20, 21, 24, D11–D15) and the D1–D10 names were not
  re-fetched this session. They match the pack, which was built from earlier research.
- **Whether SERR platform data prefills myTax.** The SERR page describes reporting to the ATO, and
  the myTax prefill list names TPAR but not SERR.
- **The linking code by phone.** Seen only in the ATO's 2021 first-timer article. The current
  linking page says only "we will let you know what to do next".
- **"An amendment that increases tax is generally treated as a voluntary disclosure".** Search
  snippet only. The 2-year amendment limit was read on the Tax Help training page ("taxpayers with
  simple affairs").
- **The 88c/km car rate for 2025–26.** Seen in a search snippet only, and deliberately not used:
  rates stay out of Quillo copy.
- **Whether myTax shows D-label codes (D1–D5) on screen** or only the item names.

## Consequences for open tickets

- **#584 Before you start:** add the "Get into myTax" checklist (myGov, myID Standard or Strong,
  link the ATO, the identity questions), the non-lodgment advice line, and Tax Help in the ladder.
  Rows 2, 3, 4, 6.
- **#585 About you:** newcomer card additions (foreign resident + HELP, WHM NDA, Medicare
  entitlement statement). Keep the residency dates. Rows 12, 31, 32.
- **#586 Bring in your money:** "tax ready" framing on the income-statement prompt, a 31 July
  employer nudge, and the SERR line on platform signals. Rows 8, 34.
- **#588 Records:** the 5-year-from-lodgment wording and a myDeductions line. The retention anchor
  goes to #594. Rows 28, 29.
- **#590 Ship it:** most of the changes, in rows 4, 8–11, 13, 16–27 and 30. The pack reorder +
  Personalise section + `managed_fund_distribution.prefilled` fix + `pft12` update could be split
  into a small pack/builder follow-up to the shipped #575.
- **New, not created (per instructions):** an *Amend after lodging* flow (row 27).

[ATO-need]: https://www.ato.gov.au/individuals-and-families/your-tax-return/before-you-prepare-your-tax-return/how-to-work-out-if-you-need-to-lodge-a-tax-return
[ATO-need26]: https://www.ato.gov.au/forms-and-instructions/individual-tax-return-2026-instructions/completing-the-individual-tax-return-2026/do-you-need-to-lodge-a-tax-return-2026
[ATO-first]: https://www.ato.gov.au/individuals-and-families/your-tax-return/how-to-lodge-your-tax-return/lodging-your-first-tax-return
[ATO-ft2021]: https://www.ato.gov.au/media-centre/attention-first-time-lodgers-your-steps-to-tax-success
[ATO-tfn]: https://www.ato.gov.au/individuals-and-families/tax-file-number/apply-for-a-tfn
[ATO-mytax]: https://www.ato.gov.au/individuals-and-families/your-tax-return/how-to-lodge-your-tax-return/lodge-your-tax-return-online-with-mytax
[ATO-link]: https://www.ato.gov.au/online-services/online-services-for-individuals-and-sole-traders/ato-online-services-and-mygov/create-a-mygov-account-and-link-it-to-the-ato
[ATO-linkinfo]: https://www.ato.gov.au/online-services/online-services-for-individuals-and-sole-traders/ato-online-services-and-mygov/create-a-mygov-account-and-link-it-to-the-ato/information-you-need-to-link-mygov-to-the-ato
[ATO-myid]: https://www.ato.gov.au/online-services/online-services-for-individuals-and-sole-traders/increase-your-online-security-with-myid
[ATO-taxhelp]: https://www.ato.gov.au/individuals-and-families/your-tax-return/help-and-support-to-lodge-your-tax-return/tax-help-program
[ATO-taxhelp-train]: https://www.ato.gov.au/individuals-and-families/your-tax-return/help-and-support-to-lodge-your-tax-return/tax-help-program-training/tax-help-mytax-and-lodging-online
[ATO-prefill]: https://www.ato.gov.au/individuals-and-families/your-tax-return/how-to-lodge-your-tax-return/lodge-your-tax-return-online-with-mytax/pre-fill-availability
[ATO-byb]: https://www.ato.gov.au/individuals-and-families/your-tax-return/instructions-to-complete-your-tax-return/mytax-instructions/supporting-documents-for-my-tax/before-you-begin
[ATO-sd]: https://www.ato.gov.au/api/public/content/0-ab4bf99d-d81a-43a1-9f15-3aace63b88b3
[ATO-incstmt]: https://www.ato.gov.au/individuals-and-families/jobs-and-employment-types/working-as-an-employee/income-statements/access-your-income-statement
[ATO-agent]: https://www.ato.gov.au/individuals-and-families/your-tax-return/how-to-lodge-your-tax-return/lodge-your-tax-return-with-a-registered-tax-agent
[ATO-estimate]: https://www.ato.gov.au/individuals-and-families/your-tax-return/instructions-to-complete-your-tax-return/mytax-instructions/2026/mytax-2026-estimate
[ATO-ftl]: https://www.ato.gov.au/individuals-and-families/paying-the-ato/interest-and-penalties/penalties/failure-to-lodge-on-time-penalty
[ATO-pu]: https://www.ato.gov.au/individuals-and-families/paying-the-ato/interest-and-penalties/penalties/penalty-units
[ATO-ins26]: https://www.ato.gov.au/individuals-and-families/your-tax-return/instructions-to-complete-your-tax-return/mytax-instructions/2026
[ATO-pers26]: https://www.ato.gov.au/individuals-and-families/your-tax-return/instructions-to-complete-your-tax-return/mytax-instructions/2026/how-to-personalise-your-tax-return
[ATO-inc26]: https://www.ato.gov.au/individuals-and-families/your-tax-return/instructions-to-complete-your-tax-return/mytax-instructions/2026/income
[ATO-ded26]: https://www.ato.gov.au/individuals-and-families/your-tax-return/instructions-to-complete-your-tax-return/mytax-instructions/2026/deductions
[ATO-adj26]: https://www.ato.gov.au/individuals-and-families/your-tax-return/instructions-to-complete-your-tax-return/mytax-instructions/2026/adjustments
[ATO-other26]: https://www.ato.gov.au/individuals-and-families/your-tax-return/instructions-to-complete-your-tax-return/mytax-instructions/2026/other-mytax-instructions-including-spouse-details-and-income-tests
[ATO-sal26]: https://www.ato.gov.au/individuals-and-families/your-tax-return/instructions-to-complete-your-tax-return/mytax-instructions/2026/income/salary-wages-or-other-income-on-an-income-statement-or-payment-summary/salary-and-wages
[ATO-sal-govt]: https://www.ato.gov.au/individuals-and-families/your-tax-return/instructions-to-complete-your-tax-return/mytax-instructions/2026/income/salary-wages-or-other-income-on-an-income-statement-or-payment-summary/government-allowances-and-payments
[ATO-int26]: https://www.ato.gov.au/individuals-and-families/your-tax-return/instructions-to-complete-your-tax-return/mytax-instructions/2026/income/australian-income-or-losses-from-investments-or-property/interest
[ATO-bpi26]: https://www.ato.gov.au/individuals-and-families/your-tax-return/instructions-to-complete-your-tax-return/mytax-instructions/2026/income/sole-trader-and-business-income-or-losses-and-partnership-distributions/business-and-professional-items
[ATO-mlre]: https://www.ato.gov.au/individuals-and-families/your-tax-return/instructions-to-complete-your-tax-return/mytax-instructions/2026/medicare-and-private-health-insurance/medicare-levy-reduction-or-exemption
[ATO-phi]: https://www.ato.gov.au/individuals-and-families/your-tax-return/instructions-to-complete-your-tax-return/mytax-instructions/2026/medicare-and-private-health-insurance/private-health-insurance
[ATO-whm-adj]: https://www.ato.gov.au/individuals-and-families/your-tax-return/instructions-to-complete-your-tax-return/mytax-instructions/2026/adjustments/working-holiday-maker
[ATO-rfc26]: https://www.ato.gov.au/individuals-and-families/your-tax-return/instructions-to-complete-your-tax-return/mytax-instructions/2026/applying-for-a-refund-of-franking-credits
[ATO-q1-12]: https://www.ato.gov.au/forms-and-instructions/individual-tax-return-2026-instructions/income-questions-1-12-individual-tax-return-2026
[ATO-noa]: https://www.ato.gov.au/individuals-and-families/your-tax-return/check-the-progress-of-your-return-and-refund/your-notice-of-assessment
[ATO-progress]: https://www.ato.gov.au/individuals-and-families/your-tax-return/check-the-progress-of-your-return-and-refund
[ATO-amend]: https://www.ato.gov.au/individuals-and-families/your-tax-return/amend-your-tax-return/how-to-request-an-amendment-to-your-tax-return
[ATO-records]: https://www.ato.gov.au/individuals-and-families/income-deductions-offsets-and-records/records-you-need-to-keep
[ATO-mydeductions]: https://www.ato.gov.au/online-services/online-services-for-individuals-and-sole-traders/ato-app/mydeductions
[ATO-whm]: https://www.ato.gov.au/individuals-and-families/coming-to-australia-or-going-overseas/coming-to-australia/working-holiday-makers
[ATO-temp]: https://www.ato.gov.au/individuals-and-families/coming-to-australia-or-going-overseas/your-tax-residency/foreign-and-temporary-residents
[ATO-serr]: https://www.ato.gov.au/businesses-and-organisations/preparing-lodging-and-paying/third-party-reporting/sharing-economy-reporting-regime/what-is-the-serr
[ATO-paygi]: https://www.ato.gov.au/businesses-and-organisations/income-deductions-and-concessions/payg-instalments/starting-payg-instalments
