/**
 * Car-expense copy (design audit #696, F14). A novated lease already pays the car's running costs through
 * salary packaging, so claiming them again under cents-per-km or the logbook method double-counts. Quillo
 * can't see which costs the lease covered, so it warns and defers. General information only: no figures,
 * no verdict (the tax-advice denylist scans this file).
 */
export const NOVATED_LEASE_CAR_NOTE = {
  lead: "You have a",
  term: "novated car lease",
  body:
    "Car running costs paid through a novated lease (such as the lease payments, fuel, servicing, insurance and registration) are generally part of the salary-packaging arrangement, so they aren't usually claimed again as a car expense under either method. Quillo doesn't check which costs your lease covered.",
  defer: "Before you claim car expenses for a leased car, confirm with a registered tax agent. General information only.",
} as const;
