import type { Env } from "../env";
import { BUCKETS } from "./taxonomy";
import { propertyToCgtInputs } from "./cgt";
import { fyForDate } from "./report";
import { ammaToCgtEvents, type AmmaComponents } from "./managed-fund";

// Situation mutations for the Settings + onboarding-web flows. These rows are not
// hash-chained (unlike corrections/consent/audit), so they're written directly to D1.
// uuid helper (Workers runtime provides crypto.randomUUID).
const uid = () => crypto.randomUUID();

// The deterministic self-person id seeded by 0006_persons.sql. New properties/entities default
// to it so a single-person tenant never has to think about persons.
const selfPersonId = (userId: string) => `person_self_${userId}`;

/**
 * Bootstrap a brand-new tenant on first authed request: an empty profile (AU / au-v1 / no consent
 * defaults) + the 'self' person. Idempotent (`INSERT OR IGNORE`) and KV-flag-gated so it costs one
 * cheap KV read per request after the first. Without this a new Clerk user would hit "no profile for
 * tenant X"; the existing onboarding wizard + APP-8 consent flow take over once the profile exists.
 */
export async function ensureTenant(env: Env, userId: string, email?: string): Promise<void> {
  const flag = `tenant:init:${userId}`;
  if (await env.RULES.get(flag)) return;
  await env.DB.prepare(`INSERT OR IGNORE INTO profiles (user_id) VALUES (?)`).bind(userId).run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO persons (id, user_id, display_name, role) VALUES (?, ?, 'You', 'self')`,
  )
    .bind(selfPersonId(userId), userId)
    .run();
  // Record the signup email (from the Clerk JWT) once, so the admin signups list can show who joined.
  if (email) await env.DB.prepare(`UPDATE profiles SET email = ? WHERE user_id = ? AND email IS NULL`).bind(email, userId).run();
  await env.RULES.put(flag, "1");
}

export async function addPerson(
  env: Env,
  userId: string,
  p: { display_name: string; role?: string; occupation?: string; tax_residency?: string; tfn_last4?: string },
): Promise<string> {
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO persons (id, user_id, display_name, role, occupation, tax_residency, tfn_last4)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, p.display_name, p.role ?? "other", p.occupation ?? null, p.tax_residency ?? "AU", p.tfn_last4 ?? null)
    .run();
  return id;
}

export async function updatePerson(
  env: Env,
  userId: string,
  id: string,
  p: { display_name?: string; role?: string; occupation?: string; tax_residency?: string; tfn_last4?: string },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE persons SET display_name = COALESCE(?, display_name), role = COALESCE(?, role),
            occupation = COALESCE(?, occupation), tax_residency = COALESCE(?, tax_residency),
            tfn_last4 = COALESCE(?, tfn_last4) WHERE id = ? AND user_id = ?`,
  )
    .bind(p.display_name ?? null, p.role ?? null, p.occupation ?? null, p.tax_residency ?? null, p.tfn_last4 ?? null, id, userId)
    .run();
}

export async function addProperty(
  env: Env,
  userId: string,
  p: { label: string; address?: string; status?: string; use_status?: string; ownership_pct?: number; acquired_date?: string; notes?: string; person_id?: string },
): Promise<string> {
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO properties (id, user_id, label, address, status, use_status, ownership_pct, acquired_date, notes, person_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, p.label, p.address ?? null, p.status ?? "rented", p.use_status ?? null, p.ownership_pct ?? 100, p.acquired_date ?? null, p.notes ?? null, p.person_id ?? selfPersonId(userId))
    .run();
  // 0033: seed a rental income_activity ONLY for a genuine rental — never for an owner-occupied or
  // main-residence property (that would offer a target that routes private home costs into the
  // negative-gearing position). A property that later becomes a rental gets its activity on update.
  const status = p.status ?? "rented";
  const isRental = status !== "owner_occupied" && (p.use_status ?? status) !== "owner_occupied";
  if (isRental) {
    await env.DB.prepare(`INSERT OR IGNORE INTO income_activities (id, user_id, activity_type, property_id, label) VALUES (?, ?, 'rental_property', ?, ?)`)
      .bind("iact_prop_" + id, userId, id, p.label)
      .run();
  }
  return id;
}

