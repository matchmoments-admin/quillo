// Receipt ↔ bank-line LINK writes — the only code that sets transactions.matched_txn_id on a receipt.
//
// Extracted from TaxAgent.linkReceiptToLine (A8, #574) so the persona harness can drive the exact SQL a
// user's Match tap runs, and so the manual Link and a confirmed proposal are provably the same write.
// The Durable Object still owns the call (audit + notification); these helpers only touch D1.
//
// Money semantics (unchanged): COUNTABLE counts bank lines plus UNMATCHED receipts, so a linked receipt
// stops counting separately and the bank line — the authoritative AUD — counts once. The receipt donates
// its GST / bucket / ATO label to the line where the line lacks them.
import type { Env } from "../env";

export interface ReceiptDonor {
  gst_cents: number | null;
  bucket: string | null;
  ato_label: string | null;
}

/**
 * Resolve a link request to the tenant's own receipt + bank line. Returns null when either id is not
 * this user's row of the right kind (or the line is a duplicate / ignored transfer) — a link to another
 * tenant's line, or to a non-line, would silently drop the receipt from the position with nothing
 * counting in its place.
 *
 * `opts.sameDirection` (#589, reconcile_proposals ON — when the picker lists credit lines): also refuse a
 * receipt and line of opposite directions (NULL = debit, the column default), the proposer's like-with-like
 * rule. A spend receipt on a "money in" line would drop the spend and leave the credit counting. OFF the
 * SQL is unchanged (lines are debit-only there anyway).
 */
export async function receiptLinkTargets(env: Env, userId: string, receiptId: string, lineId: string, opts: { sameDirection?: boolean } = {}): Promise<{ donor: ReceiptDonor } | null> {
  if (!receiptId || !lineId || receiptId === lineId) return null;
  const receipt = await env.DB.prepare(
    opts.sameDirection
      ? `SELECT gst_cents, bucket, ato_label, COALESCE(direction,'debit') AS dir FROM transactions WHERE id = ? AND user_id = ? AND kind = 'receipt'`
      : `SELECT gst_cents, bucket, ato_label FROM transactions WHERE id = ? AND user_id = ? AND kind = 'receipt'`,
  ).bind(receiptId, userId).first<ReceiptDonor & { dir?: string }>();
  if (!receipt) return null;
  const line = await env.DB.prepare(
    opts.sameDirection
      ? `SELECT id, COALESCE(direction,'debit') AS dir FROM transactions WHERE id = ? AND user_id = ? AND kind = 'bank_line' AND status NOT IN ('duplicate','ignored')`
      : `SELECT id FROM transactions WHERE id = ? AND user_id = ? AND kind = 'bank_line' AND status NOT IN ('duplicate','ignored')`,
  ).bind(lineId, userId).first<{ id: string; dir?: string }>();
  if (!line) return null;
  if (opts.sameDirection && receipt.dir !== line.dir) return null;
  return { donor: { gst_cents: receipt.gst_cents, bucket: receipt.bucket, ato_label: receipt.ato_label } };
}

/**
 * #589: what a link changed beyond matched_txn_id, so an Undo can put it back. `filled` = the line fields
 * that were empty and took the receipt's value (the COALESCE donation), with the value donated; the two
 * statuses are the rows' statuses before the link. Stored on the receipt row (0084
 * `transactions.link_snapshot`, flag reconcile_proposals ON only — OFF nothing is written there).
 */
export interface LinkSnapshot {
  /** The line this snapshot belongs to — a snapshot for any other line is ignored. */
  line_id: string;
  /** Linked by the import-time auto-matcher (no user tap). */
  auto: boolean;
  filled: { gst_cents?: number; bucket?: string; ato_label?: string };
  line_status: string | null;
  receipt_status: string | null;
}

/** The receipt row's stored link snapshot (0084 `transactions.link_snapshot`) when it is for `lineId`, else null. */
export function parseLinkSnapshot(raw: string | null | undefined, lineId: string): LinkSnapshot | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<LinkSnapshot> | null;
    if (!d || typeof d !== "object" || d.line_id !== lineId || typeof d.filled !== "object" || d.filled === null) return null;
    return { line_id: lineId, auto: d.auto === true, filled: d.filled, line_status: d.line_status ?? null, receipt_status: d.receipt_status ?? null };
  } catch {
    return null;
  }
}

/**
 * Write the link. Callers validate first (receiptLinkTargets) or pass rows they selected themselves.
 * `opts.snapshot` (reconcile_proposals ON) reads the two rows first, stores what the link changes on the
 * receipt row (`link_snapshot`, with `opts.auto` = an auto-matcher link) and returns it; OFF there is no extra
 * read, the receipt UPDATE is byte-identical and null is returned. The line write is identical either way.
 */
