import { Agent } from "agents";
import type { Env } from "./env";
import { getProfile, getSituation, renderSituation, type Profile, type Situation, type UserRule } from "./lib/db";
import { addRule } from "./lib/situation-write";
import { COUNTABLE } from "./lib/queries";
import { sha256hex, sha256hexBytes } from "./lib/base64";
import { getLLM, type LLM } from "./llm";
import { extractReceipt, extractReceipts, extractFromText, extractColumnMap, extractStatement, extractBatch, type Extracted, type ExtractedStatement } from "./extract";
import { parseCsv, applyColumnMap, lineFingerprint, deriveBalances, reconcileStatement, fuzzyMerchant, isTransferLike, type ColumnMap, type Reconciliation, type StatementLine } from "./lib/statements";
import { cleanMerchant } from "./lib/bank-parsers";
import { pdfPageCount, splitPdf } from "./lib/pdf";
import { getLedger, LedgerNotConnectedError, type LedgerExpense } from "./ledger";
import { redact } from "./lib/redact";
import { toAud } from "./lib/fx";
import { spentTodayCents } from "./lib/usage";
import { parseTransactionAlert } from "./lib/bank-parsers";
import auV1RulePack from "./rulepacks/au-v1.json";

const CONFIDENCE_THRESHOLD = 0.85;

type RulePack = typeof auV1RulePack;

// Corrections may only target these fields. Each maps to a fixed column name, so
// the field never reaches SQL as interpolated text (fixes blocker B2: injection).
const CORRECTABLE: Record<string, string> = {
  bucket: "bucket",
  ato_label: "ato_label",
  amount_cents: "amount_cents",
  amount_aud_cents: "amount_aud_cents", // the reconciled AUD value (e.g. from the bank feed)
  currency: "currency",
  gst_cents: "gst_cents",
  txn_date: "txn_date", // lets undated receipts be fixed so they land in an FY
  merchant: "merchant",
  property_id: "property_id",
  paid_account: "paid_account", // drives reconcile-vs-push in Phase 3
};

// Default AU rule pack is the canonical JSON in src/rulepacks/ (single source of truth
// shared with the eval harness). Overridable per-version via KV `rulepack:<ver>`.
const DEFAULT_RULE_PACK: RulePack = auV1RulePack;

/**
 * Deterministic per-user override. Returns the highest-priority rule whose pattern
 * matches the merchant, or null. Rules are pre-sorted by priority DESC in getSituation.
 * Pure + side-effect-free so it can be unit-tested without the API.
 */
export function applyUserRules(merchant: string, rules: UserRule[]): UserRule | null {
  const m = (merchant ?? "").toLowerCase();
  for (const r of rules) {
    const p = r.pattern.toLowerCase();
    const hit = r.match_type === "merchant_exact" ? m === p : m.includes(p);
    if (hit) return r;
  }
  return null;
}

export class TaxAgent extends Agent<Env> {
  // ── 1. INGEST: receipt image/PDF arrives as bytes ──────────────────────────
  async ingest(
    userId: string,
    source: string,
    bytes: ArrayBuffer,
    mime: string,
    bucketHint: string | null = null,
  ): Promise<string> {
    const txnId = crypto.randomUUID();
    const key = `${userId}/${txnId}`;
    await this.env.RECEIPTS.put(key, bytes, { httpMetadata: { contentType: mime } });

    // Exact-duplicate detection: identical bytes ⇒ same receipt. If we've already captured
    // this image, record a 'duplicate' row (linked to the original) and SKIP the Claude
    // call — saves cost and stops double-counting. The user can delete it.
    const imageHash = await sha256hexBytes(bytes);
    const prior = await this.env.DB.prepare(
      `SELECT id, merchant FROM transactions
        WHERE user_id = ? AND image_hash = ? AND status <> 'duplicate' ORDER BY created_at LIMIT 1`,
    )
      .bind(userId, imageHash)
      .first<{ id: string; merchant: string | null }>();
    if (prior) {
      await this.env.DB.prepare(
        `INSERT INTO transactions (id, user_id, source, status, receipt_key, image_hash, duplicate_of)
         VALUES (?, ?, ?, 'duplicate', ?, ?, ?)`,
      )
        .bind(txnId, userId, source, key, imageHash, prior.id)
        .run();
      await this.audit(userId, "ingest_duplicate", JSON.stringify({ txnId, duplicateOf: prior.id }));
      await this.notify(
        userId,
        `Looks like a duplicate of a receipt you already uploaded${prior.merchant ? ` (${prior.merchant})` : ""} — skipped re-reading it. Delete it if it's the same expense.`,
        txnId,
      );
      return txnId;
    }

    await this.env.DB.prepare(
      `INSERT INTO transactions (id, user_id, source, status, receipt_key, image_hash)
       VALUES (?, ?, ?, 'needs_extraction', ?, ?)`,
    )
      .bind(txnId, userId, source, key, imageHash)
      .run();
    await this.audit(userId, "ingest", JSON.stringify({ txnId, source, bucketHint }));

    // Run extraction within the DO's active lifetime (NOT ctx.waitUntil — that is a
    // no-op in Durable Objects, finding H3). Awaiting keeps the DO alive for the call.
    await this.extractAndCategorise(userId, txnId, bytes, mime, bucketHint);
    return txnId;
  }

  /**
   * Ingest a receipt that spans MULTIPLE images (several screenshots / multi-page PDF) as
   * ONE transaction: store every image in R2, then run a single multi-image extraction.
   */
  async ingestImages(
    userId: string,
    source: string,
    images: { bytes: ArrayBuffer; mime: string }[],
    bucketHint: string | null = null,
  ): Promise<string> {
    const first = images[0];
    if (!first) throw new Error("no images provided");
    const txnId = crypto.randomUUID();
    const keys: string[] = [];
    let i = 0;
    for (const im of images) {
      const k = `${userId}/${txnId}-${i++}`;
      await this.env.RECEIPTS.put(k, im.bytes, { httpMetadata: { contentType: im.mime } });
      keys.push(k);
    }
    const imageHash = await sha256hexBytes(first.bytes);
    await this.env.DB.prepare(
      `INSERT INTO transactions (id, user_id, source, status, receipt_key, receipt_keys, image_hash)
       VALUES (?, ?, ?, 'needs_extraction', ?, ?, ?)`,
    )
      .bind(txnId, userId, source, keys[0] ?? null, JSON.stringify(keys), imageHash)
      .run();
    await this.audit(userId, "ingest_multi", JSON.stringify({ txnId, source, count: images.length }));

    const ctx = await this.prepareCategorisation(userId, txnId, bucketHint);
    if (!ctx) return txnId; // consent gate blocked
    const { parsed } = await extractReceipts(ctx.llm, ctx.system, images);
    await this.finaliseExtraction(userId, txnId, parsed, ctx.situation, ctx.llm, ctx.system);
    return txnId;
  }

