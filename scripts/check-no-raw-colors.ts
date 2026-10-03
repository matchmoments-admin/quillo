#!/usr/bin/env tsx
// Raw-colour guard: the SPA consumes colour ONLY through the semantic roles in design/tokens.mjs
// (Tailwind aliases like bg-paper / text-ink / border-line, or role()/CHART_SERIES from
// web/src/lib/theme.ts for inline styles). That is what lets a re-skin or a new theme
// (docs/first-timer/design-system.md §2, rollout steps 2–3) be a token change rather than a
// hunt through every screen. This guard fails `npm test` on a NEW:
//   • hard-coded hex colour        — "#0c3f26", bg-[#fff]
//   • numeric rgb()/hsl() literal  — "rgba(12,63,38,0.1)"   (rgb(var(--role) / a) is fine)
//   • raw Tailwind palette class   — bg-red-500, text-amber-900, border-slate-200
// anywhere in web/src (ts/tsx/css). Comments are ignored (issue refs like "#256" live there).
// white/black/transparent/current are not palette shades and are not flagged.
//
// Escape hatch: ALLOWLIST below — file + the exact offending text + why. Keep it small; prefer
// adding a role to design/tokens.mjs.
//
// Run: npx tsx scripts/check-no-raw-colors.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(root, "web/src");

type Allow = { file: string; match: string; why: string };
const ALLOWLIST: Allow[] = [
  // e.g. { file: "web/src/components/SomeChart.tsx", match: "#123456", why: "third-party chart lib needs a literal; move to a role in #NNN" },
];

const PALETTE =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const UTIL =
  "bg|text|border(?:-[xytrblse])?|ring|ring-offset|from|via|to|fill|stroke|divide|outline|decoration|placeholder|accent|caret|shadow";

const RULES: { name: string; re: RegExp }[] = [
  // 6/8-digit hex always; 3/4-digit only with a letter (so a stray "#245" issue ref in a string passes).
  { name: "hard-coded hex colour", re: /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})\b|#(?=[0-9]*[a-fA-F])[0-9a-fA-F]{3,4}\b/g },
  { name: "numeric rgb()/hsl() literal", re: /\b(?:rgba?|hsla?)\(\s*[\d.]/g },
  { name: "raw Tailwind palette class", re: new RegExp(`\\b(?:${UTIL})-(?:${PALETTE})-(?:50|[1-9]00|950)\\b`, "g") },
];

/** Blank out comments (keeping line numbers) so issue refs / prose never trip the rules. */
export function stripComments(src: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:"'`\\])(\/\/[^\n]*)/g, (_, pre: string, c: string) => pre + blank(c));
}

export function findViolations(src: string): { rule: string; text: string; line: number }[] {
  const code = stripComments(src);
  const out: { rule: string; text: string; line: number }[] = [];
  for (const { name, re } of RULES) {
    for (const m of code.matchAll(re)) {
      out.push({ rule: name, text: m[0], line: code.slice(0, m.index).split("\n").length });
    }
  }
  return out;
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(tsx?|css)$/.test(e.name) ? [p] : [];
  });
}

// ── Self-test: the rules must catch what they claim and spare what they must (negative control).
const MUST_FLAG = ['const c = "#0c3f26";', "bg-[#fff]", 'const t = "rgba(12,63,38,0.1)";', '<p className="bg-red-500" />', "hover:text-amber-900", "border-x-slate-200"];
const MUST_PASS = ["// see #256 and #fff in a comment", "/* #0c3f26 */", 'const r = "rgb(var(--text-primary) / 0.1)";', '<p className="bg-green text-yellow-d border-line/60 text-white" />'];
let selfTestFailed = false;
for (const s of MUST_FLAG) if (findViolations(s).length === 0) { console.error(`  ✗ self-test: should flag ${JSON.stringify(s)}`); selfTestFailed = true; }
for (const s of MUST_PASS) {
  const v = findViolations(s);
  if (v.length) { console.error(`  ✗ self-test: should NOT flag ${JSON.stringify(s)} (got ${v.map((x) => x.text).join(", ")})`); selfTestFailed = true; }
}

const violations: string[] = [];
const usedAllow = new Set<Allow>();
for (const file of walk(SRC)) {
  const rel = path.relative(root, file);
  for (const v of findViolations(fs.readFileSync(file, "utf8"))) {
    const allow = ALLOWLIST.find((a) => a.file === rel && a.match === v.text);
    if (allow) { usedAllow.add(allow); continue; }
    violations.push(`  ✗ ${rel}:${v.line}  ${v.rule}: ${v.text}`);
  }
}
const stale = ALLOWLIST.filter((a) => !usedAllow.has(a)).map((a) => `  ✗ stale allowlist entry (no longer matches — delete it): ${a.file} ${a.match}`);

if (selfTestFailed || violations.length || stale.length) {
  console.error("raw-colour guard FAILED — use a semantic role (design/tokens.mjs → Tailwind alias, or role()/CHART_SERIES from web/src/lib/theme.ts):");
  for (const l of [...violations, ...stale]) console.error(l);
  process.exit(1);
}
console.log(`raw-colour guard: ${walk(SRC).length} web/src files clean (${ALLOWLIST.length} allowlisted)`);
