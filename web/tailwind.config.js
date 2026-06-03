import { color, font, shadow } from "../design/tokens.mjs";

/** @type {import('tailwindcss').Config} */
// Colours/fonts/radii/shadows all come from the centralised token source
// (../design/tokens.mjs), shared with the marketing landing page. Repointing a value
// there re-skins every screen here automatically, because the app's existing classes
// (bg-ink, text-muted, border-line, rounded-lg, shadow-card …) map onto these names.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: color.ink,
        "ink-2": color.ink2,
        "ink-3": color.ink3,
        muted: color.ink2, // the app's long-standing "muted" → secondary forest ink
        line: color.line,
        surface: color.paper2, // soft panels / hover fills
        paper: color.paper,
        card: color.card,
        yellow: color.yellow, // back-compat alias → sage (signature accent)
        "yellow-d": color.yellowD,
        // Named greens for the sidebar / feature surfaces.
        forest: color.forest,
        green: color.green,
        "green-d": color.greenD,
        sage: color.sage,
        olive: color.olive,
        moss: color.moss,
        cream: color.cream,
        safe: color.safe,
        warn: color.warn,
        danger: color.danger,
        info: color.info,
      },
      fontFamily: {
        // Strings already include the full fallback stack.
        sans: font.sans,
        serif: font.serif,
        display: font.serif, // Anton — explicit alias for big display headings/numbers
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
  plugins: [],
};