  // ── 1c. STATEMENT IMPORT (CSV) — bank lines for un-fed accounts ──────────────
  // Parse a statement: store the raw file, infer the column map with ONE Claude call,
  // parse rows, and return a preview (no rows are committed yet). Re-uploading the exact
  // file short-circuits on file_hash. Refuses accounts whose canonical source is the QBO
  // feed (avoids feed-vs-statement double counting).
  async parseStatement(
    userId: string,
    accountId: string,
    filename: string,
    bytes: ArrayBuffer,
    format: string,
  ): Promise<{ statementId: string; columnMap: ColumnMap | null; preview: unknown[]; rowCount: number; duplicate: boolean; reconciliation?: Reconciliation }> {
    const account = await this.env.DB.prepare(`SELECT source FROM accounts WHERE id = ? AND user_id = ?`)
      .bind(accountId, userId)
      .first<{ source: string }>();
    if (!account) throw new Error("account not found");
    if (account.source === "qbo_feed") {
      throw new Error("This account is reconciled from the QuickBooks feed — don't import statements for it (would double-count).");
    }

    const fileHash = await sha256hexBytes(bytes);
    const existing = await this.env.DB.prepare(`SELECT id FROM statements WHERE user_id = ? AND file_hash = ?`)
      .bind(userId, fileHash)
      .first<{ id: string }>();
    if (existing) {
      return { statementId: existing.id, columnMap: null, preview: [], rowCount: 0, duplicate: true };
    }

    const statementId = crypto.randomUUID();
    const fileKey = `${userId}/statements/${statementId}`;
    await this.env.RECEIPTS.put(fileKey, bytes, { httpMetadata: { contentType: format === "pdf" ? "application/pdf" : "text/csv" } });

    const profile = await this.requireProfile(userId);
    const llm = await getLLM(this.env, profile, { userId });

    let lines: StatementLine[];
    let columnMap: ColumnMap | null = null;
    let recon: Reconciliation;

    if (format === "pdf") {
      // PDF: Claude transcribes the table. Reconcile; if it doesn't balance, escalate —
      // re-extract once for small PDFs, or CHUNK by page for multi-page ones (bounds the
      // per-call output so nothing truncates). The stitched result is reconciled end-to-end,
      // so a dropped page anywhere breaks the running balance and is flagged.
      const single = async () => {
        const ext = await extractStatement(llm, bytes, "application/pdf");
        const ls = this.pdfLines(ext);
        return { ls, recon: reconcileStatement(ls, ext.opening_cents, ext.closing_cents) };
      };
      let a = await single();
      if (a.recon.available && !a.recon.ok) {
        const pages = await pdfPageCount(bytes);
        if (pages > 2) {
          const chunks = await splitPdf(bytes, 3);
          const all: StatementLine[] = [];
          let opening: number | null = null;
          let closing: number | null = null;
          for (let k = 0; k < chunks.length; k++) {
            const ext = await extractStatement(llm, chunks[k]!, "application/pdf");
            all.push(...this.pdfLines(ext));
            if (k === 0) opening = ext.opening_cents;
            closing = ext.closing_cents;
          }
          const recon2 = reconcileStatement(all, opening, closing);
          if (recon2.ok || (recon2.available && Math.abs(recon2.diff_cents) < Math.abs(a.recon.diff_cents))) a = { ls: all, recon: recon2 };
        } else {
          const b = await single(); // small PDF: just a fresh re-extract
          if (b.recon.ok || (b.recon.available && Math.abs(b.recon.diff_cents) < Math.abs(a.recon.diff_cents))) a = b;
        }
      }
      lines = a.ls;
      recon = a.recon;
    } else {
      const rows = parseCsv(new TextDecoder().decode(bytes));
      columnMap = await extractColumnMap(llm, rows);
      lines = applyColumnMap(rows, columnMap);
      const bal = deriveBalances(lines);
      recon = reconcileStatement(lines, bal?.opening_cents ?? null, bal?.closing_cents ?? null);
    }

    // Store the normalised lines beside the raw file so confirmImport never re-extracts.
    await this.env.RECEIPTS.put(`${fileKey}.lines`, JSON.stringify(lines), { httpMetadata: { contentType: "application/json" } });
    if (recon.available && !recon.ok) {
      await this.audit(userId, "statement_recon_fail", JSON.stringify({ statementId, diff: recon.diff_cents, bad: recon.first_bad_line }));
    }

    await this.env.DB.prepare(
      `INSERT INTO statements (id, user_id, account_id, filename, file_key, file_hash, format, column_map, row_count,
         opening_cents, closing_cents, reconciled, recon_diff_cents, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'parsed')`,
    )
      .bind(
        statementId, userId, accountId, filename, fileKey, fileHash, format, JSON.stringify(columnMap), lines.length,
        recon.opening_cents, recon.closing_cents, recon.available ? (recon.ok ? 1 : 0) : null, recon.available ? recon.diff_cents : null,
      )
      .run();
    await this.audit(userId, "statement_parsed", JSON.stringify({ statementId, accountId, rows: lines.length, reconciled: recon.ok }));

    return { statementId, columnMap, preview: lines.slice(0, 25), rowCount: lines.length, duplicate: false, reconciliation: recon };
  }

