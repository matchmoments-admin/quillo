// ============================================================================
// Quillo design tokens — the single source of truth for the whole website.
//
// Both consumers import THIS file, so a brand tweak here updates everything:
//   • web/tailwind.config.js  → the React dashboard (Node reads it at build time)
//   • src/marketing/landing.ts → (legacy) the marketing page's inline :root
//
// Plain ESM (.mjs) so it resolves identically across the two separate npm packages
// without a TypeScript loader. Keep this file dependency-free and side-effect-free.
//
// The visual language is the "Organic-Brutalist" GREEN system: deep forest green +
// sage + cream canvas, Anton condensed display type for headings/big numbers, Inter
// for body and dense data. Text is never pure black (forest #0c3f26 reads as ink).
// The signature accent is SAGE (not yellow) — used for highlights and the active
// nav/feature surfaces. Ported from the Claude Design "Claim Better" / "Dashboard v2"
// handoff so the marketing site and the app share one identity.
// ============================================================================

export const color = {
  // Canvas + surfaces
  paper: "#eef0d2", // page canvas (soft olive-cream)
  paper2: "#e3e8c2", // soft panel / hover fill
  card: "#fbfbef", // raised card surface
  ink: "#0c3f26", // forest — primary text + dark actions (never pure black)
  ink2: "#4a6450", // secondary text (the app's "muted")
  ink3: "#7c8e78", // tertiary / faint labels
  line: "rgba(12,63,38,0.13)", // borders, dividers

  // Brand greens (named surfaces used by the sidebar / feature cards)
  forest: "#0c3f26", // wordmark, sidebar, dark text
  green: "#15643a", // mid green — buttons / accents
  greenD: "#1c7a48", // hover
  sage: "#c9d2a8", // signature accent — active nav, accent cards, highlights
  olive: "#e8ecca", // alt soft canvas
  moss: "#97a86f", // muted accent / chart segment
  cream: "#f4f3dd", // lightest paper (text on forest)

  // Back-compat alias: the app's long-standing `yellow` accent class now resolves to
  // sage so existing `bg-yellow`/`text-yellow` usages keep working under the green system.
  yellow: "#c9d2a8", // → sage
  yellowD: "#97a86f", // → moss (yellow hover/pressed)

  // Semantic states (data UI).
  safe: "#15643a", // confident / good (green)
  warn: "#9a6712", // needs-a-look (warm ochre)
  danger: "#9c3b2c", // error / destructive (brick)
  info: "#2f6bd6", // informational (PAYG / blue accent in charts)
};

export const font = {
  // Anton is a condensed display face — headings + big numbers only.
  serif: '"Anton", Impact, "Arial Narrow", sans-serif',
  // Inter carries body, labels and dense tabular data.
  sans: '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
};

export const radius = {
  sm: "13px",
  md: "20px",
  lg: "24px",
  pill: "999px",
};

export const shadow = {
  card: "0 1px 2px rgba(12,63,38,.05), 0 6px 24px -12px rgba(12,63,38,.18)",
  float: "0 24px 50px -24px rgba(12,63,38,.30)",
};

// Emit a marketing-page-style `:root { … }` custom-property block from the tokens above.
// (The green landing inlines its own :root, but this stays exported and in lockstep so any
//  consumer reading CSS vars gets the current palette.)
export function cssRootVars() {
  return `:root {
  --paper:   ${color.paper};
  --paper-2: ${color.paper2};
  --card:    ${color.card};
  --ink:     ${color.ink};
  --ink-2:   ${color.ink2};
  --ink-3:   ${color.ink3};
  --line:    ${color.line};

  --forest:  ${color.forest};
  --green:   ${color.green};
  --green-2: ${color.greenD};
  --sage:    ${color.sage};
  --olive:   ${color.olive};
  --moss:    ${color.moss};
  --cream:   ${color.cream};

  --yellow:  ${color.yellow};
  --yellow-d:${color.yellowD};

  --serif: ${font.serif};
  --sans:  ${font.sans};

  --maxw: 1240px;
  --gutter: 40px;
  --radius: ${radius.md};
}`;
}
