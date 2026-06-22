// Bundled Private-Health extras product schedules ("auto-source" Slice 2 — the bundled-seed approach).
//
// WHY a seed (not a live importer yet): the per-product extras schedule (categories + annual limits +
// reset basis) is PUBLIC standardised data — every product's Private Health Information Statement (PHIS)
// is published on privatehealth.gov.au and redistributed as the data.gov.au "PrivateHealth.gov.au"
// dataset under CC BY 3.0 AU. The end state is to import that monthly XML feed; for now we bundle a
// small, hand-verified seed (the products we've confirmed against a real PHIS) so the auto-fill flow is
// testable end-to-end. Adding a product = appending here. A live gov-dataset importer is backlogged.
//
// Amounts are the STANDARD product limits; a member's actual limit can vary (loyalty/tenure), which is
// exactly why every sourced limit lands `verified=0` and the member confirms it. `combined_group` ties
// pooled services to one shared limit (poolExtrasTotals counts it once). `category` values MUST be in
// EXTRAS_CATEGORIES (advisory.ts) — asserted by a unit golden.

export interface PhisLimitSeed {
  category: string;            // an EXTRAS_CATEGORIES value
  annual_limit_cents: number;  // standard product limit (0 = covered, member enters the figure)
  combined_group?: string;     // shared-pool id (services sharing one limit)
  note?: string;               // factual note shown on confirm (e.g. a sub-limit)
}
export interface PhisProductSeed {
  id: string;
  name: string;
  cover_type: "extras" | "combined";
  reset_basis: "calendar" | "financial_year" | "anniversary";
  limits: PhisLimitSeed[];
}
export interface PhisInsurerSeed {
  id: string;
  name: string;
  products: PhisProductSeed[];
}

export const PHIS_SEED: PhisInsurerSeed[] = [
  {
    id: "nib",
    name: "nib / Qantas Insurance",
    products: [
      {
        // Verified from the Qantas Active Extras PHIS + product fact sheet (nib, issued 2025/2026).
        id: "qantas-active-extras",
        name: "Qantas Active Extras",
        cover_type: "extras",
        reset_basis: "calendar", // fact sheet: "maximum amount claimable per person in a calendar year"
        limits: [
          { category: "dental.general", annual_limit_cents: 70000, note: "No limit on preventative dental." },
          { category: "dental.major", annual_limit_cents: 100000, note: "Combined limit for major dental & endodontic." },
          { category: "optical", annual_limit_cents: 25000 },
          { category: "physiotherapy", annual_limit_cents: 75000, combined_group: "qa_physio" },
          { category: "chiropractic", annual_limit_cents: 75000, combined_group: "qa_physio" },
          { category: "osteopathy", annual_limit_cents: 75000, combined_group: "qa_physio" },
          { category: "remedial_massage", annual_limit_cents: 40000, combined_group: "qa_natural", note: "Remedial massage sub-limited to $200 within the $400 natural-therapies pool." },
          { category: "acupuncture_natural", annual_limit_cents: 40000, combined_group: "qa_natural", note: "Acupuncture, Chinese herbalism & myotherapy share this $400 pool." },
          { category: "pharmacy", annual_limit_cents: 10000, note: "Non-PBS items only." },
          { category: "appliances", annual_limit_cents: 30000 },
          { category: "exercise_physiology", annual_limit_cents: 15000 },
          { category: "podiatry", annual_limit_cents: 25000, note: "Combined with foot orthotics." },
          { category: "dietetics", annual_limit_cents: 30000 },
          { category: "psychology", annual_limit_cents: 30000, note: "Digital CBT up to $150 within this limit." },
          { category: "occupational_therapy", annual_limit_cents: 20000 },
          { category: "health_management", annual_limit_cents: 20000 },
          { category: "preventative_tests", annual_limit_cents: 10000 },
        ],
      },
    ],
  },
  {
    // A generic AU extras template for any fund we don't have a verified schedule for yet: it pre-loads
    // the common category list (so the member never types the taxonomy) with BLANK limits to fill in.
    id: "generic",
    name: "Other fund (enter your limits)",
    products: [
      {
        id: "generic-extras",
        name: "Generic extras — common categories",
        cover_type: "extras",
        reset_basis: "calendar",
        limits: [
          { category: "dental.general", annual_limit_cents: 0 },
          { category: "dental.major", annual_limit_cents: 0 },
          { category: "optical", annual_limit_cents: 0 },
          { category: "physiotherapy", annual_limit_cents: 0 },
          { category: "chiropractic", annual_limit_cents: 0 },
          { category: "psychology", annual_limit_cents: 0 },
          { category: "podiatry", annual_limit_cents: 0 },
          { category: "remedial_massage", annual_limit_cents: 0 },
          { category: "pharmacy", annual_limit_cents: 0 },
        ],
      },
    ],
  },
];

/** Flat product lookup for the picker + apply path. */
export function findPhisProduct(productId: string): { insurer: PhisInsurerSeed; product: PhisProductSeed } | null {
  for (const insurer of PHIS_SEED) {
    const product = insurer.products.find((p) => p.id === productId);
    if (product) return { insurer, product };
  }
  return null;
}

/** The picker list (insurer + product names/ids only — no member data). */
export function phisProductList(): { insurer_id: string; insurer_name: string; products: { id: string; name: string }[] }[] {
  return PHIS_SEED.map((i) => ({
    insurer_id: i.id,
    insurer_name: i.name,
    products: i.products.map((p) => ({ id: p.id, name: p.name })),
  }));
}
