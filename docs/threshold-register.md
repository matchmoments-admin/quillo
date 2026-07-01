# Threshold register — `thresholds_by_fy` runbook

The single source of truth for every year-specific tax constant is
`src/rulepacks/au-v1.json` → `thresholds_by_fy` (all dollar values in **cents**). Engines read it
per-FY (`buildReport` → `src/lib/report.ts`), never inline; `src/lib/work-use.ts` holds
order-of-magnitude fallbacks only. **Current values are pinned in `scripts/check-units.ts`
("threshold register" block) — that block, not this doc, is the guarded record of the numbers.**

Three layers keep the register honest:

1. **Test guard** (`scripts/check-units.ts`): fails the suite if the current FY — or, within 45
   days of the next FY's first day — has no block; if any block misses an engine-consumed key or
   carries a non-numeric value; if FY blocks drift out of key-set lockstep; and pins the statutory
   values per FY.
2. **Push gate** (`scripts/push-rulepack.mjs`): the same structural rules run before any KV write,
   because the KV pack (`rulepack:au-v1`) fully **shadows** the bundled default — a bad push would
   silently serve wrong rates while tests stay green. Keep its `REQUIRED_KEYS` in sync with the
   test guard's.
3. **Deploy coupling** (`package.json`): `npm run deploy` runs `wrangler deploy` **and then
   `rulepack:push`**, so the KV shadow can't drift from the deployed bundle. (Depreciation reads
   the bundled pack; report/readiness read KV-first — drift between them mixes statutory values
   within one report.)

**A rule must never hardcode a bare year-specific number — including in prose.** Rule notes and
occupation-guide text must stay FY-neutral ("the ATO fixed rate per hour", not "70c/hr"); the SPA
must read rates from the API (see `/api/car-use` → `rates`), never inline them. Add a new key to
*every* FY block (lockstep is enforced), and if it is informational only, list it in
`_reference_only_keys`.

## Key → legal source

| Key | What it is | Source to re-verify against |
|---|---|---|
| `car_cents_per_km` / `car_km_cap` | D1 cents-per-km rate; work-km cap per car | Annual legislative instrument (LI 2024/19 for 2024-25/2025-26; LI 2026/19 for 2026-27 — 89c base + 2c one-off uplift; future years index the 89c base) |
| `wfh_fixed_rate_cents_per_hour` | WFH fixed rate (bundles energy/phone/internet/stationery) | PCG 2023/1; check each year |
| `instant_asset_write_off_cents` | Small-business instant asset write-off, per asset | Budget measure / ITAA. **$20k law to 30 Jun 2026; $1,000 from 1 Jul 2026 by current law.** A proposed permanent $20k (May 2026 Budget) is NOT yet law — track enacted status, not announcements |
| `car_limit_cents` | Depreciation cost limit for cars | Annual indexation TD (ATO "car thresholds from 1 July" page) |
| `super_concessional_cap_cents` | Concessional contributions cap | s 960-285 AWOTE indexation, confirmed via ATO each Feb |
| `super_non_concessional_cap_cents` | **Reference-only.** NCC cap (4× concessional) | Same indexation. Never computed — bring-forward + total-super-balance conditions are agent territory |
| `low_value_pool_threshold_cents` | Low-value pool entry (<$1,000) | Div 40 ITAA 1997 (stable) |
| `immediate_non_business_cents` | $300 immediate deduction, non-business individual | s 40-80(2) (stable) |
| `gst_registration_threshold_cents` | GST registration turnover threshold (taxi/rideshare must register from the first dollar regardless) | GST Act Div 23 / Div 144 |
| `div293_threshold_cents` | Reference-only; defer-nudge input | s 293-20 ($250k, unindexed) |
| `mls_single_threshold_cents`, `base_rate_company_tax_pct`, `full_company_tax_pct` | Reference-only, unconsumed (no tax-payable computation, by design) | ATO MLS pages / ITR Act |
| `div7a_benchmark_rate_pct` | **Reference-only, unconsumed.** Div 7A benchmark interest rate | ATO annual determination (RBA indicator rate last published before 1 July) — **changes every year; the 2026-27 rate was unpublished at the July 2026 review, so the pack carries the last published rate (8.37%, 2025-26) until the ATO posts it** |
| `rd_refundable_turnover_cap_cents`, `rd_premium_pct` | R&D tax offset params | Div 355 ITAA 1997 |
| `s40_880_years` | Blackhole expenditure write-off period | s 40-880 (stable) |

## Review cadence

**April–May (Federal Budget):**
- Sweep Budget papers for: IAWO, cents/km, car limit, super caps, WFH rate, Medicare/MLS,
  CGT/negative-gearing structural measures.
- Record each relevant measure's **legislative status** (announced / before Parliament / enacted).
  Only enacted law goes into a threshold value; announced-but-not-law items get a note here.

**June (pre-EOFY):**
- Stage the incoming FY's block with every key re-verified against ato.gov.au and the instruments
  above (the check-units guard starts demanding it 45 days out).
- Re-pin the new values in `scripts/check-units.ts` (threshold-register block).
- Sweep prose for year-specific rates that crept in (`grep -n "c/km\|c/hr\|\\$[0-9]" src/rulepacks/`).

**July (post-EOFY):**
- Re-verify `div7a_benchmark_rate_pct` for the new FY once the ATO publishes it.

## Update procedure

1. Edit **all** FY blocks in `src/rulepacks/au-v1.json` (lockstep keys; cents).
2. Update the pins in `scripts/check-units.ts`; `npm test` must pass.
3. Keep rule prose FY-neutral (no rates or year ranges in notes).
4. Ship per CLAUDE.md loop. `npm run deploy` pushes the pack to KV automatically; a standalone
   `npm run rulepack:push` also works (both validate before writing). Smoke-test a report for the
   new FY.

## Known not-yet-law items (as of July 2026)

- Permanent $20k IAWO (12 May 2026 Budget) — not law; register carries the $1,000 cliff.
- 2027 CGT discount → indexation reform and negative-gearing quarantine (1 Jul 2027 proposals) —
  would need a dual-regime CGT engine keyed to acquisition date; track, do not build.
- Medicare levy low-income threshold uplift for 2025-26 — reference-only values unaffected.
