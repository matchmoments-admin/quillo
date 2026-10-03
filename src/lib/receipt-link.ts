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
 */
export async function receiptLinkTargets(env: Env, userId: string, receiptId: string, lineId: string): Promise<{ donor: ReceiptDonor } | null> {
  if (!receiptId || !lineId || receiptId === lineId) return null;
  const receipt = await env.DB.prepare(
    `SELECT gst_cents, bucket, ato_label FROM transactions WHERE id = ? AND user_id = ? AND kind = 'receipt'`,
  ).bind(receiptId, userId).first<ReceiptDonor>();
  if (!receipt) return null;
  const line = await env.DB.prepare(
    `SELECT id FROM transactions WHERE id = ? AND user_id = ? AND kind = 'bank_line' AND status NOT IN ('duplicate','ignored')`,
  ).bind(lineId, userId).first<{ id: string }>();
  if (!line) return null;
  return { donor: receipt };
}

/** Write the link. Callers validate first (receiptLinkTargets) or pass rows they selected themselves. */
export async function applyReceiptLink(env: Env, userId: string, receiptId: string, lineId: string, donor?: ReceiptDonor): Promise<void> {
  await env.DB.prepare(`UPDATE transactions SET matched_txn_id = ?, status = 'matched_receipt' WHERE id = ? AND user_id = ? AND kind = 'receipt'`)
    .bind(lineId, receiptId, userId)
    .run();
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
}
