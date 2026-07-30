# Running the FY2025-26 return through Quillo — owner walkthrough

> Written 2026-07-30, against the live account at [app.quillo.au](https://app.quillo.au). FY2025-26 ended
> **30 June 2026**, so this is the year just closed.
>
> **GENERAL INFORMATION ONLY.** Quillo never lodges, never holds money and never computes tax payable. Every
> judgement call — deductibility, cost-base composition, parcel choice, apportionment — is for a registered
> tax agent. Nothing here is advice.

---

## Where the account actually stands

Checked against prod, not assumed:

| | rows | FY2025-26 |
|---|---|---|
| transactions | 2401 | **46** |
| income | 51 | **1** (`salary_payg`, $37,530.20) |
| properties | 4 | — |
| entities | 2 | — |
| `cgt_assets` | **0** | — |
| clarify questions | 207 | — |

**The engine is ready; the data isn't.** FY2024-25 is well populated (50 `rent` rows, ~2355 transactions).
FY2025-26 has almost nothing in it — including **zero rent recorded against 4 properties**. So the work
ahead is data entry and review, not building.

Verified ready, so don't re-derive it: `thresholds_by_fy` in `src/rulepacks/au-v1.json` carries a complete
FY2025-26 block (88c/km, 70c WFH, $30,000 super concessional cap, $69,674 car limit) and FY2026-27 too, and
the persona suite already runs `buildReport(env, u, 2025)` — FY2025-26 **is** the tested path.

---

## The order that matters

Do these in sequence. Later steps depend on earlier ones, and doing them out of order creates rework.

### 1. Bank statements first — everything follows from them

Upload FY2025-26 statements for every account, on **Accounts**. This is the step that unblocks the rest:
rent income rows are derived from bank credits, which is why 4 properties currently show no FY25-26 rent.

- One canonical money source per account — **statement XOR QuickBooks feed, never both.** An account on the
  QBO feed will refuse a statement import, deliberately: importing both double-counts.
- The parse shows a **preview and a reconciliation verdict** before anything is written. If it doesn't
  balance, that's usually a missing page or an overlapping date range — fix the export rather than
  overriding, unless you know why it's off.
- Re-uploading the same file is detected by hash and won't duplicate.

**Expect a large review queue afterwards.** ~2400 lines went through this for FY24-25. Use the grouped
bulk-triage on **Review** — confirm and ignore in batches rather than row by row.

### 2. Property income and expenses

With the bank data in, check each of the 4 properties: rent received, interest, rates, insurance, agent
fees, repairs vs improvements.

The repairs/improvements split is the one that actually moves money and is easy to get wrong — a repair is
deductible now, an improvement is capital and depreciates. Quillo will flag the ones it isn't sure about
rather than guessing.

### 3. Salary, interest, dividends and distributions

One `salary_payg` row exists for FY25-26. Add anything else on **Income** — bank interest, dividends,
managed-fund distributions.

For **ETF / managed-fund distributions**, use the AMMA statement (the annual tax statement), not the cash
that hit your bank. They differ, often materially: the AMMA carries franking credits, foreign income,
capital-gains components and the **AMIT cost-base net amount**. Quillo captures the components; note that
the cost-base amount is **recorded but not yet applied** to your holdings' cost base (that's #454, and it
only changes anything in a year you actually sell).

**Link each dividend or distribution to the holding that paid it** — the picker on the income row. That link
is what makes the DRP and AMIT work possible later, and it costs nothing now.

### 4. Capital — your ETFs, shares and crypto

**Income → Capital & equity → Import CSV.** This is the newest surface and the one built specifically for
this job.

Export from each venue (broker transaction history, registry statement, exchange CSV) and upload. What
happens:

- One model call infers the file's shape — it does **not** need to be a format anyone has seen before. That
  matters most for crypto, where there are hundreds of exchanges.
- You get a **full preview**: every row, its date, units, amount and whether it read as a buy or a sell.
  Rows it couldn't read are shown **with the reason and the original row number**, never silently dropped.
- Tick what to import. **Nothing is written until you confirm.**

Things to know before you do it:

- **Brokerage is handled correctly and automatically**: added to a purchase's cost base, subtracted from a
  sale's proceeds. Never both. It stays itemised, so the accountant pack shows it.
