import type { Env } from "../env";
import { BUCKETS } from "./taxonomy";

// Situation mutations for the Settings + onboarding-web flows. These rows are not
// hash-chained (unlike corrections/consent/audit), so they're written directly to D1.
// uuid helper (Workers runtime provides crypto.randomUUID).
const uid = () => crypto.randomUUID();

// The deterministic self-person id seeded by 0006_persons.sql. New properties/entities default
// to it so a single-person tenant never has to think about persons.
const selfPersonId = (userId: string) => `person_self_${userId}`;

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
  p: { label: string; address?: string; status?: string; ownership_pct?: number; acquired_date?: string; notes?: string; person_id?: string },
): Promise<string> {
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO properties (id, user_id, label, address, status, ownership_pct, acquired_date, notes, person_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, p.label, p.address ?? null, p.status ?? "rented", p.ownership_pct ?? 100, p.acquired_date ?? null, p.notes ?? null, p.person_id ?? selfPersonId(userId))
    .run();
  return id;
}

export async function updateProperty(
  env: Env,
  userId: string,
  id: string,
  p: {
    label?: string;
    status?: string;
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
            ownership_pct = COALESCE(?, ownership_pct), jurisdiction = COALESCE(?, jurisdiction),
            cost_base_cents = COALESCE(?, cost_base_cents), disposal_proceeds_cents = COALESCE(?, disposal_proceeds_cents),
            disposal_date = COALESCE(?, disposal_date), acquired_date = COALESCE(?, acquired_date),
            main_residence_flag = COALESCE(?, main_residence_flag)
      WHERE id = ? AND user_id = ?`,
  )
    .bind(
      p.label ?? null, p.status ?? null, p.ownership_pct ?? null, p.jurisdiction ?? null,
      p.cost_base_cents ?? null, p.disposal_proceeds_cents ?? null, p.disposal_date ?? null,
      p.acquired_date ?? null, p.main_residence_flag ?? null, id, userId,
    )
    .run();
}

export async function addEntity(env: Env, userId: string, e: { kind: string; name?: string; detail?: unknown; person_id?: string }): Promise<string> {
  const id = uid();
  await env.DB.prepare(`INSERT INTO entities (id, user_id, kind, name, detail_json, person_id) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, userId, e.kind, e.name ?? null, JSON.stringify(e.detail ?? {}), e.person_id ?? selfPersonId(userId))
    .run();
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

export async function deleteRow(env: Env, userId: string, table: "properties" | "entities" | "user_rules" | "accounts" | "persons" | "income" | "assets", id: string): Promise<void> {
  // table is from a fixed allowlist (never user input) — safe to interpolate.
  await env.DB.prepare(`DELETE FROM ${table} WHERE id = ? AND user_id = ?`).bind(id, userId).run();
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
