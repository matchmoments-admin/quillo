// ============================================================================
// Quillo design tokens — the single source of truth for the whole website.
//
// Consumers import THIS file, so a brand tweak here updates everything:
//   • web/tailwind.config.js  → the React dashboard (Node reads it at build time). The config
//                               injects `themeCssVars()` as `:root { --role: r g b; … }` and maps
//                               every colour class onto `rgb(var(--role) / <alpha-value>)`.
//   • src/marketing/legal.ts   → the legal pages' inline :root via `cssRootVars()` (hex).
//   • src/marketing/landing.ts → (legacy) inlines its own green :root; does not read this file.
//
// Plain ESM (.mjs) so it resolves identically across the two separate npm packages
// without a TypeScript loader. Keep this file dependency-free and side-effect-free.
//
// THREE LAYERS (docs/first-timer/design-system.md §2). Components only ever touch layer 3.
//   1. `primitives` — the raw palette, no meaning. Changed only by a brand refresh.
//   2. `themes`     — per theme, maps every semantic role → a primitive (optionally with alpha).
//                     A new theme / white-label / regional brand is a new entry here, nothing else.
//   3. `roles`      — the semantic names the UI consumes (as CSS vars `--surface-page`, …, and via
//                     the Tailwind aliases in web/tailwind.config.js).
//
// `themes.light` currently holds the EXACT pre-tokenisation values (the "Organic-Brutalist" GREEN
// system: forest + sage + cream canvas, Anton display / Inter body), so tokenisation is
// visually byte-identical. Direction A ("Quiet ledger") lands later as a theme switch.
// ============================================================================

// ── Layer 1: primitives ─────────────────────────────────────────────────────
// Raw values only. Named by hue + rough lightness, never by use.
export const primitives = {
  olive50: "#fbfbef",
  olive100: "#f4f3dd",
  olive150: "#eef0d2",
  olive200: "#e8ecca",
  olive300: "#e3e8c2",
  sage300: "#c9d2a8",
  sage500: "#97a86f",
  sage600: "#7c8e78",
  sage700: "#4a6450",
  green600: "#1c7a48",
  green700: "#15643a",
  green900: "#0c3f26",
  ochre700: "#9a6712",
  brick700: "#9c3b2c",
  blue600: "#2f6bd6",
  // Warm caution + soft-danger tints (were raw Tailwind amber-*/red-* classes; same values).
  amber50: "#fffbeb",
  amber300: "#fcd34d",
  amber800: "#92400e",
  amber900: "#78350f",
  red100: "#fee2e2",
  red700: "#b91c1c",
};

// ── Layer 3: semantic roles ─────────────────────────────────────────────────
// Every theme must map every role. CSS var name = role with "." → "-" (`surface.page` →
// `--surface-page`).
export const roles = [
  "surface.page", // page canvas
  "surface.sunken", // soft panel / hover fill (the app's `surface`)
  "surface.raised", // raised card surface
  "text.primary", // primary text + dark actions (never pure black)
  "text.secondary", // secondary text (the app's `muted`)
  "text.tertiary", // tertiary / faint labels
  "border.default", // borders, dividers
  "brand.forest", // wordmark, sidebar, dark text
  "brand.green", // mid green — buttons / accents
  "brand.green-hover", // hover
  "brand.olive", // alt soft canvas
  "brand.cream", // lightest paper (text on forest)
  "accent.default", // signature accent — active nav, accent cards, highlights (sage)
  "accent.strong", // muted accent / pressed (moss)
  "status.safe",
  "status.warn",
  "status.danger",
  "status.info",
  "status.caution-surface", // "review separately" callout fill
  "status.caution-border",
  "status.caution-text",
  "status.caution-text-strong",
  "status.danger-surface", // soft destructive badge fill
  "status.danger-text",
  "chart.series.1", // chart / breakdown swatches, in order
  "chart.series.2",
  "chart.series.3",
  "chart.series.4",
  "chart.series.5",
  "chart.series.6",
];