  // Commit a parsed statement: re-read the raw file, parse with the (optionally corrected)
  // column map, de-dup each line by fingerprint, batch-insert the new bank lines, and
  // categorise deterministically (user rules + merchant hints — FREE; LLM categorisation of
  // the remainder is a later phase). Returns counts.
  async confirmImport(userId: string, statementId: string, _columnMapOverride?: ColumnMap, force?: boolean): Promise<{ imported: number; skipped: number }> {
    const stmt = await this.env.DB.prepare(
      `SELECT account_id, file_key, opening_cents, closing_cents FROM statements WHERE id = ? AND user_id = ?`,
    )
      .bind(statementId, userId)
      .first<{ account_id: string; file_key: string; opening_cents: number | null; closing_cents: number | null }>();
    if (!stmt) throw new Error("statement not found");

    // Use the normalised lines stored at parse time (so a PDF is never re-extracted).
    const sidecar = await this.env.RECEIPTS.get(`${stmt.file_key}.lines`);
    if (!sidecar) throw new Error("parsed lines missing — re-upload the statement");
    const lines = JSON.parse(await sidecar.text()) as StatementLine[];

    // Reconciliation gate: refuse to import a statement that doesn't balance unless the user
    // explicitly overrides after reviewing the flagged line(s). This is the proof of completeness.
    const recon = reconcileStatement(lines, stmt.opening_cents, stmt.closing_cents);
    if (recon.available && !recon.ok && !force) {
      const off = `$${Math.abs(recon.diff_cents / 100).toFixed(2)}`;
      throw new Error(`Statement doesn't reconcile (off by ${off}${recon.first_bad_line != null ? `, first wrong around line ${recon.first_bad_line + 1}` : ""}). Review the lines, then import anyway to override.`);
    }

    const profile = await this.requireProfile(userId);
    const situation = await getSituation(this.env, userId, profile);
    const rulePack = await this.loadRulePack(profile.rule_pack_ver);

    // Existing fingerprints for this account → skip re-uploaded/overlapping lines.
    const seen = new Set<string>();
    const prior = await this.env.DB.prepare(
      `SELECT line_fingerprint FROM transactions WHERE user_id = ? AND account_id = ? AND line_fingerprint IS NOT NULL`,
    )
      .bind(userId, stmt.account_id)
      .all<{ line_fingerprint: string }>();
    for (const r of prior.results ?? []) seen.add(r.line_fingerprint);

    const inserts: D1PreparedStatement[] = [];
    let skipped = 0;
    for (const line of lines) {
      const fp = await lineFingerprint(stmt.account_id, line);
      if (seen.has(fp)) {
        skipped++;
        continue;
      }
      seen.add(fp);
      // Transfers / card payments / internal movements are NOT spend → 'ignored' (never counted).
      const transfer = isTransferLike(line.raw_description);
      // Deterministic categorisation (no model call): user rule first, then merchant hints.
      const cat = !transfer && line.direction === "debit" ? this.deterministicCategorise(line.description, situation.rules, rulePack) : null;
      const status = transfer ? "ignored" : cat ? "extracted" : line.direction === "credit" ? "extracted" : "needs_review";
      inserts.push(
        this.env.DB.prepare(
          `INSERT INTO transactions
             (id, user_id, source, status, kind, account_id, statement_id, line_fingerprint, raw_description,
              merchant, amount_cents, currency, amount_aud_cents, txn_date, direction, bucket, ato_label, confidence)
           VALUES (?, ?, 'statement', ?, 'bank_line', ?, ?, ?, ?, ?, ?, 'AUD', ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, account_id, line_fingerprint) DO NOTHING`,
        ).bind(
          crypto.randomUUID(),
          userId,
          status,
          stmt.account_id,
          statementId,
          fp,
          line.raw_description,
          line.description,
          line.amount_cents,
          line.amount_cents, // AU statement = AUD
          line.date,
          line.direction,
          cat?.bucket ?? null,
          cat?.ato_label ?? null,
          cat ? cat.confidence : null,
        ),
      );
    }

    // Batch insert in chunks (D1 bounds params per batch).
    let imported = 0;
    for (let i = 0; i < inserts.length; i += 50) {
      const chunk = inserts.slice(i, i + 50);
      const res = await this.env.DB.batch(chunk);
      imported += res.reduce((s, r) => s + (r.meta?.changes ?? 0), 0);
    }

    await this.env.DB.prepare(`UPDATE statements SET status='imported', imported_count=? WHERE id=?`)
      .bind(imported, statementId)
      .run();
    await this.audit(userId, "statement_imported", JSON.stringify({ statementId, imported, skipped }));

    // Batch-categorise the lines that the deterministic pass (rules+hints) didn't cover.
    const cat = await this.categoriseStatement(userId, statementId);
    // Attach any existing receipts to the new lines (stops double-counting + donates GST).
    await this.matchReceiptsForUser(userId);

    await this.notify(
      userId,
      `Imported ${imported} transaction(s)${skipped ? ` (${skipped} already on file)` : ""}${cat.categorised ? `, categorised ${cat.categorised} with Claude` : ""}.`,
      null,
    );
    return { imported, skipped };
  }

  /**
   * Batch-categorise statement bank lines the deterministic pass left as needs_review.
   * One Claude call per ~40 lines (not per line); cap-aware (counts lines-sent against
   * MAX_EXTRACTIONS_PER_DAY) — over the cap, the remainder stays needs_review.
   */
  async categoriseStatement(userId: string, statementId: string): Promise<{ categorised: number }> {
    const rows = await this.env.DB.prepare(
      `SELECT id, merchant, amount_cents, txn_date FROM transactions
        WHERE user_id = ? AND statement_id = ? AND kind = 'bank_line' AND status = 'needs_review' AND direction = 'debit'`,
    )
      .bind(userId, statementId)
      .all<{ id: string; merchant: string | null; amount_cents: number | null; txn_date: string | null }>();
    const items = rows.results ?? [];
    if (!items.length) return { categorised: 0 };

    const profile = await this.requireProfile(userId);
    const provider = profile.inference_provider ?? this.env.DEFAULT_INFERENCE_PROVIDER;
    if (provider === "anthropic" && profile.consent_xborder !== 1) return { categorised: 0 }; // consent gate
    const rulePack = await this.loadRulePack(profile.rule_pack_ver);
    const situation = await getSituation(this.env, userId, profile);
    const system = this.buildSystemPrompt(rulePack, profile, situation, null);
    const llm = await getLLM(this.env, profile, { userId });

    let categorised = 0;
    for (let i = 0; i < items.length; i += 40) {
      const chunk = items.slice(i, i + 40);
      // Stop categorising once the daily $ budget is hit; the rest stays needs_review.
      if (!(await this.withinBudget(userId, null))) break;
      const results = await extractBatch(
        llm,
        system,
        chunk.map((c) => ({ merchant: c.merchant ?? "", amount_cents: c.amount_cents ?? 0, date: c.txn_date })),
      );
      const updates: D1PreparedStatement[] = [];
      for (let j = 0; j < chunk.length; j++) {
        const r = results[j];
        if (!r) continue;
        updates.push(
          this.env.DB.prepare(
            `UPDATE transactions SET status='extracted', bucket=?, ato_label=?, confidence=?, reasoning=? WHERE id=? AND user_id=?`,
          ).bind(r.bucket, r.ato_label, r.confidence, r.reasoning, chunk[j]!.id, userId),
        );
        categorised++;
      }
      if (updates.length) await this.env.DB.batch(updates);
    }
    await this.audit(userId, "statement_categorised", JSON.stringify({ statementId, categorised }));
    return { categorised };
  }