export async function updateProperty(
  env: Env,
  userId: string,
  id: string,
  p: {
    label?: string;
    status?: string;
    use_status?: string;
    ownership_pct?: number;
    jurisdiction?: string;
    cost_base_cents?: number;
    disposal_proceeds_cents?: number;
    disposal_date?: string;
    acquired_date?: string;
    main_residence_flag?: number;
  },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE properties SET label = COALESCE(?, label), status = COALESCE(?, status),
            use_status = COALESCE(?, use_status),
            ownership_pct = COALESCE(?, ownership_pct), jurisdiction = COALESCE(?, jurisdiction),
            cost_base_cents = COALESCE(?, cost_base_cents), disposal_proceeds_cents = COALESCE(?, disposal_proceeds_cents),
            disposal_date = COALESCE(?, disposal_date), acquired_date = COALESCE(?, acquired_date),
            main_residence_flag = COALESCE(?, main_residence_flag)
      WHERE id = ? AND user_id = ?`,
  )
    .bind(
      p.label ?? null, p.status ?? null, p.use_status ?? null, p.ownership_pct ?? null, p.jurisdiction ?? null,
      p.cost_base_cents ?? null, p.disposal_proceeds_cents ?? null, p.disposal_date ?? null,
      p.acquired_date ?? null, p.main_residence_flag ?? null, id, userId,
    )
    .run();
  // Slice F: keep the property's CGT materialisation in sync with its disposal fields.
  await syncPropertyDisposalToCgt(env, userId, id);
}

/**
 * Slice F: materialise (or clear) a property's disposal into the CGT engine. Idempotent REBUILD keyed on
 * cgt_assets.property_id: drop any prior property-sourced asset/events for this property, then recreate one
 * cgt_asset + cgt_event when the disposal is complete and it isn't a flagged main residence. A
 * manually-entered cgt_asset (property_id NULL) is never touched, so there's no double-count. Gated at read
 * time by cgt_engine; un-setting a disposal removes the synthetic rows so the position can never go stale.
 */
export async function syncPropertyDisposalToCgt(env: Env, userId: string, propertyId: string): Promise<void> {
  try {
    // Rebuild-from-scratch: drop any prior property-sourced asset/events, then (when applicable) recreate
    // exactly one asset + event. The mutations run as a single atomic batch() so two concurrent rebuilds of
    // the same property can't interleave into "both delete, only one inserts → zero rows".
    const delEvents = env.DB.prepare(
      `DELETE FROM cgt_events WHERE user_id = ? AND cgt_asset_id IN (SELECT id FROM cgt_assets WHERE user_id = ? AND property_id = ?)`,
    ).bind(userId, userId, propertyId);
    const delAssets = env.DB.prepare(`DELETE FROM cgt_assets WHERE user_id = ? AND property_id = ?`).bind(userId, propertyId);

    const prop = await env.DB.prepare(
      `SELECT p.label, p.cost_base_cents, p.disposal_proceeds_cents, p.disposal_date, p.acquired_date,
              p.ownership_pct, p.main_residence_flag, p.person_id, COALESCE(pe.tax_residency, 'AU') AS tax_residency
         FROM properties p LEFT JOIN persons pe ON pe.id = p.person_id
        WHERE p.id = ? AND p.user_id = ?`,
    ).bind(propertyId, userId).first<{
      label: string; cost_base_cents: number | null; disposal_proceeds_cents: number | null;
      disposal_date: string | null; acquired_date: string | null; ownership_pct: number | null;
      main_residence_flag: number; person_id: string | null; tax_residency: string;
    }>();
    // Nothing to materialise until the disposal is fully specified — but still drop any stale synthetic rows
    // (e.g. the user un-set the disposal) so the position can't go stale.
    if (!prop || prop.cost_base_cents == null || prop.disposal_proceeds_cents == null || !prop.disposal_date || !prop.acquired_date) {
      await env.DB.batch([delEvents, delAssets]);
      return;
    }

    // Div 43 capital-works deductions claimed against this property reduce its cost base.
    const div43 = await env.DB.prepare(
      `SELECT COALESCE(SUM(d.deduction_cents),0) AS total FROM depreciation_schedule d
         JOIN assets a ON a.id = d.asset_id
        WHERE d.user_id = ? AND a.property_id = ? AND d.method_applied = 'div43'`,
    ).bind(userId, propertyId).first<{ total: number }>();

    const synth = propertyToCgtInputs({
      cost_base_cents: prop.cost_base_cents,
      proceeds_cents: prop.disposal_proceeds_cents,
      div43_claimed_cents: div43?.total ?? 0,
      acquired_date: prop.acquired_date,
      disposal_date: prop.disposal_date,
      ownership_pct: prop.ownership_pct,
      is_resident_individual: prop.tax_residency === "AU",
      main_residence_exempt: prop.main_residence_flag === 1,
    });
    // Main residence → no event (the engine never auto-exempts); just clear stale rows and let readiness
    // surface a defer nudge instead.
    if ("defer" in synth) {
      await env.DB.batch([delEvents, delAssets]);
      return;
    }

    const assetId = uid();
    const fy = fyForDate(prop.disposal_date);
    const insAsset = env.DB.prepare(
      `INSERT INTO cgt_assets (id, user_id, person_id, asset_kind, label, acquired_date, cost_base_cents, main_residence_exempt, status, property_id)
       VALUES (?, ?, ?, 'property', ?, ?, ?, 0, 'disposed', ?)`,
    ).bind(assetId, userId, prop.person_id ?? selfPersonId(userId), prop.label, synth.asset.acquired_date, synth.asset.cost_base_cents, propertyId);
    const insEvent = env.DB.prepare(
      `INSERT INTO cgt_events (id, user_id, cgt_asset_id, fy, event_type, event_date, proceeds_cents, cost_base_used_cents, discount_eligible)
       VALUES (?, ?, ?, ?, 'disposal', ?, ?, ?, ?)`,
    ).bind(uid(), userId, assetId, fy, synth.event.event_date, synth.event.proceeds_cents, synth.event.cost_base_used_cents, synth.event.discount_eligible ? 1 : 0);
    // Atomic rebuild: delete-then-insert in one batch.
    await env.DB.batch([delEvents, delAssets, insAsset, insEvent]);
  } catch (e) {
    // If the CGT tables/column aren't present yet (pre-0054), skip silently — the disposal stays captured
    // on the property and is materialised once the migration lands.
    if (/no such table|no such column/i.test((e as Error).message)) return;
    throw e;
  }
}

/**
 * Slice B: materialise a managed-fund distribution's capital-gain components into the CGT engine, so they get
 * the 50% discount + loss-offset instead of being taxed as ordinary income. Idempotent atomic REBUILD keyed on
 * cgt_assets.income_id (mirrors syncPropertyDisposalToCgt): drop any prior income-sourced asset/events, then —
 * when there's a non-zero CG bucket — insert one cgt_asset (asset_kind='managed_fund', income_id provenance)
 * + one cgt_event per non-zero bucket with an EXPLICIT discount_eligible. No CG ⇒ just clears stale rows.
 */
export async function syncIncomeCgtFromComponents(
  env: Env,
  userId: string,
  incomeId: string,
  components: AmmaComponents,
  fy: string,
  personId: string | null,
  label: string | null,
  eventDate: string | null,
): Promise<void> {
  try {
    // cgt_events.event_date is NOT NULL; use the distribution date, falling back to the FY end ("2025-26" →
    // "2026-06-30"). The discount is set explicitly, so event_date is a record only, not used in the calc.
    const evDate = eventDate ?? `${Number(fy.slice(0, 4)) + 1}-06-30`;
    const delEvents = env.DB.prepare(
      `DELETE FROM cgt_events WHERE user_id = ? AND cgt_asset_id IN (SELECT id FROM cgt_assets WHERE user_id = ? AND income_id = ?)`,
    ).bind(userId, userId, incomeId);
    const delAssets = env.DB.prepare(`DELETE FROM cgt_assets WHERE user_id = ? AND income_id = ?`).bind(userId, incomeId);

    const cgEvents = ammaToCgtEvents(components);
    if (!cgEvents.length) {
      // No capital gain to materialise — just clear any stale income-sourced rows (e.g. an earlier version
      // had a CG that's since been removed). Atomic.
      await env.DB.batch([delEvents, delAssets]);
      return;
    }

    const assetId = uid();
    const insAsset = env.DB.prepare(
      `INSERT INTO cgt_assets (id, user_id, person_id, asset_kind, label, cost_base_cents, main_residence_exempt, status, income_id)
       VALUES (?, ?, ?, 'managed_fund', ?, 0, 0, 'disposed', ?)`,
    ).bind(assetId, userId, personId ?? selfPersonId(userId), `${label ?? "Managed fund"} (AMMA distributed capital gain)`, incomeId);
    const insEvents = cgEvents.map((ev) =>
      env.DB.prepare(
        `INSERT INTO cgt_events (id, user_id, cgt_asset_id, fy, event_type, event_date, proceeds_cents, cost_base_used_cents, discount_eligible)
         VALUES (?, ?, ?, ?, 'distribution', ?, ?, ?, ?)`,
      ).bind(uid(), userId, assetId, fy, evDate, ev.proceeds_cents, ev.cost_base_used_cents, ev.discount_eligible ? 1 : 0),
    );
    // Atomic rebuild: delete-then-insert in one batch.
    await env.DB.batch([delEvents, delAssets, insAsset, ...insEvents]);
  } catch (e) {
    // Pre-0055 (no income_id column) → skip materialising; the ordinary income is still recorded, and the CG
    // materialises once the migration lands. Degrade gracefully rather than 500-ing the income POST.
    if (/no such table|no such column/i.test((e as Error).message)) return;
    throw e;
  }
}

/** Slice B: remove a managed-fund income row's materialised CGT rows (called when the income row is deleted,
 *  so its capital gain doesn't orphan into the position). Atomic; safe pre-0055. */
export async function clearIncomeCgt(env: Env, userId: string, incomeId: string): Promise<void> {
  try {
    const delEvents = env.DB.prepare(
      `DELETE FROM cgt_events WHERE user_id = ? AND cgt_asset_id IN (SELECT id FROM cgt_assets WHERE user_id = ? AND income_id = ?)`,
    ).bind(userId, userId, incomeId);
    const delAssets = env.DB.prepare(`DELETE FROM cgt_assets WHERE user_id = ? AND income_id = ?`).bind(userId, incomeId);
    await env.DB.batch([delEvents, delAssets]);
  } catch (e) {
    if (/no such table|no such column/i.test((e as Error).message)) return;
    throw e;
  }
}

// Map the legacy `kind` to the 0032 entity_type so a freshly-created entity isn't NULL (which would
// misroute its attributions to the individual headline — see attributionTotals' COALESCE fallback).
function entityTypeForKind(kind: string): string {
  switch (kind) {
    case "employment": return "payg_employment";
    case "company": return "company";
    case "trust": return "trust";
    case "smsf": return "smsf";
    case "partnership": return "partnership";
    default: return "individual";
  }
}

export async function addEntity(env: Env, userId: string, e: { kind: string; name?: string; detail?: unknown; person_id?: string }): Promise<string> {
  const id = uid();
  const personId = e.person_id ?? selfPersonId(userId);
  const entityType = entityTypeForKind(e.kind);
  // Most small trading companies are base-rate entities (25% — turnover < $50m, ≤80% passive income),
  // so default a company to 1 (the user can change it). Non-companies: 0 (irrelevant).
  const baseRate = e.kind === "company" ? 1 : 0;
  await env.DB.prepare(`INSERT INTO entities (id, user_id, kind, name, detail_json, person_id, entity_type, base_rate_entity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, userId, e.kind, e.name ?? null, JSON.stringify(e.detail ?? {}), personId, entityType, baseRate)
    .run();
  // 0032: seed a self->entity role so the join mirrors the scalar from the start (employment->employee,
  // company->director, else co_owner). 0033: seed the matching income_activity so attributions/UI have
  // a target. INSERT OR IGNORE keeps both idempotent against the migration backfill.
  const role = e.kind === "employment" ? "employee" : e.kind === "company" ? "director" : e.kind === "individual" ? "individual_taxpayer" : "co_owner";
  await env.DB.prepare(`INSERT OR IGNORE INTO entity_roles (id, user_id, person_id, entity_id, role, ownership_pct) VALUES (?, ?, ?, ?, ?, 100.0)`)
    .bind("erole_" + id, userId, personId, id, role)
    .run();
  if (e.kind === "company" || e.kind === "employment") {
    await env.DB.prepare(`INSERT OR IGNORE INTO income_activities (id, user_id, entity_id, activity_type, label) VALUES (?, ?, ?, ?, ?)`)
      .bind((e.kind === "company" ? "iact_co_" : "iact_sal_") + id, userId, id, e.kind === "company" ? "business" : "salary_wages", e.name ?? null)
      .run();
  }
  return id;
}