// ── Layer 2: themes ─────────────────────────────────────────────────────────
// role → primitive name, or { ref, alpha } for a translucent role.
export const themes = {
  light: {
    "surface.page": "olive150",
    "surface.sunken": "olive300",
    "surface.raised": "olive50",
    "text.primary": "green900",
    "text.secondary": "sage700",
    "text.tertiary": "sage600",
    "border.default": { ref: "green900", alpha: 0.13 },
    "brand.forest": "green900",
    "brand.green": "green700",
    "brand.green-hover": "green600",
    "brand.olive": "olive200",
    "brand.cream": "olive100",
    "accent.default": "sage300",
    "accent.strong": "sage500",
    "status.safe": "green700",
    "status.warn": "ochre700",
    "status.danger": "brick700",
    "status.info": "blue600",
    "status.caution-surface": "amber50",
    "status.caution-border": "amber300",
    "status.caution-text": "amber800",
    "status.caution-text-strong": "amber900",
    "status.danger-surface": "red100",
    "status.danger-text": "red700",
    "chart.series.1": "green900",
    "chart.series.2": "green700",
    "chart.series.3": "green600",
    "chart.series.4": "sage500",
    "chart.series.5": "blue600",
    "chart.series.6": "ochre700",
  },
};

/** CSS custom-property name for a role: `surface.page` → `--surface-page`. */
export function roleVar(role) {
  return `--${role.replace(/\./g, "-")}`;
}

function hexToChannels(hex) {
  const h = hex.replace("#", "");
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function resolveRole(theme, role) {
  const entry = themes[theme][role];
  if (entry === undefined) throw new Error(`tokens: theme "${theme}" has no value for role "${role}"`);
  const ref = typeof entry === "string" ? entry : entry.ref;
  const hex = primitives[ref];
  if (!hex) throw new Error(`tokens: role "${role}" references unknown primitive "${ref}"`);
  return { hex, alpha: typeof entry === "string" ? undefined : entry.alpha };
}

/**
 * The custom properties for one theme, as `{ "--surface-page": "238 240 210", … }`.
 * Values are space-separated RGB channel triplets so Tailwind can append an alpha
 * (`rgb(var(--x) / <alpha-value>)`). A translucent role also gets `--x-alpha` (its default alpha).
 */
export function themeCssVars(theme = "light") {
  const out = {};
  for (const role of roles) {
    const { hex, alpha } = resolveRole(theme, role);
    out[roleVar(role)] = hexToChannels(hex).join(" ");
    if (alpha !== undefined) out[`${roleVar(role)}-alpha`] = String(alpha);
  }
  return out;
}

function rgbaString(hex, alpha) {
  const [r, g, b] = hexToChannels(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** A role's resolved colour in a theme as a plain CSS colour string (hex, or rgba() if translucent). */
export function roleColor(role, theme = "light") {
  const { hex, alpha } = resolveRole(theme, role);
  return alpha === undefined ? hex : rgbaString(hex, alpha);
}

// ── Back-compat flat palette (resolved from themes.light) ───────────────────
// The legacy named colours, kept so existing consumers (cssRootVars / the legal pages) and
// any external reader see the exact same values as before tokenisation.
export const color = {
  paper: roleColor("surface.page"),
  paper2: roleColor("surface.sunken"),
  card: roleColor("surface.raised"),
  ink: roleColor("text.primary"),
  ink2: roleColor("text.secondary"),
  ink3: roleColor("text.tertiary"),
  line: roleColor("border.default"),

  forest: roleColor("brand.forest"),
  green: roleColor("brand.green"),
  greenD: roleColor("brand.green-hover"),
  sage: roleColor("accent.default"),
  olive: roleColor("brand.olive"),
  moss: roleColor("accent.strong"),
  cream: roleColor("brand.cream"),

  // The app's long-standing `yellow` accent resolves to sage under the green system.
  yellow: roleColor("accent.default"),
  yellowD: roleColor("accent.strong"),

  safe: roleColor("status.safe"),
  warn: roleColor("status.warn"),
  danger: roleColor("status.danger"),
  info: roleColor("status.info"),
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

// Emit a marketing-page-style `:root { … }` custom-property block (hex values) for the legal
// pages. Output is unchanged by tokenisation; the SPA uses `themeCssVars()` instead.
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
