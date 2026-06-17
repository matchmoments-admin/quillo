# CLAUDE.md — Quillo (tax-agent) working agreement

> How Claude Code should work in this repo. The build spec for the v2 feature work lives in
> the commit history / `/Users/brendanmilton/.claude/plans/`. This file is the **operating
> manual**: orientation + the ship workflow. Keep it short; link out, don't inline.

## What this is
Quillo is an Australian tax-evidence assistant on **Cloudflare**: a Worker (`src/`) + a
per-tenant `TaxAgent` Durable Object, D1 (`tax-agent-db`), R2 (`tax-agent-receipts`), KV
(`RULES`), and a React/Vite SPA (`web/`) served by the same Worker. It captures receipts,
bank lines, income, assets/depreciation and documents; categorises with Claude; and produces
a tax-position report. **General information only — never tax advice.**

> Architecture note: the DO is a **write-coordinator**, D1 is the store **and the scale ceiling**
> (the per-DO SQLite is declared but unused). See [`docs/adr-0001`](docs/adr-0001-do-write-coordinator-d1-ceiling.md).

## Commands
- `npm run typecheck` — server (tsc). `npm --prefix web exec tsc -- --noEmit` — SPA.
- `npm test` — unit goldens (`scripts/check-units.ts`) + statement reconciliation. `npm run test:units` for just units.
- `npm run eval` / `npm run eval:gate` — promptfoo categorisation eval (this is what CI runs: `.github/workflows/evals.yml`).
- `npm run web:build` — build the SPA. `npm run deploy` (`wrangler deploy`) — deploy the Worker.
- Migrations: `npx wrangler d1 execute tax-agent-db --remote --file=migrations/NNNN_x.sql` (in order).
- `npm run rulepack:push` — push `src/rulepacks/au-v1.json` to KV `rulepack:au-v1` (**do this whenever the rule pack changes** — KV shadows the bundled default).