export async function addRule(
  env: Env,
  userId: string,
  r: { match_type?: string; pattern: string; bucket: string; ato_label: string; property_id?: string; priority?: number },
): Promise<string> {
  // Reject buckets the taxonomy doesn't know — an unknown bucket would store but never match a
  // model output, silently failing to categorise. (Previously any string was accepted.)
  if (!(BUCKETS as readonly string[]).includes(r.bucket)) {
    throw new Error(`unknown bucket '${r.bucket}' — must be one of: ${BUCKETS.join(", ")}`);
  }
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO user_rules (id, user_id, match_type, pattern, bucket, ato_label, property_id, priority)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, r.match_type ?? "merchant_contains", r.pattern, r.bucket, r.ato_label, r.property_id ?? null, r.priority ?? 100)
    .run();
  return id;
}

export async function updateEntity(
  env: Env,
  userId: string,
  id: string,
  e: { kind?: string; name?: string; detail?: unknown },
): Promise<void> {
  // detail_json is replaced wholesale when `detail` is supplied (the edit form always sends the full
  // kind-aware detail); kind/name COALESCE so a partial patch leaves the rest intact. Scoped + active.
  await env.DB.prepare(
    `UPDATE entities SET kind = COALESCE(?, kind), name = COALESCE(?, name),
            detail_json = COALESCE(?, detail_json)
      WHERE id = ? AND user_id = ? AND active = 1`,
  )
    .bind(e.kind ?? null, e.name ?? null, e.detail !== undefined ? JSON.stringify(e.detail) : null, id, userId)
    .run();
}

