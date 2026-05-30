/**
 * PII redaction for FREE TEXT before it is sent to a text LLM call (fix H7).
 *
 * Scope note: receipt IMAGES are sent to Claude vision as-is (that is the OCR
 * input and cannot be redacted pre-OCR). This helper applies to free text only —
 * e.g. an email body used as a fallback "receipt", or any reasoning/advice prompt.
 * The cross-border exposure of image data is governed by the explicit APP-8
 * consent recorded per tenant (recordConsent), not by this function.
 *
 * AU identifiers covered: TFN (9 digits), ABN (11 digits), BSB+account, and
 * card PANs (13-19 digits). Patterns are deliberately conservative.
 */
const PATTERNS: Array<{ label: string; re: RegExp }> = [
  // Card PAN 13-19 digits, optionally separated by spaces/hyphens. Check first (longest).
  { label: "CARD", re: /\b(?:\d[ -]?){13,19}\b/g },
  // ABN: 11 digits, often grouped 2 3 3 3.
  { label: "ABN", re: /\b\d{2}[ ]?\d{3}[ ]?\d{3}[ ]?\d{3}\b/g },
  // TFN: 8-9 digits, often grouped 3 3 3 / 3 3 2.
  { label: "TFN", re: /\b\d{3}[ ]?\d{3}[ ]?\d{2,3}\b/g },
  // BSB (3-3) + account (5-10).
  { label: "BANK", re: /\b\d{3}[ -]?\d{3}\b(?:[ -]?\d{5,10})?/g },
];

export function redact(text: string): string {
  let out = text;
  for (const { label, re } of PATTERNS) {
    out = out.replace(re, `[REDACTED:${label}]`);
  }
  return out;
}
