// promptfoo prompt function: builds the categorisation prompt from the SAME rule-pack
// JSON the Worker uses (src/rulepacks/au-v1.json) so the bucket/guidance data never drifts.
// Returns OpenAI-style chat messages (promptfoo maps these to the Anthropic provider).
const fs = require("node:fs");
const path = require("node:path");

const RULEPACK = path.join(__dirname, "..", "..", "src", "rulepacks", "au-v1.json");
const rulePack = JSON.parse(fs.readFileSync(RULEPACK, "utf8"));

function buildSystem(rp) {
  return [
    "You categorise AU expense transactions from their extracted fields.",
    "General information only — not tax advice.",
    `Rule pack ${rp.version}:`,
    ...Object.entries(rp.buckets).map(([k, v]) => `  - ${k}: ${v}`),
    rp.guidance,
    'Return ONLY a JSON object: {"bucket": <one of the bucket keys>, "ato_label": <string>, "confidence": <0..1 number>}.',
    "No prose, no markdown fences.",
  ].join("\n");
}

module.exports = async function ({ vars }) {
  const fields = {
    merchant: vars.merchant ?? null,
    amount_cents: vars.amount_cents ?? null,
    gst_cents: vars.gst_cents ?? null,
    txn_date: vars.txn_date ?? null,
  };
  return JSON.stringify([
    { role: "system", content: buildSystem(rulePack) },
    {
      role: "user",
      content: `Extracted fields:\n${JSON.stringify(fields, null, 2)}\n\nCategorise into exactly one bucket and an ATO label.`,
    },
  ]);
};
