#!/usr/bin/env tsx
// Theme token test (spec docs/first-timer/spec.md A12, ticket #573). Three guarantees:
//   1. COMPLETE   — every theme in design/tokens.mjs maps every semantic role to a known primitive, and
//                   defines the same typography keys (a missing role would silently fall back to the
//                   legacy :root value under that theme).
//   2. LEGACY PINNED — `legacy` (the bare :root block, what renders with ft_journey OFF) still emits
//                   exactly the pre-Direction-A values, so flag OFF stays byte-identical. Adding a NEW
//                   role is fine; changing an existing legacy value fails here.
//   3. WCAG AA    — in the Direction A themes (quiet-light, quiet-dark): text.primary / secondary /
//                   tertiary ≥ 4.5:1 on every surface; accent ≥ 3:1 on every surface; plus the fg/bg
//                   pairs today's markup actually renders under the flag (text-cream on bg-ink, status
//                   text on its fill, …) ≥ 4.5:1. A failing value is adjusted in tokens.mjs within its hue.
//
// Run: npx tsx scripts/check-theme-contrast.ts
import { roles, themes, themeType, themeCssVars, themeTypeVars, roleValue } from "../design/tokens.mjs";

const failures: string[] = [];
const fail = (msg: string) => failures.push(`  ✗ ${msg}`);

