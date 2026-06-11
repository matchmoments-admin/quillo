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

// ── Referral lifecycle (Tier-1 energy) ───────────────────────────────────────────────────────────
// created → presented → clicked → converted → paid, plus the terminals dismissed/expired/clawed_back.
// A referral is born 'clicked' (it is ONLY created by the consumer pressing the CTA — the "no cold
// calls" rule), then the partner's postback walks it converted→paid. Slice 2 simulates the postback
// from an admin-gated endpoint (the real HMAC webhook is the outward integration step, deferred).
export const REFERRAL_STATUSES = [
  "created", "presented", "clicked", "converted", "paid", "dismissed", "expired", "clawed_back",
] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

const FORWARD: Record<string, ReferralStatus[]> = {
  created: ["presented", "clicked", "dismissed", "expired"],
  presented: ["clicked", "dismissed", "expired"],
  clicked: ["converted", "dismissed", "expired"],
  converted: ["paid", "clawed_back"],
  paid: ["clawed_back"],
};

/** Whether a referral may move from→to (forward-only; terminals are sinks). Guards the simulate endpoint. */
export function canAdvanceReferral(from: string, to: string): boolean {
  return (FORWARD[from] ?? []).includes(to as ReferralStatus);
}

/** Append the attribution token to a partner's affiliate deep-link (the postback key the partner echoes). */
export function buildReferralUrl(targetUrl: string, token: string): string {
  const sep = targetUrl.includes("?") ? "&" : "?";
  return `${targetUrl}${sep}ref=${encodeURIComponent(token)}`;
}

export interface EnergyOfferMatch {
  offer_id: string;
  partner_id: string;
  partner_name: string;
  target_url: string;
  disclosure_text: string | null;
  cta_label: string;
}

/**
 * The active energy offer to present, if any. Tier-1 only: vertical='energy', offer active, partner
 * active. Postcode scoping is deferred (offers are nationwide for now → postcode_scope NULL). Returns
 * the single best (newest) match, or null when no live partner exists — in which case NO CTA is shown.
 */
export async function matchEnergyOffer(db: PartnerDB): Promise<EnergyOfferMatch | null> {
  const row = await db
    .prepare(
      `SELECT o.id AS offer_id, o.target_url, o.title AS offer_title,
              p.id AS partner_id, p.name AS partner_name, p.disclosure_text
         FROM partner_offers o JOIN partners p ON p.id = o.partner_id
        WHERE o.vertical = 'energy' AND o.active = 1 AND p.status = 'active'
        ORDER BY o.created_at DESC LIMIT 1`,
    )
    .bind()
    .first<{
      offer_id: string;
      target_url: string;
      offer_title: string | null;
      partner_id: string;
      partner_name: string;
      disclosure_text: string | null;
    }>();
  if (!row) return null;
  return {
    offer_id: row.offer_id,
    partner_id: row.partner_id,
    partner_name: row.partner_name,
    target_url: row.target_url,
    disclosure_text: row.disclosure_text,
    cta_label: row.offer_title || `Get a quote from ${row.partner_name}`,
  };
}

/**
 * A specific offer by id — used to PIN the referral to the exact offer the user saw on the CTA, so the
 * lead can't be mis-attributed if the active offer changes between display and click. By default only
 * returns a live offer (active + partner active); pass {anyStatus:true} to rebuild a prior referral's
 * URL from its stored offer even after it's been deactivated (a re-click must stay stable).
 */
export async function getOfferById(db: PartnerDB, offerId: string, opts: { anyStatus?: boolean } = {}): Promise<EnergyOfferMatch | null> {
  const live = opts.anyStatus ? "" : " AND o.active = 1 AND p.status = 'active'";
  const row = await db
    .prepare(
      `SELECT o.id AS offer_id, o.target_url, o.title AS offer_title,
              p.id AS partner_id, p.name AS partner_name, p.disclosure_text
         FROM partner_offers o JOIN partners p ON p.id = o.partner_id
        WHERE o.id = ?${live} LIMIT 1`,
    )
    .bind(offerId)
    .first<{
      offer_id: string;
      target_url: string;
      offer_title: string | null;
      partner_id: string;
      partner_name: string;
      disclosure_text: string | null;
    }>();
  if (!row) return null;
  return {
    offer_id: row.offer_id,
    partner_id: row.partner_id,
    partner_name: row.partner_name,
    target_url: row.target_url,
    disclosure_text: row.disclosure_text,
    cta_label: row.offer_title || `Get a quote from ${row.partner_name}`,
  };
}

/** Clamp a postback revenue figure to a sane non-negative integer-cents value (rejects NaN/Infinity). */
export function sanitizeRevenueCents(input: unknown): number {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.round(n), 100_000_000); // cap at $1,000,000 — far above any real energy CPA
}

