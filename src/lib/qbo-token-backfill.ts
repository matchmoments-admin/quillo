import type { Env } from "../env";
import { isPlaintextEncVer, looksSealedWith, openToken, sealToken, tokenEncryptionEnabled } from "./token-crypto";

// One-off, idempotent re-encryption of QuickBooks tokens stored before QBO_TOKEN_KEY was set
// (#637, security A4). Runs INSIDE the Worker (POST /api/admin/qbo-token-backfill) because the key is
// a Worker secret — a local script would need the key on a laptop, which is exactly what we avoid.
//
// Per row:
//   enc_ver 0/NULL → seal both tokens, verify the round-trip, then UPDATE … WHERE enc_ver = 0 AND
//                    the tokens = <the values we read> (a concurrent token refresh wins; that row
//                    is counted `skipped_concurrent` and the refresh itself seals it).
//                    If the values already authenticate under the key (a sealed row mislabelled 0),
//                    only enc_ver is corrected — never double-sealed.
//   enc_ver 1      → left alone; counted `sealed_ok`, or `sealed_undecryptable` when the current key
//                    can't open it (a rotated/wrong key — the user must reconnect).
// Output is COUNTS ONLY: no tokens, no user ids, no realm ids. Re-running is a no-op once done.

export interface QboTokenBackfillResult {
  dry_run: boolean;
  key_configured: boolean;
  total: number;
  plaintext: number; // enc_ver 0 rows found (before this run)
  sealed_now: number; // rows sealed by this run (0 on a dry run)
  relabelled: number; // enc_ver 0 rows whose values were already sealed — enc_ver corrected only
  skipped_concurrent: number; // the row changed under us; a refresh re-wrote it
  sealed_ok: number; // enc_ver 1 rows that decrypt under the current key
  sealed_undecryptable: number; // enc_ver 1 rows the current key can't open
  errors: number;
}

interface Row {
  user_id: string;
  access_token: string | null;
  refresh_token: string;
  enc_ver: number | null;
}

/** Throws when not a dry run and no key is configured (nothing could be sealed). */
export async function backfillQboTokens(env: Env, opts: { dryRun: boolean }): Promise<QboTokenBackfillResult> {
  const keyConfigured = tokenEncryptionEnabled(env);
  if (!opts.dryRun && !keyConfigured) throw new Error("QBO_TOKEN_KEY is not set — set the secret before running the backfill (dry_run=1 works without it).");

  const out: QboTokenBackfillResult = {
    dry_run: opts.dryRun,
    key_configured: keyConfigured,
    total: 0,
    plaintext: 0,
    sealed_now: 0,
    relabelled: 0,
    skipped_concurrent: 0,
    sealed_ok: 0,
    sealed_undecryptable: 0,
    errors: 0,
  };

  // Cross-tenant by design (an admin maintenance job); the table holds one row per connected tenant.
  const { results } = await env.DB.prepare(
    `SELECT user_id, access_token, refresh_token, enc_ver FROM qbo_connections`,
  ).all<Row>();

  for (const row of results ?? []) {
    out.total++;
    try {
      if (!isPlaintextEncVer(row.enc_ver)) {
        if (!keyConfigured || !(await looksSealedWith(env, row.refresh_token))) out.sealed_undecryptable++;
        else out.sealed_ok++;
        continue;
      }
      out.plaintext++;
      if (opts.dryRun) continue;

      // A row already holding sealed values but labelled 0: fix the label, don't seal twice.
      const refreshSealed = await looksSealedWith(env, row.refresh_token);
      // A null access token (cleared after a dead refresh) carries no format of its own: follow refresh.
      const accessSealed = row.access_token == null ? refreshSealed : await looksSealedWith(env, row.access_token);
      if (refreshSealed && accessSealed) {
        const r = await env.DB.prepare(
          `UPDATE qbo_connections SET enc_ver = 1, updated_at = datetime('now')
            WHERE user_id = ? AND COALESCE(enc_ver, 0) = 0 AND refresh_token = ? AND access_token IS ?`,
        )
          .bind(row.user_id, row.refresh_token, row.access_token)
          .run();
        if (r.meta?.changes) out.relabelled++;
        else out.skipped_concurrent++;
        continue;
      }
      if (refreshSealed !== accessSealed) {
        // Half-sealed: can't tell which value is which format safely. Leave it for a reconnect.
        out.errors++;
        continue;
      }

      const access = row.access_token == null ? null : await sealToken(env, row.access_token);
      const refresh = await sealToken(env, row.refresh_token);
      // Verify before writing: a sealed value we can't open again must never replace a working one.
      if ((await openToken(env, refresh)) !== row.refresh_token) throw new Error("round-trip mismatch");
      if (access != null && (await openToken(env, access)) !== row.access_token) throw new Error("round-trip mismatch");

      const r = await env.DB.prepare(
        `UPDATE qbo_connections SET access_token = ?, refresh_token = ?, enc_ver = 1, updated_at = datetime('now')
          WHERE user_id = ? AND COALESCE(enc_ver, 0) = 0 AND refresh_token = ? AND access_token IS ?`,
      )
        .bind(access, refresh, row.user_id, row.refresh_token, row.access_token)
        .run();
      if (r.meta?.changes) out.sealed_now++;
      else out.skipped_concurrent++;
    } catch {
      // Never log the row (tokens) or the tenant — the count is the signal.
      out.errors++;
    }
  }
  return out;
}