export async function updateRule(
  env: Env,
  userId: string,
  id: string,
  r: { match_type?: string; pattern?: string; bucket?: string; ato_label?: string; property_id?: string; priority?: number },
): Promise<void> {
  // Same taxonomy guard as addRule — an unknown bucket would store but never match.
  if (r.bucket !== undefined && !(BUCKETS as readonly string[]).includes(r.bucket)) {
    throw new Error(`unknown bucket '${r.bucket}' — must be one of: ${BUCKETS.join(", ")}`);
  }
  await env.DB.prepare(
    `UPDATE user_rules SET match_type = COALESCE(?, match_type), pattern = COALESCE(?, pattern),
            bucket = COALESCE(?, bucket), ato_label = COALESCE(?, ato_label),
            property_id = COALESCE(?, property_id), priority = COALESCE(?, priority)
      WHERE id = ? AND user_id = ?`,
  )
    .bind(r.match_type ?? null, r.pattern ?? null, r.bucket ?? null, r.ato_label ?? null, r.property_id ?? null, r.priority ?? null, id, userId)
    .run();
}

export async function addAccount(
  env: Env,
  userId: string,
  a: { institution?: string; name: string; last4?: string; type?: string; source?: string; qbo_account_id?: string },
): Promise<string> {
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO accounts (id, user_id, institution, name, last4, type, source, qbo_account_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, a.institution ?? null, a.name, a.last4 ?? null, a.type ?? "transaction", a.source ?? "statement", a.qbo_account_id ?? null)
    .run();
  return id;
}

