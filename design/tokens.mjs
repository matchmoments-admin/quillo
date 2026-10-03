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
// THEMES (docs/first-timer/spec.md A12):
//   • `legacy`      — the EXACT pre-tokenisation values (the "Organic-Brutalist" GREEN system: forest
//                     + sage + cream canvas, Anton display / Inter body). Emitted on bare `:root`, so
//                     with `ft_journey` OFF the app is visually byte-identical to before #566.
//   • `quiet-light` — Direction A "Quiet ledger" (design-system.md §3, verbatim), Geist + Geist Mono.
//   • `quiet-dark`  — the same roles, dark (spec A12 table).
// The quiet themes apply only when `ft_journey` is ON (web/src/lib/theme.ts sets
// `<html data-theme>`). scripts/check-theme-contrast.ts asserts every theme maps every role and
// that the quiet themes meet WCAG AA.
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
  white: "#ffffff",

  // Direction A "Quiet ledger" (design-system.md §3 + spec A12 dark table). Warm stone neutrals,
  // one emerald accent. Light end first, dark end after.
  stone50: "#f4f3ee",
  stone100: "#eceae3",
  stone200: "#e3e1d9",
  stone300: "#cfcbc1",
  ink500: "#646b66",
  ink600: "#555d58",
  ink900: "#1d2420",
  emerald100: "#e2eee8",
  emerald200: "#c9ded3",
  emerald700: "#1e6b52",
  emerald800: "#17543f",
  apricot50: "#fff6ec",
  apricot200: "#e8c99a",
  ochre750: "#94630f", // status.warn #9a6712 nudged darker within its hue: 4.37:1 on stone50 failed AA (spec A12)
  ochre800: "#7a510d",
  brick50: "#f7e4e0",
  cobalt700: "#2f5f9e",
  mist100: "#ecede8",
  mist400: "#a8afa9",
  mist500: "#8f9690",
  slate700: "#3a413c",
  slate800: "#2a302c",
  slate900: "#1a1f1c",
  slate950: "#121614",
  slate975: "#0d100e",
  emerald300: "#63b394",
  emerald400: "#4fa383",
  emerald850: "#24493b",
  emerald900: "#1c3a2f",
  gold300: "#ebc07f",
  gold400: "#e0a955",
  umber700: "#5c4520",
  umber900: "#2b2214",
  coral400: "#e07a68",
  brick950: "#3a1d18",
  sky400: "#7fa6dd",
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
  "text.inverse", // text on accent / dark fills (also the Tailwind `white` alias)
  "border.default", // borders, dividers
  "border.strong", // inputs, secondary buttons
  "brand.forest", // wordmark, sidebar, dark text
  "brand.green", // mid green — buttons / accents
  "brand.green-hover", // hover
  "brand.olive", // alt soft canvas
  "brand.cream", // lightest paper (text on forest)
  "accent.default", // THE action accent — primary actions, progress, links (Direction A)
  "accent.hover", // its hover
  "accent.soft", // soft accent fill — 'Worth a look' badges, selected chips
  "accent.highlight", // legacy signature highlight — active nav, accent cards (sage; `yellow`/`sage` aliases)
  "accent.strong", // muted highlight / pressed (moss)
  "status.ok",
  "status.safe",
  "status.warn",
  "status.warn-surface", // the fill status.warn sits on
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
  "focus.ring", // keyboard focus outline (translucent)
];

// ── Layer 2: themes ─────────────────────────────────────────────────────────
// role → primitive name, or { ref, alpha } for a translucent role.
export const themes = {
  legacy: {
    "surface.page": "olive150",
    "surface.sunken": "olive300",
    "surface.raised": "olive50",
    "text.primary": "green900",
    "text.secondary": "sage700",
    "text.tertiary": "sage600",
    "text.inverse": "white",
    "border.default": { ref: "green900", alpha: 0.13 },
    "border.strong": { ref: "green900", alpha: 0.25 },
    "brand.forest": "green900",
    "brand.green": "green700",
    "brand.green-hover": "green600",
    "brand.olive": "olive200",
    "brand.cream": "olive100",
    "accent.default": "green700",
    "accent.hover": "green600",
    "accent.soft": "sage300",
    "accent.highlight": "sage300",
    "accent.strong": "sage500",
    "status.ok": "green700",
    "status.safe": "green700",
    "status.warn": "ochre700",
    "status.warn-surface": "amber50",
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
    "focus.ring": { ref: "green700", alpha: 0.4 },
  },
  // Direction A light — design-system.md §3 table verbatim for its roles; the legacy-only roles
  // (brand.*, accent.highlight/strong, caution-*, danger-*, text.tertiary) get the nearest Direction A
  // value so today's screens stay legible under the flag until the ft/ components replace them.
  "quiet-light": {
    "surface.page": "stone50",
    "surface.sunken": "stone100",
    "surface.raised": "white",
    "text.primary": "ink900",
    "text.secondary": "ink600",
    "text.tertiary": "ink500",
    "text.inverse": "white",
    "border.default": "stone200",
    "border.strong": "stone300",
    "brand.forest": "ink900",
    "brand.green": "emerald700",
    "brand.green-hover": "emerald800",
    "brand.olive": "stone100",
    "brand.cream": "stone50",
    "accent.default": "emerald700",
    "accent.hover": "emerald800",
    "accent.soft": "emerald100",
    "accent.highlight": "emerald100",
    "accent.strong": "emerald200",
    "status.ok": "emerald700",
    "status.safe": "emerald700",
    "status.warn": "ochre750",
    "status.warn-surface": "apricot50",
    "status.danger": "brick700",
    "status.info": "cobalt700",
    "status.caution-surface": "apricot50",
    "status.caution-border": "apricot200",
    "status.caution-text": "ochre750",
    "status.caution-text-strong": "ochre800",
    "status.danger-surface": "brick50",
    "status.danger-text": "brick700",
    "chart.series.1": "emerald800",
    "chart.series.2": "emerald700",
    "chart.series.3": "cobalt700",
    "chart.series.4": "ochre750",
    "chart.series.5": "brick700",
    "chart.series.6": "ink600",
    "focus.ring": { ref: "emerald700", alpha: 0.4 },
  },
  // Direction A dark — spec A12 dark table. The legacy "dark ink on light" pairs invert (forest <->
  // cream, ink buttons become light) so every existing fg/bg pairing keeps its contrast.
  "quiet-dark": {
    "surface.page": "slate950",
    "surface.sunken": "slate975",
    "surface.raised": "slate900",
    "text.primary": "mist100",
    "text.secondary": "mist400",
    "text.tertiary": "mist500",
    "text.inverse": "slate975",
    "border.default": "slate800",
    "border.strong": "slate700",
    "brand.forest": "mist100",
    "brand.green": "emerald400",
    "brand.green-hover": "emerald300",
    "brand.olive": "slate900",
    "brand.cream": "slate975",
    "accent.default": "emerald400",
    "accent.hover": "emerald300",
    "accent.soft": "emerald900",
    "accent.highlight": "emerald900",
    "accent.strong": "emerald850",
    "status.ok": "emerald400",
    "status.safe": "emerald400",
    "status.warn": "gold400",
    "status.warn-surface": "umber900",
    "status.danger": "coral400",
    "status.info": "sky400",
    "status.caution-surface": "umber900",
    "status.caution-border": "umber700",
    "status.caution-text": "gold400",
    "status.caution-text-strong": "gold300",
    "status.danger-surface": "brick950",
    "status.danger-text": "coral400",
    "chart.series.1": "emerald300",
    "chart.series.2": "emerald400",
    "chart.series.3": "sky400",
    "chart.series.4": "gold400",
    "chart.series.5": "coral400",
    "chart.series.6": "mist400",
    "focus.ring": { ref: "emerald400", alpha: 0.5 },
  },
};

