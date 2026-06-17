# UX/UI research — the guided tax journey (EPIC #248)

> **Status:** research deliverable (Wave 3 prerequisite). No code yet. This is the "research first,
> then build behind flags" artefact #248's charter calls for, and the input that Wave-1's *functional*
> UI (the #258 refund picker, #254 reason copy, #249 inputs) should be reconciled against.
>
> **Method note:** synthesised from the established products' well-known flows (Xero, MYOB, QuickBooks,
> TurboTax/H&R Block, ATO myTax/myDeductions, Hnry/Airtax, Pocketbook/WeMoney/Up) and standard UX
> authorities (Nielsen Norman Group, GOV.UK / ATO content design). A parallel live-citation pass was
> rate-limited mid-run; **exact source URLs to be appended on the next research pass** — the patterns
> below are stable and long-documented, but treat specific product details as "as generally known,
> verify before quoting publicly."

---

## 0. Guiding principles (the lens for every screen)

From #248's charter + best practice, the journey must:
1. **Lead with WHY, then ask.** Every panel states what the ATO needs / why it matters before showing
   inputs. (ATO/GOV.UK content design; reduces abandonment vs cold forms.)
2. **One clear next step.** The user should never wonder "where do I go?" — a single primary action per
   screen, a visible sequence, breadcrumbs. (TurboTax interview model; NN/g on wizards.)
3. **Right data in first.** Surface *which* accounts/statements are missing up front, not at hand-off.
   (Xero/QuickBooks setup checklists; myTax prefill.)
4. **One thing at a time.** Reduce on-screen competition; progressive disclosure of advanced fields.
5. **Honest numbers.** Indicative position only; confirmed-vs-tracked always distinguished; **never**
   predict a refund. (Composes with the GENERAL-INFO invariant.)
6. **Design to the standard.** Match Xero/MYOB/QuickBooks shapes for coding/reconcile/reports; the ATO
   methods for WFH/car; diverge only when clearly better.

---

## 1. Onboarding completeness — "tell me what to add and why" (#246)

**How the leaders do it**
- **Xero / QuickBooks**: a **setup checklist** of cards ("Connect a bank", "Add your details",
  "Capture a receipt") with completion ticks and a progress meter; bank-feed connection is the
  headline first step. Hubdoc/QBO receipt capture is introduced *in context*.
- **ATO myTax**: **prefill** — it tells you what it already knows (employers, banks, health funds) and
  what's still needed, so the user fills *gaps*, not everything.
