# Test plan — two-persona data-model epic (Phases A–D)

How to verify the features shipped across Phases A, B, C and D. Two layers: **automated**
(runs locally, covers the engine/maths) and **manual in-product** (the UI/journey, run against
the deployed app — local runtime is deploy-only). `attribution_engine` is **ON** in prod.

> General information only — Quillo never lodges. Every figure is indicative.

---

## 1. Automated (run before/after any change)

```bash
npm run typecheck          # server (tsc)
npm --prefix web run typecheck   # SPA
npm test                   # units + personas + statement recon + schema-drift
#   ├─ test:units      — depreciation goldens, deny-by-default, attribution snapshot/routing,
#   │                    prepareAttributions validation, deriveWfhHours, assetDepreciatesForTaxpayer
#   ├─ test:personas   — END-TO-END buildReport on both case studies (14 checks) ← the key one
#   └─ test:schema     — migrations 0001–0036 reproduce schema.sql exactly
```

`npm run test:personas` is the regression guard for the whole epic — it builds a real DB from
the migrations via `node:sqlite`, seeds both personas, and runs the actual `buildReport` with
the flag on. Green = both case studies produce the legally-correct position. If you change any
money path, this must stay 14/14.

**Prod migration check** (read-only, confirms a tenant's schema/backfills):
```bash
npx wrangler d1 execute tax-agent-db --remote --command \
  "SELECT (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN \
   ('entity_roles','income_activities','transaction_attributions','company_tax_positions', \
    'blackhole_costs','shareholder_loans','rd_claims')) AS new_tables_7of7;"
```

---

## 2. Manual — Persona 1 (PAYG renter, employer-owned laptop)

Sign in as a fresh tester (or a clean FY). Expected results in **bold**.

| # | Feature (phase) | Steps | Expected |
|---|---|---|---|
| 1 | Wizard WFH (D.1) | Onboarding → *people* step → "Work from home? ~days/week?" → enter **2** | Saved; no error |
| 2 | Dashboard WFH card (D.1) | Go to **Dashboard** | A "Working from home" card pre-filled **2 days/week → ~730 hrs → ~$511 @ 70c**, editable; editing days re-derives hours |
| 3 | PAYG checklist (D.2) | Dashboard checklist | Items appear: WFH reminder, **income protection, professional membership, self-education, tax-agent fee, donations, "bought equipment?"** |
| 4 | Asset ownership gate (D.3) | Accounts → import a statement with a monitor purchase → Assets → Add asset → set **"Who owns it? = Employer-owned"** | Explainer "can't claim decline-in-value on employer-owned gear"; the asset is saved but contributes **$0** depreciation (check the Filing position) |
| 4b | Self-owned asset | Add the monitor as **"I bought it"**, % used for work **80** | Depreciates normally (Div 40); shows on the Assets schedule |
| 5 | Reimbursed flag (D.4b) | Open a work expense → tick **"My employer reimbursed me for this"** | The line drops out of the deduction position (Dashboard/Filing total decreases) |
| 6 | Rent explainer (D.4c) | Open a rent-like line | Note: "Rent isn't deductible for an employee — your home-office running costs are" |
| 7 | Phone/internet badge (D.4c) | With WFH hours set, open a phone/internet line | Warn badge: "Already covered by the 70c rate — don't claim again" |
| 8 | Post-import landing (D.4c) | Bulk-import statements | Toast with a **"See your claims"** action → Dashboard |
| 9 | Evidence reminder (D.4c) | Filing / hand-off | Footer: "Keep your evidence 5 years … contemporaneous WFH hours record … myDeductions" |
| 10 | Hand-off (existing) | Filing → Print / CSV | Position = salary − (WFH + confirmed items + self-bought depreciation); **no** employer-laptop depreciation |

**Pass criteria:** her position shows WFH ~$511 + confirmed non-statement items + any self-bought
equipment, and **never** a depreciation claim on the employer laptop or a reimbursed item.

---

## 3. Manual — Persona 2 (PAYG + Pty Ltd + 3 properties)

Set up: an `employment` entity, a `company` entity, two co-owned rentals, one father-occupied house.

| # | Feature (phase) | Steps | Expected |
|---|---|---|---|
| 1 | Company entity (B2.2) | Settings → add a `company` entity | `entity_type=company`, `base_rate_entity=1` (defaults); a `business` income-activity is seeded |
| 2 | Payer≠claimant — Cloudflare (B2/C) | Open the Cloudflare line → "Who paid vs who claims" panel → claim by **the company**, 100% | Claimed amount shown; "recorded as a loan from you to the company" note. **$0 against salary**; appears in the company track |
| 3 | Co-owned split — TR 93/32 (B2) | Open a co-owned-property bill paid 100% by him → attribute to **himself**, share **50%**, activity = the rental | Claimed = **50%** of the bill; per-property position reflects his half |
| 4 | Father's house use_status (D.4a) | Settings → the father's property → edit → **"How was it used? = Private use — a relative lives there rent-free"** | Warn explainer (no deductions; CGT cost base still accrues); its expenses are **denied** in the position |
| 5 | Company position (C) | Filing → company section | Pre-revenue company shows a **carried-forward loss = its deductions**, a **shareholder-loan balance** (person→company, *not* Div 7A), R&D flagged only if a registered `rd_claims` row exists |
| 6 | Negative gearing | Filing → per-property | The two rentals net a loss (his share) that offsets salary; the father's house = **$0** |

**Pass criteria:** the Cloudflare bill never reduces his salary (it's a company loss + shareholder
loan); co-owned deductions follow legal title; the rent-free house yields nothing while accruing
CGT cost base. No "renovation" framing is offered.

---

## 4. Safety / regression spot-checks

- **Flag-off parity:** the engine is gated by `attribution_engine`; with no attribution rows a
  tenant's position is byte-identical (proved by the flag-off persona checks).
- **No double-claim:** a line covered by the WFH 70c rate (phone/internet) and the itemised
  receipt are never both counted.
- **Audit-risk framing:** rent-free property and any company-vs-salary routing show the
  general-info / defer-to-agent explainer; nothing predicts a refund or a $ tax figure.