## Non-negotiable invariants
- **Multi-tenant**: every table has `user_id`; identity is derived server-side (verified HMAC key / Clerk / mailbox), **never** a client header.
- **One canonical money source per account** (QBO feed XOR statement) — never double-count. QBO is reader/reconciler; never auto-post what a feed already provides.
- **APP-8 consent gate**: any US/`anthropic` inference on personal data needs recorded consent; the gate runs **before** any model call. Bedrock/AU is the residency path.
- **Migrations are additive + apply-once**: `CREATE TABLE/INDEX IF NOT EXISTS`, `ALTER TABLE ADD COLUMN`, idempotent backfills (`INSERT OR IGNORE`, guarded `UPDATE`). New migrations continue the `00NN_` sequence; keep `schema.sql` in lockstep. New tenant tables MUST be added to `PURGE_TABLES` (`src/lib/retention.ts`).
- **Persona coverage is a contract**: the 10 taxpayer personas ([`docs/personas.md`](docs/personas.md)) are the coverage lens. **Any change to the data model, the money/tax-position pipeline (`report.ts`/`ledger-totals.ts`), or the user workflow MUST keep `npm run test:personas` green for all 10** and update `docs/personas.md` if coverage changes. A new tax feature lands **additive + feature-flag-gated** (flag OFF ⇒ byte-identical) and **adds or flips a persona golden in the same PR**. Shipping an engine is not "done" until the front end lets the relevant persona enter the data and see the result (engine ✓ + UI ✓ + display ✓) — track the UI/API gap if you defer it, don't silently call it complete.
- **GENERAL-INFO framing** on every suggestion; `defer_to_agent` rules say "confirm with a registered tax agent"; never predict a refund amount.
- **Design to the standard**: before building a new feature or planning a database/data-model change, sanity-check the design against how the established players model it — **Xero / MYOB / QuickBooks** for bookkeeping / GL / invoicing / payroll shapes; the **ATO Standard Distribution Statement / AMMA** + SMSF-admin tools (**Simple Fund 360, BGL**) for tax-specific structures. **Don't drift from the standard unless our design is clearly better** — and when it is, prefer the simpler, more scalable, future-proof shape (generalise the mechanism rather than special-case it). Composes with the additive / flag-gated / persona-coverage / jurisdiction-neutral invariants above.
- **Local runtime is deploy-only** (macOS 12.6 can't run workerd) — verify via typecheck + `npm test`, then deploy to test live.

---

## Ship workflow — default to shipping (the autonomy contract)

**When a unit of work is complete and green, drive it all the way to production without
pausing for step-by-step approval.** The owner wants to test working changes in prod, not
babysit branching. Do the due diligence below, then ship.

### The loop (run end-to-end, autonomously)
1. **Branch** off `main` for anything non-trivial: `git checkout main && git pull --ff-only && git checkout -b <scope>/<short-name>`. (Trivial one-line fixes may go straight on a branch too — just never commit on `main`.)
2. **Build green** — `npm run typecheck` + web tsc + `npm test` (which includes `test:personas` — all 10 personas). All must pass before going further. If you touched the data model, the position pipeline or the workflow, confirm the persona goldens still hold (and add/flip one for the change). If a change touches the rule pack, also reason about the eval gate.
3. **Quick review, proportional to risk** — read your own diff; for anything touching **money/tax math, migrations, auth, or the ingest/report path**, run `/code-review` (high effort, like the v2 pass). For small UI/copy/config, a self-read is enough.
4. **Fix confirmed findings** in the same branch; re-run the gates. Note genuinely low/edge deferrals in the PR body rather than fixing everything.
5. **Commit** — explicit, descriptive message (WHY, not just what), end with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer. Prefer staging the specific files you changed.
6. **Push + open a PR** — `git push -u origin <branch>` then `gh pr create --base main`. PR body: what changed, migrations touched + whether applied, the review verdict, and any deferred items.
7. **Migrate** — apply new migrations to remote D1 **in order**, then verify (`SELECT name FROM sqlite_master …`, spot-check a backfill). Migrations must be additive/idempotent.
8. **Merge** — `gh pr merge --squash --delete-branch` (or a fast-forward merge to `main`), then push `main`.
9. **Deploy** — `npm run web:build && npm run deploy`; push the rule pack to KV if it changed; `curl -s https://app.quillo.au/healthz` and smoke-test the touched surface.
10. **Report** — a tight summary: what shipped, what's live (note the single-user Clerk gate + APP-8 consent), migrations applied, review findings fixed/deferred, and any follow-ups.

CI (`evals.yml`) runs the categorisation eval on PRs — it's a signal, not a deploy gate (deploys are manual via wrangler). Don't block a merge on an unrelated pre-existing eval drift; flag it instead.

### Issue hygiene (keep the backlog honest)
The backlog lives in **GitHub Issues** (`gh` CLI); epics are tracking issues labelled `epic`, with
children linked to their epic (no issue gets two epics). Labels already in use: `severity:{blocker,
high,medium,low}`, `area:*`, `priority:{p1,p2,p3}`, `epic`, `needs-decision` (owner sign-off — touches
money/tax output or is net-new). Treat triage as part of the loop, not a separate chore:
- **Sweep** at the start of any new wave/epic, and whenever a PR closes issues: bucket each open issue
  as **keep / done / superseded / wontfix / needs-decision**. Cross-check against recent commits,
  closed issues, and the code before deciding — don't guess from the title.
- **Every closure cites evidence** (commit, PR, closed-issue #, or code path) in a one-line closing
  comment. Set the reason: `state_reason=completed` for shipped work, `not_planned` for superseded /
  won't-do (name the successor). With this older `gh` (no `--reason` flag): `gh issue comment N -b …`
  then `gh api repos/{owner}/{repo}/issues/N -X PATCH -f state=closed -f state_reason=…`.
- **Epics:** when an epic's headline item ships, re-evaluate the umbrella for closure — don't leave
  parking issues open once their core item lands.
- **`needs-decision` is never auto-closed.** Surface the fork via `AskUserQuestion` and hold — this
  composes with "When to STOP and ask" below.

### When to STOP and ask (do not auto-ship)
- A migration is **destructive or non-additive** (DROP/rename/data rewrite) — needs an explicit go + a reverse plan.
- The change would alter **money/tax outputs** in a way that's a genuine product/judgement call, not a clear bug fix.
- A review finding is real but the **fix is ambiguous** or trades off behaviour the owner should choose.
- An **outward-facing action beyond deploy** (emailing users, public marketing/landing changes, anything touching the waitlist or third-party registrations).
- A **due-diligence gate fails** and you can't resolve it cleanly.

In those cases, surface the decision crisply (use AskUserQuestion for real forks) and hold. Otherwise: ship, then tell me what you did.
