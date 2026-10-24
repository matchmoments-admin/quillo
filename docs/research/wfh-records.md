# Working-from-home hours: what record the ATO accepts

Research for #787 (map #692). Question: can a work-from-home diary save time when most weeks are the
same, and still meet the ATO's record rules for the fixed-rate method?

Primary sources only, all read on 2026-10-24:

- **PCG 2023/1**, *Claiming a deduction for additional running expenses incurred while working from home:
  ATO compliance approach* (issued 16 February 2023; amended 17 August 2023, 12 June 2024 and 16 April
  2025). <https://www.ato.gov.au/law/view/document?docid=COG/PCG20231/NAT/ATO/00001>
- **ATO, "Fixed rate method"** (last updated 8 June 2026).
  <https://www.ato.gov.au/individuals-and-families/income-deductions-offsets-and-records/deductions-you-can-claim/work-related-deductions/working-from-home-expenses/fixed-rate-method>
- **ATO, "Actual cost method"** (last updated 8 June 2026).
  <https://www.ato.gov.au/individuals-and-families/income-deductions-offsets-and-records/deductions-you-can-claim/work-related-deductions/working-from-home-expenses/actual-cost-method>
- **ATO media release, "ATO announces changes to working from home deductions"** (16 February 2023).
  <https://www.ato.gov.au/Media-centre/Media-releases/ATO-announces-changes-to-working-from-home-deductions/>

General information only, not tax advice.

## 1. Fixed-rate method (PCG 2023/1, from 1 July 2022)

**Rates (PCG 2023/1 para 26A, ATO fixed-rate page):** 67c an hour for 2022–23 and 2023–24, and 70c an hour
from 1 July 2024 (2024–25 and 2025–26). Quillo already reads these from the rule pack
(`thresholds_by_fy[fy].wfh_fixed_rate_cents_per_hour`); nothing here changes the maths.

**What has to be recorded.** To rely on the guideline you must keep "records showing the total number of
hours you worked from home during the income year" plus one bill or receipt for each running expense the
rate covers (PCG para 56). Para 58 is the key rule:

> "For the 2023–24 and later income years, you must keep a record for the entire income year of the number
> of hours you worked from home during that income year. An estimate for the entire income year or an
> estimate based on the number of hours you work from home during a particular period and applied to the
> rest of the income year will not be accepted. A record of your hours for the income year can be in any
> form, provided it is kept contemporaneously."

**What's acceptable (para 58):** timesheets; rosters; logs of time spent accessing employer systems or
online business systems; time-tracking apps; or "a diary or similar document kept contemporaneously". The
ATO page says the same in plain words: "your timesheets, rosters, diary or similar document you keep at the
same time as when you work".

**What's not acceptable:**
- An estimate for the year (PCG Example 2, paras 35–43: Dan's "2 days per week × 8 hours × 49 weeks" is an
  estimate, so the fixed-rate method is lost and he falls back to actual costs he can prove).
- A sample period applied to the rest of the year (para 58). That rules out the 4-week representative diary.
- The 2022–23 transition (para 59; media release): a representative record was accepted for 1 July 2022 to
  28 February 2023, but actual hours were needed from **1 March 2023**. From 2023–24 the whole year needs
  actual hours.
- The ATO page's Wanda example: she kept no record from 1 July to 28 February, estimated it, and could
  claim only the hours she logged in her calendar from 1 March onwards. "Only a record kept at the time the
  hours are worked from home is acceptable."

**The guideline is lost wholesale, not hour by hour.** If the records fall short, you "will not be able to
use the fixed-rate method" and can only claim actual expenses (para 5). Claiming more hours than you
actually worked takes you outside the guideline (para 28). If you object, you can't rely on the fixed rate
at all (para 6).

**Examples of good records in the guideline:** Pamela (Example 7) puts a calendar entry in when she starts
and finishes working from home. Yang (ATO page) keeps a spreadsheet of start and finish times. Keisha (ATO
page) uses her timesheets.

