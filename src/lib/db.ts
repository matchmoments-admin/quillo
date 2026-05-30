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
