// Type declarations for the centralised design tokens (tokens.mjs is plain JS so it can
// be imported by both the Worker/TS build and the Node-loaded Tailwind config). Keep these
// in sync with tokens.mjs.

export const color: {
  paper: string;
  paper2: string;
  ink: string;
  ink2: string;
  ink3: string;
  line: string;
  yellow: string;
  yellowD: string;
  card: string;
  safe: string;
  warn: string;
  danger: string;
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
