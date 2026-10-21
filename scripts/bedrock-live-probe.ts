/**
 * Bedrock live probe — proves the REAL extractors work end-to-end on the AU-resident path (#641).
 *
 * Unlike check-units (mocked fetch), this spends real money (a few cents): it calls Bedrock
 * InvokeModel through getLLM with the `au.` profile, using the AWS keys in .dev.vars. It exercises
 * exactly the request shapes the MVP journey sends — receipt image vision, statement PDF `document`
 * blocks, forced tool use, and prompt caching — none of which the ping probe in
 * security-dashboard.ts covers. NOT part of `npm test`.
 *
 *   npm run probe:bedrock                       # print the evidence JSON
 *   npm run probe:bedrock -- --out evidence.json
 *
 * Fixtures (scripts/fixtures/bedrock-probe/) are synthetic — no real customer data leaves the machine.
 */
import fs from "node:fs";
import path from "node:path";
import type { Env } from "../src/env";
import { getLLM, resolveRegion, type LLM, type ProviderProfile } from "../src/llm";
import { extractReceipt, extractStatement, extractAnswer } from "../src/extract";
import { AU_DESCRIPTOR } from "../src/lib/jurisdiction";

const root = process.cwd();
const fixtures = path.join(root, "scripts", "fixtures", "bedrock-probe");

function loadDevVars(): Record<string, string> {
  const out: Record<string, string> = {};
  const file = path.join(root, ".dev.vars");
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

const vars = { ...loadDevVars(), ...process.env } as Record<string, string | undefined>;
if (!vars.AWS_ACCESS_KEY_ID || !vars.AWS_SECRET_ACCESS_KEY) {
  console.error("probe:bedrock needs AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (in .dev.vars or the environment).");
  process.exit(2);
}
// No DEFAULT_INFERENCE_REGION: the region must come from the AU descriptor, as in production.
const env = {
  DEFAULT_INFERENCE_PROVIDER: "bedrock",
  AWS_ACCESS_KEY_ID: vars.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: vars.AWS_SECRET_ACCESS_KEY,
} as unknown as Env;
// A CDR-tainted tenant: getLLM runs the full residency assert before every call below.
const tenant: ProviderProfile = { inference_provider: null, inference_region: null, cdr_tainted: 1 };

interface Usage { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }
interface CheckResult { name: string; pass: boolean; ms: number; usage?: Usage; detail: string }
const results: CheckResult[] = [];

// Wrap create() so each check can report the usage Bedrock actually returned.
function capturing(llm: LLM): { llm: LLM; last: () => Usage | undefined } {
  let last: Usage | undefined;
  return {
    llm: { ...llm, async create(params, feature) { const m = await llm.create(params, feature); last = m.usage as Usage; return m; } },
    last: () => last,
  };
}

async function run(name: string, fn: (llm: LLM) => Promise<string>, check: (detail: string) => boolean): Promise<Usage | undefined> {
  const { llm, last } = capturing(await getLLM(env, tenant));
  const t0 = Date.now();
  try {
    const detail = await fn(llm);
    results.push({ name, pass: check(detail), ms: Date.now() - t0, usage: last(), detail });
  } catch (e) {
    results.push({ name, pass: false, ms: Date.now() - t0, usage: last(), detail: (e as Error).message.slice(0, 300) });
  }
  return last();
}

// A system prompt long enough to cross Haiku's minimum cacheable prefix, built from the real rule
// pack the receipt prompt embeds — so the cache check measures the production shape.
const rulePack = fs.readFileSync(path.join(root, "src", "rulepacks", "au-v1.json"), "utf8");
const receiptSystem =
  "You categorise Australian taxpayer receipts into the buckets and ATO labels defined by this rule pack. " +
  "General information only — never tax advice.\n\nRULE PACK:\n" + rulePack.slice(0, 24_000);

const toAB = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const receipt = toAB(fs.readFileSync(path.join(fixtures, "receipt.png")));
const statement = toAB(fs.readFileSync(path.join(fixtures, "statement.pdf")));

// (a) Receipt image — vision + forced tool + cache_control (first call writes the cache).
await run("receipt image (vision + forced tool)", async (llm) => {
  const r = await extractReceipt(llm, receiptSystem, receipt, "image/png");
  return `${r.parsed.merchant} ${r.parsed.amount_cents}c bucket=${r.parsed.bucket}`;
}, (d) => /officeworks/i.test(d) && d.includes("26395c"));

// (b) Statement PDF — `document` block + forced tool.
await run("statement PDF (document block + forced tool)", async (llm) => {
  const s = await extractStatement(llm, statement, "application/pdf");
  return `${s.lines.length} lines, opening=${s.opening_cents} closing=${s.closing_cents}`;
}, (d) => /^[4-6] lines/.test(d) && d.includes("closing=385865"));

// (c) Ask — text + forced ANSWER tool.
await run("ask (text + forced answer tool)", async (llm) => {
  const a = await extractAnswer(llm, "You answer Australian personal-tax questions with general information only.", [
    { role: "user", content: "Can I claim an office chair I use for working from home?" },
  ]);
  return a.answer.slice(0, 160);
}, (d) => d.length > 20);

// (d) Prompt caching — repeat (a); the shared system prefix should now read from cache.
const cached = await run("prompt cache read on repeat", async (llm) => {
  const r = await extractReceipt(llm, receiptSystem, receipt, "image/png");
  return r.parsed.merchant;
}, () => true);
const last = results[results.length - 1]!;
last.pass = (cached?.cache_read_input_tokens ?? 0) > 0;
last.detail = `cache_read_input_tokens=${cached?.cache_read_input_tokens ?? 0}`;

// (e) Residency refusal — the same tainted tenant on the US provider must never get a client.
{
  const t0 = Date.now();
  let refused = "";
  try { await getLLM({ ...env, DEFAULT_INFERENCE_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "unused" } as unknown as Env, tenant); }
  catch (e) { refused = (e as Error).message; }
  results.push({ name: "CDR-tainted tenant refused on US provider", pass: refused.startsWith("data_residency_required:"), ms: Date.now() - t0, detail: refused.slice(0, 120) });
}

const evidence = {
  probe: "bedrock-live-probe",
  at: new Date().toISOString(),
  model: (await getLLM(env, tenant)).modelId,
  region: resolveRegion(env, tenant, AU_DESCRIPTOR), // the region actually signed for, not the expectation
  allowed_regions: AU_DESCRIPTOR.residency.regions,
  passed: results.filter((r) => r.pass).length,
  total: results.length,
  results,
};
const outIdx = process.argv.indexOf("--out");
if (outIdx > 0 && process.argv[outIdx + 1]) fs.writeFileSync(process.argv[outIdx + 1]!, JSON.stringify(evidence, null, 2) + "\n");
for (const r of results) console.log(`${r.pass ? "✓" : "✗"} ${r.name} (${r.ms}ms) — ${r.detail}`);
console.log(`=== bedrock probe: ${evidence.passed}/${evidence.total} passed on ${evidence.model} (${evidence.region}) ===`);
process.exit(evidence.passed === evidence.total ? 0 : 1);
