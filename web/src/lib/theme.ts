// Inline-style access to the semantic colour roles (design/tokens.mjs → CSS vars injected by
// web/tailwind.config.js). Use these where a Tailwind class can't reach — inline gradients,
// chart swatches, SVG fills — instead of hard-coding hex (scripts/check-no-raw-colors.ts fails on that).

/** `rgb(var(--role))`, optionally with an alpha: role("text-primary", 0.1). Pass the CSS var name sans `--`. */
export function role(name: string, alpha?: number): string {
  return alpha === undefined ? `rgb(var(--${name}))` : `rgb(var(--${name}) / ${alpha})`;
}

/** The chart / breakdown swatch series (`chart.series.1..6`), cycled across rows. */
export const CHART_SERIES: readonly string[] = [1, 2, 3, 4, 5, 6].map((n) => role(`chart-series-${n}`));

// ── Theme selection (spec A12) ──────────────────────────────────────────────
// `<html data-theme>` picks a theme block emitted by web/tailwind.config.js from design/tokens.mjs.
// `legacy` is also the bare `:root` default, so it renders identically with or without the attribute.

/** The user's Appearance choice (account menu), stored in profiles.ui_state.theme. */
export type Appearance = "system" | "light" | "dark";
export const APPEARANCES: readonly Appearance[] = ["system", "light", "dark"];
export type ThemeName = "legacy" | "quiet-light" | "quiet-dark";

/**
 * The theme to render. `ft_journey` OFF ⇒ always `legacy` (today's look, whatever was stored).
 * ON ⇒ Direction A: Light/Dark as chosen, System follows `prefers-color-scheme`.
 */
export function resolveTheme(ftJourney: boolean, appearance: Appearance, prefersDark: boolean): ThemeName {
  if (!ftJourney) return "legacy";
  const dark = appearance === "dark" || (appearance === "system" && prefersDark);
  return dark ? "quiet-dark" : "quiet-light";
}

/** The stored Appearance from a profile's ui_state JSON, or null when unset / malformed. */
export function parseAppearance(uiState?: string | null): Appearance | null {
  if (!uiState) return null;
  try {
    const v = (JSON.parse(uiState) as { theme?: unknown }).theme;
    return APPEARANCES.includes(v as Appearance) ? (v as Appearance) : null;
  } catch {
    return null;
  }
}
