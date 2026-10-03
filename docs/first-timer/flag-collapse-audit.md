# Which Wave 1 flag collapses are actually safe?

> Findings for wayfinder ticket #440 on map #529 (*Ship-it-yourself — Quillo for first-time
> taxpayers*), which absorbed the old simplify-workflow map #432. Audited 2026-10-03 against `main`
> at `e441af4`. The Wave 1 list comes from
> [`docs/ux/dashboard-simplification-review-2026-07.md`](../ux/dashboard-simplification-review-2026-07.md)
> ("Wave 1 — Subtract the dead generations"). Many of that dossier's line numbers have drifted, so
> every reference below was re-read at `e441af4`.

## Verdict

Of the 24 flags/surfaces Wave 1 touches, **12 flag keys can be retired and about 530 lines deleted
without changing anything production does.** That work is five PR-sized batches (below), and they
are `build-ready` candidates. The rest split like this:

| Class | Count | Flags |
|---|---|---|
| **SAFE** | 10 | `guidance_v2`, `journey_spine`, `onboarding_checklist`, `checklist_v2`, `adaptive_dashboard`, `floating_chat`*, `wfh_hours_simple`, `categorise_v2`, `txn_drawer`, `grouped_review` |
| **SAFE-WITH-GOLDEN-CHANGE** | 2 | `refund_netting_v2` (folded into `refund_netting`), `loan_split` (plus the orphaned loan-split write path) |
| **KEEP: genuine kill-switch, no dead branch** | 7 | `ask_quillo`, `grouped_review_v2`, `unified_review_groups`, `accountant_pass`, `txn_scan_v2`, `ask_actions_v2`, `accountant_schedule_v2` (and `refund_netting` stays as the refund-netting switch) |
| **NOT SAFE** (flag OFF in prod) | 1 | `bank_feed_cdr` (OFF, not Wave 1; listed so the OFF set is complete) |
| **NEEDS-DECISION** | 2 | `partnership_losses`, `phi_tax_inputs` |

\* `floating_chat` is safe only if FloatingChat is re-gated on `ask_quillo` in the same PR (see Batch 2).

**The critic was right about the review trio.** Merging `grouped_review` / `grouped_review_v2` /
`unified_review_groups` into one key would be a mistake. Only `grouped_review` is a pure SPA branch.

## Method

- **Which flags are ON in prod.** Parsed `wrangler.toml:80` `FEATURES` (95 keys) against
  `FEATURE_KEYS` in `src/lib/features.ts` (98 keys). Three are OFF: `bank_feed_cdr`,
  `partnership_losses` and `phi_tax_inputs`. `featureOn` (`src/lib/features.ts:130`) is
  **env-global**: there is no per-tenant override and `JURISDICTION = "AU"` only. So an ON flag is ON
  for every tenant, and no tenant or jurisdiction can still be on an OFF branch.
- **Read sites.** Server: `grep -a 'featureOn('` over `src/` (the `-a` matters, see
  `memory/MEMORY.md` on NUL bytes; `report.ts` is clean today and `npm test` guards it). SPA:
  `grep 'has("'` over `web/src/`. Today that is **135 server sites and 103 SPA sites (238 in all)**,
  up from the 193 the old plan counted.
- **Goldens.** The flags the test harnesses run with differ from prod, and that difference decides
  between SAFE and SAFE-WITH-GOLDEN-CHANGE:
  - `scripts/check-personas.ts:54` runs 18 flags, with `refund_netting` ON and `refund_netting_v2`
    **OFF**.
  - Overrides at `:467`, `:485`, `:602`, `:1415`, `:1514`, `:1525` and `:1753`. The UK-seam
    `envOff` at `:1753` omits `loan_split`.
  - `scripts/check-au-snapshot.ts:57` and `scripts/e2e-journey.ts:42`.
  - SPA flags have no golden. The SPA has no component tests, and `scripts/check-mobile-shell.ts`
    regex-scans `web/src/App.tsx` text.
- **Line counts.** These are hand-measured contiguous dead ranges at `e441af4` (whole files, branch
  bodies, handlers and state used only by the dead branch, imports, one `FEATURE_KEYS` line per
  retired key). Comment rewrites are not counted. Treat each figure as ±10%. They are measured
  ranges, not an extrapolation.

## Per-flag rulings

### Guidance shell

