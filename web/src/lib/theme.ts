// Inline-style access to the semantic colour roles (design/tokens.mjs → CSS vars injected by
// web/tailwind.config.js). Use these where a Tailwind class can't reach — inline gradients,
// chart swatches, SVG fills — instead of hard-coding hex (scripts/check-no-raw-colors.ts fails on that).

/** `rgb(var(--role))`, optionally with an alpha: role("text-primary", 0.1). Pass the CSS var name sans `--`. */
export function role(name: string, alpha?: number): string {
  return alpha === undefined ? `rgb(var(--${name}))` : `rgb(var(--${name}) / ${alpha})`;
}

/** The chart / breakdown swatch series (`chart.series.1..6`), cycled across rows. */
export const CHART_SERIES: readonly string[] = [1, 2, 3, 4, 5, 6].map((n) => role(`chart-series-${n}`));
