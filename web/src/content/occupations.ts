// Canonical occupations the rule pack authors deduction hints for — these mirror the
// scope_type:"occupation" scope_value tokens in src/rulepacks/au-v1.json. We keep a human
// label <-> enum token mapping so the onboarding UI shows real words (typeahead) while the
// categoriser still receives the snake_case token it matches on. Previously the field leaked
// tokens like "it_professional" into the placeholder and free-text that didn't match a token
// silently produced no occupation-specific hints (#72).
export const OCCUPATIONS: { token: string; label: string }[] = [
  { token: "nurse", label: "Nurse" },
  { token: "healthcare_worker", label: "Healthcare worker" },
  { token: "aged_care_worker", label: "Aged & disability care worker" },
  { token: "it_professional", label: "IT professional" },
  { token: "office_professional", label: "Office professional" },
  { token: "teacher", label: "Teacher" },
  { token: "tradesperson", label: "Tradesperson" },
  { token: "apprentice", label: "Apprentice / trainee" },
  { token: "driver", label: "Driver" },
  { token: "hospitality_worker", label: "Hospitality worker" },
  { token: "retail_worker", label: "Retail worker" },
  { token: "sales_professional", label: "Sales professional" },
  { token: "real_estate_agent", label: "Real estate agent" },
  { token: "adf_member", label: "ADF member" },
  { token: "police_officer", label: "Police officer" },
  { token: "security_guard", label: "Security guard" },
  { token: "cleaner", label: "Cleaner" },
];

// Lookup by either the human label or the token (both lower-cased) → canonical token.
const BY_KEY = new Map<string, string>();
for (const o of OCCUPATIONS) {
  BY_KEY.set(o.label.toLowerCase(), o.token);
  BY_KEY.set(o.token.toLowerCase(), o.token);
}
// Legacy/colloquial aliases → canonical token (e.g. old tenants who typed "tradie" free-text — the
// rule pack's guide + claimability tokens are canonical, so a save normalises to them).
BY_KEY.set("tradie", "tradesperson");
BY_KEY.set("aged care worker", "aged_care_worker");
BY_KEY.set("carer", "aged_care_worker");
BY_KEY.set("police", "police_officer");
BY_KEY.set("defence", "adf_member");
BY_KEY.set("army", "adf_member");

/**
 * Map a typed/selected occupation to its canonical token. A known label or token resolves to
 * the token the rule pack matches on; anything else is passed through trimmed (lower-cased) so
 * the generic "all"-occupation rules still apply and the user's words are never discarded.
 */
export function normaliseOccupation(input: string): string {
  const t = input.trim();
  if (!t) return "";
  return BY_KEY.get(t.toLowerCase()) ?? t.toLowerCase();
}

/** Token → human label for display. Unknown free-text occupations are shown exactly as stored. */
export function occupationLabel(token: string): string {
  const hit = OCCUPATIONS.find((o) => o.token === token);
  return hit ? hit.label : token;
}