export async function updateAccount(
  env: Env,
  userId: string,
  id: string,
  a: { institution?: string; name?: string; last4?: string; type?: string; source?: string; interest_rate_pct?: number | null; balance_cents?: number | null },
): Promise<void> {
  // interest_rate_pct / balance_cents (0044): loan facts, FALLBACK estimate inputs only (S4 sources
  // actual interest from the statement). Distinguish "not supplied" (undefined → COALESCE keeps the
  // existing value) from an explicit clear (null → write NULL) so the user can blank the rate. Rate
  // is clamped to a sane 0–100; a negative/garbage balance is dropped to NULL rather than stored.
  const rate = a.interest_rate_pct === undefined ? undefined : a.interest_rate_pct === null || !Number.isFinite(a.interest_rate_pct) ? null : Math.max(0, Math.min(100, a.interest_rate_pct));
  const bal = a.balance_cents === undefined ? undefined : a.balance_cents === null || !Number.isFinite(a.balance_cents) || a.balance_cents < 0 ? null : Math.round(a.balance_cents);
  await env.DB.prepare(
    `UPDATE accounts SET institution = COALESCE(?, institution), name = COALESCE(?, name),
            last4 = COALESCE(?, last4), type = COALESCE(?, type), source = COALESCE(?, source),
            interest_rate_pct = CASE WHEN ? = 1 THEN ? ELSE interest_rate_pct END,
            balance_cents     = CASE WHEN ? = 1 THEN ? ELSE balance_cents END
      WHERE id = ? AND user_id = ?`,
  )
    .bind(
      a.institution ?? null, a.name ?? null, a.last4 ?? null, a.type ?? null, a.source ?? null,
      rate === undefined ? 0 : 1, rate ?? null,
      bal === undefined ? 0 : 1, bal ?? null,
      id, userId,
    )
    .run();
}

// ── Loan → property links (Set-up data; pre-fills the Phase 5 interest split) ──
// Capture-only: recording a link does NOT change the position or claim anything.
const clampPct = (n: number | undefined): number => Math.max(0, Math.min(100, Number.isFinite(n as number) ? (n as number) : 0));

export async function addLoanProperty(
  env: Env,
  userId: string,
  lp: { loan_account_id: string; property_id: string; deductible_interest_pct?: number },
): Promise<string> {
  if (!lp.loan_account_id || !lp.property_id) throw new Error("loan_account_id and property_id are required");
  // Ownership check: both ids must belong to THIS tenant. Stops a dangling/cross-tenant reference
  // (which Phase 5 would later try to pre-fill a split from) — every join must be user_id-scoped.
  const owns = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM accounts   WHERE id = ? AND user_id = ?) AS acct,
            (SELECT COUNT(*) FROM properties WHERE id = ? AND user_id = ?) AS prop`,
  )
    .bind(lp.loan_account_id, userId, lp.property_id, userId)
    .first<{ acct: number; prop: number }>();
  if (!owns || owns.acct === 0) throw new Error("loan account not found");
  if (owns.prop === 0) throw new Error("property not found");
  const id = uid();
  // INSERT OR IGNORE on the UNIQUE(user_id, loan_account_id, property_id) so re-linking is idempotent.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO loans_properties (id, user_id, loan_account_id, property_id, deductible_interest_pct)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, lp.loan_account_id, lp.property_id, clampPct(lp.deductible_interest_pct))
    .run();
  return id;
}

export async function updateLoanProperty(
  env: Env,
  userId: string,
  id: string,
  lp: { deductible_interest_pct?: number },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE loans_properties SET deductible_interest_pct = COALESCE(?, deductible_interest_pct) WHERE id = ? AND user_id = ?`,
  )
    .bind(lp.deductible_interest_pct === undefined ? null : clampPct(lp.deductible_interest_pct), id, userId)
    .run();
}

// ── Prior-year carry-ins (capture-only; surfaced as defer findings, never auto-applied) ──
export async function addCapitalLoss(
  env: Env,
  userId: string,
  c: { prior_fy: number; loss_cents: number; asset_id?: string; notes?: string },
): Promise<string> {
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO capital_loss_carryins (id, user_id, prior_fy, loss_cents, asset_id, notes) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, c.prior_fy, Math.max(0, Math.round(c.loss_cents)), c.asset_id ?? null, c.notes ?? null)
    .run();
  return id;
}

