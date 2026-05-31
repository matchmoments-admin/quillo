# Stage 6 — self-improvement eval harness

Measures the agent's **categorisation** (extracted fields → `bucket` + `ato_label`) and
gates any rule-pack/prompt change behind a regression check, so quality only moves up.

```
correction (in-app)  ──promoteToEvalCase()──▶  eval_cases (D1)
        │                                            │
        │                              npm run eval:export
        ▼                                            ▼
  user fixes a category               evals/cases/<user>.json  (golden cases, in git)
                                                     │
                            npm run eval (promptfoo) ▼   ── CI gate vs evals/baseline.json
                       Haiku categorises ─► graded: exact-match bucket + Opus judge label
```

## Run it

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... npm run eval     # runs evals/promptfooconfig.yaml
npm run eval:view                             # open the promptfoo web UI for the last run
```

The harness tests **categorisation from fields**, not OCR/vision (eval cases store fields,
not images). Image-based extraction-accuracy evals are a future extension.

## The improvement loop

1. A correction in the app is promoted to an `eval_cases` row after it recurs
   (`promoteToEvalCase()` in `src/agent.ts`).
2. `npm run eval:export` pulls `eval_cases` from D1 into committed fixtures under
   `evals/cases/<user>.json` (review the diff, commit — these are the golden cases).
3. To improve accuracy, edit `src/rulepacks/au-vN.json` (the single source of truth the
   Worker **and** this harness read) or the prompt in `evals/prompts/categorise.cjs`.
4. `npm run eval` → open a PR. CI (`.github/workflows/evals.yml`) reruns and **fails the
   PR if the pass rate regresses** below `evals/baseline.json` (plus a 70% absolute floor).
5. Merge only if it holds/beats baseline. Bump the rule-pack version and
   `npm run rulepack:push` to sync the deployed Worker (KV `rulepack:<version>`).

A coding agent (Claude/Codex) can draft step 3; the gate is what makes it safe to accept.

## Set the baseline (one-time)

`evals/baseline.json` ships with `passRate: 0`. After your first green `npm run eval`,
read the pass rate from `evals/results.json` and set `passRate` (0..1), then commit.

## Scoring tiers

- `is-json` — output must be valid JSON.
- `bucket_match` — **deterministic** exact-match on the `bucket` enum.
- `label_match` — **LLM-judge** (`llm-rubric`) on `ato_label`, graded by Opus.

## Honest caveats

- **Judge is same-family.** Opus grading Haiku mitigates but does not eliminate
  self-preference bias. A true cross-family judge (e.g. a non-Claude model) is a later
  option — set it via `defaultTest.options.provider` / the per-assertion `provider`.
- **Seed cases are illustrative, not vetted tax determinations.** `evals/cases/*.json`
  ships with placeholder AU examples (incl. negative controls) so the harness runs today.
  Replace them with real corrections via `eval:export`. Categorisation correctness must be
  confirmed with a registered tax/BAS agent — this is general information only.
- **Small-set overfitting.** Keep `evals/cases/holdout/` out of the gated set (it is) and
  use `npx promptfoo optimize --validation-split 0.2` when tuning prompts.
- **Verify output-shape field names** in `scripts/check-eval-baseline.mjs` against your
  installed promptfoo version on first run (it tolerates `successes/failures` and `pass/total`).
- **wrangler KV CLI** syntax in `scripts/push-rulepack.mjs` is `kv key put` (v3.60+);
  older wrangler uses `kv:key put`.
```
