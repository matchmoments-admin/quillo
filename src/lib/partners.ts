import type { Env } from "../env";

// Advisory Phase 2 — partner platform, Slice 1 (identity + isolation scaffold).
// docs/advisory-phase2-partners.md §1. This module is the ONLY sanctioned read path into partner-scoped
// data. It exists to make the app's SECOND isolation axis explicit and testable: the consumer app keys
// everything by `user_id` (identity derived server-side, never trusted from the client); the partner
// portal keys everything by `partner_id`. The two domains must NEVER cross — a sloppy join here leaks
// one consumer's referral (postcode + "shopping for energy") to the wrong partner org. So:
//   1. `isPartner(profile)` (roles.ts) proves the caller is partner STAFF — necessary, never sufficient.
//   2. `resolvePartnerId` maps the caller's own tenant → their ONE partner_id (via partner_members).
//   3. Every read below binds that resolved partner_id. No caller may pass a partner_id from the request.
// NOTE: no portal/CTA/live-partner ships in Slice 1 — these readers return [] until rows exist, and the
// whole commercial surface stays behind the advisory_partners_energy flag (OFF in prod).

// The minimal D1 surface these helpers touch — narrow so the isolation logic is unit-testable with a fake
// (the unit goldens never reach real D1; see the "partner isolation" check in scripts/check-units.ts).
export interface PartnerDB {
  prepare(sql: string): {
    bind(...vals: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
      all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
    };
  };
}

export interface PartnerReferral {
  id: string;
  user_id: string;
  partner_id: string;
  status: string;
  revenue_cents: number;
  created_at: string;
}

/**
 * The caller's tenant → their partner org. A staff tenant belongs to exactly one partner
 * (partner_members.UNIQUE(user_id)). Returns null when the tenant isn't partner staff — callers MUST
 * treat null as "no access" (return [] / 403), never fall back to an unscoped read.
 */
export async function resolvePartnerId(db: PartnerDB, staffUserId: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT partner_id FROM partner_members WHERE user_id = ?`)
    .bind(staffUserId)
    .first<{ partner_id: string }>();
  return row?.partner_id ?? null;
}

/**
 * Referrals for ONE partner org — the portal's lead list. Scoped by the resolved partner_id ONLY (never
 * by anything from the request). Pass the partner_id returned by `resolvePartnerId`; if that was null,
 * do not call this — there is no "all referrals" read path by design.
 */
export async function listPartnerReferrals(db: PartnerDB, partnerId: string): Promise<PartnerReferral[]> {
  const r = await db
    .prepare(
      `SELECT id, user_id, partner_id, status, revenue_cents, created_at
         FROM referrals WHERE partner_id = ? ORDER BY created_at DESC`,
    )
    .bind(partnerId)
    .all<PartnerReferral>();
  return r.results ?? [];
}

/**
 * Convenience gate for a portal request: resolve the caller's partner_id and hand back their referrals,
 * or null if the caller maps to no partner org (caller turns null into a 403). This is the single entry
 * point a `/partner` route should use — it can't accidentally read another org's data because the only
 * partner_id it ever binds is the one resolved from the caller's own tenant.
 */
export async function partnerScopedReferrals(env: Env, staffUserId: string): Promise<PartnerReferral[] | null> {
  const partnerId = await resolvePartnerId(env.DB as unknown as PartnerDB, staffUserId);
  if (!partnerId) return null;
  return listPartnerReferrals(env.DB as unknown as PartnerDB, partnerId);
}