export async function listCapitalLosses(env: Env, userId: string) {
  const res = await env.DB.prepare(
    `SELECT id, prior_fy, loss_cents, asset_id, notes FROM capital_loss_carryins WHERE user_id = ? ORDER BY prior_fy DESC, created_at`,
  )
    .bind(userId)
    .all();
  return res.results ?? [];
}

export async function addDepreciationOpening(
  env: Env,
  userId: string,
  d: { fy: number; opening_adjustable_value_cents: number; asset_id?: string; notes?: string },
): Promise<string> {
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO depreciation_opening_balances (id, user_id, fy, asset_id, opening_adjustable_value_cents, notes) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, d.fy, d.asset_id ?? null, Math.max(0, Math.round(d.opening_adjustable_value_cents)), d.notes ?? null)
    .run();
  return id;
}

export async function listDepreciationOpenings(env: Env, userId: string) {
  const res = await env.DB.prepare(
    `SELECT id, fy, asset_id, opening_adjustable_value_cents, notes FROM depreciation_opening_balances WHERE user_id = ? ORDER BY fy DESC, created_at`,
  )
    .bind(userId)
    .all();
  return res.results ?? [];
}

// ── Soft per-FY sign-off (the user's own "ready to hand off" attestation; re-openable) ──
export async function signOffFy(env: Env, userId: string, fy: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO fy_signoff (user_id, fy, signed_off_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(user_id, fy) DO UPDATE SET signed_off_at = datetime('now')`,
  )
    .bind(userId, fy)
    .run();
}

export async function clearSignOffFy(env: Env, userId: string, fy: number): Promise<void> {
  await env.DB.prepare(`DELETE FROM fy_signoff WHERE user_id = ? AND fy = ?`).bind(userId, fy).run();
}

export async function getFySignoff(env: Env, userId: string, fy: number): Promise<{ signed_off_at: string } | null> {
  return await env.DB.prepare(`SELECT signed_off_at FROM fy_signoff WHERE user_id = ? AND fy = ?`)
    .bind(userId, fy)
    .first<{ signed_off_at: string }>();
}

// ── Delete integrity (RESTRICT) ────────────────────────────────────────────────
// The schema has no foreign keys, so a hard DELETE of a parent (account / property /
// entity / person / asset …) would leave orphaned child rows that the tax report still
// sums — silently changing the position. Production financial apps (Xero, QuickBooks)
// block deleting anything that still has linked records and offer "archive" instead.
// We mirror that: deleteRow refuses when blocking children exist (DeleteBlockedError →
// 409 at the API boundary), and accounts/entities get a non-destructive archiveRow.
export type DeleteBlocker = { table: string; label: string; count: number };

export class DeleteBlockedError extends Error {
  blockers: DeleteBlocker[];
  parentTable: string;
  archivable: boolean;
  constructor(parentTable: string, blockers: DeleteBlocker[]) {
    super(`cannot delete ${parentTable}: ${blockers.length} dependent record set(s) still reference it`);
    this.name = "DeleteBlockedError";
    this.parentTable = parentTable;
    this.blockers = blockers;
    this.archivable = parentTable === "accounts" || parentTable === "entities";
  }
}

// parent table → child references (childTable, fk column, human label). A parent only
// blocks if at least one referencing row exists. Leaf tables are absent ⇒ guard is a no-op.
const CHILD_REFS: Record<string, ReadonlyArray<{ table: string; column: string; label: string }>> = {
  accounts: [
    { table: "transactions", column: "account_id", label: "transactions" },
    { table: "transactions", column: "paid_via_account_id", label: "transactions paid from this account" },
    { table: "statements", column: "account_id", label: "imported statements" },
    { table: "loans_properties", column: "loan_account_id", label: "loan-to-property links" },
    { table: "loan_interest_summaries", column: "loan_account_id", label: "loan-interest records" },
  ],
  properties: [
    { table: "transactions", column: "property_id", label: "transactions" },
    { table: "income", column: "property_id", label: "income records" },
    { table: "assets", column: "property_id", label: "assets" },
    { table: "property_owners", column: "property_id", label: "co-owners" },
    { table: "loans_properties", column: "property_id", label: "loan links" },
    { table: "income_activities", column: "property_id", label: "income activities" },
    { table: "documents", column: "property_id", label: "documents" },
  ],
  entities: [
    { table: "income", column: "entity_id", label: "income records" },
    { table: "assets", column: "entity_id", label: "assets" },
    { table: "entity_roles", column: "entity_id", label: "person roles" },
    { table: "income_activities", column: "entity_id", label: "income activities" },
    { table: "transaction_attributions", column: "entity_id", label: "transaction attributions" },
    { table: "company_tax_positions", column: "entity_id", label: "company tax positions" },
    { table: "bas_periods", column: "entity_id", label: "BAS periods" },
    { table: "payg_instalments", column: "entity_id", label: "PAYG instalments" },
    { table: "rd_claims", column: "entity_id", label: "R&D claims" },
    { table: "trust_distributions", column: "trust_entity_id", label: "trust distributions" },
    { table: "smsf_members", column: "smsf_entity_id", label: "SMSF members" },
    { table: "ess_grants", column: "employer_entity_id", label: "ESS grants" },
    { table: "documents", column: "entity_id", label: "documents" },
  ],
  persons: [
    { table: "properties", column: "person_id", label: "properties" },
    { table: "entities", column: "person_id", label: "entities" },
    { table: "entity_roles", column: "person_id", label: "entity roles" },
    { table: "property_owners", column: "person_id", label: "property co-ownerships" },
    { table: "income", column: "person_id", label: "income records" },
    { table: "assets", column: "person_id", label: "assets" },
    { table: "transactions", column: "payer_person_id", label: "transactions paid by this person" },
    { table: "vehicle_logbooks", column: "person_id", label: "vehicle logbooks" },
    { table: "trust_distributions", column: "beneficiary_person_id", label: "trust distributions" },
    { table: "smsf_members", column: "person_id", label: "SMSF memberships" },
    { table: "super_contributions", column: "person_id", label: "super contributions" },
    { table: "cgt_assets", column: "person_id", label: "CGT assets" },
    { table: "ess_grants", column: "person_id", label: "ESS grants" },
  ],
  assets: [
    { table: "depreciation_schedule", column: "asset_id", label: "depreciation schedules" },
    { table: "vehicle_logbooks", column: "asset_id", label: "vehicle logbooks" },
    { table: "capital_loss_carryins", column: "asset_id", label: "capital-loss carry-ins" },
    { table: "transactions", column: "asset_id", label: "transactions" },
  ],
  income_activities: [
    { table: "transaction_attributions", column: "income_activity_id", label: "transaction attributions" },
  ],
  cgt_assets: [
    { table: "cgt_events", column: "cgt_asset_id", label: "CGT events" },
  ],
};

// Throws DeleteBlockedError if any child row still references this parent. One batched
// round-trip; tables/columns come from the static allowlist above (never user input).
export async function assertNoBlockingChildren(env: Env, userId: string, parentTable: string, parentId: string): Promise<void> {
  const refs = CHILD_REFS[parentTable];
  if (!refs || refs.length === 0) return;
  const rows = await env.DB.batch(
    refs.map((r) => env.DB.prepare(`SELECT COUNT(*) AS n FROM ${r.table} WHERE ${r.column} = ? AND user_id = ?`).bind(parentId, userId)),
  );
  // Aggregate by label (transactions appear twice for accounts/persons via two columns).
  const byLabel = new Map<string, DeleteBlocker>();
  refs.forEach((r, i) => {
    const n = (rows[i]?.results?.[0] as { n?: number } | undefined)?.n ?? 0;
    if (n <= 0) return;
    const existing = byLabel.get(r.label);
    if (existing) existing.count += n;
    else byLabel.set(r.label, { table: r.table, label: r.label, count: n });
  });
  if (byLabel.size > 0) throw new DeleteBlockedError(parentTable, [...byLabel.values()]);
}

export async function deleteRow(env: Env, userId: string, table: "properties" | "entities" | "user_rules" | "accounts" | "persons" | "income" | "assets" | "loans_properties" | "capital_loss_carryins" | "depreciation_opening_balances" | "property_owners" | "entity_roles" | "cgt_assets" | "cgt_events" | "ess_grants" | "vehicle_logbooks" | "trust_distributions" | "smsf_members" | "super_contributions" | "income_activities" | "bas_periods" | "payg_instalments", id: string): Promise<void> {
  // RESTRICT: refuse if dependent financial records still reference this row (no FK = no
  // engine-level cascade, so orphans would silently stay in the tax position). Callers that
  // legitimately remove children first (e.g. income clears matched_income_id) are unaffected.
  await assertNoBlockingChildren(env, userId, table, id);
  // table is from a fixed allowlist (never user input) — safe to interpolate.
  await env.DB.prepare(`DELETE FROM ${table} WHERE id = ? AND user_id = ?`).bind(id, userId).run();
}

// Non-destructive alternative to deleting an account/entity that still has history: hide it
// from pickers/source-of-truth (read paths already filter active = 1) while keeping its rows —
// the money they carry is real evidence and must stay correctly counted.
export async function archiveRow(env: Env, userId: string, table: "accounts" | "entities", id: string): Promise<boolean> {
  const res = await env.DB.prepare(`UPDATE ${table} SET active = 0 WHERE id = ? AND user_id = ?`).bind(id, userId).run();
  return (res.meta?.changes ?? 0) > 0;
}

// ── Co-ownership capture (Phase B / G2) ────────────────────────────────────────
// property_owners is the per-person legal-interest split (TR 93/32) the attribution writer reads to
// snapshot a co-owned bill; entity_roles captures shareholder/co-owner/partner roles. Both override
// the scalar fast paths (properties.ownership_pct / entities.person_id) when rows exist.

export async function addPropertyOwner(env: Env, userId: string, o: { property_id: string; person_id: string; ownership_pct?: number }): Promise<string> {
  const id = uid();
  await env.DB.prepare(`INSERT INTO property_owners (id, user_id, property_id, person_id, ownership_pct) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, userId, o.property_id, o.person_id, o.ownership_pct ?? 100)
    .run();
  return id;
}

