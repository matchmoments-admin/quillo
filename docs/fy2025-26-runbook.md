# FY2025-26 — the owner's runbook

> **Click-by-click, in order, personalised to your confirmed situation.** Written 2026-08-01 against
> `main@c70fa50`, live at [app.quillo.au](https://app.quillo.au).
>
> - [`fy2025-26-walkthrough.md`](fy2025-26-walkthrough.md) = *how the system works.*
> - [`fy2025-26-handoff.md`](fy2025-26-handoff.md) = *where the project stands.*
> - **This file = what you personally do, in what order.**
>
> **GENERAL INFORMATION ONLY.** Quillo never lodges, never holds money, never predicts a refund. Every
> judgement call is for a registered tax agent.

---

## Your confirmed situation

Settled 2026-07-31 — everything below assumes it:

- **PAYG salary**, and you **rent the home you live in** (rent paid is *not* deductible; your real
  claim in that shape is WFH running costs).
- **Property A — rented out.**
- **Property B — a relative lives there rent-free** ⇒ deductions correctly **denied**.
- **Shares: bought and held, no disposals** ⇒ no capital gain this year.
- **Both properties 100% yours.**
- **FY2024-25 lodged; NOA not to hand.**

---

## Step 1 · Properties — 10 minutes, do this first

**Where:** Settings (the gear) → the Properties section.

Setting this first is what stops you re-triaging thousands of transactions later — `use_status` is what
gates deductibility, so every property expense is classified against it.

### For each property, set:

| Field | Property A (rented) | Property B (relative) |
|---|---|---|
| **Label** | something you'll recognise in a review queue | same |
| **Address** | required | required |
| **Status** ("You own this") | `rented` | `rented` or `vacant` — see note |
| **Use status** | **Rented out** | **Private use — a relative lives there rent-free** |
| **Own %** | `100` | `100` |

Those are the exact on-screen labels.

> **Note on Property B's `status`:** `status` is the own-vs-rent *relationship*; `use_status` is what
> actually gates deductibility. Setting `use_status` correctly is the part that matters. **Do not set
> `status = owner_occupied`** — you don't live there, and it would misrepresent the property.

### ⚠️ Three questions to answer honestly before you save

1. **Did the rent-free arrangement run the whole financial year?** `use_status` is a *single value* —
   Quillo cannot express "private use Jul–Dec, rented Jan–Jun". **If it changed mid-year, stop and tell
   me** — that's a modelling gap, not something to paper over by picking one.
2. **Is the relative paying anything at all?** If *any* money changes hands it stops being the rent-free
   case and becomes **below-market rent**, where deductions are capped at the rent received. **Quillo
   does not implement that** ([#184](https://github.com/matchmoments-admin/quillo/issues/184)). Tell me
   if so.
3. **Did Property A have vacant periods?** Genuinely advertised and available between tenants is
   **Genuinely available for rent** (deductions continue). Any private or family use is not.

### Also: `acquired_date` — and what you can't do yet

**Ask Quillo** (the chat bubble) can set it: *"Set the acquired date on \<label\> to YYYY-MM-DD."*

Worth doing because it gates the 12-month CGT discount and third-element eligibility (no third element
for property acquired **before 21 Aug 1991** —
[#469](https://github.com/matchmoments-admin/quillo/issues/469)).

> **[#486](https://github.com/matchmoments-admin/quillo/issues/486) — fixed and live, same day.**
> The property editor now has a collapsed **"Capital details (for when you sell)"** section carrying
> **Bought**, **Cost base $** and **This is / was my main residence**. So set the acquired date there
> rather than via chat, and record the cost base while the contract is in front of you.
>
> Leave the main-residence box **unticked** on both — you rent where you live, so neither is your main
> residence. Note what ticking it actually does: Quillo never applies the exemption, it **sets the
> disposal aside for your registered tax agent**. It never puts a number on it.

### Loans

While you're in Settings, confirm the loan→property links. **Interest follows the use of the borrowed
funds, not the security** — so if either loan has had a **redraw, offset or refinance**, tell me rather
than guessing at a split.

---

## Step 2 · Statements — the big one

**Where:** Accounts → add each account, then upload its statements.

This unblocks everything: you currently have **zero rent recorded against 4 properties** because rent
income is *derived* from bank credits.

### What to gather

- Every **transaction account** money moved through in FY2025-26.
- **Both property loan accounts.** Interest is one of your largest deductions — and Property B's
  interest must **land** so it can be visibly *denied*. Denied and missing look identical on the
  headline and are completely different to an accountant.
- Any **credit card** used for property or work costs.

Date range: **1 Jul 2025 – 30 Jun 2026**.

### 🚨 The coverage trap — read before you start

**Quillo does not check that your statements cover the whole year.** Reconciliation happens *within* a
statement only. Upload Jul–Feb and Apr–Jun and **every file reports `reconciled = 1`** while March is
silently missing from your position, with **no warning anywhere**.

**So keep a list as you go** — one line per file:

```
Account            File                        Period covered
CBA everyday       cba-2025-07-to-2025-12.csv  01/07/2025 – 31/12/2025
CBA everyday       cba-2026-01-to-2026-06.csv  01/01/2026 – 30/06/2026   ✅ continuous
Loan – Property A  ...
```

Then check each account runs **1 Jul → 30 Jun with no gap and no overlap**. Paste the list into
[#472](https://github.com/matchmoments-admin/quillo/issues/472) and I'll confirm.

### While uploading

- **One source per account — statement XOR QuickBooks feed.** An account on the QBO feed will refuse a
  statement import, deliberately. That's not a bug.
- Each parse shows a **preview and a reconciliation verdict before anything is written.** If it doesn't
  balance, that's usually a missing page or an overlapping range — **fix the export rather than
  overriding**, unless you know why it's off.
- Re-uploading the same file is hash-detected; it won't duplicate.
- **Note anything the parser gets wrong** — institution and format. That's a deliverable, not an
  annoyance.

---

## Step 3 · The NOA — 10 minutes, independent

**Where:** myGov → ATO → Tax → Lodgments → Income tax → your FY2024-25 notice of assessment.

Enter it in Quillo (NOA capture). It's the **only** route by which carry-forward losses reach FY2025-26.

**It may turn out to be a no-op, and that's fine.** With no disposals this year, a carried *capital*
loss has no gain to offset and simply continues forward. A carried *tax* loss does apply.

Its other value: the **Suggested-vs-Assessed delta** — the honest measure of whether Quillo got
FY2024-25 right. Record it either way.

---

## Step 4 · Broker CSVs — optional this year

**Where:** Income → Capital & equity → Import CSV.

**This changes no number on your FY2025-26 return** — you had no disposals, so there's no capital gain
and no CGT line. Its value is (a) recording cost bases while the records are in front of you, and
(b) it's the **first time this path has ever run against a real file**.

Do it if you have the time; defer it if you don't. It is not on the critical path to filing.

If you do:

- Export from **each** venue (broker, registry, exchange). One model call infers the file's shape — it
  doesn't need to be a format anyone has seen before.
- **A full preview shows every row** before anything is written. Rows it couldn't read appear **with
  the reason and the original row number** — never silently dropped.
- **Nothing is written until you confirm.**
- **Brokerage is handled automatically** — added to a purchase's cost base, never double-counted.
- **Watch for a column read *plausibly but wrongly*** — that's the dangerous failure, and the preview is
  the only safety net. If anything looks off, **cancel and tell me what you saw**.
- **Tell me if any holding has DRP switched on.** Each reinvestment is a separate acquisition with its
  own 12-month clock, and Quillo doesn't mint those parcels yet
  ([#455](https://github.com/matchmoments-admin/quillo/issues/455)).

---

## Step 5 · Review the queue

**Where:** Review — use the **grouped bulk-triage**, confirm and ignore in batches, not row by row.

Expect a large queue (FY2024-25 had ~2,400 lines).

**Slow down on these — they're where money actually moves:**

- **Repairs vs improvements** on Property A. A repair is deductible now; an improvement is capital and
  depreciates. Quillo flags what it isn't sure about rather than guessing — those flags are the ones to
  read.
- **Property B's expenses must appear and be DENIED**, not go missing. You should be able to find them
  in the accountant pack's explicitly-not-claimed section, with a reason.
- **Your own rent must not be claimed.** Quillo should catch it — confirm it did.
- **WFH hours** at the FY2025-26 fixed rate (70c/hr). Running costs yes; **occupancy costs never**.

Then clear the **blockers** on Readiness. With no disposals, **no capital blockers should appear at all
— if one does, that's a bug and I want to know.**

> The readiness reconciliation defect (#444) that would have bitten you here — franked dividends
> rendering as no line — **was fixed and deployed today**. Your lines should now sum to the headline.

---

## Step 6 · The pack

**Where:** Filing → accountant schedule (CSV or XLSX).

**Check before you hand it over:**

1. Salary matches your income statement.
2. Property A's rent and expenses look right (FY2024-25 is a sanity baseline, not a target).
3. **Property B appears under EXPLICITLY-NOT-CLAIMED with a reason.** The single most important check
   in your pack — denied ≠ missing.
4. Franked dividends show the gross-up and the credit as separate lines.
5. **No capital gain line at all.** A non-zero CGT figure is a bug.
6. Closing holdings carried forward — correctly with **no tie-back** (a closing balance contributes to
   no figure this year).
7. **Every tie-back reconciles.** Any section that doesn't is a blocker — tell me.

**If you can't explain a figure from the pack alone, that's a product failure, not yours.** Tell me and
I'll fix it.

Then give it to a registered tax agent. **Quillo does not lodge.**

---

## Separately: Basiq and AWS (nothing to do with your return)

Do these whenever — they don't touch FY2025-26.

### Basiq sandbox — to start testing

1. Sign up at the Basiq dashboard; create an application named `quillo-dev` on **sandbox**.
2. Your application → Developers → API keys → copy it.
3. `npx wrangler secret put BASIQ_API_KEY` (the surface to receive it shipped today).
4. Leave `BASIQ_ENV = "sandbox"`. **Production is gated deliberately** and must not be flipped.

### Ask Basiq — the commercial diligence ([#475](https://github.com/matchmoments-admin/quillo/issues/475))

- **The platform access fee, in writing.** Unpublished, and it dominates the economics below ~500 users.
- **Will they name Cloudflare and AWS as OSPs** in the representative arrangement — and, given
  [#474](https://github.com/matchmoments-admin/quillo/issues/474), **can Quillo satisfy PS8 exception 2
  ("reasonable steps") with Cloudflare as host?** As principal they carry the liability, so their answer
  may settle it commercially before it needs settling legally. **A refusal is more disqualifying than a
  high fee.**
- **A ramped or usage-only first year.** The 12-month minimum is the single largest financial risk.
- **Confirm per-*user*, not per-*connection*** pricing.

### AWS — Bedrock `au.` ([#476](https://github.com/matchmoments-admin/quillo/issues/476))

Full steps are in [`CONFIG.md`](../CONFIG.md). Short version: request access to **Claude Haiku 4.5** in
Bedrock `ap-southeast-2`; create an IAM user with `bedrock:InvokeModel` scoped to the `au.*` inference
profile; then:

```
npx wrangler secret put AWS_ACCESS_KEY_ID
npx wrangler secret put AWS_SECRET_ACCESS_KEY
```

Already built and inert — this is activation, not development. Required under **every** CDR option.

---

## Three decisions only you can make

| | Decision | My recommendation |
|---|---|---|
| [#474](https://github.com/matchmoments-admin/quillo/issues/474) | PS8: option **A** (stay on Cloudflare, test exception 2), **B** (AU-controlled infra), or **C** (no CDR) | **A** — its cost is a legal opinion, not a re-platform, and if it fails B is still available |
| [#469](https://github.com/matchmoments-admin/quillo/issues/469) | Commit the CGT engine to a two-figure cost base (`reduced_cost_base_cents`)? | Yes, but **not this year** — no disposals, and the rows accrue for free |
| [#461](https://github.com/matchmoments-admin/quillo/issues/461) | Drop the dead `cgt_assets.status` column (**destructive**) | **Not during a live return run.** It also isn't the one-line migration it looks like — six code references, one a golden `SELECT` |

---

## If something breaks

- Health: `curl -s https://app.quillo.au/healthz` → `{"ok":true}`
- **Deploy-only environment** — problems surface in prod first. Tell me what you saw and I'll fix it.
- Nothing destructive has been run.