- **TurboTax**: an **interview** that asks situation questions ("Did you work from home? Own a rental?
  Have shares?") and uses the answers to decide which sections/documents apply.
- **Hnry/Airtax**: radically pared-back — ask only what changes the outcome for an individual.

**Anti-patterns to avoid**
- A blank dashboard with no "start here" (our current state).
- Asking for everything regardless of situation (over-long forms → abandonment).
- Discovering a missing account/statement only at the report/hand-off stage.

**Recommendation for Quillo**
A short **situation interview → personalised checklist**:
- Ask the few questions that change *what evidence is needed*: employment (PAYG? multiple employers?),
  work-from-home, a car for work, investment property (how many? co-owned? loan?), shares/crypto,
  sole-trader/ABN income, super contributions. (We already capture most of this in Settings/situation
  — reuse it; this is a *guided* front door to the same data.)
- Output a **"To bring in" checklist** derived from the answers: e.g. *rental* ⇒ "loan statement(s),
  agent summary, council/water rates"; *WFH* ⇒ "hours log / diary"; *shares* ⇒ "dividend + CGT
  statements". Each item: WHY one line + a deep link to the exact add-screen + a done/skip state.
- A **completion meter** ("3 of 7 evidence sources added") that the dashboard mirrors.

**Wireframe — onboarding interview + checklist**
```
┌ Let's set up your return ───────────────────────────────┐
│ A few questions so we only ask for what you need.       │
│                                                         │
│  Do you…                                                │
│   [✓] earn a salary (PAYG)        employers: [ 2 ▾]     │
│   [✓] work from home sometimes                          │
│   [ ] use a car for work                                │
│   [✓] own an investment property  how many: [ 1 ▾]      │
│   [ ] have shares / crypto                               │
│   [ ] earn ABN / sole-trader income                     │
│                              [ See my checklist → ]      │
└─────────────────────────────────────────────────────────┘
┌ Bring these in  ·  3 of 7 done ─────────────────────────┐
│ ✓ Salary — added from payslip                            │
│ ○ Bank statements (everyday + savings)   WHY  [ Add → ] │
│ ○ Home-loan annual summary               WHY  [ Add → ] │
│ ○ Rental agent summary                   WHY  [ Add → ] │
│ ○ Council & water rates                  WHY  [ Add → ] │
│ ○ WFH hours / diary                      WHY  [ Add → ] │
│                                          [ Skip for now ]│
└─────────────────────────────────────────────────────────┘
```

---

## 2. Guided "what do I do next" + per-step help (#244, #247)

**How the leaders do it**
- **TurboTax / H&R Block**: a persistent **progress rail** + "Continue where you left off"; the app
  decides the next step. Help is **contextual** ("Learn more" inline, not a separate manual).
- **Xero / QuickBooks dashboards**: task-oriented tiles ("X transactions to reconcile", "Y bills to
  pay") that are *both* status and the entry point — each tile is the next action.
- **NN/g**: wizards/progress indicators reduce anxiety; empty states should teach the first action.

**Anti-patterns**
- A dashboard that's a wall of numbers with no prioritised action (our #244 complaint).
- Generic help pages divorced from the screen the user is on.
- Inconsistent FY scope between header figures (our noted bug).

**Recommendation for Quillo**
- A **"Your next step" component** at the top of the Dashboard: one primary recommended action derived
  from state, with 2–3 secondary tasks beneath. States, e.g.:
  - data missing ⇒ "Add your bank statements (2 accounts still needed)" → onboarding checklist
  - inbox backlog ⇒ "Sort 34 transactions that need a category" → Sort
  - clarifications ⇒ "Answer 5 quick questions to finish categorising" → Clarify
  - refunds/property unlinked ⇒ "Link 3 refunds / attribute 2 property costs" (Wave-1 nudges feed this)
  - all clear ⇒ "Review your position & download the schedule" → Reports/File
- **Per-step guidance (#247)**: each page carries a one-line "what to do here" + a "?" that expands the
  relevant glossary/why, and breadcrumbs showing place in the sequence
  (**Set up → Bring in → Sort → Check → Position → File** — already our happy-path spine).
- Fix the FY-scope inconsistency: one active-FY control, all header counts honour it.

**Wireframe — Dashboard "next step"**
```
┌ Your next step ─────────────────────────────────────────┐
│  ●  Sort 34 transactions that need a category           │
│     We can't finish your position until these have a     │
│     category.                              [ Start → ]    │
│  ── then ───────────────────────────────────────────────│
│  ○ Answer 5 quick questions (Clarify)                    │
│  ○ Link 3 refunds to the expense they reverse            │
│  Set up ─ Bring in ─ ▣ Sort ─ Check ─ Position ─ File    │
└─────────────────────────────────────────────────────────┘
```

---

## 3. Single-transaction categorise screen (#253)

**Problem today:** 3 overlapping controls — bucket dropdown, free-text `ato_label`, and "confirm
as-is" — three ways to do one thing.

**How the leaders do it**
- **Xero reconcile / QuickBooks "For review"**: one row = **one decision**. Pick an account/category
  (typeahead), optionally add detail, **one confirm button** ("OK"/"Add"). Advanced fields are
  disclosed, not always-on. **Bank rules / "apply to similar"** are offered *after* the pick.
- **Pocketbook/WeMoney/Up**: a single category picker + an optional note; "always categorise X here?"
  rule prompt after.

**Recommendation for Quillo**
- **One primary control**: a **category picker** (the bucket, shown with friendly labels) as the single
  decision. `ato_label` becomes an **optional "detail" field disclosed under "Add detail"**, not a
  co-equal input. Property/refund pickers stay context-conditional (as Wave-1 added).
- **One primary button** that adapts: "Confirm" when unchanged, "Save" when edited — never both.
- After save, the existing **apply-to-siblings / learn-a-rule** prompt (good — keep, it matches Xero
  rules).

**Wireframe — simplified categorise**
```
┌ Windsor Alehouse · $14.74 · 12 Mar ─────────────────────┐
│ Category   [ Meals & entertainment            ▾]        │
│            ▸ Add detail (ATO label, property, …)        │
│                                        [ Confirm ]       │
│ after: "Categorise the other 6 from Windsor Alehouse?"  │
└─────────────────────────────────────────────────────────┘
```

---

## 4. Transactions list IA (#251)

**Problem today:** duplicate FY filters + conflicting count messaging.

**How the leaders do it**
- **Xero/QuickBooks**: one filter bar (date range, account, status, search), a clear result count, and
  **batch-select → bulk action** toolbar. Faceted, non-redundant.
- **NN/g**: faceted filtering, a single source of truth for the active filter set, visible result counts
  that match the filters.

**Recommendation for Quillo**
- **One filter bar**: active-FY (single control, shared with the app), date sub-range, account,
  status/needs-review, bucket, search. Remove the duplicate FY control.
- **One count line** that always reflects the *current* filter ("48 of 312 in FY2024-25").
- **Bulk-select + a bulk bar** (re-categorise / set property / learn a rule) — the home for #252's
  bulk re-categorise.

---

## 5. One Save per component (#250)

**How the leaders do it**: a single primary action per form is a baseline heuristic (NN/g: one primary
button; competing saves cause errors). Xero/QBO forms save the whole panel once.

**Recommendation for Quillo**: collapse dual saves (the Accounts "Save" + separate "Save interest" is
the cited offender) into **one primary Save per panel** that persists all the panel's fields, or split
into clearly separate cards each with their own single save — never two competing saves in one visual
group. (Wave-1's #249 already routed those inputs through shared parsers; #250 finishes the IA.)

---

## 6. Reports / position clarity (#255)

**Problem today:** confirmed-vs-tracked blur, duplicate FY, position framing.

**How the leaders do it**
- **TurboTax/H&R Block**: a running figure, but **heavily caveated** ("estimate"), with a breakdown you
  can drill into. The status (complete vs in-progress) is explicit.
- **Xero/MYOB reports**: clear report date controls (one set), and totals that reconcile to their lines.
- **ATO myTax**: shows income/deductions as you go; never a "you'll get $X back" promise mid-flow.

**Recommendation for Quillo**
- **Two clearly-separated tiers**: **Confirmed/claimable** (what a review has confirmed) vs **Tracked /
  pending review** (captured, not yet claimable) — distinct visual treatment + plain labels, never
  summed into one headline. Our engine already distinguishes `resolved_deductible_cents` vs
  `total_deductions_cents` — surface that split honestly.
- **Indicative position** framed as income − deductions − depreciation, labelled *indicative / general
  information only*; **no refund prediction**.
- One FY control; drill-through from each line to its transactions (we have the data).

**Wireframe — position**
```
┌ Your indicative position · FY2024-25 ───────────────────┐
│ Income            $246,272.60                            │
│ − Deductions       $13,630.04  confirmed                 │
│ − Depreciation        $X                                 │
│ ───────────────────────────────                         │
│ Indicative taxable position  $XXX,XXX   (general info)   │
│                                                          │
│ ⓘ $53,068 more is TRACKED but not yet confirmed —        │
│    review it to see if it can be claimed.  [ Review → ]  │
└──────────────────────────────────────────────────────────┘
```

---

## 7. WHY-first WFH panel + standalone car calculator (#245)

**How the leaders do it**
- **ATO myDeductions / calculators**: explicit **method choice** — WFH **fixed-rate** (cents/hour,
  covers electricity/internet/phone) vs **actual cost**; car **cents-per-km** (capped) vs **logbook**.
  Each explains what it covers and what records you need *before* inputs.
- **TurboTax**: WFH and vehicle are **separate guided mini-calculators**, each WHY-first.

**Recommendation for Quillo**
- **Split WFH and car** into two standalone tools (separate the calculators' backend, per the ticket).
- **WFH panel, WHY-first**: explain fixed-rate vs actual + what each covers and the records needed,
  *then* the method toggle, *then* inputs (hours / diary). Note the fixed-rate method already covers
  certain running costs so those receipts aren't double-claimed (we already enforce this server-side —
  say so).
- **Car tool**: method choice cents-per-km (with the km cap shown) vs logbook; recommend the better
  one once both are entered (we compute this — surface it).
- Keep GENERAL-INFO framing throughout.

**Wireframe — WFH (WHY-first)**
```
┌ Working from home ──────────────────────────────────────┐
│ If you did some work at home you may be able to claim    │
│ running costs. Two ATO methods:                          │
│  • Fixed rate (c/hour) — covers power, internet, phone   │
│  • Actual cost — itemise (needs more records)            │
│ General information only — confirm with a tax agent.     │
│  Method:  (•) Fixed rate   ( ) Actual cost              │
│  Hours worked from home this year:  [ 620 ]  [ diary ▸ ] │
│                                          [ Save ]        │
└─────────────────────────────────────────────────────────┘
```

---

## 8. Proposed build sequence (Wave 3 / #248)

Per the charter "right data in → guide → component cleanups", and lowest-risk-first:

1. **#246 onboarding interview → checklist** (get the right data in) — additive, flag-gated.
2. **#244 + #247 guided next-step + per-step help** (the spine) — Dashboard "next step" component +
   breadcrumbs + contextual help; fix FY-scope consistency.
3. **#253 categorise screen** simplification (one control + one button + disclosed detail).
4. **#251 Transactions IA** (one filter bar, one count, bulk bar) — also the home for **#252** bulk
   re-categorise.
5. **#250 one-Save** cleanup (Accounts + any other dual-save panels).
6. **#255 Reports** confirmed-vs-tracked + honest position framing.
7. **#245 WFH WHY-first + standalone car tool**.

Each ships **additive + feature-flag-gated** (flag OFF ⇒ byte-identical), keeps the 10 persona goldens
green (UX work must not move numbers), and reconciles the Wave-1 functional UI into the new design.

## 9. Open decisions for the owner
- **Reuse vs rebuild Settings/situation** for the #246 interview — recommend *reuse* (guided front door
  to the same data), not a parallel store.
- **How prescriptive** the dashboard "next step" should be (single forced step vs a prioritised list) —
  recommend a prioritised list with one highlighted primary.
- **Citation refresh**: re-run the live competitor/NN-g citation pass (rate-limited this round) and
  append source URLs before treating any specific product claim as quotable.
