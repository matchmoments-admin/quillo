import { shadow, roleVar, themeCssVars, themeTypeVars, themes, darkThemes } from "../design/tokens.mjs";

// Colour classes resolve to CSS custom properties, never hex. The vars themselves
// (`:root { --surface-page: 238 240 210; … }`) are emitted into Tailwind's base layer by the
// plugin below from the single token source (../design/tokens.mjs): `themes.legacy` on bare `:root`
// (today's look), every other theme under `:root[data-theme="<name>"]` (set by web/src/lib/theme.ts
// only when `ft_journey` is ON). A re-skin / new theme is a token change, not a markup change.
//
// Channel triplets keep Tailwind's alpha modifiers working: `bg-ink/5` → rgb(var(--text-primary) / 0.05).
const role = (r) => `rgb(var(${roleVar(r)}) / <alpha-value>)`;

// A translucent role (border.default = forest @ 13%) keeps its own default alpha on a bare class
// (`border-line`), while an explicit modifier still overrides it (`border-line/60` → 60%), exactly
// as Tailwind treated the old rgba() value. Tailwind calls a colour function with
// `opacityVariable` set for a bare class and with only `opacityValue` for a `/NN` modifier.
const translucentRole = (r) => {
  const v = roleVar(r);
  return ({ opacityVariable, opacityValue }) =>
    opacityVariable !== undefined || opacityValue === undefined
      ? `rgb(var(${v}) / var(${v}-alpha))`
      : `rgb(var(${v}) / ${opacityValue})`;
};

/** @type {import('tailwindcss').Config} */
// The app's long-standing class names (bg-ink, text-muted, border-line, bg-yellow …) are kept as
// ALIASES onto semantic roles, so tokenisation needed no markup churn.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: role("text.primary"),
        "ink-2": role("text.secondary"),
        "ink-3": role("text.tertiary"),
        muted: role("text.secondary"), // the app's long-standing "muted" → secondary forest ink
        line: translucentRole("border.default"),
        surface: role("surface.sunken"), // soft panels / hover fills
        paper: role("surface.page"),
        card: role("surface.raised"),
        yellow: role("accent.highlight"), // back-compat alias → sage (signature highlight)
        "yellow-d": role("accent.strong"),
        // Named greens for the sidebar / feature surfaces.
        forest: role("brand.forest"),
        green: role("brand.green"),
        "green-d": role("brand.green-hover"),
        sage: role("accent.highlight"),
        olive: role("brand.olive"),
        moss: role("accent.strong"),
        cream: role("brand.cream"),
        safe: role("status.safe"),
        warn: role("status.warn"),
        danger: role("status.danger"),
        info: role("status.info"),
        // Roles that replaced raw Tailwind palette classes (amber-*/red-*), same values.
        "caution-surface": role("status.caution-surface"),
        "caution-border": role("status.caution-border"),
        "caution-text": role("status.caution-text"),
        "caution-text-strong": role("status.caution-text-strong"),
        "danger-surface": role("status.danger-surface"),
        "danger-text": role("status.danger-text"),
        // `white` is only ever "text/marks on a dark fill" in this app, so it follows the theme's
        // inverse role (pure white in legacy → identical; near-black under quiet-dark).
        white: role("text.inverse"),
        // Direction A roles (spec A12) for the ft/ component library.
        accent: role("accent.default"),
        "accent-hover": role("accent.hover"),
        "accent-soft": role("accent.soft"),
        "line-strong": translucentRole("border.strong"),
        ok: role("status.ok"),
        "warn-surface": role("status.warn-surface"),
        focus: translucentRole("focus.ring"),
      },
      fontFamily: {
        // Per-theme CSS vars (tokens.mjs `themeType`); each value already includes its fallback stack.
        sans: "var(--font-sans)",
        serif: "var(--font-display)",
        display: "var(--font-display)", // Anton (legacy) / Geist (quiet) — big display headings/numbers
        mono: "var(--font-mono)", // Tailwind's default stack (legacy) / Geist Mono (quiet) — money figures
      },
      // NOTE: we intentionally do NOT remap Tailwind's default radius scale
      // (rounded-lg/xl/2xl) — the dashboard relies on those exact sizes for dense
      // inputs/cards. `radius` from tokens governs the marketing page only.
      boxShadow: {
        card: shadow.card,
        float: shadow.float,
      },
    },
  },
  plugins: [
    // Inject every theme's colour-role + typography variables. Deterministic (pure function of
    // tokens.mjs), so there is no generated file to keep in sync. `legacy` is the bare `:root`
    // default; the attribute blocks are more specific, so they win whenever data-theme is set.
    function themeVars({ addBase }) {
      const vars = (t) => ({ ...themeCssVars(t), ...themeTypeVars(t) });
      addBase({ ":root": vars("legacy") });
      for (const t of Object.keys(themes).filter((name) => name !== "legacy")) {
        addBase({ [`:root[data-theme="${t}"]`]: { ...vars(t), colorScheme: darkThemes.includes(t) ? "dark" : "light" } });
      }
    },
  ],
};
