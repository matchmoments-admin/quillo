// The single home of the "is this FY lodged?" rule (#572, first-timer spec A1 ticket b).
//
// A year counts as LODGED when the user marked it (fy_signoff.lodged_at set, migration 0087) or a confirmed
// Notice of Assessment closed it (status 'closed_with_noa' — the ATO assessed it). Quillo never lodges, so
// those are the only two signals. The rule exists twice by necessity — once as SQL (for queries) and once in
// TS (for a row already in hand) — and both live HERE, side by side, so they can't drift. The lodging-year
// default (lodging-year.ts), getSituation (db.ts), /api/lodged and A5's bank-data minimisation all read it from
// this module.
//
// Imports ONLY Env (no report / situation-write) so any module — db.ts included — can use it without joining
// the report import cycle. Flag gating (situation_profile) is the CALLER's job: lodged_at only exists once 0087
// is applied, so flag-OFF code paths must never call into the lodged_at readers/writers below.

import type { Env } from "../env";

/** The fy_signoff row as the lodged readers return it. lodged_at = the 'YYYY-MM-DD' day the user says they lodged. */
export type FyLodgedRow = { fy: number; lodged_at: string | null; status: string | null; signed_off_at: string };

/** SQL form of the lodged rule, for a WHERE clause over fy_signoff (unaliased columns). */
export const FY_LODGED_SQL = `(lodged_at IS NOT NULL OR status = 'closed_with_noa')`;

/** TS form of the same rule, for a row already loaded. */
export function isFyMarkedLodged(row: Pick<FyLodgedRow, "lodged_at" | "status"> | null | undefined): boolean {
  return !!row && (!!row.lodged_at || row.status === "closed_with_noa");
}

export async function getFyLodged(env: Env, userId: string, fy: number): Promise<FyLodgedRow | null> {
  return await env.DB.prepare(`SELECT fy, lodged_at, status, signed_off_at FROM fy_signoff WHERE user_id = ? AND fy = ?`)
    .bind(userId, fy)
    .first<FyLodgedRow>();
}

/** Every FY (start year) that counts as lodged, ascending. */
export async function listLodgedFys(env: Env, userId: string): Promise<number[]> {
  const res = await env.DB.prepare(`SELECT fy FROM fy_signoff WHERE user_id = ? AND ${FY_LODGED_SQL} ORDER BY fy`)
    .bind(userId)
    .all<{ fy: number }>();
  return (res.results ?? []).map((r) => Number(r.fy));
}

/**
 * The user's own "I've lodged this year" mark. A NOA close (status 'closed_with_noa') is kept as-is; otherwise
 * status becomes 'lodged'. signed_off_at is left alone on an existing row (the user's attestation timestamp) and
 * set on a new one (lodging implies the attestation).
 */
export async function markFyLodged(env: Env, userId: string, fy: number, lodgedOn: string): Promise<FyLodgedRow> {
  await env.DB.prepare(
    `INSERT INTO fy_signoff (user_id, fy, signed_off_at, status, lodged_at) VALUES (?, ?, datetime('now'), 'lodged', ?)
     ON CONFLICT(user_id, fy) DO UPDATE SET lodged_at = excluded.lodged_at,
       status = CASE WHEN fy_signoff.status = 'closed_with_noa' THEN 'closed_with_noa' ELSE 'lodged' END`,
  ).bind(userId, fy, lodgedOn).run();
  return (await getFyLodged(env, userId, fy))!;
}

/**
 * Undo the lodged mark. A NOA close stays closed; a 'lodged' status falls back to a plain soft sign-off (the row
 * is kept: marking lodged implied the user's "ready" attestation, which they can re-open on Filing).
 */
export async function unmarkFyLodged(env: Env, userId: string, fy: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE fy_signoff SET lodged_at = NULL, status = CASE WHEN status = 'lodged' THEN NULL ELSE status END
      WHERE user_id = ? AND fy = ?`,
  ).bind(userId, fy).run();
}
