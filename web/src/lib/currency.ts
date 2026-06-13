// UK epic stop 2 — currency display helper (SPA twin of the server currencySymbol map). The money model
// is de-anchored from AUD to the tenant's BASE currency; this turns a base-currency CODE into a display
// symbol and (for money()) a locale.
//
// AU byte-identical guard: 'AUD' (and any unknown/absent code that resolves through the '$' default) must
// render exactly as before — '$' + 'en-AU'. The whole stop's byte-identity for AU rests on this default.

const SYMBOLS: Record<string, string> = {
  AUD: "$",
  GBP: "£",
  USD: "US$",
  EUR: "€",
  NZD: "NZ$",
};

/** The display symbol for a currency code. Unknown ⇒ the code plus a space (e.g. 'CAD ') — never blank. */
export function currencySymbol(code: string | null | undefined): string {
  if (!code) return "$"; // absent ⇒ AU default (byte-identical)
  const c = code.trim().toUpperCase();
  return SYMBOLS[c] ?? `${c} `;
}

// The Intl locale used to format the amount for each base currency. AUD ⇒ en-AU (byte-identical default).
const LOCALES: Record<string, string> = {
  AUD: "en-AU",
  GBP: "en-GB",
  USD: "en-US",
  EUR: "en-IE",
  NZD: "en-NZ",
};

/** The number-formatting locale for a base currency code. Unknown/absent ⇒ 'en-AU' (byte-identical). */
export function currencyLocale(code: string | null | undefined): string {
  if (!code) return "en-AU";
  return LOCALES[code.trim().toUpperCase()] ?? "en-AU";
}