| Flag | Prod | Class | Evidence | Ruling |
|---|---|---|---|---|
| `guidance_v2` | ON | **SAFE** | Only read site `web/src/App.tsx:187`. The else branch `:194-213` mounts `NextActionBar` + `TabGuide` + the un-enhanced spine. | Inline true. Delete `web/src/components/NextAction.tsx` (49 lines, only importer `App.tsx:11`), the else branch, the `enhanced` prop and the `if (!enhanced) return spineNav` at `JourneySpine.tsx:86`. **Keep `TabGuide.tsx`**: it is live inside the enhanced spine (`JourneySpine.tsx:125`, imported at `:5`). **Visible fix:** `useFeatures().has` returns false until the dashboard payload loads (`web/src/lib/features.ts:16`), and `App.tsx` has no `loaded` gate. So today the v1 bar paints on every cold load and then swaps out. Inlining removes that layout shift. |
| `journey_spine` | ON | **SAFE** | Only read `App.tsx:207`, inside the dead v1 branch. The enhanced spine never reads it. | Retire with `guidance_v2`. |

### Dashboard

| Flag | Prod | Class | Evidence | Ruling |
|---|---|---|---|---|
| `onboarding_checklist` + `checklist_v2` | ON + ON | **SAFE** | `Dashboard.tsx:74` `has("onboarding_checklist") && !has("checklist_v2")` is false in prod and false while loading. `Dashboard.tsx:182` `showEvidence = both`, so it is always true in prod. That makes the early return at `Dashboard.tsx:205-224` dead. `SetupChecklist.tsx:157-175`: only the `embedded` return is reachable. | Delete the `:74` mount and the `:205-224` early return. Hard-code `showEvidence`. Drop SetupChecklist's non-embedded return and its `embedded` prop. Retire both keys. |
| `ask_quillo` (SPA read only) | ON | dead mount **SAFE**; key **KEEP** | `Dashboard.tsx:82` `has("ask_quillo") && !has("floating_chat")` is false. The key also gates `POST /api/ask` (`src/api.ts:362`) and `/api/chat` (`src/api.ts:377`). | Delete the mount, `AskQuillo()` (`AskQuillo.tsx:8-97`) and `SaveRule` (`:169-182`, no external consumer; FloatingChat has its own `SaveRuleInline`). Move `ProposedActionCard` (+`STATE_LABEL`) to its own file for `ScanFindings.tsx:5` and `chat/FloatingChat.tsx:8`. **Keep `ask_quillo`**: it is the server kill-switch on chat model spend. |
| `floating_chat` | ON | **SAFE** (re-gate) | Only read `chat/FloatingChat.tsx:35`. Once the Dashboard fallback is gone, it can disagree with the server: `ask_quillo` OFF with `floating_chat` ON leaves a bubble whose requests 404. | Re-gate FloatingChat on `has("ask_quillo")` and retire `floating_chat`. Both are ON, so prod is unchanged. The chat UI then follows the one real switch. |
| `adaptive_dashboard` | ON | **SAFE** | `Dashboard.tsx:21` plus three `!adaptive \|\|` guards (`:102`, `:104`, `:127`). Once inlined, each panel's `.length ? … : <Empty/>` fallback is also unreachable. | Inline. Keep the `.length > 0` conditions. Delete the two `<Empty/>` fallbacks. Also delete the stale "NextActionBar" comment at `Dashboard.tsx:48-50`. |

### Calculators, transaction detail, review list

| Flag | Prod | Class | Evidence | Ruling |
|---|---|---|---|---|
| `wfh_hours_simple` | ON | **SAFE** | `WorkMethodsCard.tsx:33`. The else branch `:167-189`, and `onDays`/`onWeeks` (`:62-73`), are used only by it. The component also mounts on Reports, so the same cold-load flash applies there. | Inline. Delete the old three-field UI and its two handlers. The save payload is unchanged. |
| `txn_drawer` | ON | **SAFE** | `TxnDetail.tsx:191`. The non-drawer branches are `:408-428` and `:499-531`. | Inline `drawer = true`. Delete both branches. Keep `detailRelevant` (`:167`) and `moreOpen` (`:170-171`) where they are, above the early return, because of the hooks rule. |
| `categorise_v2` | ON | **SAFE** | Read only at `TxnDetail.tsx:184`, and used only inside the dead `:408-428` branch (`showDetail` `:28`, `v2cat`/`detailOpen` `:184-185`). | Retire with `txn_drawer`. The dead branch's `has("apply_to_siblings")` (`:507`) goes with it. That key keeps its other SPA read and its server reads. |
| `grouped_review` | ON | **SAFE** | SPA-only: `ReviewView.tsx:39`, `:154`, `:172`. The flat-list fallback is `:221-243`. No server read. | Inline. Delete the flat list. `Row` stays because the grouped list uses it at `:315` and `:383`. |
| `grouped_review_v2` | ON | **KEEP** | Gates a server endpoint (`src/api.ts:197`, 404 when OFF) and attaching `group_key` to the transactions payload (`src/api.ts:221`). | Real kill-switch on a whole-queue aggregation and a payload contract. Do not merge it into `grouped_review`. |
| `unified_review_groups` | ON | **KEEP** (no dead code) | `ReviewView.tsx:41` `has("unified_review_groups") && groupedV2 && hasAccountantPass`. | Inlining the key removes 0 lines. The real gate is the conjunction with `accountant_pass`. Retire it with the ClarifyCard retirement (Wave 4 Part 2), or let the Sort redesign replace the surface. |
| `accountant_pass` | ON | **KEEP** | Server: `src/api.ts:1667`, `:1693`, `src/agent.ts:461` (all 404 or no-op when OFF). | Gates the clarify and "do my books" endpoints. |

