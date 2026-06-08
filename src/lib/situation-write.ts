import type { Env } from "../env";
import { BUCKETS } from "./taxonomy";

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
}

// Map the legacy `kind` to the 0032 entity_type so a freshly-created entity isn't NULL (which would
// misroute its attributions to the individual headline — see attributionTotals' COALESCE fallback).
function entityTypeForKind(kind: string): string {
  switch (kind) {
    case "employment": return "payg_employment";
    case "company": return "company";
    case "trust": return "trust";
    default: return "individual";
  }
}

export async function addEntity(env: Env, userId: string, e: { kind: string; name?: string; detail?: unknown; person_id?: string }): Promise<string> {
  const id = uid();
  const personId = e.person_id ?? selfPersonId(userId);
  const entityType = entityTypeForKind(e.kind);
  await env.DB.prepare(`INSERT INTO entities (id, user_id, kind, name, detail_json, person_id, entity_type) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, userId, e.kind, e.name ?? null, JSON.stringify(e.detail ?? {}), personId, entityType)
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
  a: { institution?: string; name?: string; last4?: string; type?: string; source?: string },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE accounts SET institution = COALESCE(?, institution), name = COALESCE(?, name),
            last4 = COALESCE(?, last4), type = COALESCE(?, type), source = COALESCE(?, source)
      WHERE id = ? AND user_id = ?`,
  )
    .bind(a.institution ?? null, a.name ?? null, a.last4 ?? null, a.type ?? null, a.source ?? null, id, userId)
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

export async function deleteRow(env: Env, userId: string, table: "properties" | "entities" | "user_rules" | "accounts" | "persons" | "income" | "assets" | "loans_properties" | "capital_loss_carryins" | "depreciation_opening_balances" | "property_owners" | "entity_roles", id: string): Promise<void> {
  // table is from a fixed allowlist (never user input) — safe to interpolate.
  await env.DB.prepare(`DELETE FROM ${table} WHERE id = ? AND user_id = ?`).bind(id, userId).run();
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
  return (await env.DB.prepare(`SELECT id, entity_id, activity_type, property_id, label, fy FROM income_activities WHERE user_id = ? ORDER BY activity_type, label`).bind(userId).all()).results ?? [];
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