  // ── Receipt ↔ bank-line matching: a receipt becomes EVIDENCE on a money line ──
  // Counted set = bank lines + unmatched receipts, so a matched receipt stops double-counting.
  // The bank line is the authoritative AUD; the receipt donates its GST/bucket to the line.
  private async matchReceipt(
    userId: string,
    receipt: { id: string; amount_aud_cents: number | null; amount_cents: number | null; txn_date: string | null; merchant: string | null; gst_cents: number | null; bucket: string | null; ato_label: string | null },
  ): Promise<boolean> {
    const amt = receipt.amount_aud_cents ?? receipt.amount_cents;
    if (amt == null || !receipt.txn_date) return false;
    const tol = Math.max(50, Math.round(amt * 0.01));
    const cands = await this.env.DB.prepare(
      `SELECT id, amount_aud_cents, amount_cents, txn_date, raw_description, merchant FROM transactions
        WHERE user_id = ? AND kind = 'bank_line' AND status NOT IN ('duplicate','ignored') AND matched_txn_id IS NULL
          AND direction = 'debit'
          AND ABS(COALESCE(amount_aud_cents, amount_cents) - ?) <= ?
          AND txn_date BETWEEN date(?, '-4 day') AND date(?, '+4 day')`,
    )
      .bind(userId, amt, tol, receipt.txn_date, receipt.txn_date)
      .all<{ id: string; amount_aud_cents: number | null; amount_cents: number | null; txn_date: string | null; raw_description: string | null; merchant: string | null }>();

    let best: { id: string } | null = null;
    let bestScore = 0;
    let second = 0;
    for (const c of cands.results ?? []) {
      const camt = c.amount_aud_cents ?? c.amount_cents ?? 0;
      const amountScore = 1 - Math.abs(camt - amt) / (tol || 1);
      const dayDiff = Math.abs((Date.parse(c.txn_date ?? "") - Date.parse(receipt.txn_date)) / 86_400_000);
      const dateScore = 1 - Math.min(Number.isFinite(dayDiff) ? dayDiff : 4, 4) / 4;
      const mScore = fuzzyMerchant(c.raw_description ?? c.merchant ?? "", receipt.merchant ?? "");
      const score = 0.5 * amountScore + 0.2 * dateScore + 0.3 * mScore;
      if (score > bestScore) {
        second = bestScore;
        bestScore = score;
        best = { id: c.id };
      } else if (score > second) second = score;
    }
    if (best && bestScore >= 0.8 && bestScore - second > 0.15) {
      await this.linkReceiptToLine(userId, receipt.id, best.id, receipt);
      return true;
    }
    return false;
  }

  private async linkReceiptToLine(
    userId: string,
    receiptId: string,
    lineId: string,
    receipt?: { gst_cents: number | null; bucket: string | null; ato_label: string | null },
  ): Promise<void> {
    await this.env.DB.prepare(`UPDATE transactions SET matched_txn_id = ?, status = 'matched_receipt' WHERE id = ? AND user_id = ? AND kind = 'receipt'`)
      .bind(lineId, receiptId, userId)
      .run();
    // The line is authoritative AUD; take the receipt's GST/bucket where the line lacked them.
    if (receipt) {
      await this.env.DB.prepare(
        `UPDATE transactions SET gst_cents = COALESCE(gst_cents, ?), bucket = COALESCE(bucket, ?),
                ato_label = COALESCE(ato_label, ?), status = CASE WHEN bucket IS NULL THEN 'extracted' ELSE status END
          WHERE id = ? AND user_id = ?`,
      )
        .bind(receipt.gst_cents, receipt.bucket, receipt.ato_label, lineId, userId)
        .run();
    }
    await this.audit(userId, "match", JSON.stringify({ receiptId, lineId }));
    await this.notify(userId, `Matched a receipt to a statement line — counted once now.`, lineId);
  }

  /** Manual link (user clicks): attach a receipt to a bank line as evidence. */
  async linkReceipt(userId: string, receiptId: string, lineId: string): Promise<void> {
    const r = await this.env.DB.prepare(`SELECT gst_cents, bucket, ato_label FROM transactions WHERE id = ? AND user_id = ?`)
      .bind(receiptId, userId)
      .first<{ gst_cents: number | null; bucket: string | null; ato_label: string | null }>();
    await this.linkReceiptToLine(userId, receiptId, lineId, r ?? undefined);
  }

  /** Manual unlink: detach a receipt so it counts standalone again. */
  async unlinkReceipt(userId: string, receiptId: string): Promise<void> {
    await this.env.DB.prepare(`UPDATE transactions SET matched_txn_id = NULL, status = 'extracted' WHERE id = ? AND user_id = ? AND kind = 'receipt'`)
      .bind(receiptId, userId)
      .run();
    await this.audit(userId, "unmatch", JSON.stringify({ receiptId }));
  }

  /** After a statement import, try to match each unmatched receipt to a new line. */
  private async matchReceiptsForUser(userId: string): Promise<void> {
    const rows = await this.env.DB.prepare(
      `SELECT id, amount_aud_cents, amount_cents, txn_date, merchant, gst_cents, bucket, ato_label FROM transactions
        WHERE user_id = ? AND kind = 'receipt' AND status NOT IN ('duplicate') AND matched_txn_id IS NULL AND txn_date IS NOT NULL`,
    )
      .bind(userId)
      .all<{ id: string; amount_aud_cents: number | null; amount_cents: number | null; txn_date: string | null; merchant: string | null; gst_cents: number | null; bucket: string | null; ato_label: string | null }>();
    for (const r of rows.results ?? []) await this.matchReceipt(userId, r);
  }

  /** Map a Claude-extracted PDF statement to the shared StatementLine shape. */
  private pdfLines(ext: ExtractedStatement): StatementLine[] {
    return ext.lines.map((l) => ({
      date: l.date,
      amount_cents: Math.abs(l.amount_cents),
      direction: l.direction === "credit" ? "credit" : "debit",
      description: cleanMerchant(l.description) || l.description,
      raw_description: l.description,
      balance_cents: l.balance_cents ?? null,
    }));
  }

  /** Deterministic categorisation for a statement line: user rule (1.0) then merchant hints (0.8). */
  private deterministicCategorise(
    merchant: string,
    rules: UserRule[],
    rulePack: typeof DEFAULT_RULE_PACK,
  ): { bucket: string; ato_label: string; confidence: number } | null {
    const rule = applyUserRules(merchant, rules);
    if (rule) return { bucket: rule.bucket, ato_label: rule.ato_label, confidence: 1 };
    const hints = (rulePack as { merchant_hints?: { match: string; bucket: string; ato_label: string }[] }).merchant_hints;
    if (Array.isArray(hints)) {
      const m = merchant.toLowerCase();
      for (const h of hints) {
        const terms = h.match.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
        if (terms.some((t) => t && m.includes(t))) return { bucket: h.bucket, ato_label: h.ato_label, confidence: 0.8 };
      }
    }
    return null;
  }

  /** Set an account's canonical money source (qbo_feed | statement | manual). */
  async setAccountSource(userId: string, accountId: string, source: string): Promise<void> {
    await this.env.DB.prepare(`UPDATE accounts SET source = ? WHERE id = ? AND user_id = ?`).bind(source, accountId, userId).run();
    await this.audit(userId, "account_source", JSON.stringify({ accountId, source }));
  }

