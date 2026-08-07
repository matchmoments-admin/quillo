# Bank feeds — the state of play, and what happens next

> **Read this first.** State as at **2026-08-07**, `main@af4933e`, clean tree. Everything described
> as shipped is **merged and deployed**, but the feature is **flag-OFF and sandbox-only** — no real
> consumer data has ever flowed through it.
>
> The companion doc for the owner's own return is [`fy2025-26-handoff.md`](fy2025-26-handoff.md).
> The design is [ADR-0003](adr-0003-bank-feed-cdr-access.md); this file is *where we are*.
>
> **GENERAL INFORMATION ONLY.** The CDR/PS8 positions here are engineering inputs, not legal advice.
> ADR-0003 is explicit that the representative arrangement needs an Australian privacy/CDR lawyer
> before signing.

---

## 1. One-line summary

**The connector is built and the compliance guards are real; what's missing is a consent dashboard,
a bounded backfill, and — entirely outside the code — a commercial arrangement with Basiq.**

## 2. Shipped this session

| PR | What | Migration |
|---|---|---|
| [#504](https://github.com/matchmoments-admin/quillo/pull/504) | **Auth fails closed** — a missing `CLERK_ISSUER` used to return an *authenticated* founder tenant | — |
| [#505](https://github.com/matchmoments-admin/quillo/pull/505) | **Residency guard is jurisdiction-scoped and actually checks the region** (it previously checked only the provider, so Bedrock + `us-east-1` passed an "AU residency" assert) | — |
| [#502](https://github.com/matchmoments-admin/quillo/pull/502) | Basiq foundation — schema, transport client, `bank_feed_cdr` flag | `0075` |
| [#506](https://github.com/matchmoments-admin/quillo/pull/506) | Connect flow + account picker | `0076` |
| [#507](https://github.com/matchmoments-admin/quillo/pull/507) | Sync fed lines into the ledger | — |
| [#508](https://github.com/matchmoments-admin/quillo/pull/508) | **R1** — closed two double-counting paths found by review | — |
| [#509](https://github.com/matchmoments-admin/quillo/pull/509) | **R2** — moved the CDR residency guard onto the data | `0077` |

Gates at handoff: **units 1134**, personas **306/306**, e2e 12/12, AU snapshot byte-identical,
schema drift clean (809 columns). Migrations applied through `0077`. **Next free: `0078`.**

## 3. What a 5-agent review found — and the lesson worth keeping

`/local-ultrareview` on #507 returned **2 BLOCKER + 8 HIGH**. Both blockers were verified against
the code and both are now fixed (#508, #509). They shared one shape:

> **A rule enforced at a call site instead of at a seam.**

1. **Half an invariant in each of two places.** `parseStatement` refused a QuickBooks account;
   `bankSelectAccounts` refused a feed onto a statement account. So a feed could be mapped and
   statements uploaded *afterwards*, and every overlapping dollar counted twice — silently, because
   statements hash content and feeds hash the provider id, so they never collide on the unique index
   and no downstream dedup could catch it. Now one function, `assertCanonicalSource`.
2. **A compliance check attached to one function.** The sync asserted PS8 residency inside its own
   categoriser, while the Ask/chat digest read the same rows unguarded. There are **14** `getLLM`
   call sites. The assert now lives *inside* `getLLM` — all 14 covered without touching one.

**If you take one thing from this handoff:** a self-read did not catch either. Both were found by
independent reviewers looking at the same diff through different lenses.

## 4. Compliance model, as built

- **`bank_connections.access_type`** (`'cdr' | 'web'`, default `'cdr'` = fail-closed) carries the
  legal difference. Web-connector data is ordinary personal information under APP-8; CDR data is not.
- **`requiresAuResidency` = `access_type='cdr'` AND `BASIQ_ENV='production'`.** The sandbox carve-out
  is what makes the feed testable before Bedrock is live — Hooli data is synthetic, so there is no
  consumer and no safeguard to breach.
- **`profiles.cdr_tainted`** (0077) is **one-way**. Once a tenant holds production CDR data,
  `getLLM` refuses non-AU-resident inference for them **on every path**. Nothing clears it —
  revoking a consent stops future *collection*, it does not change what the safeguards cover.
  ⚠️ **PR5's disconnect must not be written to clear this.**
- **Accepted consequence:** a tainted tenant needs Bedrock for *all* inference, receipt OCR and chat
  included. Filtering CDR rows out of prompts instead would answer "you spent $X" from a knowingly
  incomplete ledger — a worse failure than refusing.

## 5. Bedrock — wired, not operational

Verified against account `417755753627`:

- ✅ `au.anthropic.claude-haiku-4-5-20251001-v1:0` is ACTIVE and routes to **ap-southeast-2 +
  ap-southeast-4 only — no New Zealand** (from `get-inference-profile`, not documentation). Pinned
  by a golden so it can't silently widen to ANZ — "ANZ" is not "Australia" for a PS8 claim.
- ✅ IAM `QuilloBedrockAuInvoke` — allow only the `au.` profile + AU model ARNs, explicit deny
  outside AU regions. **Tested: a `us-east-1` call was refused by policy.**
- ✅ Runtime credentials in prod secrets.
- ❌ **BLOCKED: the Anthropic use-case form has not been submitted.** Every `InvokeModel` returns
  `ResourceNotFoundException: Model use case details have not been submitted`. Bedrock console →
  Model access → Anthropic, in **both** Sydney and Melbourne, then ~15 min.
- ❌ No tenant flipped (`profiles.inference_provider` is still the env default). Deliberate — flipping
  before the form clears would just make the app throw.

> ⚠️ **CONFIG.md's old SCP advice was wrong** — SCPs need AWS Organizations and this is a standalone
> account. The identity-based deny above is the equivalent control. Already corrected.

## 6. What is NOT done

| | Why it matters |
|---|---|
| **PR5 — consent dashboard, disconnect, PS12 delete, CDR audit log** | ADR-0003 §6.4: *"the feature is not shippable without it."* **This is the gate on flipping the flag.** `purgeTenant` also does not yet revoke upstream (`deleteBasiqUser` exists, unwired) |
| **R3 — bounded backfill** | `bankSync` does up to 200 pages × 500 rows in ONE DO request with statements accumulated in memory; blows the 1000-subrequest cap around ~45k rows. Also: the `bank_sync_runs` row is written *after* the work, so the failures that most need evidence leave none. Needed before real data, not before the flag |
| **The `account.id` provider filter is UNVERIFIED** | Basiq documents the field as filterable but not the operator grammar; the local key was stale so it couldn't be tested. Flagged in `basiq.ts`. If it is silently ignored, the data-minimisation claim is false |
| **S8b — redaction on statement lines** | Deliberately declined: `redact()` eats any 6+ digit run, so extending it changes categorisation and therefore the position. Needs its own flag + persona golden |
| **No persona golden for the feed** | Judged out of scope (flag OFF ⇒ byte-identical, so no golden could distinguish the states), but the three money-visible status decisions in `bankSync` — transfer⇒`ignored`, unconverted FX⇒`needs_review`, else⇒`extracted` — have no unit coverage |

Six further MEDIUM/LOW review findings are in the plan file, not yet ticketed.

## 7. Owner actions — nobody else can do these

1. **Submit the Anthropic use-case form** (Bedrock console, both AU regions). Blocks all Bedrock.
2. **Delete the `quillo-setup` IAM access key.** Part of the secret appeared in a screenshot; the
   key has done its job.
3. **Send the Basiq message** — draft delivered. Longest lead item, and its answers resolve
   [#474](https://github.com/matchmoments-admin/quillo/issues/474) (PS8 option A/B/C) and
   [#475](https://github.com/matchmoments-admin/quillo/issues/475) (fees) as a side effect. Ask
   early whether their representative arrangement permits naming **Cloudflare and AWS as OSPs** —
   a "no" forces sponsored accreditation and changes the whole plan.
4. **Configure the redirect URL** in the Basiq dashboard → `https://app.quillo.au/api/bank/callback`
   (or `http://localhost:8788/api/bank/callback` for local testing).
5. **Refresh `BASIQ_API_KEY` in `.dev.vars`** — the local key is stale, which is what blocked
   verifying the account filter.

## 8. The uncomfortable fact

**FY2025-26 still holds 46 transactions against FY2024-25's 2,355.** This session built
infrastructure; the owner's actual return has not moved. The feed cannot help it in time — a
representative arrangement is weeks away at best. **If the return is the priority, the statement
path ([#465](https://github.com/matchmoments-admin/quillo/issues/465) /
[#466](https://github.com/matchmoments-admin/quillo/issues/466)) is still the only route that
files this year**, and #466 was estimated at minutes.

## 9. Local dev now works — use it

`wrangler dev` runs (macOS 26.2; the "deploy-only" note was years stale and is now corrected in
CLAUDE.md). The whole connect flow was exercised against the **Hooli OB** sandbox this way.

```bash
npx wrangler d1 execute tax-agent-db --local --file=schema.sql   # once
FEAT=$(grep '^FEATURES' wrangler.toml | sed 's/^FEATURES = "//; s/"$//')
npx wrangler dev --port 8788 --var "FEATURES:${FEAT},bank_feed_cdr" --var "CLERK_ISSUER:"
```

`CLERK_ISSUER:` empty activates the `DEV_AUTH_BYPASS=1` path in `.dev.vars`; flags come from
`wrangler.toml`, so the extra one has to be passed in.