// What the consumer Save surface renders beneath an energy opportunity (the government comparator is
// already on the opportunity's signpost; this is the COMMERCIAL CTA shown AFTER it, with disclosure).
export interface PartnerCta {
  offer_id: string;
  partner_id: string;
  partner_name: string;
  cta_label: string;
  disclosure: string;
}

const DEFAULT_DISCLOSURE = "pays Quillo a fee if you switch. This is a referral, not advice — compare the government option first, and you choose and start anything yourself.";

/** Build the CTA descriptor from a matched offer (factual disclosure naming the commercial relationship). */
export function ctaFromOffer(o: EnergyOfferMatch): PartnerCta {
  return {
    offer_id: o.offer_id,
    partner_id: o.partner_id,
    partner_name: o.partner_name,
    cta_label: o.cta_label,
    disclosure: o.disclosure_text || `${o.partner_name} ${DEFAULT_DISCLOSURE}`,
  };
}

/** True when an opportunity should carry an energy partner CTA (energy/gas switch nudges only). */
export function opportunityTakesEnergyCta(o: { opportunity_type?: string | null; category?: string | null }): boolean {
  return o.category === "energy" || o.category === "gas" || o.opportunity_type === "essential_switch";
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

// ── Partner portal payload (the /partner page) ───────────────────────────────────────────────────
// A LEAD is the partner's view of a referral. CRITICAL: it deliberately omits user_id and
// opportunity_id — the consumer's identity and ledger NEVER reach the partner (Tier-1 keeps PII in
// Quillo). The referral_token IS the partner's own attribution key, so showing it is correct.
export interface PartnerLead {
  referral_token: string;
  status: string;
  revenue_cents: number;
  created_at: string;
  updated_at: string;
}
export interface PartnerPortalOffer {
  id: string;
  vertical: string;
  title: string | null;
  target_url: string;
  active: number;
  created_at: string;
}
export interface PartnerPortal {
  partner: { id: string; name: string; vertical: string; status: string } | null; // null ⇒ caller isn't partner staff
  funnel: { status: string; n: number; revenue_cents: number }[];
  total: number;
  revenue_cents: number; // PAID only (earned), same truthful basis as the admin funnel
  leads: PartnerLead[];
  offers: PartnerPortalOffer[];
}

const EMPTY_PORTAL: PartnerPortal = { partner: null, funnel: [], total: 0, revenue_cents: 0, leads: [], offers: [] };

/**
 * The whole /partner portal payload for the signed-in partner staff member — org, funnel, anonymised
 * leads, and their offers. EVERY query is scoped by the partner_id resolved from the CALLER'S OWN
 * tenant (resolvePartnerId), never a request value, so one org can never read another's. A caller who
 * isn't partner staff resolves to null → an empty portal (the route also 403s on the isPartner role).
 */
export async function partnerPortalData(env: Env, staffUserId: string): Promise<PartnerPortal> {
  const db = env.DB as unknown as PartnerDB;
  const partnerId = await resolvePartnerId(db, staffUserId);
  if (!partnerId) return EMPTY_PORTAL;

  const [orgRes, funnelRes, leadsRes, offersRes] = await Promise.all([
    env.DB.prepare(`SELECT id, name, vertical, status FROM partners WHERE id = ?`).bind(partnerId).first<{ id: string; name: string; vertical: string; status: string }>(),
    env.DB.prepare(`SELECT status, COUNT(*) AS n, COALESCE(SUM(revenue_cents),0) AS revenue_cents FROM referrals WHERE partner_id = ? GROUP BY status`).bind(partnerId).all<{ status: string; n: number; revenue_cents: number }>(),
    // Leads: NO user_id / opportunity_id — the consumer's identity never reaches the partner.
    env.DB.prepare(`SELECT referral_token, status, revenue_cents, created_at, updated_at FROM referrals WHERE partner_id = ? ORDER BY created_at DESC LIMIT 200`).bind(partnerId).all<PartnerLead>(),
    env.DB.prepare(`SELECT id, vertical, title, target_url, active, created_at FROM partner_offers WHERE partner_id = ? ORDER BY created_at DESC`).bind(partnerId).all<PartnerPortalOffer>(),
  ]);

  const funnel = funnelRes.results ?? [];
  return {
    partner: orgRes ?? null,
    funnel,
    total: funnel.reduce((n, r) => n + r.n, 0),
    revenue_cents: funnel.filter((r) => r.status === "paid").reduce((n, r) => n + r.revenue_cents, 0),
    leads: leadsRes.results ?? [],
    offers: offersRes.results ?? [],
  };
}
