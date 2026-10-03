/**
 * Tax-advice wording denylist for first-timer copy (spec docs/first-timer/spec.md §3.4 + A10, #584).
 *
 * The goldens already lint generated text with `refund|tax payable|marginal rate|N% tax`; this is the
 * same family widened for hand-written education copy, where the risks are outcome promises
 * ("you'll get…"), entitlement claims, guarantees, peer comparisons (#537: no peer benchmarks),
 * money figures (thresholds and dates belong in the rule pack, not copy) and — owner ruling
 * 2026-10-03 — any verdict on whether the reader has to lodge (that is the ATO tool's call).
 *
 * Used by scripts/check-units.ts over web/src/content, the ft/ components, the Before you start page
 * and the pack's before_you_start block. Pure; no runtime caller.
 */
export const TAX_ADVICE_DENYLIST: readonly { name: string; re: RegExp }[] = [
  { name: "refund mention", re: /\brefund/i },
  { name: "outcome promise", re: /\byou(?:'ll|’ll| will) (?:get|receive|be paid|save|owe)\b/i },
  { name: "entitlement claim", re: /\byou(?:'re|’re| are) entitled\b/i },
  { name: "guarantee", re: /\bguarantee/i },
  { name: "peer comparison", re: /\b(?:people|others|users|taxpayers|workers|students) like you\b/i },
  { name: "peer benchmark", re: /\b(?:most|average|typical|other) (?:people|taxpayers|users|first[- ]timers|workers|students) (?:claim|get|earn|receive|save)\b/i },
  { name: "on-average framing", re: /\bon average\b/i },
  { name: "tax payable", re: /\btax payable\b/i },
  { name: "rate", re: /\bmarginal (?:tax )?rate\b|\b\d{1,2}%\s*(?:tax|bracket)/i },
  { name: "money figure", re: /\$\s?\d/ },
  {
    name: "lodge verdict",
    re: /\byou (?:must|need to|have to|are required to|do not need to|don't need to|don’t need to|do not have to|don't have to|don’t have to|won't need to|will not need to|may not need to|might not need to|probably don't need to) lodge\b/i,
  },
  { name: "Quillo lodges", re: /\bQuillo (?:lodges|will lodge|can lodge|lodges for you)\b/i },
];

/** The names of every denylist entry the text trips (empty ⇒ clean). */
export function denylistHits(text: string): string[] {
  return TAX_ADVICE_DENYLIST.filter((d) => d.re.test(text)).map((d) => d.name);
}

/** Strip // line and block comments from TS/TSX source so only shipped strings/markup are scanned. URLs (`https://`) survive. */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
}
