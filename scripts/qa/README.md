# New-user QA suite (`scripts/qa`, #699)

Two npm scripts:

| Script | What it does | Writes? |
|---|---|---|
| `npm run qa:browser` | Drives the real SPA in Chromium against a local `wrangler dev`, at 1280px and 390px | Local scratch D1 only |
| `npm run qa:smoke-prod` | `GET https://app.quillo.au/healthz`, then cold loads of `/` and `/start` | Nothing. Never signs in. Every non-GET the page makes is aborted |

## What `qa:browser` covers

1. **First-timer journey.** Before you start, then Get set up (myTax check, APP-8 consent, the six
   questions, save), then Connect. Connect runs the error paths first (zero credit, a bad file, a 12 MB
   file) and then the happy path (upload `evals/statements/westpac-sample.csv`, import it, then import
   the next fortnight so pay recurs). After Connect come Review (one card action), Check
   (`/review/match`), Position (`/reports`), Lodge (the worksheet, the print view, mark as lodged) and
   Ask (the Why? drawer, `/api/guide`, `/api/chat`).
   - At 1280px the answers are a resident PAYG worker.
   - At 390px they are a working-holiday newcomer, which exercises `residency_assessability`.
2. **Billing** renders the wallet and makes no Stripe call. **Settings → Privacy** checks that
   cancelling "withdraw consent" changes nothing, that export downloads a file, and that dismissing the
   delete-account prompt (or typing the wrong word) deletes nothing.
3. **Route sweep.** Every route in `docs/architecture/feature-inventory.md` is loaded three times: on an
   empty tenant and on a seeded tenant with the journey flags ON, then with production's flag set (the
   legacy pages).
4. **Personas.** P1 Maya, P6 Susan & Greg, P4 Priya and P8 James are seeded through the public API. Each
   persona checks that the position API reflects the data and that the persona can see it on a page.
   When the UI doesn't show it, that is recorded as a **gap**, not a failure.

Every page load asserts all of these:
- no React or router error screen and no 404;
- no uncaught console or page error;
- no 5xx;
- no horizontal scroll at 390px;
- no request off localhost.

Each action also asserts visible feedback: a toast, a `role=status` or `role=alert`, or the expected text.

The output goes to `.qa/report.md` and `.qa/report.json`. The report has:
- a journey × viewport table;
- a verdict for each journey flag;
- the failures;
- the gaps.

The run exits with 1 when there is a failure that `known.ts` doesn't list.

## Why it can't spend money or touch real data

- **The server reads only `.qa/qa.env`**, which contains `DEV_AUTH_BYPASS=1`. `--env-file` replaces
  `.dev.vars`, so no API key is loaded at all.
- **`CLERK_ISSUER` is set to empty**, which selects the bypass path.
- **`QA_LLM_STUB=1`** swaps every model call for `src/lib/llm-stub.ts`. The stub is honoured only together
  with `DEV_AUTH_BYPASS=1` and an empty `CLERK_ISSUER`. Production sets `CLERK_ISSUER` in
  `wrangler.toml`, and a check-units golden proves the stub can't switch on there.
- **The SPA is a `vite build --mode qa` bundle in `web/dist-qa`.** It skips the Clerk session gate only
  on a loopback host. The production bundle (`web/dist`) has no such branch: the suite checks this, and
  so does a golden.
- **Each server has its own persist directory** (`.qa/state-<name>`), and the suite refuses a port that
  is already in use. Set `QA_PORT` to change the port (default 8796).
- **Chromium aborts every request that leaves localhost.**

`api_rate_limit` is left OFF in the QA servers. A scripted sweep loads about 45 pages a minute and would
trip the 300/min per-user limit.

## Where it runs: its own CI job, not `npm test`

`npm test` is the unit gate. It runs in seconds, in-process, with no browser and no network.
This suite boots `wrangler dev` seven times, needs a Chromium binary, and takes several minutes. It is
hermetic: no secrets and no network beyond localhost. But it is not fast, so it runs as
`.github/workflows/qa.yml` on PRs that touch `src/`, `web/`, `scripts/qa/`, the migrations, the schema
or `wrangler.toml`.

Known defects are listed in `known.ts`, each with its issue number. They are reported but don't fail
the job, so the job stays green until something **new** breaks. When an issue is fixed, delete its
entry, so the check guards the fix from then on.

## Running it

```bash
npm run qa:browser                       # everything (~10 min)
npx tsx scripts/qa/run.ts --only=journeys --vp=desktop   # one slice
npm run qa:smoke-prod                    # read-only prod check
```

`playwright` is a transitive dependency (promptfoo → playwright-extra). In CI the job installs its
browser with `npx --no-install playwright install --with-deps chromium`. In a worktree, symlink
`node_modules` and `web/node_modules` from the main checkout first.
