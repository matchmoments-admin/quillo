// promptfoo prompt function: builds the categorisation prompt from the SAME rule-pack
// JSON the Worker uses (src/rulepacks/au-v1.json) so the bucket/guidance data never drifts.
// Returns OpenAI-style chat messages (promptfoo maps these to the Anthropic provider).
//
// Situation-aware (task3): if a test case's vars include a `situation` object, this
// function renders it using the SAME format as src/lib/db.ts renderSituation() so
// the eval exercises the same situation-aware path the live agent uses.
// The situation schema mirrors the Situation/Property/Entity/UserRule types in db.ts.
const fs = require("node:fs");
const path = require("node:path");

const RULEPACK = path.join(__dirname, "..", "..", "src", "rulepacks", "au-v1.json");
const rulePack = JSON.parse(fs.readFileSync(RULEPACK, "utf8"));

/**
 * Render a situation object into the compact model-facing description.
 * Mirrors src/lib/db.ts renderSituation() exactly so evals stay consistent
 * with the live agent's system prompt.
 *
 * situation shape:
 *   { entities?: [{kind, name, detail}], properties?: [{id, label, status}], rules?: [{match_type, pattern, bucket, ato_label, property_id}] }
 */
function renderSituation(situation) {
  if (!situation) return null;

  const lines = ["Your situation:"];

  for (const e of situation.entities ?? []) {
    const d = e.detail ?? {};
    if (e.kind === "company") {
      lines.push(
        `  - Company: ${e.name ?? "?"} (ABN ${d.abn ?? "?"}, GST ${d.gst_registered ? "registered" : "not registered"}). Business expenses -> bucket "company".`,
      );
    } else if (e.kind === "employment") {
      lines.push(
        `  - Employment (PAYG): ${e.name ?? d.employer ?? "?"}. Work-related deductions -> bucket "payg".`,
      );
    } else if (e.kind === "novated_lease") {
      lines.push(
        `  - Novated lease: ${d.vehicle ?? e.name ?? "vehicle"} via ${d.provider ?? "?"} (salary-packaged). Lease/running costs are employment salary-packaging, not company.`,
      );
    } else {
      lines.push(`  - ${e.kind}: ${e.name ?? ""}`);
    }
  }

  if ((situation.properties ?? []).length > 0) {
    lines.push("  - Properties (use property_id when the bucket is a property bucket):");
    for (const p of situation.properties) {
      const bucket =
        p.status === "rented"
          ? "property_rented"
          : p.status === "vacant"
            ? "property_vacant"
            : "payg";
      lines.push(`      · id=${p.id} "${p.label}" — ${p.status} -> ${bucket}`);
    }
  }

  if ((situation.rules ?? []).length > 0) {
    lines.push("  - Known rules (apply when the merchant matches):");
    for (const r of situation.rules) {
      lines.push(
        `      · merchant ${r.match_type === "merchant_exact" ? "is" : "contains"} "${r.pattern}" -> bucket ${r.bucket}, label ${r.ato_label}${r.property_id ? `, property ${r.property_id}` : ""}`,
      );
    }
  }

  return lines.length > 1
    ? lines.join("\n")
    : "Your situation: (not yet registered — categorise from the receipt alone).";
}

function buildSystem(rp, situationText) {
  const parts = [
    "You categorise AU expense transactions from their extracted fields.",
    "General information only — not tax advice.",
    `Rule pack ${rp.version}:`,
    ...Object.entries(rp.buckets).map(([k, v]) => `  - ${k}: ${v}`),
    rp.guidance,
  ];
  if (situationText) {
    parts.push(situationText);
  }
  parts.push(
    'Return ONLY a JSON object: {"bucket": <one of the bucket keys>, "ato_label": <string>, "confidence": <0..1 number>}.',
    "No prose, no markdown fences.",
  );
  return parts.join("\n");
}

module.exports = async function ({ vars }) {
  const fields = {
    merchant: vars.merchant ?? null,
    amount_cents: vars.amount_cents ?? null,
    gst_cents: vars.gst_cents ?? null,
    txn_date: vars.txn_date ?? null,
  };

  // Include situation context if the case provides it (situation-aware path).
  const situationText = renderSituation(vars.situation ?? null);

  return JSON.stringify([
    { role: "system", content: buildSystem(rulePack, situationText) },
    {
      role: "user",
      content: `Extracted fields:\n${JSON.stringify(fields, null, 2)}\n\nCategorise into exactly one bucket and an ATO label.`,
    },
  ]);
};