  /** Email-body fallback when an email has no attachment.
   *
   * Attempts to parse the body as a bank/merchant transaction-alert email using the
   * conservative bank-parsers (no Claude call). If a known alert pattern is matched,
   * the extracted fields are stored and the status is set to 'extracted' (with confidence
   * flagged for human review). If no pattern matches, falls back to 'needs_review' as before.
   *
   * The body is redacted (card numbers, TFNs, bank BSBs) before any parsing or storage.
   */
  async ingestText(userId: string, source: string, text: string): Promise<string> {
    const txnId = crypto.randomUUID();

    // Redact PII from the text before parsing or logging (fix H7 equivalent for email bodies).
    const safe = redact(text);

    // Try the bank-alert parser (pure, no Claude call, conservative).
    const parsed = parseTransactionAlert(safe);

    if (parsed) {
      // Store structured fields; mark as 'extracted' but flag for human review — the
      // parser is heuristic and the bucket cannot be determined from the alert alone.
      await this.env.DB.prepare(
        `INSERT INTO transactions (id, user_id, source, status, merchant, amount_cents, txn_date)
         VALUES (?, ?, ?, 'needs_review', ?, ?, ?)`,
      )
        .bind(txnId, userId, source, parsed.merchant, parsed.amount_cents, parsed.txn_date)
        .run();
      await this.audit(userId, "ingest_text_parsed", JSON.stringify({ txnId, source, merchant: parsed.merchant, amount_cents: parsed.amount_cents }));
      await this.notify(
        userId,
        `Spend alert parsed: ${parsed.merchant} $${(parsed.amount_cents / 100).toFixed(2)}${parsed.txn_date ? ` on ${parsed.txn_date}` : ""} — bucket not yet determined. Confirm or upload a receipt for full categorisation.`,
        txnId,
      );
    } else {
      // No known pattern — store as unstructured and ask for manual review.
      await this.env.DB.prepare(
        `INSERT INTO transactions (id, user_id, source, status) VALUES (?, ?, ?, 'needs_review')`,
      )
        .bind(txnId, userId, source)
        .run();
      await this.audit(userId, "ingest_text", JSON.stringify({ txnId, source }));
      await this.notify(userId, "Received an email with no receipt attachment — left for manual review.", txnId);
    }

    return txnId;
  }

  // ── 1b. INGEST + CATEGORISE typed / free-text expense (no image) ────────────
  // HTTP entry point: POST /ingest with a text/* content-type (see src/index.ts). Unlike
  // ingestText (the conservative bank-alert parser, no Claude), this runs the SAME
  // categorisation as a receipt so a typed line gets a real bucket + ato_label.
  async ingestCategoriseText(
    userId: string,
    source: string,
    text: string,
    bucketHint: string | null = null,
  ): Promise<string> {
    const txnId = crypto.randomUUID();
    const safe = redact(text); // strip PII before it reaches the model or logs
    await this.env.DB.prepare(
      `INSERT INTO transactions (id, user_id, source, status) VALUES (?, ?, ?, 'needs_extraction')`,
    )
      .bind(txnId, userId, source)
      .run();
    await this.audit(userId, "ingest_text_categorise", JSON.stringify({ txnId, source }));

    const ctx = await this.prepareCategorisation(userId, txnId, bucketHint);
    if (!ctx) return txnId; // APP-8 consent gate blocked it
    const { parsed } = await extractFromText(ctx.llm, ctx.system, safe);
    await this.finaliseExtraction(userId, txnId, parsed, ctx.situation, ctx.llm, ctx.system);
    return txnId;
  }

  // ── 2. EXTRACT + CATEGORISE (Claude vision = OCR) ──────────────────────────
  async extractAndCategorise(
    userId: string,
    txnId: string,
    bytes: ArrayBuffer,
    mime: string,
    bucketHint: string | null,
  ): Promise<void> {
    const ctx = await this.prepareCategorisation(userId, txnId, bucketHint);
    if (!ctx) return; // APP-8 consent gate blocked it
    const { parsed } = await extractReceipt(ctx.llm, ctx.system, bytes, mime);
    await this.finaliseExtraction(userId, txnId, parsed, ctx.situation, ctx.llm, ctx.system);
  }

  /**
   * Shared setup for the image and text categorisation paths: enforce the APP-8
   * cross-border consent gate (fix H7 — a US/anthropic inference call on personal tax
   * data needs explicit recorded consent; Bedrock/AU does not), then build the
   * (cacheable) rule-pack + profile + situation system prompt and the inference client.
   * Returns null when consent blocks the call (txn marked blocked_consent + user notified).
   */
  private async prepareCategorisation(
    userId: string,
    txnId: string,
    bucketHint: string | null,
  ): Promise<{ llm: LLM; system: string; situation: Situation } | null> {
    const profile = await this.requireProfile(userId);

    const provider = profile.inference_provider ?? this.env.DEFAULT_INFERENCE_PROVIDER;
    if (provider === "anthropic" && profile.consent_xborder !== 1) {
      await this.markStatus(txnId, "blocked_consent");
      await this.notify(
        userId,
        "Cross-border processing consent (APP 8) is required before this receipt can be read by the US inference API. Record consent to proceed.",
        txnId,
      );
      return null;
    }

    // Per-user daily $ budget — credit insurance, measured (not a count guess). The metered
    // LLM seam keeps cost:<userId>:<day> in KV; over budget → degrade to needs_review.
    if (!(await this.withinBudget(userId, txnId))) return null;

    const rulePack = await this.loadRulePack(profile.rule_pack_ver);
    const situation = await getSituation(this.env, userId, profile);
    const system = this.buildSystemPrompt(rulePack, profile, situation, bucketHint);
    const llm = await getLLM(this.env, profile, { userId });
    return { llm, system, situation };
  }

  /**
   * Persist a categorised expense. A deterministic per-user rule (confidence 1.0) wins
   * over the model's guess; then write the row, trace, and the company / low-confidence
   * notifications. Shared by the image and text paths so both behave identically.
   *
   * DESIGN DECISION (reader/reconciler): the agent does NOT auto-create Purchase objects
   * in QuickBooks for company-bucket txns — bank feeds are the source of truth in QBO, so
   * auto-posting here would duplicate the feed. We notify for reconciliation instead.
   * pushToLedger() remains for genuine cash / non-feed expenses only.
   */
  private async finaliseExtraction(
    userId: string,
    txnId: string,
    parsed: Extracted,
    situation: Situation,
    llm: LLM,
    system: string,
  ): Promise<void> {
    const rule = applyUserRules(parsed.merchant, situation.rules);
    const final: Extracted = rule
      ? {
          ...parsed,
          bucket: rule.bucket as Extracted["bucket"],
          ato_label: rule.ato_label,
          property_id: rule.property_id ?? parsed.property_id,
          confidence: 1,
        }
      : parsed;

    // Currency: AU GST only applies to AUD supplies — force null for anything foreign
    // (defensive, on top of the prompt rule). Convert to AUD for reporting (estimate; the
    // authoritative AUD is the reconciled bank-feed line).
    const currency = (final.currency ?? "AUD").trim().toUpperCase();
    const gstCents = currency === "AUD" ? final.gst_cents : null;
    const fx = await toAud(this.env, final.amount_cents, currency, final.txn_date);

    await this.env.DB.prepare(
      `UPDATE transactions SET status='extracted', merchant=?, amount_cents=?, currency=?,
              amount_aud_cents=?, fx_rate=?, fx_date=?, gst_cents=?, txn_date=?, bucket=?,
              ato_label=?, property_id=?, paid_account=?, confidence=?, reasoning=? WHERE id=? AND user_id=?`,
    )
      .bind(
        final.merchant,
        final.amount_cents,
        currency,
        fx.amount_aud_cents,
        fx.fx_rate,
        fx.fx_date,
        gstCents,
        final.txn_date,
        final.bucket,
        final.ato_label,
        final.property_id,
        final.paid_account ?? null,
        final.confidence,
        // Teaching moment: the one-line "why" (note when a deterministic user rule decided it).
        rule ? `Matched your saved rule for "${final.merchant}". ${final.reasoning}` : final.reasoning,
        txnId,
        userId,
      )
      .run();

    await this.trace(userId, txnId, llm.modelId, system, { parsed, rule: rule?.id ?? null });

    if (final.bucket === "company" && final.confidence >= CONFIDENCE_THRESHOLD) {
      await this.notify(
        userId,
        `Company expense captured: "${final.merchant}" ($${(final.amount_cents / 100).toFixed(2)}, ${final.ato_label}) — will reconcile against your QuickBooks bank feed. Receipt attached. Review at /api/qbo/reconcile.`,
        txnId,
      );
    } else if (final.confidence < CONFIDENCE_THRESHOLD) {
      await this.notify(
        userId,
        `Need a hand: is "${final.merchant}" ($${(final.amount_cents / 100).toFixed(2)}) ${final.bucket}? Confirm or correct.`,
        txnId,
      );
    }

    // If this receipt matches a statement/feed bank line, attach it as evidence (no double count).
    await this.matchReceipt(userId, {
      id: txnId,
      amount_aud_cents: fx.amount_aud_cents,
      amount_cents: final.amount_cents,
      txn_date: final.txn_date,
      merchant: final.merchant,
      gst_cents: gstCents,
      bucket: final.bucket,
      ato_label: final.ato_label,
    });
  }

