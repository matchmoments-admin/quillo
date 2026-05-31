// promptfoo dynamic test generator. Reads every top-level evals/cases/*.json fixture
// (shared.json + per-user files; the holdout/ subdir is excluded) and attaches the
// scoring tiers: deterministic exact-match on `bucket`, LLM-judge on `ato_label`.
const fs = require("node:fs");
const path = require("node:path");

const CASES_DIR = path.join(__dirname, "cases");
const GRADER = "anthropic:messages:claude-opus-4-8"; // different tier than the model under test

function caseFiles() {
  return fs
    .readdirSync(CASES_DIR, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".json"))
    .map((d) => path.join(CASES_DIR, d.name));
}

function toTest(c) {
  const assert = [
    { type: "is-json" },
    {
      type: "equals",
      value: c.expected_bucket,
      transform: "JSON.parse(output).bucket",
      metric: "bucket_match",
    },
  ];
  if (c.expected_label) {
    assert.push({
      type: "llm-rubric",
      value:
        `The predicted ATO label should match "${c.expected_label}" in meaning. ` +
        "Synonyms and formatting differences are acceptable; a materially different category is a FAIL.",
      transform: "JSON.parse(output).ato_label",
      provider: GRADER,
      metric: "label_match",
      threshold: 0.7,
    });
  }
  return {
    description: c.description || `${c.merchant} -> ${c.expected_bucket}`,
    vars: {
      merchant: c.merchant ?? "",
      amount_cents: c.amount_cents ?? null,
      gst_cents: c.gst_cents ?? null,
      txn_date: c.txn_date ?? null,
    },
    assert,
  };
}

module.exports = async function () {
  return caseFiles().flatMap((f) => JSON.parse(fs.readFileSync(f, "utf8"))).map(toTest);
};
