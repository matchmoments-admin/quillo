# Quillo design system — Direction A "Quiet ledger", fully tokenised

> Decision record for wayfinder ticket #539 on map #529. Owner chose **Direction A** (2026-10-03)
> from three directions on the [first-timer journey canvas](https://claude.ai/artifact/65dYStvQ2Cudrcq8XYQmKA),
> with the instruction: *"ensure our entire system is tokenised or best practice themed so we can
> adapt this universally easily."* This document is the target the redesign builds to.

## 1. Look and feel

Calm, trustworthy, a little analogue: a novice is handling money and the tax office, so nothing
shouts. Warm off-white ground, deep emerald as the single accent, soft bordered cards used only
where a card *is* a decision (a claim, a record, a check). One sans family for everything, with a
mono for figures. Motion is quiet: short ease-out transitions, no perpetual animation, and
`prefers-reduced-motion` respected everywhere.

Explicitly **not**: Anton condensed display type (retired), serif headings in the app, gradients,
glows, purple, emoji, refund-meter visuals.

## 2. Token architecture (the part that makes it adaptable)

Three layers. Components only ever touch layer 3.

| Layer | What | Example | Who changes it |
|---|---|---|---|
| 1. **Primitives** | Raw palette and scales, no meaning | `emerald-700 #1E6B52`, `stone-50 #F4F3EE`, `space-4 16px` | Brand refresh only |
| 2. **Themes** | Map semantic roles → primitives, per theme | `light: surface.page = stone-50`; `dark: surface.page = stone-950` | Adding a theme or brand |
| 3. **Semantic roles** | What the UI uses | `surface.page`, `text.primary`, `accent.default`, `status.warn` | Never by components, only consumed |

**Mechanism.**
- `design/tokens.mjs` stays the single source. It gains `primitives`, `themes.{light,dark}` and
  the semantic role list. It is still dependency-free ESM, still shared with the landing page.
- A build step (or `cssRootVars()`, generalised) emits **CSS custom properties** per theme:
  `:root { --surface-page: 244 243 238; … }` and `[data-theme="dark"] { … }`, plus a
  `prefers-color-scheme` fallback. Channel triplets let Tailwind keep alpha:
  `rgb(var(--surface-page) / <alpha-value>)`.
- `web/tailwind.config.js` maps **semantic names to variables**, not hex. The app's existing class
  names (`bg-paper`, `bg-card`, `text-ink`, `text-muted`, `border-line`, `bg-yellow`…) stay as
  **aliases** onto semantic variables, so tokenisation lands with no markup churn and a re-skin is
  a token change.
- **Guardrail:** a test (in `npm test`, like the hooks and NUL guards) fails on new hard-coded hex,
  `rgb()` literals, or raw Tailwind palette classes (`bg-red-500`) in `web/src`, with an allowlist
  for charts until they move to tokens. Today 3 files hard-code hex (Dashboard, Extras, Savings)
  and 2 use raw palette classes.
- Charts read the same variables (a `chart.series.1..6` role set), so they theme too.
- Jurisdiction- and brand-neutral: a white-label or regional theme is a new entry in `themes`,
  nothing else.

## 3. Direction A values

### Semantic roles → light theme (dark theme mirrors these and ships in the same build)

| Role | Light | Notes |
|---|---|---|
| `surface.page` | `#F4F3EE` | warm off-white ground |
| `surface.raised` | `#FFFFFF` | cards that are decisions |
| `surface.sunken` | `#ECEAE3` | wells, inputs on raised, progress track |
| `border.default` | `#E3E1D9` | 1px card and divider borders |
| `border.strong` | `#CFCBC1` | inputs, secondary buttons |
| `text.primary` | `#1D2420` | never pure black |
| `text.secondary` | `#555D58` | body copy, meta (passes 4.5:1 on page and raised) |
| `text.inverse` | `#FFFFFF` | on accent fills |
| `accent.default` | `#1E6B52` | the one accent: primary actions, progress, links |
| `accent.hover` | `#17543F` | |
| `accent.soft` | `#E2EEE8` | 'Worth a look' badges, selected chips |
| `status.ok` | `#1E6B52` | recorded, done |
| `status.warn` | `#94630F` on `#FFF6EC` | needs a record / missing income statement. (Was `#9A6712`; nudged darker within the hue in #573 because it measured 4.37:1 on `surface.page`.) |
| `status.danger` | `#9C3B2C` | errors, destructive confirmation |
| `status.info` | `#2F5F9E` | neutral info |
| `focus.ring` | `#1E6B52` at 40% | 2px outline, 2px offset, always visible on keyboard focus |

### Typography

- **Geist** (UI, headings, body) and **Geist Mono** (all money figures and labels like `D5`),
  self-hosted woff2 with a `system-ui` fallback stack.
- Scale (rem, 16px base): 12 / 13 / 14 / 15 (body) / 17 / 20 / 26 (step title) / 32 (Home only).
  Headings `font-weight 600`, `letter-spacing -0.02em`. Body line-height 1.5, max 65ch.

### Shape, space, elevation, motion

- Radius: `sm 8px` (inputs, small buttons), `md 14px` (cards), `pill 999px` (badges, chips).
- Spacing: 4px base, scale 4 / 8 / 12 / 16 / 20 / 24 / 32 / 48.
- Elevation: borders do the work; one tinted shadow for sheets and drawers only
  (`0 -8px 24px rgb(29 36 32 / 0.10)`).
- Motion: 150ms (hover/press) and 220ms (sheets) `cubic-bezier(0.16,1,0.3,1)`, transform and opacity
  only, press = `scale(0.98)`. Off under `prefers-reduced-motion`.
- Touch targets ≥44px; mobile-first (the first-timer cohort skews phone), stacking to one column
  under 768px.

## 4. Core components (built once on the tokens)

Step header (progress segments + 'Step n of 6'), step footer (Back / Why? / primary), claim card
(title, figure, badge, why, evidence, Claim it / Not work-related), record row (status + action),
check item (warn/info), worksheet line (label, figure, copy button, record link), 'Why?' sheet
(Ask Quillo drawer), chip (tick-what-applies), completeness meter, empty / loading (skeleton) /
error states for each. General-information footnote style used on every money surface.

## 5. Rollout

1. **Tokenise first, look unchanged.** Move today's values into the three-layer structure and CSS
   variables with aliases. Byte-identical visuals; adds the hex/palette guard. This is safe to
   build now (graduated as its own build-ready ticket).
2. **Apply Direction A** as a theme switch (new `themes.light` values + Geist), landing with the
   redesigned journey screens. Behind the redesign's flag so the old look stays until the
   journey ships.
3. **Dark theme** from the same roles.
4. The landing page consumes the same variables (retire its inline `:root`).
