import type { Env } from "../env";

export interface Profile {
  user_id: string;
  jurisdiction: string;
  rule_pack_ver: string;
  gst_registered: number;
  buckets: string;
  ledger_provider: string;
  inference_provider: string | null;
  inference_region: string | null;
  consent_xborder: number;
  consent_xborder_at: string | null;
}

/** Load a tenant profile; returns null if the tenant has no profile row yet. */
export async function getProfile(env: Env, userId: string): Promise<Profile | null> {
  return env.DB.prepare(
    `SELECT user_id, jurisdiction, rule_pack_ver, gst_registered, buckets,
            ledger_provider, inference_provider, inference_region,
            consent_xborder, consent_xborder_at
       FROM profiles WHERE user_id = ?`
  )
    .bind(userId)
    .first<Profile>();
}

export interface Person {
  id: string;
  user_id: string;
  display_name: string;
  role: string; // self|spouse|dependent|other
  occupation: string | null; // ATO occupation guide key (drives the claimability brain)
  tax_residency: string; // AU|UK|...
}

export interface Property {
  id: string;
  user_id: string;
  label: string;
  address: string | null;
  status: string; // rented|vacant|owner_occupied|sold
  ownership_pct: number;
  person_id: string | null; // primary owner (FK persons.id)
}

export interface Entity {
  id: string;
  user_id: string;
  kind: string; // employment|company|novated_lease|individual|trust
  name: string | null;
  detail_json: string;
}

export interface UserRule {
  id: string;
  user_id: string;
  match_type: string; // merchant_contains|merchant_exact
  pattern: string;
  bucket: string;
  ato_label: string;
  property_id: string | null;
  priority: number;
}

export interface Situation {
  profile: Profile;
  persons: Person[];
  properties: Property[];
  entities: Entity[];
  rules: UserRule[];
}

/** Load everything the categoriser needs to know about who this tenant is. */
export async function getSituation(env: Env, userId: string, profile: Profile): Promise<Situation> {
  const [persons, props, ents, rules] = await Promise.all([
    env.DB.prepare(
      `SELECT id, user_id, display_name, role, occupation, tax_residency FROM persons WHERE user_id = ? ORDER BY role = 'self' DESC, created_at`,
    ).bind(userId).all<Person>(),
    env.DB.prepare(
      `SELECT id, user_id, label, address, status, ownership_pct, person_id FROM properties WHERE user_id = ?`,
    ).bind(userId).all<Property>(),
    env.DB.prepare(
      `SELECT id, user_id, kind, name, detail_json FROM entities WHERE user_id = ? AND active = 1`,
    ).bind(userId).all<Entity>(),
    env.DB.prepare(
      `SELECT id, user_id, match_type, pattern, bucket, ato_label, property_id, priority
         FROM user_rules WHERE user_id = ? AND active = 1 ORDER BY priority DESC`,
    ).bind(userId).all<UserRule>(),
  ]);
  return {
    profile,
    persons: persons.results ?? [],
    properties: props.results ?? [],
    entities: ents.results ?? [],
    rules: rules.results ?? [],
  };
}

/** Compact, model-facing description of the tenant's situation for the system prompt. */
export function renderSituation(s: Situation): string {
  const lines: string[] = ["Your situation:"];

  // Taxpayers first — occupation seeds occupation-specific deduction guidance (claimability).
  if (s.persons.length) {
    for (const p of s.persons) {
      const bits = [p.occupation ? `occupation ${p.occupation}` : null, p.tax_residency !== "AU" ? `tax residency ${p.tax_residency}` : null].filter(Boolean);
      lines.push(`  - Taxpayer: ${p.display_name}${p.role !== "self" ? ` (${p.role})` : ""}${bits.length ? ` — ${bits.join(", ")}` : ""}.`);
    }
  }

  for (const e of s.entities) {
    let d: Record<string, unknown> = {};
    try {
      d = JSON.parse(e.detail_json) as Record<string, unknown>;
    } catch {
      /* ignore malformed detail */
    }
    if (e.kind === "company") {
      lines.push(`  - Company: ${e.name ?? "?"} (ABN ${d.abn ?? "?"}, GST ${d.gst_registered ? "registered" : "not registered"}). Business expenses -> bucket "company".`);
    } else if (e.kind === "employment") {
      lines.push(`  - Employment (PAYG): ${e.name ?? d.employer ?? "?"}. Work-related deductions -> bucket "payg".`);
    } else if (e.kind === "novated_lease") {
      lines.push(`  - Novated lease: ${d.vehicle ?? e.name ?? "vehicle"} via ${d.provider ?? "?"} (salary-packaged). Lease/running costs are employment salary-packaging, not company.`);
    } else {
      lines.push(`  - ${e.kind}: ${e.name ?? ""}`);
    }
  }

  if (s.properties.length) {
    lines.push("  - Properties (use property_id when the bucket is a property bucket):");
    for (const p of s.properties) {
      const bucket = p.status === "rented" ? "property_rented" : p.status === "vacant" ? "property_vacant" : "payg";
      lines.push(`      · id=${p.id} "${p.label}" — ${p.status} -> ${bucket}`);
    }
  }

  if (s.rules.length) {
    lines.push("  - Known rules (apply when the merchant matches):");
    for (const r of s.rules) {
      lines.push(`      · merchant ${r.match_type === "merchant_exact" ? "is" : "contains"} "${r.pattern}" -> bucket ${r.bucket}, label ${r.ato_label}${r.property_id ? `, property ${r.property_id}` : ""}`);
    }
  }

  return lines.length > 1 ? lines.join("\n") : "Your situation: (not yet registered — categorise from the receipt alone).";
}

/** Resolve a tenant's user_id from an email localpart like "receipts+me". */
export async function userIdFromLocalpart(env: Env, localpart: string): Promise<string | null> {
  // sub-addressing: "receipts+<tenant>" -> tenant slug after the '+'
  const plus = localpart.indexOf("+");
  const slug = plus >= 0 ? localpart.slice(plus + 1) : localpart;
  const row = await env.DB.prepare(
    `SELECT user_id FROM tenants WHERE email_localpart = ?`
  )
    .bind(slug)
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}
