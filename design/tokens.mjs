// ============================================================================
// Quillo design tokens — the single source of truth for the whole website.
//
// Both consumers import THIS file, so a brand tweak here updates everything:
//   • web/tailwind.config.js  → the React dashboard (Node reads it at build time)
//   • src/marketing/landing.ts → the marketing page's inline :root (esbuild bundles it)
//
// Plain ESM (.mjs) so it resolves identically across the two separate npm packages
// without a TypeScript loader. Keep this file dependency-free and side-effect-free.
//
// The visual language is the editorial "Quill" system: warm cream canvas, near-black
// warm ink, a single signature yellow used ONLY for highlights/CTAs, Spectral serif
// for display and Hanken Grotesk for body/data. Interactive UI is ink-monochrome
// (yellow text fails contrast), so there is deliberately no blue "accent" colour.
// ============================================================================

export const color = {
  paper: "#fbfaf6", // page canvas
  paper2: "#f1efe7", // soft panel / surface
  ink: "#14130f", // near-black warm text + primary actions
  ink2: "#514d44", // secondary text (the app's "muted")
  ink3: "#8c8678", // tertiary / faint labels
  line: "#e4e1d6", // borders, dividers
  yellow: "#f1e740", // signature accent — highlights & CTAs only
  yellowD: "#e7dc2a", // yellow hover/pressed
  card: "#ffffff", // raised card surface

  // Semantic states (kept for the dashboard's data UI).
  safe: "#16a34a", // confident / good
  warn: "#a8631a", // needs-a-look (warm amber, matches the landing's flag tone)
  danger: "#dc2626", // error / destructive
};

export const font = {
  serif: '"Spectral", Georgia, "Times New Roman", serif',
  sans: '"Hanken Grotesk", system-ui, -apple-system, sans-serif',
};

export const radius = {
  sm: "10px",
  md: "14px",
  lg: "18px",
  pill: "999px",
};

export const shadow = {
  card: "0 1px 2px rgba(20,19,15,.04), 0 4px 16px rgba(20,19,15,.06)",
  float: "0 24px 50px -24px rgba(20,19,15,.28)",
};

// Emit the marketing page's `:root { … }` custom-property block from the tokens above,
// so landing.ts no longer hardcodes a second copy of the palette. The CSS variable
// names match the ones the landing's stylesheet already references (var(--ink) etc.).
export function cssRootVars() {
  return `:root {
  --paper:   ${color.paper};
  --paper-2: ${color.paper2};
  --ink:     ${color.ink};
  --ink-2:   ${color.ink2};
  --ink-3:   ${color.ink3};
  --line:    ${color.line};
  --yellow:  ${color.yellow};
  --yellow-d:${color.yellowD};
  --card:    ${color.card};

  --serif: ${font.serif};
  --sans:  ${font.sans};

  --maxw: 1240px;
  --gutter: 40px;
  --radius: ${radius.md};
}`;
}
