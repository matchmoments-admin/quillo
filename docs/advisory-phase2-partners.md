# Advisory Phase 2 — Partner platform (energy first)

> Plan / design doc. Builds on the shipped Phase 1 (PRs #190–192, flag `advisory_layer`).
> **Status: NOT started. Gated on founder decisions (§6) + a legal sign-off (§5).** Compliance
> framing here is product-risk, not legal advice.

## 0. What changes vs the build brief
The original brief (Section D/G) modelled `partners` as a **global reference table** the cron reads.
The founder's steer: **partners are authenticated entities** — partner staff **log in via Clerk** and
carry a **`partner` role**, with a **partner portal**. So Phase 2 is a *platform* (identity + portal +
lead lifecycle), not a lookup table. This doc supersedes the brief's Section D/G for Phase 2.

A second refinement that shrinks Phase 2 risk: **split referrals into two integration tiers** —
- **Tier 1 — tracked outbound link (NO PII leaves Quillo).** The user clicks "Get a quote from
  [partner]" and completes everything on the partner's site; Quillo only appends an attribution token
  to the URL and records click/conversion via a postback. **Energy & telco fit here.** No
  `referral_consents`, no APP-8 data-sharing event — the consent surface is just "you're leaving
  Quillo for [partner], who pays us a fee."
- **Tier 2 — data handoff (PII leaves → full consent machinery).** Quillo pre-fills/sends the user's
  details to a partner. **Health/general insurance (Phase 3) need this** — and an AFSL/AR structure.

Phase 2 builds **Tier 1 + the partner platform**. Tier 2 is deferred to Phase 3.

## 1. Identity model (the core new decision)
Reuse the existing seams — do NOT build a separate partner auth system:
- **Clerk → tenant** already bootstraps any signed-in Clerk sub into its own tenant (`ensureTenant`).
  A partner staff member signs in the same way and gets a tenant.
- **Roles** already live in `profiles.roles` (`src/lib/roles.ts`: admin/accountant/bookkeeper/support/
  individual) with an `isAdmin`-style gate. Add a **`partner`** role (+ optional `partner_admin`) and an
  `isPartner` gate, exactly mirroring how `/admin` is founder-gated.
- A partner **organisation** is a row in `partners` (global, no `user_id` — org reference data). A new
  **`partner_members`** table links a Clerk-mapped tenant (`user_id`) to a `partner_id` + staff role.
- The **partner portal** (`/partner`, role-gated) shows ONLY that org's leads (`referrals WHERE
  partner_id = …`) + their offers — **never** any end-user ledger. Hard isolation: the portal queries
  by `partner_id`, the consumer app queries by `user_id`; they never cross.

## 2. Data model (migrations — additive, Quillo style)
Global reference (no `user_id`, NOT in `PURGE_TABLES`):
- `partners` — id, name, vertical, afsl_or_acl, is_authorised_representative, commission_model,
  disclosure_text, status, created_at.
- `partner_offers` — id, partner_id, vertical, title, description, target_url (the affiliate
  deep-link base), postcode_scope, cpl_cents, cpa_cents, active, created_at.

Per-user / per-tenant (carry `user_id`, ADD to `PURGE_TABLES` + export/retention):
- `partner_members` — id, partner_id, user_id (staff tenant), role (partner_admin|partner_agent),
  created_at. (Removing a staff member's tenant removes their membership.)
- `referrals` — id, user_id (the **consumer**), opportunity_id, partner_id, partner_offer_id,
  referral_token (unique, the postback key), status, consent_id (NULL for Tier 1), revenue_cents,
  created_at, updated_at. UNIQUE(user_id, opportunity_id); UNIQUE(referral_token).
- `referral_consents` — (Tier 2 only; create the table now, use it in Phase 3) id, user_id,
  partner_id, scope, disclosure_shown, consented_at, revoked_at.

Roles: extend `ROLES` in `src/lib/roles.ts` + web mirror; add `isPartner`. (Persona harness unaffected
— no money/position change.)

## 3. Referral lifecycle (Tier 1, energy)
`created → presented → clicked → converted → paid` (+ terminal `dismissed`, `expired`, `clawed_back`).
- **Always user-initiated** (the "no cold calls" rule): a referral is created ONLY by the consumer
  clicking the CTA on an opportunity — never by the cron.
- **Idempotent**: UNIQUE(user_id, opportunity_id) — one referral per opportunity; re-click is a no-op
  that re-returns the same token.
- **Audited**: every status transition appends to the hash-chained `audit_log` (actor, old→new, ts) —
  reuse the existing `audit()` helper.
- **Attribution**: `referral_token` is appended to the partner's affiliate URL; the partner's postback
  (a tokened webhook `POST /api/partner/postback`) moves `clicked → converted → paid` and writes
  `revenue_cents`. Verify the postback with an HMAC/shared secret per partner.
- **Disclosure before the CTA**: the opportunity card shows the factual basis ("you paid $X to [biller]
  last year"), names the commercial relationship ("[partner] pays Quillo a fee if you switch"), and
  links the **government comparator first** (Energy Made Easy) — then the partner CTA. Never
  "best/cheapest/whole-of-market."

## 4. Surfaces
- **Consumer**: extend an existing energy `opportunity` (already produced by `detectAdvisory`) with an
  optional partner CTA when an active `partner_offer` matches (vertical=energy, postcode scope).
  Gated behind a NEW per-vertical flag `advisory_partners_energy` (so `advisory_layer` stays
  signpost-only until partners are live).
- **Partner portal** `/partner` (role `partner`): their leads + statuses + funnel + offer management.
- **Admin**: extend `platformOverview` with the referral funnel (created→…→paid counts) + revenue per
  partner/vertical (brief A.3 #3/#4).

## 5. Compliance gates (MUST clear before the commercial CTA ships) — not legal advice
- **Legal sign-off** on the Tier-1 mere-referral structure + disclosure wording (brief H.4).
- **Energy is NOT a financial product** → no AFSL needed; but **ACCC/ACL** misleading-comparison rules
  apply: disclose the commercial relationship prominently, never imply whole-of-market/"best", keep the
  government comparator (Energy Made Easy / Victorian Energy Compare) as the first, default option
  (ACCC v iSelect, $8.5m). 
- **Tier 1 keeps PII in Quillo** (outbound link only) → no APP-8 data-sharing event; the only consent is
  the factual "you're leaving for [partner], who pays us a fee."
- Tier 2 (Phase 3) needs: a fresh, specific, unbundled `referral_consents` event before any field
  leaves; APP-6 secondary-use + APP-8 (if offshore); AFSL/AR for health/general insurance; commission
  disclosure + PHIIA/clawback handling. **Out of Phase 2 scope.**

## 6. Open decisions for the founder (resolve before building 2b)
1. **Partner identity** — confirm the Clerk-tenant + `partner` role + `/partner` portal model above
   (recommended: reuses ensureTenant + roles + role-gated-page; no new auth system).
2. **First commercial partner + integration** — affiliate **deep-link** (Tier 1, simplest, zero PII;
   e.g. Econnex via Commission Factory) vs a white-label API (CIMET). Recommendation: **start Tier-1
   deep-link** — it sidesteps the entire PII/consent surface for energy.
3. **Commission model + disclosure** — CPA per switch (~$50–$200 energy) and whether to disclose the
   amount. Brand stance: commission-free/trust (Bill Hero/CHOICE) vs commission.
4. **Legal sign-off** — engage a lawyer on the mere-referral + disclosure structure (a hard gate).
5. **Partner onboarding** — who creates `partners`/`partner_offers` rows and invites partner staff
   (founder/admin via `/admin`, at least initially).

## 7. Build order (once §6 + §5 clear)
1. Roles: add `partner`/`isPartner` (+ web mirror) — tiny, no migration beyond data.
2. Migration: `partners`, `partner_offers`, `partner_members`, `referrals`, `referral_consents`
   (+ PURGE_TABLES for the per-user ones). Flag `advisory_partners_energy` (OFF).
3. Admin: create partners/offers + invite staff (role assignment already exists on `/admin`).
4. Consumer: partner CTA on energy opportunities (flag-gated) + the create-referral endpoint
   (user-initiated, idempotent, audited) returning the tokened URL.
5. Postback webhook (`/api/partner/postback`, HMAC-verified) → status/revenue.
6. Partner portal `/partner` (their leads/funnel/offers).
7. Admin funnel + revenue metrics.

Each step is additive + flag-gated (`advisory_partners_energy` OFF ⇒ byte-identical), shippable
independently, and adds a persona/unit golden where it touches data. The detector and the consumer
Save surface from Phase 1 are untouched until step 4.