/** Themes whose colour scheme is dark (sets CSS `color-scheme` so form controls/scrollbars follow). */
export const darkThemes = ["quiet-dark"];

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
export function themeCssVars(theme = "legacy") {
  const out = {};
  for (const role of roles) {
    const { hex, alpha } = resolveRole(theme, role);
    out[roleVar(role)] = hexToChannels(hex).join(" ");
    // A role translucent in ANY theme gets its -alpha var in EVERY theme (1 when opaque there), so a
    // `rgb(var(--x) / var(--x-alpha))` consumer resolves under every theme.
    if (alpha !== undefined) out[`${roleVar(role)}-alpha`] = String(alpha);
    else if (translucentRoles.has(role)) out[`${roleVar(role)}-alpha`] = "1";
  }
  return out;
}

/** Roles that carry an alpha in at least one theme. */
const translucentRoles = new Set(roles.filter((r) => Object.values(themes).some((t) => typeof t[r] === "object")));

/** A role's resolved `{ hex, alpha }` in a theme (alpha undefined when opaque). For tests/tools. */
export function roleValue(role, theme = "legacy") {
  return resolveRole(theme, role);
}

function rgbaString(hex, alpha) {
  const [r, g, b] = hexToChannels(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** A role's resolved colour in a theme as a plain CSS colour string (hex, or rgba() if translucent). */
export function roleColor(role, theme = "legacy") {
  const { hex, alpha } = resolveRole(theme, role);
  return alpha === undefined ? hex : rgbaString(hex, alpha);
}

// ── Back-compat flat palette (resolved from themes.legacy) ───────────────────
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
  sage: roleColor("accent.highlight"),
  olive: roleColor("brand.olive"),
  moss: roleColor("accent.strong"),
  cream: roleColor("brand.cream"),

  // The app's long-standing `yellow` accent resolves to sage under the green system.
  yellow: roleColor("accent.highlight"),
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

// Per-theme typography, emitted as CSS vars alongside the colour roles (`--font-sans`, `--heading-weight`,
// …) so type re-skins with the theme exactly like colour. `legacy` reproduces today's computed values
// (Anton uppercase headings, Inter body, Tailwind's default mono stack). Geist + Geist Mono are
// self-hosted (web/public/fonts, SIL OFL 1.1) and only downloaded when a quiet theme uses them.
const MONO_DEFAULT = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
const GEIST_SANS = '"Geist", system-ui, -apple-system, "Segoe UI", sans-serif';
const GEIST_MONO = '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const QUIET_TYPE = {
  "font.sans": GEIST_SANS,
  "font.display": GEIST_SANS, // Anton retired in Direction A — one sans family for everything
  "font.mono": GEIST_MONO, // money figures and labels like D5
  "heading.weight": "600",
  "heading.tracking": "-0.02em",
  "heading.leading": "1.2",
  "heading.transform": "none",
};
export const themeType = {
  legacy: {
    "font.sans": font.sans,
    "font.display": font.serif,
    "font.mono": MONO_DEFAULT,
    "heading.weight": "400",
    "heading.tracking": "0.01em",
    "heading.leading": "1",
    "heading.transform": "uppercase",
  },
  "quiet-light": QUIET_TYPE,
  "quiet-dark": QUIET_TYPE,
};

/** Typography custom properties for one theme: `{ "--font-sans": "…", "--heading-weight": "600", … }`. */
export function themeTypeVars(theme = "legacy") {
  const t = themeType[theme];
  if (!t) throw new Error(`tokens: no typography for theme "${theme}"`);
  const out = {};
  for (const [k, v] of Object.entries(t)) out[roleVar(k)] = v;
  return out;
}

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