  // ── 3. CORRECTION: user overrides a field -> training signal ───────────────
  async applyCorrection(userId: string, txnId: string, field: string, newValue: string): Promise<void> {
    const column = CORRECTABLE[field];
    if (!column) throw new Error(`field not correctable: ${field}`);

    const row = await this.env.DB.prepare(
      `SELECT ${column} AS old FROM transactions WHERE id = ? AND user_id = ?`,
    )
      .bind(txnId, userId)
      .first<{ old: string | null }>();
    if (!row) throw new Error("transaction not found");

    await this.env.DB.prepare(
      `UPDATE transactions SET ${column} = ?, status='corrected' WHERE id = ? AND user_id = ?`,
    )
      .bind(newValue, txnId, userId)
      .run();
    await this.env.DB.prepare(
      `INSERT INTO corrections (id, user_id, txn_id, field, old_value, new_value)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), userId, txnId, field, row.old, newValue)
      .run();

    await this.promoteToEvalCase(userId, txnId);
    await this.audit(userId, "correction", JSON.stringify({ txnId, field, newValue }));
  }

  /**
   * Hard-delete a transaction (e.g. a duplicate upload). Removes the row and its R2
   * receipt image(s), but writes an audit_log breadcrumb so the hash-chain records WHAT was
   * deleted even though the data is gone (honours "deleted means deleted").
   */
  async deleteTransaction(userId: string, txnId: string): Promise<void> {
    const row = await this.env.DB.prepare(
      `SELECT merchant, amount_cents, currency, receipt_key, receipt_keys
         FROM transactions WHERE id = ? AND user_id = ?`,
    )
      .bind(txnId, userId)
      .first<{
        merchant: string | null;
        amount_cents: number | null;
        currency: string | null;
        receipt_key: string | null;
        receipt_keys: string | null;
      }>();
    if (!row) throw new Error("transaction not found");

    // Collect every R2 key (primary + any multi-image keys) and delete the objects.
    const keys = new Set<string>();
    if (row.receipt_key) keys.add(row.receipt_key);
    if (row.receipt_keys) {
      try {
        for (const k of JSON.parse(row.receipt_keys) as string[]) if (k) keys.add(k);
      } catch {
        /* ignore malformed json */
      }
    }
    for (const k of keys) await this.env.RECEIPTS.delete(k);

    await this.env.DB.prepare(`DELETE FROM corrections WHERE txn_id = ? AND user_id = ?`).bind(txnId, userId).run();
    await this.env.DB.prepare(`DELETE FROM transactions WHERE id = ? AND user_id = ?`).bind(txnId, userId).run();
    await this.audit(
      userId,
      "delete",
      JSON.stringify({ txnId, merchant: row.merchant, amount_cents: row.amount_cents, currency: row.currency }),
    );
  }

  /**
   * Push a company expense to QuickBooks as a Purchase — USER-TRIGGERED, for NON-FEED
   * expenses only (cash, or a card not connected to QBO like a separate Amex). Fed
   * accounts must NOT be pushed: the bank feed already posts them, and a Purchase here
   * would double-count (the reader/reconciler rule). Idempotent via `ledger_ref`. Posts
   * the AUD amount (`amount_aud_cents`), matching QBO's home currency.
   */
  async pushToQuickBooks(userId: string, txnId: string): Promise<{ ok: boolean; ledgerRef?: string; error?: string }> {
    const row = await this.env.DB.prepare(
      `SELECT merchant, amount_cents, amount_aud_cents, gst_cents, txn_date, ato_label, bucket, ledger_ref
         FROM transactions WHERE id = ? AND user_id = ?`,
    )
      .bind(txnId, userId)
      .first<{
        merchant: string | null;
        amount_cents: number | null;
        amount_aud_cents: number | null;
        gst_cents: number | null;
        txn_date: string | null;
        ato_label: string | null;
        bucket: string | null;
        ledger_ref: string | null;
      }>();
    if (!row) throw new Error("transaction not found");
    if (row.ledger_ref) return { ok: true, ledgerRef: row.ledger_ref }; // already posted
    if (row.bucket !== "company") return { ok: false, error: "only company-bucket expenses post to QuickBooks" };

    // pushToLedger reads amount_cents/gst_cents/txn_date/merchant/ato_label — feed it the
    // AUD amount so QBO records the home-currency value.
    const parsed = {
      merchant: row.merchant ?? "",
      amount_cents: row.amount_aud_cents ?? row.amount_cents ?? 0,
      gst_cents: row.gst_cents,
      txn_date: row.txn_date,
      ato_label: row.ato_label ?? "company:expense",
    } as Extracted;
    await this.pushToLedger(userId, txnId, parsed);

    const after = await this.env.DB.prepare(`SELECT ledger_ref FROM transactions WHERE id = ?`)
      .bind(txnId)
      .first<{ ledger_ref: string | null }>();
    return after?.ledger_ref
      ? { ok: true, ledgerRef: after.ledger_ref }
      : { ok: false, error: "QuickBooks not connected — connect it first, then push." };
  }

  // ── 4. PROACTIVE engine (called by cron) ───────────────────────────────────
  async runProactiveScan(userId: string): Promise<void> {
    const suggestions: string[] = [];

    const uncategorised = await this.env.DB.prepare(
      // Parenthesise the OR so BOTH clauses are scoped to this user (prior precedence bug
      // leaked other tenants' needs_review rows). Duplicates excluded.
      `SELECT COUNT(*) AS n FROM transactions
        WHERE user_id = ? AND status NOT IN ('duplicate','ignored','matched_receipt') AND (bucket = 'unknown' OR status = 'needs_review')`,
    )
      .bind(userId)
      .first<{ n: number }>();
    if (uncategorised && uncategorised.n > 0) {
      suggestions.push(`${uncategorised.n} transaction(s) still need categorising.`);
    }

    const vacant = await this.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND bucket = 'property_vacant'`,
    )
      .bind(userId)
      .first<{ n: number }>();
    if (vacant && vacant.n > 0) {
      suggestions.push(
        `${vacant.n} expense(s) on a vacant property — holding costs may not be deductible. Flag for your registered tax agent.`,
      );
    }

    const money = (c: number) => `$${(c / 100).toFixed(2)}`;
    // Current AU financial year (Jul–Jun) bounds for the FY-scoped nudges.
    const now = new Date();
    const fyStart = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
    const fyStartDate = `${fyStart}-07-01`;
    const fyEndDate = `${fyStart + 1}-06-30`;

    // GST credits captured on company expenses this FY (the BAS / reconcile angle).
    const gst = await this.env.DB.prepare(
      `SELECT COALESCE(SUM(gst_cents),0) AS g, COUNT(*) AS n FROM transactions
        WHERE user_id = ? AND bucket = 'company' AND ${COUNTABLE}
          AND txn_date >= ? AND txn_date <= ?`,
    )
      .bind(userId, fyStartDate, fyEndDate)
      .first<{ g: number; n: number }>();
    if (gst && gst.g > 0) {
      suggestions.push(
        `You've captured ${money(gst.g)} in GST credits across ${gst.n} company expense(s) this FY — reconcile them in QuickBooks to claim.`,
      );
    }

    // Vehicle/fuel spend → logbook reminder (the logbook method needs a valid 12-week log).
    const car = await this.env.DB.prepare(
      `SELECT COALESCE(SUM(COALESCE(amount_aud_cents, amount_cents)),0) AS t FROM transactions
        WHERE user_id = ? AND ${COUNTABLE}
          AND (lower(ato_label) LIKE '%car%' OR lower(ato_label) LIKE '%vehicle%'
               OR lower(ato_label) LIKE '%fuel%' OR lower(merchant) LIKE '%petrol%'
               OR lower(merchant) LIKE '%caltex%' OR lower(merchant) LIKE '%shell%'
               OR lower(merchant) LIKE '%ampol%')`,
    )
      .bind(userId)
      .first<{ t: number }>();
    if (car && car.t > 30000) {
      suggestions.push(
        `You've logged ${money(car.t)} of vehicle/fuel expenses — to claim these with the logbook method you need a valid 12-week logbook. Keep one if you haven't started.`,
      );
    }

    // Low-confidence categorisations — a quick review both fixes them and trains Quillo.
    const lowConf = await this.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM transactions
        WHERE user_id = ? AND status NOT IN ('duplicate','ignored','matched_receipt') AND confidence IS NOT NULL AND confidence < ?`,
    )
      .bind(userId, CONFIDENCE_THRESHOLD)
      .first<{ n: number }>();
    if (lowConf && lowConf.n > 0) {
      suggestions.push(
        `${lowConf.n} categorisation(s) are low-confidence — a quick review fixes them and teaches Quillo your spending.`,
      );
    }

    if (suggestions.length) {
      await this.notify(userId, suggestions.join("\n"), null);
    }
    await this.audit(userId, "proactive_scan", JSON.stringify({ count: suggestions.length }));
  }

  /** Record explicit, dated APP-8 cross-border consent (fix H7). */
  async recordConsent(userId: string, text: string, method: string): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE profiles SET consent_xborder = 1, consent_xborder_at = datetime('now'),
              consent_xborder_method = ?, consent_xborder_text = ? WHERE user_id = ?`,
    )
      .bind(method, text, userId)
      .run();
    await this.audit(userId, "consent_xborder", JSON.stringify({ method }));
  }

  // ── ledger push (idempotent, egress-aware) ─────────────────────────────────
  // RESERVED FOR CASH / NON-FEED EXPENSES ONLY.
  // This method is intentionally NOT called from extractAndCategorise for company-bucket
  // transactions. Bank feeds in QuickBooks Online are the source of truth; calling
  // pushExpense() for a company receipt that will also arrive via the bank feed would
  // create a duplicate Purchase object. Only call this for genuine cash transactions
  // (e.g. petty cash) that will never appear in the bank feed.
  // The reconcile READ path (QuickBooksAdapter.listRecentPurchases + GET /api/qbo/reconcile)
  // is the correct way to match captured receipts against QBO bank-feed purchases.
  private async pushToLedger(userId: string, txnId: string, parsed: Extracted): Promise<void> {
    const existing = await this.env.DB.prepare(
      `SELECT ledger_ref FROM transactions WHERE id = ?`,
    )
      .bind(txnId)
      .first<{ ledger_ref: string | null }>();
    if (existing?.ledger_ref) return; // already posted — never double-post

    const profile = await this.requireProfile(userId);
    const ledger = getLedger(this.env, profile.ledger_provider);
    const expense: LedgerExpense = {
      txnId,
      amountCents: parsed.amount_cents,
      gstCents: parsed.gst_cents,
      date: parsed.txn_date ?? new Date().toISOString(),
      merchant: parsed.merchant,
      atoLabel: parsed.ato_label,
    };

    try {
      const { ledgerRef } = await ledger.pushExpense(userId, expense);
      await this.env.DB.prepare(`UPDATE transactions SET ledger_ref = ? WHERE id = ?`)
        .bind(ledgerRef, txnId)
        .run();
      await this.audit(userId, "ledger_push", JSON.stringify({ txnId, ledgerRef }));
    } catch (err) {
      if (err instanceof LedgerNotConnectedError) {
        await this.notify(userId, "A company expense is ready but QuickBooks isn't connected yet.", txnId);
        await this.audit(userId, "ledger_skip_unconnected", JSON.stringify({ txnId }));
        return;
      }
      throw err;
    }
  }

  // ── helpers ─────────────────────────────────────────────────────────────────
  private async requireProfile(userId: string): Promise<Profile> {
    const p = await getProfile(this.env, userId);
    if (!p) throw new Error(`no profile for tenant ${userId}`);
    return p;
  }

  private async loadRulePack(ver: string): Promise<typeof DEFAULT_RULE_PACK> {
    const override = await this.env.RULES.get(`rulepack:${ver}`, "json");
    return (override as typeof DEFAULT_RULE_PACK | null) ?? DEFAULT_RULE_PACK;
  }

  private buildSystemPrompt(
    rulePack: typeof DEFAULT_RULE_PACK,
    profile: Profile,
    situation: Situation,
    bucketHint: string | null,
  ): string {
    const hint = bucketHint ? `\nThe user hinted this is bucket="${bucketHint}" — respect it unless the receipt clearly contradicts.` : "";
    // Optional merchant hints (e.g. SaaS/cloud) so well-known vendors categorise consistently.
    const hints = (rulePack as { merchant_hints?: { match: string; bucket: string; ato_label: string; note?: string }[] }).merchant_hints;
    const hintLines =
      Array.isArray(hints) && hints.length
        ? [
            "Merchant hints (apply when the merchant matches one of these, unless the receipt clearly says otherwise):",
            ...hints.map((h) => `  - [${h.match}] → bucket=${h.bucket}, ato_label=${h.ato_label}${h.note ? ` (${h.note})` : ""}`),
          ]
        : [];
    return [
      "You extract and categorise AU expense receipts. General information only — not tax advice.",
      `Tenant jurisdiction: ${profile.jurisdiction}. GST registered: ${profile.gst_registered ? "yes" : "no"}.`,
      `Rule pack ${rulePack.version}:`,
      ...Object.entries(rulePack.buckets).map(([k, v]) => `  - ${k}: ${v}`),
      rulePack.guidance,
      ...hintLines,
      renderSituation(situation),
      hint,
    ].join("\n");
  }

  private async markStatus(txnId: string, status: string): Promise<void> {
    await this.env.DB.prepare(`UPDATE transactions SET status = ? WHERE id = ?`).bind(status, txnId).run();
  }

  /**
   * Daily $-budget guard (measured spend, not a count). Returns false when today's spend has
   * hit MAX_DAILY_COST_CENTS — caller degrades to needs_review. Emits a one-time soft alert at
   * 80%. 0/unset budget = unlimited.
   */
  private async withinBudget(userId: string, txnId: string | null): Promise<boolean> {
    const budget = Number(this.env.MAX_DAILY_COST_CENTS ?? 0);
    if (budget <= 0) return true;
    const spent = await spentTodayCents(this.env, userId);
    if (spent >= budget) {
      if (txnId) {
        await this.markStatus(txnId, "needs_review");
        await this.notify(
          userId,
          `Daily AI budget reached ($${(budget / 100).toFixed(2)}). Saved for review — it'll process after the daily reset, or raise MAX_DAILY_COST_CENTS.`,
          txnId,
        );
      }
      return false;
    }
    if (spent >= budget * 0.8) {
      const day = new Date().toISOString().slice(0, 10);
      const flag = `costalert:${userId}:${day}`;
      if (!(await this.env.RULES.get(flag))) {
        await this.env.RULES.put(flag, "1", { expirationTtl: 60 * 60 * 26 });
        await this.notify(userId, `Heads up: today's AI spend is $${(spent / 100).toFixed(2)} of the $${(budget / 100).toFixed(2)} daily budget.`, null);
      }
    }
    return true;
  }

  private async promoteToEvalCase(userId: string, txnId: string): Promise<void> {
    // Promote to an eval case once a txn has accumulated repeated corrections.
    const count = await this.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM corrections WHERE user_id = ? AND txn_id = ?`,
    )
      .bind(userId, txnId)
      .first<{ n: number }>();
    if (!count || count.n < 2) return;

    const txn = await this.env.DB.prepare(
      `SELECT merchant, amount_cents, gst_cents, bucket, ato_label, property_id, rule_pack_ver
         FROM transactions JOIN profiles USING (user_id) WHERE transactions.id = ?`,
    )
      .bind(txnId)
      .first<{ merchant: string; amount_cents: number; gst_cents: number | null; bucket: string; ato_label: string; property_id: string | null; rule_pack_ver: string }>();
    if (!txn) return;

    await this.env.DB.prepare(
      `INSERT INTO eval_cases (id, user_id, input_json, expected_bucket, expected_label, rule_pack_ver)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        userId,
        JSON.stringify({ merchant: txn.merchant, amount_cents: txn.amount_cents, gst_cents: txn.gst_cents }),
        txn.bucket,
        txn.ato_label,
        txn.rule_pack_ver,
      )
      .run();

    await this.autoCreateUserRule(userId, txnId, txn);
  }

  /**
   * Self-improvement (Stage 6): once a merchant has been corrected repeatedly to a definite
   * bucket, turn that into a deterministic per-user rule so future receipts from the same
   * merchant are categorised at confidence 1.0 without a model call (and without the user
   * re-correcting). Guarded: skip if a rule already matches the merchant, or the bucket is
   * unknown. This is the moat — Quillo tunes to YOUR merchants over time.
   */
  private async autoCreateUserRule(
    userId: string,
    txnId: string,
    txn: { merchant: string; bucket: string; ato_label: string; property_id: string | null },
  ): Promise<void> {
    if (!txn.merchant || !txn.bucket || txn.bucket === "unknown") return;
    const profile = await this.requireProfile(userId);
    const situation = await getSituation(this.env, userId, profile);
    if (applyUserRules(txn.merchant, situation.rules)) return; // a rule already covers this merchant

    const ruleId = await addRule(this.env, userId, {
      pattern: txn.merchant,
      match_type: "merchant_contains",
      bucket: txn.bucket,
      ato_label: txn.ato_label,
      property_id: txn.property_id ?? undefined,
      priority: 100,
    });
    await this.audit(userId, "auto_rule", JSON.stringify({ merchant: txn.merchant, bucket: txn.bucket, ruleId }));
    await this.notify(
      userId,
      `Learned — I'll file "${txn.merchant}" as ${txn.bucket} (${txn.ato_label}) from now on. You can edit this rule in Settings.`,
      txnId,
    );
  }

  private async trace(userId: string, txnId: string, model: string, system: string, output: unknown): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO traces (id, user_id, txn_id, model, prompt_hash, input_json, output_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), userId, txnId, model, await sha256hex(system), null, JSON.stringify(output))
      .run();
  }

  private async notify(userId: string, body: string, txnId: string | null): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO notifications (id, user_id, body, txn_id) VALUES (?, ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), userId, body, txnId)
      .run();
    console.log(`[notify ${userId}] ${body}`);
  }

  /** Append-only, per-tenant hash chain. Serialised by this DO, so race-free. */
  private async audit(userId: string, event: string, detail: string): Promise<void> {
    const last = await this.env.DB.prepare(
      `SELECT this_hash FROM audit_log WHERE user_id = ? ORDER BY seq DESC LIMIT 1`,
    )
      .bind(userId)
      .first<{ this_hash: string }>();
    const prev = last?.this_hash ?? "";
    const createdAt = new Date().toISOString();
    const thisHash = await sha256hex(`${prev}|${userId}|${event}|${detail}|${createdAt}`);
    await this.env.DB.prepare(
      `INSERT INTO audit_log (user_id, event, detail, prev_hash, this_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(userId, event, detail, prev || null, thisHash, createdAt)
      .run();
  }
}