### Money pipeline (`report.ts` / `accountant-schedule.ts`)

| Flag | Prod | Class | Evidence | Ruling |
|---|---|---|---|---|
| `refund_netting_v2` | ON | **SAFE-WITH-GOLDEN-CHANGE** | `src/lib/report.ts:724-776`. The v1 global-netting `else` is `:764-775`. The persona harness runs v2 **OFF**, so persona goldens use the v1 branch. The pinned v1 assertion is `scripts/check-personas.ts:487-489` (`r258off`); the dossier's `:404` has drifted. | Fold into `refund_netting`, which stays as the kill-switch. Delete the v1 branch. Re-key the three SPA reads (`TxnDetail.tsx:161`, `:167`, `:235`) to `has("refund_netting")`. Delete the `r258off` assertion and drop the `env258` override. Under the default env, `p258` then uses v2 directly. `pcrefund` (`:1833-1853`) links its refund to a confirmed-deductible expense, so v2 nets the same $200: no value change expected. Run `test:personas` to confirm. No change in prod, which already runs v2. |
| `loan_split` + loan-split write path | ON | **SAFE-WITH-GOLDEN-CHANGE** | The write routes `POST /api/movements/loan-split{,-group}` (`src/api.ts:1625-1658`) → `applyLoanSplit` / `applyLoanSplitGroup` (`src/agent.ts:5064-5166`, stubs at `src/env.ts:207-208`) have no caller in `web/src` or `scripts`: the UI was retired for `loan_interest_v2`. `honorApportion = featureOn(env, "loan_split")` is read at **two** sites, `src/lib/report.ts:411` (+`:412-413`, `:738`) and `src/lib/accountant-schedule.ts:223` (+`:233`). It honours work-use %, `deductible_amount_cents` and inline "not deductible", not only loan splits. | Delete the orphaned write path. **Inline `honorApportion = true` at both sites in one PR.** Doing one site only makes the schedule and the position disagree for persona 6 (Susan & Greg). Turning `loan_split` OFF is never safe: the position would count loan repayments gross and over-claim principal. So it is not a real kill-switch, and renaming the key is riskier than inlining it (a missed `wrangler.toml` edit would turn the over-claim on). Golden impact: the UK-seam `envOff` (`check-personas.ts:1753`) runs without `loan_split`. Its rows are plain, so no value change is expected, but it does run the OFF path. `check-units.ts:1654-1655` tests `positionAmountCents(row, bool)` directly, so keep the parameter or delete the OFF assertion. Prod and every other harness already run ON. |
| `txn_scan_v2` | ON | **KEEP** | `src/agent.ts:4014`. Additive facts with no else branch. | Collapsing removes about 2 lines and loses a working switch. |
| `ask_actions_v2` | ON | **KEEP** | `src/api.ts:402` (write surface, also needs `ai_edit_feed`) and `src/agent.ts:6768`. | Gates the AI write path. Keep. |
| `accountant_schedule_v2` | ON | **KEEP** | `src/lib/accountant-schedule.ts:1178`. Additive sections. The harness runs it OFF by default and ON at `check-personas.ts:1525`. | Collapsing removes about 2 lines and changes golden output. Keep. |

### OFF flags

