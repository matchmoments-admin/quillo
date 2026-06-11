import type { Profile } from "./db";

// Platform user roles (profiles.roles, a JSON array — a user may hold several). Single source of
// truth; the web mirrors these labels. Distinct from persons.role (household: self/spouse/dependent)
// and from the future accountant→client *delegation* (an account_access table, not built yet).
export const ROLES = ["individual", "admin", "accountant", "bookkeeper", "support", "partner"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  individual: "Individual",
  admin: "Admin",
  accountant: "Accountant / tax agent",
  bookkeeper: "Bookkeeper",
  support: "Support",
  partner: "Partner",
};

/** A profile's roles, parsed defensively (bad/empty JSON → the default ["individual"]). */
export function parseRoles(profile: Pick<Profile, "roles"> | null | undefined): Role[] {
  if (!profile?.roles) return ["individual"];
  try {
    const v = JSON.parse(profile.roles) as unknown;
    if (Array.isArray(v)) {
      const known = v.filter((r): r is Role => (ROLES as readonly string[]).includes(r as string));
      return known.length ? known : ["individual"];
    }
  } catch {
    /* fall through */
  }
  return ["individual"];
}

export function hasRole(profile: Pick<Profile, "roles"> | null | undefined, role: Role): boolean {
  return parseRoles(profile).includes(role);
}

export function isAdmin(profile: Pick<Profile, "roles"> | null | undefined): boolean {
  return hasRole(profile, "admin");
}

/**
 * Gate for the partner portal. NOTE: holding the `partner` role only proves "this tenant is partner
 * staff" — it does NOT say WHICH partner org. The portal must ALSO resolve the caller's `partner_id`
 * via `partner_members` (see `resolvePartnerId` in `partners.ts`) and scope every read by it. Unlike
 * `isAdmin` (which unlocks cross-tenant god-mode), `partner` is the *constrained* direction: one org,
 * its leads only. The role is necessary but never sufficient.
 */
export function isPartner(profile: Pick<Profile, "roles"> | null | undefined): boolean {
  return hasRole(profile, "partner");
}

/** Validate + normalise a requested roles array (drops unknowns; always keeps at least 'individual'). */
export function normaliseRoles(roles: unknown): Role[] {
  const arr = Array.isArray(roles) ? roles : [];
  const known = [...new Set(arr.filter((r): r is Role => (ROLES as readonly string[]).includes(r as string)))];
  return known.length ? known : ["individual"];
}