- **An imported sale will raise a blocker, and that is correct.** An export tells you what you sold *for*,
  never *which parcel* you sold. Parcel choice changes the gain and is your decision, so Quillo leaves the
  cost base empty and flags it rather than inventing a figure that would look authoritative. Open each sale
  and set the cost base for the units sold.
- **Import buys before sells** if they're in separate files — a sale is matched to a holding by code, and an
  unmatched sale is reported back rather than creating a phantom parcel to hang itself on.
- **Crypto is a CGT asset, not currency.** Every disposal is a CGT event — including crypto-to-crypto swaps
  and spending it. If your exchange export only shows fiat trades, the swaps are missing.
- Fractional units are never rounded, anywhere.

> **This path has never run against a real file.** The local machine can't run `workerd`, so this repo is
> deploy-only and yours is genuinely the first live execution. The preview screen is the safety net — if a
> column maps oddly you'll see it there, and nothing writes until you confirm. If something looks wrong,
> cancel and say what you saw.

### 5. Work-related and other deductions

Work-from-home hours, car (logbook or cents-per-km — 88c for FY25-26, capped at 5,000km), self-education,
tools, subscriptions, donations. The occupation checklist prompts for what's commonly claimable in your
line of work; deny-by-default still applies, so nothing enters the position until you confirm it.

### 6. Read the position, then clear the blockers

**Readiness** lists what's incomplete, split into **blockers** (the position is materially distorted) and
**review** (worth checking, not distorting). Clear the blockers before you hand anything over.

Capital blockers you may see, and what each means:

| Finding | What it means |
|---|---|
| `capital_disposal_no_cost_base` | The **holding** has no cost base and you've sold it — the whole sale price is counting as gain. |
| `capital_disposal_no_cost_base_used` | The holding's cost is recorded but the **sale** doesn't say how much of it was used. Same effect: gain overstated. This is the normal state of a freshly imported sale. |
| `capital_over_disposed` (review) | You've sold more units than the parcel records — usually a missing earlier purchase. |
| `capital_over_used_cost_base` (review) | Cost base claimed across sales exceeds the parcel's. Understates the gain. |

### 7. Export the accountant pack

**Filing → accountant schedule** (CSV or XLSX). Every section that contributes to a report figure carries a
**tie-back** that reconciles to it. The closing-holdings section deliberately has none — a closing balance
contributes to no figure this year, and inventing a reconciliation would be dishonest.

Give the pack to a registered tax agent. Quillo does not lodge.

---

## Known gaps — things Quillo will NOT do for you this year

Stated plainly so you don't discover them late:

- **AMIT cost-base amounts are recorded but not applied** (#454). Your ETF distributions carry tax-deferred
  amounts that reduce the cost base. Quillo captures and nudges but doesn't adjust the holding. Only matters
  in a year you sell — flag it to your agent if you sold ETFs.
- **DRP doesn't mint parcels** (#455). If any holding has dividend reinvestment on, each reinvestment is a
  **separate acquisition** with its own 12-month discount clock, and the dividend stays fully assessable.
  You'll need to enter those parcels by hand.
- **No PDF extraction for broker or fund statements.** CSV only. `managed_fund_amma` is a recognised
  document type but is filed to the shelf unread.
- **Crypto-to-crypto swaps** are only captured if your export includes them.
- **No prior-year carry-forward of capital losses** unless you've entered a Notice of Assessment.

---

## If something breaks

Deploy-only environment, so problems surface in prod first. Useful facts:

- Health: `curl -s https://app.quillo.au/healthz` → `{"ok":true}`.
- The gates that must stay green: `npm run typecheck`, `cd web && npx tsc --noEmit && npm run lint`,
  `npm test` (1029 unit goldens + 293 persona checks + statement reconciliation + schema drift).
- Nothing destructive has been run. The one outstanding destructive change is **#461** (dropping the dead
  `cgt_assets.status` column), which needs an explicit go and is *not* the one-line migration it looks like
   — six code references, one of them a golden `SELECT` that would break `npm test`.
- Engineering state for the capital work: [`capital-cgt-handoff.md`](capital-cgt-handoff.md).