export async function listPropertyOwners(env: Env, userId: string) {
  return (await env.DB.prepare(`SELECT id, property_id, person_id, ownership_pct FROM property_owners WHERE user_id = ? ORDER BY created_at`).bind(userId).all()).results ?? [];
}

export async function addEntityRole(env: Env, userId: string, r: { person_id: string; entity_id: string; role: string; ownership_pct?: number; start_date?: string; end_date?: string }): Promise<string> {
  const id = uid();
  await env.DB.prepare(`INSERT INTO entity_roles (id, user_id, person_id, entity_id, role, ownership_pct, start_date, end_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, userId, r.person_id, r.entity_id, r.role, r.ownership_pct ?? null, r.start_date ?? null, r.end_date ?? null)
    .run();
  return id;
}

export async function listEntityRoles(env: Env, userId: string) {
  return (await env.DB.prepare(`SELECT id, person_id, entity_id, role, ownership_pct, start_date, end_date FROM entity_roles WHERE user_id = ? ORDER BY created_at`).bind(userId).all()).results ?? [];
}

export async function listIncomeActivities(env: Env, userId: string) {
  return (await env.DB.prepare(`SELECT id, entity_id, activity_type, property_id, occupation_scope, label, fy, psi_status FROM income_activities WHERE user_id = ? ORDER BY activity_type, label`).bind(userId).all()).results ?? [];
}

// S2: valid self-declared PSI/Div 86 statuses on a business activity. NULL (absent) = not assessed.
const PSI_STATUSES = ["not_psi", "psi_applies"] as const;
function normPsiStatus(v: unknown): string | null {
  return typeof v === "string" && (PSI_STATUSES as readonly string[]).includes(v) ? v : null;
}

/**
 * Update the self-declared PSI status on a business income activity (S2). Capture-only — it only sharpens
 * the readiness defer nudge; it never changes the position. An invalid/absent value clears it (NULL = not
 * assessed). Scoped to the tenant.
 */
export async function updateIncomeActivityPsiStatus(env: Env, userId: string, id: string, psi_status: unknown): Promise<void> {
  await env.DB.prepare(`UPDATE income_activities SET psi_status = ? WHERE id = ? AND user_id = ?`)
    .bind(normPsiStatus(psi_status), id, userId)
    .run();
}

/**
 * Manually create an income activity (the activity spine). Mirrors the auto-seed in addEntity/addProperty
 * but lets a sole trader name a business activity (#155) — e.g. a rideshare/freelance activity on their
 * individual entity — and tag an occupation_scope. Capture-only: no position math change (the activity
 * just gives attributions a target and surfaces occupation context). occupation_scope is stored but not
 * yet wired into claimability (persons.occupation still drives that — #156).
 */
export async function addIncomeActivity(
  env: Env,
  userId: string,
  a: { entity_id?: string | null; activity_type?: string; property_id?: string | null; occupation_scope?: string | null; label?: string | null; fy?: string | null; psi_status?: string | null },
): Promise<string> {
  const id = uid();
  const ACTIVITY_TYPES = ["salary_wages", "rental_property", "business", "investment", "private"];
  const activityType = a.activity_type && ACTIVITY_TYPES.includes(a.activity_type) ? a.activity_type : "business";
  await env.DB.prepare(
    `INSERT INTO income_activities (id, user_id, entity_id, activity_type, property_id, occupation_scope, fy, label, psi_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, a.entity_id ?? null, activityType, a.property_id ?? null, a.occupation_scope ?? null, a.fy ?? null, a.label ?? null, normPsiStatus(a.psi_status))
    .run();
  return id;
}

// ── Ingest keys (devices) ──────────────────────────────────────────────────
export async function listKeys(env: Env, userId: string) {
  const res = await env.DB.prepare(
    `SELECT key_id, label, created_at, revoked_at FROM tenant_keys WHERE user_id = ? ORDER BY created_at DESC`,
  )
    .bind(userId)
    .all();
  return res.results ?? [];
}

/** Mint a new ingest key. Returns the secret ONCE (never stored client-side / re-shown). */
export async function mintKey(env: Env, userId: string, label: string): Promise<{ keyId: string; secret: string }> {
  const keyId = `k_${[...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  const secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/[+/=]/g, "").slice(0, 43);
  await env.DB.prepare(`INSERT INTO tenant_keys (key_id, user_id, secret, label) VALUES (?, ?, ?, ?)`)
    .bind(keyId, userId, secret, label || "web")
    .run();
  return { keyId, secret };
}

export async function revokeKey(env: Env, userId: string, keyId: string): Promise<void> {
  await env.DB.prepare(`UPDATE tenant_keys SET revoked_at = datetime('now') WHERE key_id = ? AND user_id = ?`)
    .bind(keyId, userId)
    .run();
}