| Flag | Prod | Class | Evidence | Ruling |
|---|---|---|---|---|
| `phi_tax_inputs` | OFF | **NEEDS-DECISION** | Zero `featureOn`/`has` reads. Only a harness mention at `check-personas.ts:429-432`. Its table (`phi_statement`, migration 0062) is live and in `PURGE_TABLES` (`src/lib/retention.ts:76`). The `FEATURE_KEYS` comment says "Held OFF pending owner sign-off (needs-decision)". | Deleting the key removes no code. But it is the only marker for an unbuilt, owner-gated feature (epic #297), so deleting it is a backlog decision, not cleanup. My view: leave it. MLS/PHI matters more to the grow path than to first-timers. |
| `partnership_losses` | OFF | **NEEDS-DECISION** (recommend: keep OFF for now) | `src/lib/ledger-totals.ts:546`. Goldens are at `scripts/check-personas.ts:1407-1421` (the issue's `:735-736` has drifted), and no persona in `docs/personas.md` depends on it. | **Not ready to flip.** (1) The flag comment says "a Div 35 non-commercial-loss defer note applies", but no code emits one: `readiness.ts:798-800` says Div 35 prompts are deferred. (2) The readiness position line renders only when `partnership.assessable_cents > 0` (`src/lib/readiness.ts:262`), so a loss would lower the headline with no line explaining it. That is the #444 display-leg defect again. OFF today floors the loss to $0, which overstates the position (conservative). ON could understate it when Div 35 quarantines the loss. No first-timer has a partnership and prod has no partnership rows. To flip it, first add the negative position line and a Div 35 defer finding, then flip. Or close it out as grow-path work. |
| `bank_feed_cdr` | OFF | **NOT SAFE** | ADR-0003. "DO NOT ENABLE" until the CDR legal review (#524) clears; the consent dashboard (#576) and bounded backfill (#511) shipped. | Out of scope. |

## Should any of this be kept for the first-timer redesign?

No dead branch is worth keeping. The redesign builds on the **ON** generation of each surface, and
git history keeps everything else.

- The enhanced `JourneySpine` and `TabGuide` are live and stay.
- `FloatingChat` is the chat runtime the "agent alongside" design builds on. The inline `AskQuillo()`
  card is an older, separate client (its own `Turn` type and its own `SaveRule`), not a reusable
  component.
- The flat review list and the three-field WFH form are what the ON generation replaced.

The **server-side** batches (4 and 5) pay off whatever the new IA becomes. The SPA batches (1-3) are
cheap, and they fix two real cold-load flashes (the v1 shell, and the v1 WFH form on Reports). They
are still worth doing before the redesign, because redesign tickets that edit `App.tsx`, `Dashboard`,
`TxnDetail` or `ReviewView` would otherwise be written against two generations. If a redesign ticket
replaces one of those pages wholesale first, skip that page's part of the batch.

## Build plan (SAFE set, PR-sized, in order)

Every PR retires its keys from `FEATURE_KEYS` **and** from the `wrangler.toml` `FEATURES` string, and
deletes every read in the same PR. A leftover wrangler token is harmless, since `enabledFeatures`
filters by `FEATURE_KEYS`. The real risk is the opposite: removing a key from the wrangler string
while a read still exists would send prod down the OFF branch. Gates for each PR: `npm run typecheck`,
`cd web && npx tsc --noEmit && npm run lint`, and `npm test` (all 10 personas).

One caveat: after a deploy, an already-open browser tab with the old bundle sees the retired keys as
missing and shows OFF branches until it reloads. That is cosmetic for Batches 1-3. For Batch 4 it
briefly hides the refund-link picker in stale tabs.

1. **Shell guidance**: `guidance_v2`, `journey_spine`. Delete `NextAction.tsx`, the `App.tsx` else
   branch and the spine's `enhanced` prop. About 78 lines. Re-run `npx tsx scripts/check-mobile-shell.ts`
   (whitespace-sensitive regexes over `App.tsx`). Smoke test: cold-load `/` and check there is no
   layout swap.
2. **Dashboard**: `onboarding_checklist`, `checklist_v2`, `adaptive_dashboard`, `floating_chat`
   (re-gate FloatingChat on `ask_quillo`). Delete the two dead mounts, `AskQuillo()` and `SaveRule`;
   move `ProposedActionCard` to its own file; delete the ChecklistCard early return and
   SetupChecklist's standalone return. About 166 lines (about 104 of them in `AskQuillo.tsx`).
3. **Detail and review**: `wfh_hours_simple`, `txn_drawer`, `categorise_v2`, `grouped_review`. About
   129 lines. Smoke test: open a supplier-refund transaction and check the "More options" drawer
   auto-opens on the refund link.
4. **Refund netting (money)**: fold `refund_netting_v2` into `refund_netting`, delete the v1 branch,
   change the golden. About 16 lines. Touches `report.ts`, so it needs `/local-ultrareview` (per
   `memory/MEMORY.md`, `/code-review` cannot be model-invoked).
5. **Apportionment (money)**: delete the orphaned loan-split write path and inline `honorApportion`
   at **both** sites. About 143 lines. `/local-ultrareview`. Confirm persona 6's schedule and position
   still tie (`check-personas.ts` schedule tie-back block, `:1512-1519`).

**Total: 12 keys retired, about 530 lines, with no change to what prod does.** Batches 1-3 are pure
SPA and independent of each other. Batches 4-5 are money-path and should land one at a time, each
followed by a deploy and a prod `/reports` spot-check.

**Not in this plan, but worth a later look:** about 60 other ON keys have SPA-only or server-only
reads that were not audited here. Many are additive with no else branch (for example
`mobile_bottom_tabs` and `nav_progress_strip`), so they are not obviously dead code. They should be
judged against the redesigned IA rather than swept now.