## 2. Actual-cost method

The ATO's actual-cost page lets you keep either "the number of actual hours you work from home during the
entire income year – for example, a timesheet or spreadsheet" **or** "a continuous 4-week period that
represents your usual pattern of working at home – for example, a diary". You also need the receipts and
bills for each expense and a record of how you worked out the work share. A 4-week itemised phone-bill
sample is accepted for phone and internet. So the 4-week diary still works for actual costs. It just
doesn't work for the fixed rate.

## 3. Does a confirmed recurring pattern count as a contemporaneous record?

Neither the PCG nor the ATO pages deal with a "typical week, confirmed each week" record directly. What they
do settle:

1. **The form is open.** "Any form, provided it is kept contemporaneously" (para 58). A diary, calendar,
   spreadsheet or app are all fine. Nothing requires start and finish times. The test is the *total hours*,
   recorded as you go.
2. **Contemporaneous means made at, or close to, the time.** The ATO's own wording is "kept at the same time
   as when you work" and "a record kept at the time the hours are worked". Timesheets and rosters are in the
   accepted list, and they are commonly filled in or confirmed weekly. So a weekly entry made in or straight
   after the week is the same cadence as a timesheet.
3. **A pattern applied to the year is an estimate.** Projecting a typical week across weeks that were never
   checked is exactly what para 58 rejects. So is Quillo's existing "Generate a diary" button, which builds
   every day of the year from declared weekdays and leave ranges.

**Verdict.** A typical week that the user **confirms or adjusts each week, close to the time**, with each
confirmation stored with its own server timestamp, is a diary kept contemporaneously. The pattern only
pre-fills the form; the record is the confirmation. This is our reading of para 58, not an ATO ruling on
this exact UX, so the copy stays general-information and points to a registered tax agent.

What keeps it compliant:

- **Nothing is counted until the user confirms that week.** A pattern alone never produces hours.
- **Each week stores when it was recorded** (server clock, so the client can't backdate it) and when it
  was last changed. Both go in the export.
- **"On time" has a clear window.** We treat a week as on time if it's first confirmed no later than 7 days
  after the week ends (by the Sunday after). That's our working definition of "close to the time", the
  same cadence as a weekly timesheet. The ATO doesn't set a number.
- **A week can't be confirmed in advance.** Confirming opens on the week's Friday, so it's a record, not a
  plan.
- **Exceptions are easy:** sick, leave, public holiday and office days are one tap per day, so the record
  matches what happened.
- **Late catch-up is honest.** A week first entered after the window is labelled *recorded late* with its
  own timestamp and never presented as contemporaneous. The user says what they rebuilt it from:
  - From a record made at the time (work calendar, timesheet, roster or employer system logs): these are
    on the ATO's accepted list in their own right, so the hours count. The export says the week was
    recorded late and names the source the user should keep.
  - From memory: that's an estimate, so Quillo keeps the entry but **does not count its hours**, and says
    why.
- **The export is the record the user keeps** (CSV: every day, hours, reason, when recorded, on time or
  late, source). The ATO asks you to keep records for five years after lodging (ATO fixed-rate page).

What it does not cover: the bill for each running expense (para 56, still needed; the Records step already
asks for receipts) and whether the user works from home in the PCG's sense at all (para 45: substantive
work, not checking email).

## 4. What this means for the current card (design audit finding)

`docs/ux/design-audit-2026-10.md` flagged the WFH "Generate a diary" checkbox (`WorkMethodsCard.tsx`, flag
`wfh_generate_diary`) as contradicting the card's own "a 4-week estimate isn't accepted" copy. The research
confirms the audit: a diary generated for the whole year from declared weekdays is an estimate under para
58. Behind the new flag, the weekly diary replaces the generator on the card. The card copy also said
"Since 1 July 2024" for the actual-hours rule; the PCG says 1 March 2023 (and the whole of 2023–24 onwards),
so the flag-ON copy is corrected.
