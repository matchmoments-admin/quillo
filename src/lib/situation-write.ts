import type { Env } from "../env";

// Situation mutations for the Settings + onboarding-web flows. These rows are not
// hash-chained (unlike corrections/consent/audit), so they're written directly to D1.
// uuid helper (Workers runtime provides crypto.randomUUID).
const uid = () => crypto.randomUUID();

export async function addProperty(
  env: Env,
  userId: string,
  p: { label: string; address?: string; status?: string; ownership_pct?: number; acquired_date?: string; notes?: string },
): Promise<string> {
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO properties (id, user_id, label, address, status, ownership_pct, acquired_date, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, p.label, p.address ?? null, p.status ?? "rented", p.ownership_pct ?? 100, p.acquired_date ?? null, p.notes ?? null)
    .run();
  return id;
}

export async function updateProperty(env: Env, userId: string, id: string, p: { label?: string; status?: string; ownership_pct?: number }): Promise<void> {
  await env.DB.prepare(
    `UPDATE properties SET label = COALESCE(?, label), status = COALESCE(?, status),
            ownership_pct = COALESCE(?, ownership_pct) WHERE id = ? AND user_id = ?`,
  )
    .bind(p.label ?? null, p.status ?? null, p.ownership_pct ?? null, id, userId)
    .run();
}

export async function addEntity(env: Env, userId: string, e: { kind: string; name?: string; detail?: unknown }): Promise<string> {
  const id = uid();
  await env.DB.prepare(`INSERT INTO entities (id, user_id, kind, name, detail_json) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, userId, e.kind, e.name ?? null, JSON.stringify(e.detail ?? {}))
    .run();
  return id;
}

export async function addRule(
  env: Env,
  userId: string,
  r: { match_type?: string; pattern: string; bucket: string; ato_label: string; property_id?: string; priority?: number },
): Promise<string> {
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO user_rules (id, user_id, match_type, pattern, bucket, ato_label, property_id, priority)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, r.match_type ?? "merchant_contains", r.pattern, r.bucket, r.ato_label, r.property_id ?? null, r.priority ?? 100)
    .run();
  return id;
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

export async function deleteRow(env: Env, userId: string, table: "properties" | "entities" | "user_rules" | "accounts", id: string): Promise<void> {
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