export async function applyReceiptLink(
  env: Env,
  userId: string,
  receiptId: string,
  lineId: string,
  donor?: ReceiptDonor,
  opts: { snapshot?: boolean; auto?: boolean } = {},
): Promise<LinkSnapshot | null> {
  let snap: LinkSnapshot | null = null;
  if (opts.snapshot) {
    const line = await env.DB.prepare(`SELECT gst_cents, bucket, ato_label, status FROM transactions WHERE id = ? AND user_id = ?`)
      .bind(lineId, userId)
      .first<{ gst_cents: number | null; bucket: string | null; ato_label: string | null; status: string | null }>();
    const rec = await env.DB.prepare(`SELECT status FROM transactions WHERE id = ? AND user_id = ? AND kind = 'receipt'`)
      .bind(receiptId, userId)
      .first<{ status: string | null }>();
    const filled: LinkSnapshot["filled"] = {};
    if (line && donor) {
      if (line.gst_cents == null && donor.gst_cents != null) filled.gst_cents = donor.gst_cents;
      if (line.bucket == null && donor.bucket != null) filled.bucket = donor.bucket;
      if (line.ato_label == null && donor.ato_label != null) filled.ato_label = donor.ato_label;
    }
    snap = { line_id: lineId, auto: !!opts.auto, filled, line_status: line?.status ?? null, receipt_status: rec?.status ?? null };
  }
  if (snap) {
    await env.DB.prepare(`UPDATE transactions SET matched_txn_id = ?, status = 'matched_receipt', link_snapshot = ? WHERE id = ? AND user_id = ? AND kind = 'receipt'`)
      .bind(lineId, JSON.stringify(snap), receiptId, userId)
      .run();
  } else {
    await env.DB.prepare(`UPDATE transactions SET matched_txn_id = ?, status = 'matched_receipt' WHERE id = ? AND user_id = ? AND kind = 'receipt'`)
      .bind(lineId, receiptId, userId)
      .run();
  }
  // The line is authoritative AUD; take the receipt's GST/bucket where the line lacked them.
  if (donor) {
    await env.DB.prepare(
      `UPDATE transactions SET gst_cents = COALESCE(gst_cents, ?), bucket = COALESCE(bucket, ?),
              ato_label = COALESCE(ato_label, ?), status = CASE WHEN bucket IS NULL THEN 'extracted' ELSE status END
        WHERE id = ? AND user_id = ?`,
    )
      .bind(donor.gst_cents, donor.bucket, donor.ato_label, lineId, userId)
      .run();
  }
  return snap;
}

/**
 * #589 (reconcile_proposals): Undo a receipt ↔ line link from the Check step — typically a pair the
 * import-time auto-matcher (TaxAgent.matchReceipt) linked without a tap. Detaches the receipt so it counts
 * standalone again and records the pair as dismissed (neither the next import's auto-matcher nor the
 * proposer pairs them again). When the link stored a snapshot (link_snapshot, for this line) it also puts back what the link changed:
 * the line fields the receipt filled (only while they still hold the donated value, so a later user edit
 * wins), the line's status when its bucket is restored, and the receipt's prior status. A legacy link (no
 * snapshot) keeps today's unlink semantics: the line keeps the donated fields, the receipt → 'extracted'.
 *
 * Returns the line it was linked to, or null (nothing written) unless the id is this tenant's receipt and
 * it is still linked to that line when the write lands (a concurrent re-link is never undone).
 */
export async function undoReceiptLink(env: Env, userId: string, receiptId: string): Promise<string | null> {
  if (!receiptId) return null;
  const row = await env.DB.prepare(
    `SELECT matched_txn_id, link_snapshot FROM transactions WHERE id = ? AND user_id = ? AND kind = 'receipt' AND matched_txn_id IS NOT NULL`,
  ).bind(receiptId, userId).first<{ matched_txn_id: string; link_snapshot: string | null }>();
  if (!row) return null;
  const lineId = row.matched_txn_id;
  const snap = parseLinkSnapshot(row.link_snapshot, lineId);
  const f = snap?.filled ?? {};
  const receiptStatus = snap?.receipt_status && snap.receipt_status !== "matched_receipt" ? snap.receipt_status : "extracted";
  // One atomic batch. The unlink is guarded on the line read above (a concurrent re-link to another line
  // is never undone); the follow-on writes only land if the receipt is now unlinked.
  const unlinkedGuard = `EXISTS (SELECT 1 FROM transactions WHERE id = ? AND user_id = ? AND kind = 'receipt' AND matched_txn_id IS NULL)`;
  const stmts = [
    env.DB.prepare(`UPDATE transactions SET matched_txn_id = NULL, status = ?, link_snapshot = NULL WHERE id = ? AND user_id = ? AND kind = 'receipt' AND matched_txn_id = ?`)
      .bind(receiptStatus, receiptId, userId, lineId),
    env.DB.prepare(`INSERT OR IGNORE INTO reconcile_dismissals (user_id, receipt_id, line_id) SELECT ?, ?, ? WHERE ${unlinkedGuard}`)
      .bind(userId, receiptId, lineId, receiptId, userId),
  ];
  if (f.gst_cents != null || f.bucket != null || f.ato_label != null) {
    // Every SET expression reads the OLD row, so the status CASE sees the bucket before it is cleared.
    stmts.push(
      env.DB.prepare(
        `UPDATE transactions SET
            gst_cents = CASE WHEN ? IS NOT NULL AND gst_cents = ? THEN NULL ELSE gst_cents END,
            bucket    = CASE WHEN ? IS NOT NULL AND bucket = ? THEN NULL ELSE bucket END,
            ato_label = CASE WHEN ? IS NOT NULL AND ato_label = ? THEN NULL ELSE ato_label END,
            status    = CASE WHEN ? IS NOT NULL AND bucket = ? AND ? IS NOT NULL THEN ? ELSE status END
          WHERE id = ? AND user_id = ? AND kind = 'bank_line' AND ${unlinkedGuard}`,
      ).bind(
        f.gst_cents ?? null, f.gst_cents ?? null,
        f.bucket ?? null, f.bucket ?? null,
        f.ato_label ?? null, f.ato_label ?? null,
        f.bucket ?? null, f.bucket ?? null, snap?.line_status ?? null, snap?.line_status ?? null,
        lineId, userId, receiptId, userId,
      ),
    );
  }
  const res = (await env.DB.batch(stmts)) as { meta?: { changes?: number } }[];
  return Number(res[0]?.meta?.changes ?? 0) > 0 ? lineId : null;
}