// ── WCAG 2.x relative luminance + contrast ratio.
function luminance(hex: string): number {
  const n = parseInt(hex.replace("#", ""), 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Self-test (negative control): black/white is 21:1, identical colours 1:1, a known AA-fail pair < 4.5.
if (Math.abs(contrast("#000000", "#ffffff") - 21) > 0.01) fail("self-test: black on white should be 21:1");
if (Math.abs(contrast("#777777", "#777777") - 1) > 1e-9) fail("self-test: identical colours should be 1:1");
if (contrast("#777777", "#ffffff") >= 4.5) fail("self-test: #777 on white should fail AA (≈4.48)");

// ── 1. Completeness.
const themeNames = Object.keys(themes);
const typeKeys = Object.keys(themeType.legacy).sort().join(",");
for (const t of themeNames) {
  for (const r of roles) {
    try {
      roleValue(r, t);
    } catch (e) {
      fail(`${t}: ${(e as Error).message}`);
    }
  }
  const extra = Object.keys(themes[t]).filter((r) => !roles.includes(r));
  if (extra.length) fail(`${t}: maps unknown role(s) ${extra.join(", ")} — add them to \`roles\` or delete`);
  if (!themeType[t]) fail(`${t}: no typography (themeType["${t}"])`);
  else if (Object.keys(themeType[t]).sort().join(",") !== typeKeys) fail(`${t}: typography keys differ from legacy`);
}

// ── 2. Legacy pinned (pre-Direction-A computed values; additions allowed, changes not).
const LEGACY_PINNED: Record<string, string> = {
  "--surface-page": "238 240 210",
  "--surface-sunken": "227 232 194",
  "--surface-raised": "251 251 239",
  "--text-primary": "12 63 38",
  "--text-secondary": "74 100 80",
  "--text-tertiary": "124 142 120",
  "--text-inverse": "255 255 255", // the Tailwind `white` alias — must stay pure white
  "--border-default": "12 63 38",
  "--border-default-alpha": "0.13",
  "--brand-forest": "12 63 38",
  "--brand-green": "21 100 58",
  "--brand-green-hover": "28 122 72",
  "--brand-olive": "232 236 202",
  "--brand-cream": "244 243 221",
  "--accent-highlight": "201 210 168", // `yellow` / `sage` aliases
  "--accent-strong": "151 168 111",
  "--status-safe": "21 100 58",
  "--status-warn": "154 103 18",
  "--status-danger": "156 59 44",
  "--status-info": "47 107 214",
  "--status-caution-surface": "255 251 235",
  "--status-caution-border": "252 211 77",
  "--status-caution-text": "146 64 14",
  "--status-caution-text-strong": "120 53 15",
  "--status-danger-surface": "254 226 226",
  "--status-danger-text": "185 28 28",
  "--chart-series-1": "12 63 38",
  "--chart-series-2": "21 100 58",
  "--chart-series-3": "28 122 72",
  "--chart-series-4": "151 168 111",
  "--chart-series-5": "47 107 214",
  "--chart-series-6": "154 103 18",
  "--font-sans": '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
  "--font-display": '"Anton", Impact, "Arial Narrow", sans-serif',
  "--font-mono": 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  "--heading-weight": "400",
  "--heading-tracking": "0.01em",
  "--heading-leading": "1",
  "--heading-transform": "uppercase",
};
const legacy = { ...themeCssVars("legacy"), ...themeTypeVars("legacy") };
for (const [k, v] of Object.entries(LEGACY_PINNED)) {
  if (legacy[k] !== v) fail(`legacy ${k} changed: ${JSON.stringify(v)} → ${JSON.stringify(legacy[k])} (flag OFF must stay byte-identical)`);
}

// ── 3. Contrast in the Direction A themes.
const SURFACES = ["surface.page", "surface.raised", "surface.sunken"];
type Pair = [fg: string, bg: string, min: number, why: string];
const PAIRS: Pair[] = [
  ...["text.primary", "text.secondary", "text.tertiary"].flatMap((fg) => SURFACES.map((bg): Pair => [fg, bg, 4.5, "text on surface"])),
  ...SURFACES.map((bg): Pair => ["accent.default", bg, 3, "accent on surface"]),
  ...["surface.page", "surface.raised"].map((bg): Pair => ["accent.default", bg, 4.5, "accent as link text"]),
  ...["status.ok", "status.warn", "status.danger", "status.info"].flatMap((fg) =>
    ["surface.page", "surface.raised"].map((bg): Pair => [fg, bg, 4.5, "status text on surface"]),
  ),
  ["text.inverse", "accent.default", 4.5, "primary button label"],
  ["text.inverse", "accent.hover", 4.5, "primary button label (hover)"],
  ["text.primary", "accent.soft", 4.5, "'Worth a look' badge / selected chip"],
  ["status.warn", "status.warn-surface", 4.5, "warn text on its fill"],
  ["status.caution-text", "status.caution-surface", 4.5, "caution callout"],
  ["status.caution-text-strong", "status.caution-surface", 4.5, "caution callout (strong)"],
  ["status.danger-text", "status.danger-surface", 4.5, "danger badge"],
  // Today's markup rendered under the flag until the ft/ components replace it.
  ["brand.cream", "text.primary", 4.5, "text-cream on bg-ink buttons"],
  ["text.inverse", "text.primary", 4.5, "text-white on bg-ink buttons"],
  ["brand.cream", "brand.forest", 4.5, "sidebar: text-cream on bg-forest"],
  ["brand.cream", "brand.green", 4.5, "text-cream on bg-green buttons"],
  ["text.inverse", "brand.green", 4.5, "text-white on bg-green buttons"],
  ["brand.forest", "accent.highlight", 4.5, "active nav: text-forest on bg-sage"],
  ["accent.highlight", "brand.forest", 4.5, "text-sage on bg-forest"],
  ...SURFACES.map((bg): Pair => ["brand.forest", bg, 4.5, "text-forest on surface"]),
  ...["surface.page", "surface.raised"].map((bg): Pair => ["brand.green", bg, 4.5, "text-green on surface"]),
];
let checked = 0;
for (const t of themeNames.filter((n) => n !== "legacy")) {
  for (const [fg, bg, min, why] of PAIRS) {
    const f = roleValue(fg, t);
    const b = roleValue(bg, t);
    if (f.alpha !== undefined || b.alpha !== undefined) {
      fail(`${t}: ${fg} on ${bg} — contrast pairs must be opaque roles`);
      continue;
    }
    const ratio = contrast(f.hex, b.hex);
    checked++;
    if (ratio < min) fail(`${t}: ${fg} ${f.hex} on ${bg} ${b.hex} = ${ratio.toFixed(2)}:1 < ${min}:1 (${why})`);
  }
}

if (failures.length) {
  console.error("theme token test FAILED (design/tokens.mjs):");
  for (const l of failures) console.error(l);
  process.exit(1);
}
console.log(
  `theme tokens: ${themeNames.length} themes × ${roles.length} roles complete; legacy pinned (${Object.keys(LEGACY_PINNED).length} vars); ${checked} contrast pairs ≥ AA`,
);
