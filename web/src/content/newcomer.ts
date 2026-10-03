// Newcomer education for About you Q1 (spec docs/first-timer/spec.md A10 ticket b, #591; flag
// ft_journey). Shown inline under the residency question when the answer isn't "resident all year".
//
// TONE + COMPLIANCE (owner ruling #537): TEXT ONLY, NO FIGURES. No rates, thresholds or amounts (the
// ATO applies the working holiday maker rates itself); no outcome promises; no verdict on whether the
// reader has to lodge; judgement calls defer with "confirm with a registered tax agent". Scanned by
// the tax-advice denylist in scripts/check-units.ts.

import type { ExtLink } from "./beforeYouStart";
import { DEFER_TO_AGENT } from "./stepGuides";

export type NewcomerTopicKey = "whm" | "temporary_foreign_income" | "non_resident" | "medicare" | "dasp" | "unsure";

export interface NewcomerTopic {
  title: string;
  body: string;
  link: ExtLink;
}

export const NEWCOMER_TOPICS: Record<NewcomerTopicKey, NewcomerTopic> = {
  whm: {
    title: "Working holiday makers",
    body: "If you're on a working holiday visa (subclass 417 or 462), the ATO applies its own working holiday maker rates to that income when it processes your return. You don't work them out yourself. That generally applies whatever your residency, although people from certain treaty countries may be taxed as residents instead: myTax asks for your home country.",
    link: { label: "Working holiday makers (ATO)", url: "https://www.ato.gov.au/individuals-and-families/coming-to-australia-or-going-overseas/coming-to-australia/working-holiday-makers" },
  },
  temporary_foreign_income: {
    title: "Income from overseas",
    body: "Temporary residents generally declare only income earned in Australia, with some exceptions such as overseas work done while living here. Check the ATO's page, and if you're unsure, confirm with a registered tax agent.",
    link: {
      label: "Foreign and temporary resident income (ATO)",
      url: "https://www.ato.gov.au/individuals-and-families/income-deductions-offsets-and-records/income-you-must-declare/foreign-and-worldwide-income/foreign-and-temporary-resident-income",
    },
  },
  non_resident: {
    title: "Not a resident for tax",
    body: "Non-residents generally declare only income from Australian sources. Your residency can differ from your visa, so it's worth checking with the ATO's residency page. If you have a HELP or other study loan, foreign residents have extra reporting: the ATO asks you to declare your worldwide income or lodge a non-lodgment advice.",
    link: { label: "Your tax residency (ATO)", url: "https://www.ato.gov.au/individuals-and-families/coming-to-australia-or-going-overseas/your-tax-residency" },
  },
  medicare: {
    title: "Medicare entitlement statement",
    body: "If you weren't entitled to Medicare for some or all of the year, Services Australia can issue a Medicare entitlement statement. myTax asks for it if you claim an exemption from the Medicare levy.",
    link: { label: "Medicare entitlement statement (Services Australia)", url: "https://www.servicesaustralia.gov.au/medicare-entitlement-statement" },
  },
  dasp: {
    title: "Leaving Australia",
    body: "When you leave Australia for good on a temporary visa, you can apply for the super your employers paid, called a departing Australia superannuation payment (DASP). It's a separate application, not part of your tax return.",
    link: { label: "Departing Australia superannuation payment (ATO)", url: "https://www.ato.gov.au/individuals-and-families/super-for-individuals-and-families/super/temporary-residents-and-superannuation/departing-australia-superannuation-payment-dasp" },
  },
  unsure: {
    title: "Not sure about residency?",
    body: `Tax residency isn't the same as your visa or citizenship. The ATO's residency page has a tool to help you work it out. ${DEFER_TO_AGENT}`,
    link: { label: "Your tax residency (ATO)", url: "https://www.ato.gov.au/individuals-and-families/coming-to-australia-or-going-overseas/your-tax-residency" },
  },
};

/**
 * Which topics to show for the residency values a person has in the year (the pack's
 * situation_facts.residency values). Resident-only (or nothing) ⇒ no topics. Order is stable and
 * de-duplicated, so a part-year newcomer (resident + foreign periods) sees each topic once.
 */
export function newcomerTopics(residencyValues: readonly (string | null | undefined)[]): NewcomerTopicKey[] {
  const vals = new Set(residencyValues.filter((v): v is string => typeof v === "string"));
  const out: NewcomerTopicKey[] = [];
  const add = (k: NewcomerTopicKey) => {
    if (!out.includes(k)) out.push(k);
  };
  if (vals.has("whm")) add("whm");
  if (vals.has("whm") || vals.has("temporary")) add("temporary_foreign_income");
  if (vals.has("foreign")) add("non_resident");
  // A full-year non-resident doesn't pay the Medicare levy, so the statement only matters alongside a resident/temporary period.
  if (vals.has("whm") || vals.has("temporary") || (vals.has("foreign") && vals.has("resident"))) add("medicare");
  if (vals.has("whm") || vals.has("temporary")) add("dasp");
  if (vals.has("unsure")) add("unsure");
  return out;
}
