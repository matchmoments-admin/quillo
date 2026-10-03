// Type declarations for the centralised design tokens (tokens.mjs is plain JS so it can
// be imported by both the Worker/TS build and the Node-loaded Tailwind config). Keep these
// in sync with tokens.mjs.

export const primitives: Record<string, string>;

export const roles: readonly string[];

export type ThemeEntry = string | { ref: string; alpha: number };
export const themes: Record<string, Record<string, ThemeEntry>>;

export const darkThemes: readonly string[];
export const themeType: Record<string, Record<string, string>>;

export function roleVar(role: string): string;
export function themeCssVars(theme?: string): Record<string, string>;
export function themeTypeVars(theme?: string): Record<string, string>;
export function roleValue(role: string, theme?: string): { hex: string; alpha: number | undefined };
export function roleColor(role: string, theme?: string): string;

export const color: {
  paper: string;
  paper2: string;
  card: string;
  ink: string;
  ink2: string;
  ink3: string;
  line: string;
  forest: string;
  green: string;
  greenD: string;
  sage: string;
  olive: string;
  moss: string;
  cream: string;
  yellow: string;
  yellowD: string;
  safe: string;
  warn: string;
  danger: string;
  info: string;
};

export const font: {
  serif: string;
  sans: string;
};

export const radius: {
  sm: string;
  md: string;
  lg: string;
  pill: string;
};

export const shadow: {
  card: string;
  float: string;
};

export function cssRootVars(): string;
