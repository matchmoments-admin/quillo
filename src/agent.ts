import { Agent } from "agents";
import type { Env } from "./env";
import { getProfile, getSituation, renderSituation, type Profile, type Situation, type UserRule } from "./lib/db";
import { addRule, addAccount } from "./lib/situation-write";
import { QuickBooksAdapter } from "./ledger/qbo";
import { COUNTABLE } from "./lib/queries";
import { sha256hex, sha256hexBytes } from "./lib/base64";
import { getLLM, type LLM } from "./llm";
import { extractReceipt, extractReceipts, extractFromText, extractColumnMap, extractStatement, extractBatch, extractSituationDraft, classifyDocument, extractPayslip, extractAgentStatement, extractDepreciationSchedule, extractDividend, batchParams, parseBatchMessage, type Extracted, type ExtractedStatement, type SituationDraft } from "./extract";
import { fyForDate, buildReport } from "./lib/report";
import { fyLabel, fyBounds } from "./lib/ledger-totals";
import { assessReadiness, type FilingReadiness, type FilingReadinessSignals } from "./lib/readiness";
import { rollSchedule, balancingAdjustment, fyStartYearOf, type DepAsset } from "./lib/depreciation";
import { matchClaimRules, suggestionText, type ClaimRule, type ClaimContext } from "./lib/claimability";
import { parseCsv, applyColumnMap, lineFingerprint, deriveBalances, reconcileStatement, isLiabilityAccount, fuzzyMerchant, isTransferLike, type ColumnMap, type Reconciliation, type StatementLine } from "./lib/statements";
import { batchStatementStatus, isStaleBatch } from "./lib/batch";
import { cleanMerchant } from "./lib/bank-parsers";
import { pdfPageCount, splitPdf, normalizePdf } from "./lib/pdf";
import { getLedger, LedgerNotConnectedError, LedgerReauthError, type LedgerExpense } from "./ledger";
import { redact } from "./lib/redact";
import { toAud } from "./lib/fx";
import { spentTodayCents, recordUsage } from "./lib/usage";
import { parseTransactionAlert } from "./lib/bank-parsers";
import auV1RulePack from "./rulepacks/au-v1.json";
import { assertBucketKeys } from "./lib/taxonomy";
import { featureOn } from "./lib/features";

const CONFIDENCE_THRESHOLD = 0.85;
// Above this many to-categorise lines, route to the async Message Batches API (~50% cheaper);
// at or below, categorise synchronously so normal imports stay instant.
const BATCH_THRESHOLD = 60;

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
    const account = await this.env.DB.prepare(`SELECT source, type FROM accounts WHERE id = ? AND user_id = ?`)
      .bind(accountId, userId)
      .first<{ source: string; type: string }>();
    if (!account) throw new Error("account not found");
    if (account.source === "qbo_feed") {
      throw new Error("This account is reconciled from the QuickBooks feed — don't import statements for it (would double-count).");
    }
    const isLiability = isLiabilityAccount(account.type); // credit card / loan: debits increase the balance owed

    // APP-8 cross-border consent gate — parsing a statement sends the user's financial data to
    // the US inference API (a cross-border disclosure), so it needs recorded consent just like
    // every other anthropic model path. Bedrock/AU residency does not. Gate BEFORE storing the
    // file or any work (mirrors the receipt/inbox paths) so a refusal leaves nothing orphaned in
    // R2; the API layer maps consent_required to a 403.
    const profile = await this.requireProfile(userId);
    const provider = profile.inference_provider ?? this.env.DEFAULT_INFERENCE_PROVIDER;
    if (provider === "anthropic" && profile.consent_xborder !== 1) throw new Error("consent_required");

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

    const llm = await getLLM(this.env, profile, { userId });

    let lines: StatementLine[];
    let columnMap: ColumnMap | null = null;
    let recon: Reconciliation;

    if (format === "pdf") {
      // PDF: Claude transcribes the dated transaction table + the summary's opening/closing
      // balances. Multi-page statements (a credit card runs ~150 lines over 8 pages) are
      // extracted in PAGE CHUNKS up front so the per-call output never approaches max_tokens and
      // truncates to an empty table — a single whole-PDF shot over a long statement returned
      // nothing. The stitched result is reconciled end-to-end (liability-aware), so a dropped
      // page breaks the balance and is flagged.
      // Decrypt once up front (bank PDFs are encrypted) so both Claude and splitPdf see clean
      // bytes; the original encrypted file is what we retain in R2.
      const pdfBytes = await normalizePdf(bytes);
      const extractChunked = async (perChunk: number) => {
        const chunks = await splitPdf(pdfBytes, perChunk);
        // Extract chunks CONCURRENTLY (each is an independent sub-PDF) — running them in a
        // sequential loop made a multi-page statement do N back-to-back model calls (~90s with a
        // retry), long enough for Cloudflare's gateway to 502 the request. Promise.all preserves
        // order, so the opening/closing stitching and reconciliation are unchanged.
        const exts = await Promise.all(chunks.map((c) => extractStatement(llm, c, "application/pdf", { isLiability })));
        const all: StatementLine[] = [];
        let opening: number | null = null;
        let closing: number | null = null;
        for (const ext of exts) {
          all.push(...this.pdfLines(ext));
          if (opening == null && ext.opening_cents != null) opening = ext.opening_cents; // first page that carries it
          if (ext.closing_cents != null) closing = ext.closing_cents; // last page that carries it wins
        }
        return { ls: all, recon: reconcileStatement(all, opening, closing, isLiability) };
      };
      const extractWhole = async () => {
        const ext = await extractStatement(llm, pdfBytes, "application/pdf", { isLiability });
        const ls = this.pdfLines(ext);
        return { ls, recon: reconcileStatement(ls, ext.opening_cents, ext.closing_cents, isLiability) };
      };
      const pages = await pdfPageCount(pdfBytes);
      let a = pages > 2 ? await extractChunked(3) : await extractWhole();
      if (a.recon.available && !a.recon.ok) {
        // Didn't balance — retry with tighter chunks (re-reads pages, bounds output further).
        const b = await extractChunked(pages > 2 ? 2 : 3);
        if (b.recon.ok || (b.recon.available && Math.abs(b.recon.diff_cents) < Math.abs(a.recon.diff_cents))) a = b;
      }
      lines = a.ls;
      recon = a.recon;
    } else {
      const rows = parseCsv(new TextDecoder().decode(bytes));
      columnMap = await extractColumnMap(llm, rows);
      lines = applyColumnMap(rows, columnMap);
      const bal = deriveBalances(lines);
      recon = reconcileStatement(lines, bal?.opening_cents ?? null, bal?.closing_cents ?? null, isLiability);
    }

    // Zero lines means the extractor found no transaction table (unrecognised layout, scanned
    // image with no text, wrong file). Surface that as a clear "unreadable" error rather than
    // storing a phantom 0-row statement the user can pointlessly "confirm".
    if (lines.length === 0) {
      throw new Error(
        format === "pdf"
          ? "couldn't read any transactions from this PDF — it may be a scan/unusual layout; try a CSV export instead"
          : "couldn't read any transactions from this CSV — check it's a transaction export (not a summary)",
      );
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
  async confirmImport(userId: string, statementId: string, _columnMapOverride?: ColumnMap, force?: boolean, quiet?: boolean): Promise<{ imported: number; skipped: number }> {
    // LEFT JOIN (not INNER) so a statement whose account was later deleted is still found — the
    // null account_type just falls through to the asset reconcile sign via isLiabilityAccount.
    const stmt = await this.env.DB.prepare(
      `SELECT s.account_id, s.file_key, s.opening_cents, s.closing_cents, a.type AS account_type
         FROM statements s LEFT JOIN accounts a ON a.id = s.account_id AND a.user_id = s.user_id
        WHERE s.id = ? AND s.user_id = ?`,
    )
      .bind(statementId, userId)
      .first<{ account_id: string; file_key: string; opening_cents: number | null; closing_cents: number | null; account_type: string | null }>();
    if (!stmt) throw new Error("statement not found");

    // Use the normalised lines stored at parse time (so a PDF is never re-extracted).
    const sidecar = await this.env.RECEIPTS.get(`${stmt.file_key}.lines`);
    if (!sidecar) throw new Error("parsed lines missing — re-upload the statement");
    const lines = JSON.parse(await sidecar.text()) as StatementLine[];

    // Reconciliation gate: refuse to import a statement that doesn't balance unless the user
    // explicitly overrides after reviewing the flagged line(s). This is the proof of completeness.
    const recon = reconcileStatement(lines, stmt.opening_cents, stmt.closing_cents, isLiabilityAccount(stmt.account_type));
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
      // Deterministic categorisation (no model call): user rule first, then merchant hints (debits
      // only). Credits run user rules but skip expense hints, then fall to the LLM (which is told
      // the direction so it picks an income_* / refund bucket). Both directions now get a bucket.
      const cat = transfer
        ? null
        : this.deterministicCategorise(line.description, situation.rules, rulePack, { skipHints: line.direction === "credit" });
      const status = transfer ? "ignored" : cat ? "extracted" : "needs_review";
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
    // Any line a rule deterministically bucketed 'asset' becomes a depreciating asset now (the
    // LLM-categorised ones are linked when their batch applies — see categoriseStatement / poll).
    await this.linkAssetsForUser(userId);
    // Attach any existing receipts to the new lines (stops double-counting + donates GST).
    await this.matchReceiptsForUser(userId);

    if (!quiet) {
      await this.notify(
        userId,
        `Imported ${imported} transaction(s)${skipped ? ` (${skipped} already on file)` : ""}${cat.categorised ? `, categorised ${cat.categorised} with Claude` : ""}.`,
        null,
      );
    }
    return { imported, skipped };
  }

  /**
   * Bulk-confirm every statement still awaiting import (status='parsed'), or a given subset. Reuses
   * confirmImport per statement (quiet — one summary notification instead of N), isolating per-
   * statement failures: a statement that doesn't reconcile throws and is reported in `errors`, the
   * rest still import (so "import all reconciled" naturally skips the ones that don't balance).
   */
  async confirmImportBulk(
    userId: string,
    opts?: { statementIds?: string[]; force?: boolean },
  ): Promise<{ statements: number; imported: number; skipped: number; errors: { statementId: string; error: string }[] }> {
    let ids = opts?.statementIds ?? [];
    if (!ids.length) {
      const pending = await this.env.DB.prepare(
        `SELECT id FROM statements WHERE user_id = ? AND status = 'parsed' ORDER BY created_at`,
      )
        .bind(userId)
        .all<{ id: string }>();
      ids = (pending.results ?? []).map((r) => r.id);
    }
    let imported = 0;
    let skipped = 0;
    let statements = 0;
    const errors: { statementId: string; error: string }[] = [];
    for (const sid of ids) {
      try {
        const r = await this.confirmImport(userId, sid, undefined, opts?.force, true);
        imported += r.imported;
        skipped += r.skipped;
        statements++;
      } catch (e) {
        errors.push({ statementId: sid, error: (e as Error).message });
      }
    }
    await this.audit(userId, "statement_imported_bulk", JSON.stringify({ statements, imported, skipped, errors: errors.length }));
    await this.notify(
      userId,
      `Imported ${statements} statement(s): ${imported} transaction(s)${skipped ? `, ${skipped} already on file` : ""}${errors.length ? `. ${errors.length} couldn't import (e.g. didn't reconcile) — review them.` : "."}`,
      null,
    );
    return { statements, imported, skipped, errors };
  }

  /**
   * Batch-categorise statement bank lines the deterministic pass left as needs_review.
   * One Claude call per ~40 lines (not per line); budget-aware (stops at MAX_DAILY_COST_CENTS
   * via withinBudget) — over budget the remainder stays needs_review. Bulk jobs go async (Batch API).
   */
  async categoriseStatement(userId: string, statementId: string): Promise<{ categorised: number }> {
    const rows = await this.env.DB.prepare(
      `SELECT id, merchant, amount_cents, txn_date, direction FROM transactions
        WHERE user_id = ? AND statement_id = ? AND kind = 'bank_line' AND status = 'needs_review'`,
    )
      .bind(userId, statementId)
      .all<{ id: string; merchant: string | null; amount_cents: number | null; txn_date: string | null; direction: string | null }>();
    const items = rows.results ?? [];
    if (!items.length) return { categorised: 0 };

    const profile = await this.requireProfile(userId);
    const provider = profile.inference_provider ?? this.env.DEFAULT_INFERENCE_PROVIDER;
    if (provider === "anthropic" && profile.consent_xborder !== 1) return { categorised: 0 }; // consent gate
    const rulePack = await this.loadRulePack(profile.rule_pack_ver);
    const situation = await getSituation(this.env, userId, profile);
    const system = this.buildSystemPrompt(rulePack, profile, situation, null);
    const llm = await getLLM(this.env, profile, { userId });

    // Bulk → Message Batches API (async, ~50% cheaper). Small imports stay synchronous (instant).
    if (items.length > BATCH_THRESHOLD) {
      await this.submitBatchCategorisation(userId, statementId, items, system, llm);
      return { categorised: 0 };
    }

    let categorised = 0;
    for (let i = 0; i < items.length; i += 40) {
      const chunk = items.slice(i, i + 40);
      // Stop categorising once the daily $ budget is hit; the rest stays needs_review.
      if (!(await this.withinBudget(userId, null))) break;
      const results = await extractBatch(
        llm,
        system,
        chunk.map((c) => ({ merchant: c.merchant ?? "", amount_cents: c.amount_cents ?? 0, date: c.txn_date, direction: c.direction as "debit" | "credit" | null })),
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

  /**
   * Backfill: re-categorise bank lines imported under OLDER rules so the new buckets (income_*,
   * refund, asset) apply. Only the clearly-mishandled rows are re-queued — credits stranded with
   * no bucket (they were invisible) and 'unknown' lines — then the normal per-statement pipeline
   * runs (sync or async batch) and capital purchases link to assets. Already-categorised expense
   * lines (company/payg/property_*) are left untouched: no silent re-judgement of correct rows.
   * Idempotent enough to re-run (it just re-queues anything still credit-null / unknown).
   */
  async recategorise(userId: string): Promise<{ requeued: number; statements: number }> {
    const requeue = await this.env.DB.prepare(
      `UPDATE transactions SET status = 'needs_review'
        WHERE user_id = ? AND kind = 'bank_line'
          AND status NOT IN ('ignored','duplicate','matched_receipt')
          AND ((direction = 'credit' AND bucket IS NULL) OR bucket = 'unknown')`,
    )
      .bind(userId)
      .run();
    const requeued = requeue.meta?.changes ?? 0;
    if (!requeued) {
      // Nothing mishandled to re-queue — record it so a no-op run is observable, not silent
      // (the v1 backfill silently matched 0 rows because it ran against the wrong tenant id).
      await this.audit(userId, "recategorise", JSON.stringify({ requeued: 0, statements: 0 }));
      return { requeued: 0, statements: 0 };
    }

    const stmts = await this.env.DB.prepare(
      `SELECT DISTINCT statement_id FROM transactions
        WHERE user_id = ? AND kind = 'bank_line' AND status = 'needs_review' AND statement_id IS NOT NULL`,
    )
      .bind(userId)
      .all<{ statement_id: string }>();
    let count = 0;
    for (const s of stmts.results ?? []) {
      await this.categoriseStatement(userId, s.statement_id); // sync small / async batch large
      count++;
    }
    await this.linkAssetsForUser(userId); // link any capital purchases the sync path just bucketed
    await this.audit(userId, "recategorise", JSON.stringify({ requeued, statements: count }));
    return { requeued, statements: count };
  }

  /**
   * Submit a large categorisation job to the Anthropic Message Batches API (~50% cheaper,
   * async). One request per ~40-line chunk; custom_id = the chunk index, with the ordered
   * line ids stored in chunk_map so results can be applied. Polled by the cron / on demand.
   */
  private async submitBatchCategorisation(
    userId: string,
    statementId: string,
    items: { id: string; merchant: string | null; amount_cents: number | null; txn_date: string | null; direction?: string | null }[],
    system: string,
    llm: LLM,
  ): Promise<void> {
    const chunkMap: Record<string, string[]> = {};
    const requests: { custom_id: string; params: ReturnType<typeof batchParams> }[] = [];
    let idx = 0;
    for (let i = 0; i < items.length; i += 40, idx++) {
      const chunk = items.slice(i, i + 40);
      chunkMap[String(idx)] = chunk.map((c) => c.id);
      requests.push({
        custom_id: String(idx),
        params: batchParams(llm.modelId, system, chunk.map((c) => ({ merchant: c.merchant ?? "", amount_cents: c.amount_cents ?? 0, date: c.txn_date, direction: c.direction as "debit" | "credit" | null }))),
      });
    }
    const batch = await llm.client.messages.batches.create({ requests });
    await this.env.DB.prepare(
      `INSERT INTO batch_jobs (id, user_id, statement_id, batch_id, status, chunk_map) VALUES (?, ?, ?, ?, 'submitted', ?)`,
    )
      .bind(crypto.randomUUID(), userId, statementId, batch.id, JSON.stringify(chunkMap))
      .run();
    await this.env.DB.prepare(`UPDATE statements SET status='categorising' WHERE id=?`).bind(statementId).run();
    await this.audit(userId, "batch_submitted", JSON.stringify({ statementId, batchId: batch.id, chunks: requests.length }));
    await this.notify(userId, `Categorising ${items.length} transactions in the background (cheaper batch mode) — they'll fill in shortly.`, null);
  }

  /** Poll this user's submitted batch jobs; apply finished ones (metered at the half rate). */
  async pollBatchJobs(userId: string): Promise<{ applied: number }> {
    const jobs = await this.env.DB.prepare(
      `SELECT id, statement_id, batch_id, chunk_map, created_at FROM batch_jobs WHERE user_id = ? AND status = 'submitted'`,
    )
      .bind(userId)
      .all<{ id: string; statement_id: string; batch_id: string; chunk_map: string; created_at: string }>();
    if (!(jobs.results ?? []).length) return { applied: 0 };

    const profile = await this.requireProfile(userId);
    const llm = await getLLM(this.env, profile, { userId });
    let appliedTotal = 0;
    const failJob = async (job: { id: string; statement_id: string }, why: string) => {
      await this.env.DB.prepare(`UPDATE batch_jobs SET status='failed' WHERE id=?`).bind(job.id).run();
      await this.env.DB.prepare(`UPDATE statements SET status='failed' WHERE id=?`).bind(job.statement_id).run();
      await this.audit(userId, "batch_failed", JSON.stringify({ jobId: job.id, why }));
      await this.notify(userId, `Background categorisation didn't finish (${why}). The lines are imported — review/categorise them manually.`, null);
    };

    for (const job of jobs.results ?? []) {
      // Stale guard: never leave a 'submitted' job zombied — fail it after 24h.
      if (isStaleBatch(job.created_at, Date.now())) {
        await failJob(job, "timed out after 24h");
        continue;
      }
      try {
        const batch = await llm.client.messages.batches.retrieve(job.batch_id);
        if (batch.processing_status !== "ended") continue; // still in progress / canceling
        const chunkMap = JSON.parse(job.chunk_map) as Record<string, string[]>;
        let applied = 0;
        let errored = 0;
        const stream = await llm.client.messages.batches.results(job.batch_id);
        for await (const res of stream) {
          if (res.result.type !== "succeeded") {
            errored++;
            continue;
          }
          const msg = res.result.message;
          if (msg.usage) await recordUsage(this.env, userId, "statement_batch", llm.modelId, msg.usage, 0.5);
          const lineIds = chunkMap[res.custom_id] ?? [];
          const cats = parseBatchMessage(msg);
          const updates: D1PreparedStatement[] = [];
          for (let j = 0; j < lineIds.length; j++) {
            const it = cats[j];
            if (!it) continue;
            updates.push(
              this.env.DB.prepare(
                // only touch still-pending lines (a receipt-matched line is already categorised)
                `UPDATE transactions SET status='extracted', bucket=?, ato_label=?, confidence=?, reasoning=? WHERE id=? AND user_id=? AND status='needs_review'`,
              ).bind(it.bucket, it.ato_label, it.confidence, it.reasoning, lineIds[j], userId),
            );
            applied++;
          }
          for (let k = 0; k < updates.length; k += 50) await this.env.DB.batch(updates.slice(k, k + 50));
        }
        await this.env.DB.prepare(`UPDATE batch_jobs SET status='applied' WHERE id=?`).bind(job.id).run();
        // If every chunk errored and nothing applied, the import succeeded but categorisation
        // failed — mark the statement so the lines don't look stuck 'categorising'.
        await this.env.DB.prepare(`UPDATE statements SET status=? WHERE id=?`)
          .bind(batchStatementStatus(applied, errored), job.statement_id)
          .run();
        await this.audit(userId, "batch_applied", JSON.stringify({ batchId: job.batch_id, applied, errored }));
        // Async-categorised capital purchases become depreciating assets now (their bucket only
        // just landed). Idempotent — links only newly-bucketed 'asset' lines.
        await this.linkAssetsForUser(userId);
        await this.notify(
          userId,
          applied > 0
            ? `Finished categorising ${applied} transactions from your statement.`
            : `Background categorisation failed for your statement — the lines are imported; review them manually.`,
          null,
        );
        appliedTotal += applied;
      } catch (e) {
        // Transient error: leave 'submitted' for the next poll; the 24h stale guard is the backstop.
        await this.audit(userId, "batch_poll_error", JSON.stringify({ jobId: job.id, error: (e as Error).message }));
      }
    }
    return { applied: appliedTotal };
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
    return (ext.lines ?? []).map((l) => ({
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
    opts: { skipHints?: boolean } = {},
  ): { bucket: string; ato_label: string; confidence: number } | null {
    const rule = applyUserRules(merchant, rules);
    if (rule) return { bucket: rule.bucket, ato_label: rule.ato_label, confidence: 1 };
    // Merchant hints are EXPENSE-oriented (SaaS, cloud, hardware) — never apply them to a credit
    // line or a refund from a SaaS vendor would be mis-bucketed as a company expense. Credits get
    // only user rules deterministically; the LLM (direction-aware) handles the rest.
    if (opts.skipHints) return null;
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

  /**
   * Register the QuickBooks Bank/Credit-Card accounts as Quillo accounts with
   * source='qbo_feed'. This is what ACTIVATES the feed-vs-statement dedup guard: a qbo_feed
   * account refuses statement imports and is excluded from reconcile, so a real account is
   * counted through exactly one pipe (the QBO feed) — never twice.
   */
  async syncQboAccounts(userId: string): Promise<{ synced: number }> {
    const accounts = await new QuickBooksAdapter(this.env).listBankAccounts(userId);
    let synced = 0;
    for (const a of accounts) {
      const exists = await this.env.DB.prepare(`SELECT id FROM accounts WHERE user_id = ? AND qbo_account_id = ?`)
        .bind(userId, a.Id)
        .first<{ id: string }>();
      if (exists) continue;
      await addAccount(this.env, userId, {
        name: a.Name,
        institution: "QuickBooks",
        type: a.AccountType === "Credit Card" ? "credit_card" : "transaction",
        source: "qbo_feed",
        qbo_account_id: a.Id,
      });
      synced++;
    }
    await this.audit(userId, "qbo_accounts_synced", JSON.stringify({ synced }));
    return { synced };
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

    // Claimability brain (rules-first): surface any GENERAL-INFO claim guidance for this item.
    // Best-effort — a claimability failure (e.g. 0010 not yet applied) must never fail the upload,
    // which has already been persisted, notified and matched above.
    try {
      const propStatus = final.property_id ? situation.properties.find((p) => p.id === final.property_id)?.status ?? null : null;
      const occupations = situation.persons.map((p) => p.occupation).filter((o): o is string => !!o);
      await this.suggestClaims(
        userId,
        { bucket: final.bucket, merchant: final.merchant, property_status: propStatus, occupations, entity_kinds: situation.entities.map((e) => e.kind) },
        { txnId, estimatedDeductionCents: fx.amount_aud_cents ?? final.amount_cents },
      );
    } catch (e) {
      await this.audit(userId, "claims_error", JSON.stringify({ txnId, error: (e as Error).message }));
    }
  }

  // ── INCOME: first-class income record (modelled, not inferred from credits) ──
  /**
   * Persist one income record. Income is modelled because credits are unreliable (agent
   * statements are net; salary is gross-with-withholding). Converts the gross to AUD for
   * reporting (the seam reads amount_aud_cents). Returns the new income id.
   */
  async recordIncome(
    userId: string,
    inc: {
      person_id?: string | null;
      entity_id?: string | null;
      property_id?: string | null;
      income_type: string;
      ato_label?: string | null;
      fy?: string | null;
      gross_cents: number;
      net_cents?: number | null;
      withholding_cents?: number | null;
      franking_credit_cents?: number | null;
      foreign_tax_paid_cents?: number | null;
      currency?: string | null;
      source_doc_id?: string | null;
      txn_date?: string | null;
      detail_json?: string | null;
      needs_review?: number;
    },
  ): Promise<string> {
    const id = crypto.randomUUID();
    const currency = (inc.currency ?? "AUD").trim().toUpperCase();
    const fy = inc.fy ?? fyForDate(inc.txn_date ?? null) ?? this.currentFyLabel();
    const fx = await toAud(this.env, inc.gross_cents, currency, inc.txn_date ?? null);
    // Convert the non-gross money columns to AUD with the SAME rate as gross, so the reporting
    // seam (which sums these columns directly) never mixes currencies. AUD income → rate 1 (no-op).
    // Franking credits are an AU imputation amount, always AUD, so they're never converted.
    const rate = currency === "AUD" ? 1 : fx.fx_rate ?? 1;
    const toAudCents = (c: number | null | undefined): number | null => (c == null ? null : Math.round(c * rate));
    await this.env.DB.prepare(
      `INSERT INTO income (id, user_id, person_id, entity_id, property_id, income_type, ato_label, fy,
         gross_cents, net_cents, withholding_cents, franking_credit_cents, foreign_tax_paid_cents,
         currency, amount_aud_cents, fx_rate, source_doc_id, txn_date, detail_json, needs_review)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id, userId, inc.person_id ?? `person_self_${userId}`, inc.entity_id ?? null, inc.property_id ?? null,
        inc.income_type, inc.ato_label ?? null, fy, inc.gross_cents, toAudCents(inc.net_cents),
        toAudCents(inc.withholding_cents) ?? 0, inc.franking_credit_cents ?? 0, toAudCents(inc.foreign_tax_paid_cents) ?? 0,
        currency, fx.amount_aud_cents, fx.fx_rate, inc.source_doc_id ?? null, inc.txn_date ?? null,
        inc.detail_json ?? null, inc.needs_review ?? 0,
      )
      .run();
    await this.audit(userId, "income_recorded", JSON.stringify({ id, type: inc.income_type, gross: inc.gross_cents, fy }));
    return id;
  }

  /**
   * Income de-dup: surface likely duplicate pairs (a credit bank-line that looks like a documented
   * income row) and the already-confirmed links. SUGGEST ONLY — a credit is matched to an income
   * row only when the user confirms (linkIncome), because a wrong auto-match would silently corrupt
   * income. A bank salary credit is usually NET pay, so a credit is offered as a match when its
   * amount is within tolerance of EITHER the income row's net or gross, in the same FY.
   */
  async incomeMatches(userId: string): Promise<{
    suggestions: { txn_id: string; merchant: string | null; txn_amount_cents: number; txn_date: string | null; bucket: string | null; income_id: string; income_type: string; income_gross_cents: number; income_net_cents: number | null; income_date: string | null }[];
    matched: { txn_id: string; merchant: string | null; txn_amount_cents: number; txn_date: string | null; income_id: string; income_type: string; income_gross_cents: number }[];
  }> {
    const credits = await this.env.DB.prepare(
      `SELECT id, merchant, COALESCE(amount_aud_cents, amount_cents) AS amt, txn_date, bucket, matched_income_id
         FROM transactions
        WHERE user_id = ? AND kind = 'bank_line' AND direction = 'credit'
          AND bucket IN ('income_business','income_property','income_personal')
          AND status NOT IN ('duplicate','ignored')`,
    )
      .bind(userId)
      .all<{ id: string; merchant: string | null; amt: number | null; txn_date: string | null; bucket: string | null; matched_income_id: string | null }>();
    const incomes = await this.env.DB.prepare(
      `SELECT id, income_type, gross_cents, net_cents, COALESCE(amount_aud_cents, gross_cents) AS gross_aud, txn_date, fy
         FROM income WHERE user_id = ?`,
    )
      .bind(userId)
      .all<{ id: string; income_type: string; gross_cents: number; net_cents: number | null; gross_aud: number; txn_date: string | null; fy: string }>();
    const incomeRows = incomes.results ?? [];
    const incomeById = new Map(incomeRows.map((r) => [r.id, r]));
    // An income row already claimed by another credit is not offered again (one income → one credit),
    // so two near-identical fortnightly credits can't both link to one monthly payslip and under-count.
    const claimed = new Set((credits.results ?? []).map((c) => c.matched_income_id).filter(Boolean) as string[]);

    const within = (a: number, b: number): boolean => Math.abs(a - b) <= Math.max(100, Math.round(b * 0.01)); // ±$1 or ±1%
    const daysApart = (a: string | null, b: string | null): number => {
      if (!a || !b) return 9999;
      return Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);
    };

    const suggestions: Awaited<ReturnType<TaxAgent["incomeMatches"]>>["suggestions"] = [];
    const matched: Awaited<ReturnType<TaxAgent["incomeMatches"]>>["matched"] = [];
    for (const c of credits.results ?? []) {
      const amt = c.amt ?? 0;
      if (c.matched_income_id) {
        const inc = incomeById.get(c.matched_income_id);
        if (inc) matched.push({ txn_id: c.id, merchant: c.merchant, txn_amount_cents: amt, txn_date: c.txn_date, income_id: inc.id, income_type: inc.income_type, income_gross_cents: inc.gross_cents });
        continue;
      }
      // Best candidate: same FY, amount matches net or gross, closest date wins. The FY gate keeps
      // a pair from spanning two financial years (the income row counts in its FY; excluding the
      // credit by its own FY near 30 Jun would otherwise drop it from one year entirely).
      const creditFy = fyForDate(c.txn_date);
      let best: { inc: (typeof incomeRows)[number]; days: number } | null = null;
      for (const inc of incomeRows) {
        if (claimed.has(inc.id)) continue; // already linked to another credit
        if (!creditFy || creditFy !== inc.fy) continue; // same financial year only
        const amountMatch = within(amt, inc.gross_aud) || (inc.net_cents != null && within(amt, inc.net_cents));
        if (!amountMatch) continue;
        const days = daysApart(c.txn_date, inc.txn_date);
        if (days > 14) continue; // a pay credit lands within a fortnight of the documented date
        if (!best || days < best.days) best = { inc, days };
      }
      if (best) {
        suggestions.push({ txn_id: c.id, merchant: c.merchant, txn_amount_cents: amt, txn_date: c.txn_date, bucket: c.bucket, income_id: best.inc.id, income_type: best.inc.income_type, income_gross_cents: best.inc.gross_cents, income_net_cents: best.inc.net_cents, income_date: best.inc.txn_date });
      }
    }
    return { suggestions, matched };
  }

  /** Confirm a credit bank-line duplicates a documented income row → count the pair once. Audited. */
  async linkIncome(userId: string, txnId: string, incomeId: string): Promise<void> {
    const inc = await this.env.DB.prepare(`SELECT id, fy FROM income WHERE id = ? AND user_id = ?`).bind(incomeId, userId).first<{ id: string; fy: string }>();
    if (!inc) throw new Error("income row not found");
    // One income row → one credit (else two credits both excluded but one row counted = under-count).
    const taken = await this.env.DB.prepare(
      `SELECT id FROM transactions WHERE user_id = ? AND matched_income_id = ? AND id != ?`,
    )
      .bind(userId, incomeId, txnId)
      .first<{ id: string }>();
    if (taken) throw new Error("that income row is already linked to another transaction");
    // Scope to an income-bucket credit in the SAME financial year as the income row.
    const txn = await this.env.DB.prepare(
      `SELECT txn_date FROM transactions WHERE id = ? AND user_id = ? AND kind = 'bank_line' AND direction = 'credit'
         AND bucket IN ('income_business','income_property','income_personal')`,
    )
      .bind(txnId, userId)
      .first<{ txn_date: string | null }>();
    if (!txn) throw new Error("income credit not found");
    if (fyForDate(txn.txn_date) !== inc.fy) throw new Error("the credit and the income row are in different financial years");
    await this.env.DB.prepare(`UPDATE transactions SET matched_income_id = ? WHERE id = ? AND user_id = ?`)
      .bind(incomeId, txnId, userId)
      .run();
    await this.audit(userId, "income_linked", JSON.stringify({ txnId, incomeId }));
  }

  /** Undo an income match (the credit counts on its own again). Audited. */
  async unlinkIncome(userId: string, txnId: string): Promise<void> {
    await this.env.DB.prepare(`UPDATE transactions SET matched_income_id = NULL WHERE id = ? AND user_id = ?`)
      .bind(txnId, userId)
      .run();
    await this.audit(userId, "income_unlinked", JSON.stringify({ txnId }));
  }

  // ── Year-end deductibility review ───────────────────────────────────────────
  // During the year we capture + bucket spend but DON'T judge deductibility (0011). The review
  // resolves it once, per (bucket, ato_label), with apportionment — writing the resolved set that
  // feeds resolved_deductible_cents in the report. GENERAL INFO ONLY — not tax advice.

  /** Resolved deductibility states (0011). 'undetermined' is the captured default; the rest are written by review. */
  private static readonly DEDUCTIBILITY_STATES = new Set([
    "undetermined", "likely_deductible", "likely_not", "needs_apportionment", "confirmed_deductible", "confirmed_not",
  ]);

  private fyBoundsFor(fy?: string): { fy: string; start: string; end: string } {
    const label = fy ?? this.currentFyLabel();
    const sy = Number(label.slice(0, 4));
    return { fy: label, start: `${sy}-07-01`, end: `${sy + 1}-06-30` };
  }

  /**
   * Year-end review summary: countable deductible-context spend for the FY, grouped by bucket +
   * ato_label + current deductibility, with the captured total and the would-be resolved amount.
   * Drives the Review UI's per-label resolution. Read-only.
   */
  async reviewSummary(
    userId: string,
    fy?: string,
  ): Promise<{ fy: string; rows: { bucket: string; ato_label: string | null; deductibility: string; n: number; total_cents: number; resolved_cents: number }[] }> {
    const { fy: label, start, end } = this.fyBoundsFor(fy);
    const rows = await this.env.DB.prepare(
      `SELECT bucket, ato_label, COALESCE(deductibility,'undetermined') AS deductibility,
              COUNT(*) AS n,
              COALESCE(SUM(COALESCE(amount_aud_cents, amount_cents)),0) AS total_cents,
              COALESCE(SUM(COALESCE(deductible_amount_cents, amount_aud_cents, amount_cents)),0) AS resolved_cents
         FROM transactions
        WHERE user_id = ? AND txn_date >= ? AND txn_date <= ? AND ${COUNTABLE}
          AND bucket IN ('payg','company','property_rented','property_vacant')
        GROUP BY bucket, ato_label, deductibility
        ORDER BY bucket, total_cents DESC`,
    )
      .bind(userId, start, end)
      .all<{ bucket: string; ato_label: string | null; deductibility: string; n: number; total_cents: number; resolved_cents: number }>();
    return { fy: label, rows: rows.results ?? [] };
  }

  /** Resolve deductibility for specific transactions (with an optional apportioned amount). Audited. */
  async setDeductibility(userId: string, txnIds: string[], state: string, deductibleAmountCents?: number | null): Promise<{ updated: number }> {
    if (!TaxAgent.DEDUCTIBILITY_STATES.has(state)) throw new Error(`invalid deductibility state: ${state}`);
    if (!txnIds.length) return { updated: 0 };
    const amt = deductibleAmountCents ?? null;
    const stmts = txnIds.map((id) =>
      this.env.DB.prepare(`UPDATE transactions SET deductibility = ?, deductible_amount_cents = ? WHERE id = ? AND user_id = ?`)
        .bind(state, amt, id, userId),
    );
    let updated = 0;
    for (let i = 0; i < stmts.length; i += 50) {
      const res = await this.env.DB.batch(stmts.slice(i, i + 50));
      updated += res.reduce((s, r) => s + (r.meta?.changes ?? 0), 0);
    }
    await this.audit(userId, "deductibility_resolved", JSON.stringify({ txnIds: txnIds.length, state, deductibleAmountCents: amt }));
    return { updated };
  }

  /**
   * Bulk-resolve every countable txn in a (bucket, ato_label) for the FY. With businessUsePct the
   * apportioned claimable amount is computed per row (amount × pct%); without it the amount stays
   * NULL (the report falls back to the full amount for a 100%-deductible label). Audited.
   */
  async resolveByLabel(
    userId: string,
    opts: { fy?: string; bucket: string; atoLabel?: string | null; state: string; businessUsePct?: number | null },
  ): Promise<{ updated: number }> {
    if (!TaxAgent.DEDUCTIBILITY_STATES.has(opts.state)) throw new Error(`invalid deductibility state: ${opts.state}`);
    const { start, end } = this.fyBoundsFor(opts.fy);
    const pct = opts.businessUsePct == null ? null : Math.max(0, Math.min(100, opts.businessUsePct));
    const res = await this.env.DB.prepare(
      `UPDATE transactions
          SET deductibility = ?,
              deductible_amount_cents = CASE WHEN ? IS NULL THEN NULL
                ELSE CAST(ROUND(COALESCE(amount_aud_cents, amount_cents) * ? / 100.0) AS INTEGER) END
        WHERE user_id = ? AND txn_date >= ? AND txn_date <= ? AND ${COUNTABLE}
          AND bucket = ? AND COALESCE(ato_label,'') = COALESCE(?,'')`,
    )
      .bind(opts.state, pct, pct, userId, start, end, opts.bucket, opts.atoLabel ?? null)
      .run();
    const updated = res.meta?.changes ?? 0;
    await this.audit(userId, "deductibility_resolved", JSON.stringify({ bucket: opts.bucket, atoLabel: opts.atoLabel ?? null, state: opts.state, businessUsePct: pct, updated }));
    return { updated };
  }

  /** Current AU FY label, e.g. '2025-26' (Jul–Jun). */
  private currentFyLabel(): string {
    const now = new Date();
    const sy = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
    return fyLabel(sy);
  }

  /** Write a row into the canonical documents registry. */
  private async fileDocument(
    userId: string,
    doc: {
      id: string;
      doc_type: string;
      r2_key: string;
      image_hash?: string | null;
      person_id?: string | null;
      property_id?: string | null;
      entity_id?: string | null;
      fy?: string | null;
      issuer?: string | null;
      doc_date?: string | null;
      extracted_json?: string | null;
      classification_confidence?: number | null;
      needs_review?: number;
    },
  ): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO documents (id, user_id, person_id, doc_type, fy, property_id, entity_id, r2_key,
         image_hash, issuer, doc_date, extracted_json, classification_confidence, needs_review)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        doc.id, userId, doc.person_id ?? null, doc.doc_type, doc.fy ?? null, doc.property_id ?? null,
        doc.entity_id ?? null, doc.r2_key, doc.image_hash ?? null, doc.issuer ?? null, doc.doc_date ?? null,
        doc.extracted_json ?? null, doc.classification_confidence ?? null, doc.needs_review ?? 0,
      )
      .run();
  }

  /** Best-effort property resolution from free-text hint (address/label substring match). */
  // Canonicalise an address into comparable tokens: lowercase, drop punctuation, fold common
  // street-type abbreviations (Avenue↔Ave), and drop state/country noise. This is what lets a
  // doc's "104 Womerah Avenue, Darlinghurst, NSW 2010" match a stored "104 Womerah Ave Darlinghurst
  // 2010" — naive substring matching missed it on "Avenue"/commas/"NSW".
  private static readonly STREET_TYPES: Record<string, string> = {
    avenue: "ave", ave: "ave", street: "st", st: "st", road: "rd", rd: "rd",
    drive: "dr", dr: "dr", court: "ct", ct: "ct", place: "pl", pl: "pl",
    lane: "ln", ln: "ln", parade: "pde", pde: "pde", crescent: "cres", cres: "cres",
    boulevard: "blvd", blvd: "blvd", terrace: "tce", tce: "tce", highway: "hwy", hwy: "hwy",
    close: "cl", cl: "cl", circuit: "cct", cct: "cct",
  };
  private static readonly STREET_TYPE_VALUES = new Set(Object.values(TaxAgent.STREET_TYPES));
  private static readonly ADDRESS_NOISE = new Set(["nsw", "vic", "qld", "sa", "wa", "tas", "act", "nt", "australia", "unit", "apt"]);

  private normalizeAddress(s: string): string[] {
    return s
      .toLowerCase()
      .replace(/[.,/#-]/g, " ")
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => TaxAgent.STREET_TYPES[t] ?? t)
      .filter((t) => !TaxAgent.ADDRESS_NOISE.has(t));
  }

  // The street/unit number (e.g. "104", "104a", "2/15"→"2") — the first numeric token that ISN'T a
  // 4-digit AU postcode. Skipping the postcode matters: a hint that omits the street number must not
  // fall back to comparing postcodes as if they were street numbers.
  private static streetNumber(tokens: string[]): string | null {
    return tokens.find((t) => /\d/.test(t) && !/^\d{4}$/.test(t)) ?? null;
  }
  // The "name" words — street name + suburb (not numeric, not a generic street-type like ave/st/rd).
  // These are what actually disambiguate a property; sharing only a street-type or postcode is noise.
  private static nameWords(tokens: string[]): Set<string> {
    return new Set(tokens.filter((t) => !/\d/.test(t) && !TaxAgent.STREET_TYPE_VALUES.has(t)));
  }

  /**
   * Resolve a free-text property hint (as printed on a doc) to one of the user's property rows.
   * Token-overlap, not substring: tolerant of "Avenue"/"Ave", commas and "NSW". A match requires
   * (a) at least one shared NAME word (street/suburb — not a generic "St" or a shared postcode) and
   * (b) when both sides carry a street number, an EXACT number match (so 104 never collides with
   * 104A or 34A). Score favours a number match; a tie at the top returns null so the income row
   * flags for a manual set rather than silently mis-attributing rent/expenses to the wrong property.
   */
  private async resolvePropertyByHint(userId: string, hint: string | null): Promise<string | null> {
    if (!hint) return null;
    const hintTokens = this.normalizeAddress(hint);
    if (!hintTokens.length) return null;
    const hintNumber = TaxAgent.streetNumber(hintTokens);
    const hintNames = TaxAgent.nameWords(hintTokens);
    if (!hintNames.size) return null; // nothing but numbers/street-types — too weak to resolve

    const rows = await this.env.DB.prepare(`SELECT id, label, address FROM properties WHERE user_id = ?`)
      .bind(userId)
      .all<{ id: string; label: string | null; address: string | null }>();

    const scored: { id: string; score: number }[] = [];
    for (const p of rows.results ?? []) {
      const pTokens = this.normalizeAddress(`${p.label ?? ""} ${p.address ?? ""}`);
      if (!pTokens.length) continue;
      const pNumber = TaxAgent.streetNumber(pTokens);
      if (hintNumber && pNumber && hintNumber !== pNumber) continue; // 104 ≠ 104a ≠ 34a — never match across numbers
      const pNames = TaxAgent.nameWords(pTokens);
      let sharedNames = 0;
      for (const t of hintNames) if (pNames.has(t)) sharedNames++;
      if (sharedNames < 1) continue; // must agree on a real street/suburb word, not just "St"/postcode
      const numberMatch = hintNumber && pNumber && hintNumber === pNumber ? 2 : 0;
      scored.push({ id: p.id, score: sharedNames + numberMatch });
    }
    scored.sort((a, b) => b.score - a.score);
    const [best, runnerUp] = scored;
    if (!best) return null;
    if (runnerUp && best.score === runnerUp.score) return null; // ambiguous → flag, don't guess
    return best.id;
  }

  // ── SMART INBOX: capture → consent → CLASSIFY → dispatch ────────────────────
  /**
   * The Smart-Inbox front door for AMBIGUOUS uploads (email-in, the documents shelf). Cost-aware:
   * contextual "snap a receipt" uploads keep using ingest() (hint=receipt, no classify call), so
   * the common path stays a single model call. Here we capture (model-free), enforce the APP-8
   * consent gate BEFORE any model call (classification is itself a cross-border disclosure), then
   * classify and dispatch to the right typed extractor. Low-confidence is held in needs_review.
   */
  async classifyAndRoute(userId: string, source: string, bytes: ArrayBuffer, mime: string): Promise<{ docId: string; doc_type: string; routed: boolean }> {
    const docId = crypto.randomUUID();
    const r2key = `${userId}/docs/${docId}`;
    await this.env.RECEIPTS.put(r2key, bytes, { httpMetadata: { contentType: mime } });
    const imageHash = await sha256hexBytes(bytes);

    // Exact-duplicate guard: identical bytes ⇒ same document. Without this, a re-sent email
    // (reply-all, re-delivery) would double-count income/expenses AND re-bill the model call —
    // the old ingest() path deduped on image_hash and this path must too.
    const dupDoc = await this.env.DB.prepare(`SELECT id, doc_type FROM documents WHERE user_id = ? AND image_hash = ? LIMIT 1`)
      .bind(userId, imageHash)
      .first<{ id: string; doc_type: string }>();
    if (dupDoc) {
      await this.audit(userId, "classify_duplicate", JSON.stringify({ duplicateOf: dupDoc.id }));
      await this.notify(userId, `Looks like a document you already uploaded (${dupDoc.doc_type}) — skipped re-reading it.`, null);
      return { docId: dupDoc.id, doc_type: dupDoc.doc_type, routed: false };
    }

    const profile = await this.requireProfile(userId);
    const provider = profile.inference_provider ?? this.env.DEFAULT_INFERENCE_PROVIDER;
    if (provider === "anthropic" && profile.consent_xborder !== 1) {
      await this.fileDocument(userId, { id: docId, doc_type: "unknown", r2_key: r2key, image_hash: imageHash, needs_review: 1 });
      await this.notify(userId, "Cross-border processing consent (APP 8) is required before the US inference API can read this document. Record consent to proceed.", null);
      return { docId, doc_type: "unknown", routed: false };
    }
    if (!(await this.withinBudget(userId, null))) {
      await this.fileDocument(userId, { id: docId, doc_type: "unknown", r2_key: r2key, image_hash: imageHash, needs_review: 1 });
      return { docId, doc_type: "unknown", routed: false };
    }

    const llm = await getLLM(this.env, profile, { userId });
    const cls = await classifyDocument(llm, bytes, mime);
    const propertyId = await this.resolvePropertyByHint(userId, cls.likely_property_hint);
    const lowConf = cls.confidence < 0.6;
    await this.fileDocument(userId, {
      id: docId,
      doc_type: cls.doc_type,
      r2_key: r2key,
      image_hash: imageHash,
      property_id: propertyId,
      fy: fyForDate(cls.doc_date ?? null),
      issuer: cls.issuer,
      doc_date: cls.doc_date,
      extracted_json: JSON.stringify(cls),
      classification_confidence: cls.confidence,
      needs_review: lowConf ? 1 : 0,
    });
    await this.audit(userId, "classify", JSON.stringify({ docId, doc_type: cls.doc_type, confidence: cls.confidence }));

    // <0.6 → hold entirely for human confirm (defence-in-depth against ~2% misroute).
    if (lowConf) {
      await this.notify(userId, `Filed a document I wasn't sure about (${cls.doc_type}, ${(cls.confidence * 100).toFixed(0)}%). Review it in Documents.`, null);
      return { docId, doc_type: cls.doc_type, routed: false };
    }

    // The typed extractors below make a SECOND model call; re-check the daily budget so the cap
    // isn't bypassed (the receipt/invoice branch self-guards via extractAndCategorise).
    if (cls.doc_type !== "receipt" && cls.doc_type !== "invoice" && !(await this.withinBudget(userId, null))) {
      await this.notify(userId, `Filed a ${cls.doc_type} to Documents — daily AI budget reached, it'll extract after the reset.`, null);
      return { docId, doc_type: cls.doc_type, routed: false };
    }

    // Dispatch by type. Unhandled types are filed to the shelf for review.
    switch (cls.doc_type) {
      case "receipt":
      case "invoice": {
        // Route through the existing receipt extractor as a transaction linked to this document.
        const txnId = crypto.randomUUID();
        await this.env.DB.prepare(
          `INSERT INTO transactions (id, user_id, source, status, receipt_key, image_hash, document_id)
           VALUES (?, ?, ?, 'needs_extraction', ?, ?, ?)`,
        ).bind(txnId, userId, source, r2key, imageHash, docId).run();
        await this.extractAndCategorise(userId, txnId, bytes, mime, null);
        return { docId, doc_type: cls.doc_type, routed: true };
      }
      case "payslip": {
        const p = await extractPayslip(llm, bytes, mime);
        await this.recordIncome(userId, {
          entity_id: null,
          income_type: "salary_payg",
          ato_label: "1-salary",
          gross_cents: p.gross_cents,
          withholding_cents: p.tax_withheld_cents,
          net_cents: p.gross_cents - p.tax_withheld_cents,
          currency: p.currency,
          txn_date: p.pay_date,
          source_doc_id: docId,
          detail_json: JSON.stringify({ employer: p.employer, super_cents: p.super_cents, rfba_cents: p.rfba_cents }),
          needs_review: p.confidence < CONFIDENCE_THRESHOLD ? 1 : 0,
        });
        await this.notify(userId, `Payslip from ${p.employer}: gross $${(p.gross_cents / 100).toFixed(2)}, PAYG withheld $${(p.tax_withheld_cents / 100).toFixed(2)}.${p.rfba_cents ? " RFBA captured (reportable fringe benefit)." : ""}`, null);
        return { docId, doc_type: cls.doc_type, routed: true };
      }
      case "agent_rental_summary": {
        await this.decomposeAgentStatement(userId, docId, propertyId, bytes, mime, llm);
        return { docId, doc_type: cls.doc_type, routed: true };
      }
      case "depreciation_schedule": {
        await this.importDepreciationSchedule(userId, docId, bytes, mime);
        return { docId, doc_type: cls.doc_type, routed: true };
      }
      case "dividend_statement": {
        const dv = await extractDividend(llm, bytes, mime);
        const gross = dv.franked_cents + dv.unfranked_cents;
        await this.recordIncome(userId, {
          income_type: "dividend",
          ato_label: "11-dividends",
          gross_cents: gross,
          franking_credit_cents: dv.franking_credit_cents,
          currency: dv.currency,
          txn_date: dv.payment_date,
          source_doc_id: docId,
          detail_json: JSON.stringify({ payer: dv.payer, franked_cents: dv.franked_cents, unfranked_cents: dv.unfranked_cents }),
          needs_review: dv.confidence < CONFIDENCE_THRESHOLD ? 1 : 0,
        });
        await this.notify(userId, `Dividend from ${dv.payer ?? "issuer"}: $${(gross / 100).toFixed(2)}${dv.franking_credit_cents ? `, franking credit $${(dv.franking_credit_cents / 100).toFixed(2)}` : ""}.`, null);
        return { docId, doc_type: cls.doc_type, routed: true };
      }
      default: {
        await this.notify(userId, `Filed a ${cls.doc_type} to your Documents shelf.`, null);
        return { docId, doc_type: cls.doc_type, routed: true };
      }
    }
  }

  /**
   * Decompose an agent rental summary into 1 rent income row + N expense transactions, attributed
   * to a property, with a reconciliation assertion (Σrent − Σexpenses = net disbursed). Sub-threshold
   * extraction or a failed reconcile flags the income row needs_review rather than dropping it.
   */
  async decomposeAgentStatement(
    userId: string,
    docId: string,
    propertyId: string | null,
    bytes: ArrayBuffer,
    mime: string,
    llm: LLM,
  ): Promise<void> {
    const ext = await extractAgentStatement(llm, bytes, mime);
    const sumIncome = ext.income_lines.reduce((s, l) => s + Math.abs(l.amount_cents), 0);
    const sumExpense = ext.expense_lines.reduce((s, l) => s + Math.abs(l.amount_cents), 0);
    // Reconciliation: rent − expenses should equal the net disbursed (proof of completeness).
    const reconOk =
      ext.net_disbursed_cents == null
        ? true
        : Math.abs(sumIncome - sumExpense - ext.net_disbursed_cents) <= Math.max(100, Math.round(sumIncome * 0.01));
    const fy = fyForDate(ext.period_end ?? ext.period_start ?? null) ?? this.currentFyLabel();
    const needsReview = !reconOk || ext.confidence < CONFIDENCE_THRESHOLD ? 1 : 0;

    await this.recordIncome(userId, {
      property_id: propertyId,
      income_type: "rent",
      ato_label: "13R-rent",
      fy,
      gross_cents: sumIncome,
      net_cents: ext.net_disbursed_cents,
      txn_date: ext.period_end,
      source_doc_id: docId,
      detail_json: JSON.stringify({ agent: ext.agent_name, lines: ext.income_lines }),
      needs_review: needsReview,
    });

    // Each agent-deducted expense becomes a property_rented transaction (evidence + deduction).
    for (const e of ext.expense_lines) {
      await this.env.DB.prepare(
        `INSERT INTO transactions (id, user_id, source, status, kind, merchant, amount_cents, currency,
           amount_aud_cents, txn_date, bucket, ato_label, property_id, document_id, confidence, reasoning, is_capital)
         VALUES (?, ?, 'agent_statement', ?, 'receipt', ?, ?, 'AUD', ?, ?, 'property_rented', ?, ?, ?, ?, ?, 0)`,
      )
        .bind(
          crypto.randomUUID(), userId, needsReview ? "needs_review" : "extracted", e.description,
          Math.abs(e.amount_cents), Math.abs(e.amount_cents), e.date ?? ext.period_end ?? null,
          `rental:${e.category ?? "expense"}`, propertyId, docId, ext.confidence,
          `From agent statement (${ext.agent_name ?? "agent"}).`,
        )
        .run();
    }

    await this.audit(userId, "agent_statement_decomposed", JSON.stringify({ docId, propertyId, rent: sumIncome, expenses: sumExpense, net: ext.net_disbursed_cents, reconOk }));
    await this.notify(
      userId,
      `Agent statement processed: rent $${(sumIncome / 100).toFixed(2)}, expenses $${(sumExpense / 100).toFixed(2)}, net $${((ext.net_disbursed_cents ?? sumIncome - sumExpense) / 100).toFixed(2)}.${reconOk ? "" : " ⚠️ Didn't reconcile — review the income row."}${propertyId ? "" : " Couldn't match a property — set it in the income row."}`,
      null,
    );
  }

  // ── ASSETS & DEPRECIATION (deterministic; engine in lib/depreciation.ts) ────
  /** Create a depreciating asset and materialise its carry-forward schedule up to the current FY. */
  async createAsset(
    userId: string,
    a: {
      label: string;
      asset_class: string;
      cost_cents: number;
      acquired_date: string;
      property_id?: string | null;
      entity_id?: string | null;
      effective_life_years?: number | null;
      method?: string | null;
      div43_rate?: number | null;
      dv_rate_pct?: number | null;
      is_second_hand?: boolean;
      business_use_pct?: number | null;
      source_doc_id?: string | null;
      needs_review?: number;
    },
  ): Promise<string> {
    const id = crypto.randomUUID();
    await this.env.DB.prepare(
      `INSERT INTO assets (id, user_id, person_id, property_id, entity_id, label, asset_class, cost_cents,
         acquired_date, effective_life_years, method, dv_rate_pct, div43_rate, is_second_hand, business_use_pct,
         source_doc_id, status, needs_review)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    )
      .bind(
        id, userId, `person_self_${userId}`, a.property_id ?? null, a.entity_id ?? null, a.label, a.asset_class,
        a.cost_cents, a.acquired_date, a.effective_life_years ?? null, a.method ?? null, a.dv_rate_pct ?? 200, a.div43_rate ?? null,
        a.is_second_hand ? 1 : 0, a.business_use_pct ?? 100, a.source_doc_id ?? null, a.needs_review ?? 0,
      )
      .run();
    await this.audit(userId, "asset_created", JSON.stringify({ id, class: a.asset_class, cost: a.cost_cents }));
    await this.computeDepreciation(userId, id);
    return id;
  }

  /**
   * Turn every capital-purchase transaction (bucket='asset') into a depreciating asset and link
   * it, so the cost depreciates via the assets table instead of being claimed as an immediate
   * deduction. Defaults are placeholders the user confirms in the Assets page (needs_review=1):
   * Div 40 plant, diminishing value, a generic effective life, 100% business use ("work out %
   * later"). IDEMPOTENT — only touches asset txns not yet linked — so it's safe to call after any
   * categorise / batch-apply / correction. Skips undated or zero-cost lines (can't depreciate).
   */
  private async linkAssetsForUser(userId: string): Promise<void> {
    const rows = await this.env.DB.prepare(
      `SELECT id, merchant, COALESCE(amount_aud_cents, amount_cents) AS cost, txn_date, property_id
         FROM transactions
        WHERE user_id = ? AND bucket = 'asset' AND asset_id IS NULL AND status NOT IN ('duplicate','ignored')
          AND COALESCE(direction,'debit') = 'debit'  -- a capital purchase is money OUT; never an asset from a credit
          AND txn_date IS NOT NULL AND COALESCE(amount_aud_cents, amount_cents) > 0`,
    )
      .bind(userId)
      .all<{ id: string; merchant: string | null; cost: number; txn_date: string; property_id: string | null }>();
    if (!rows.results?.length) return;
    // `asset_defaults` flag: classify the capital purchase by merchant against the rule pack's
    // asset_class_hints and seed a sensible TR 2022/1-style effective life/method (still
    // needs_review). Off → legacy flat default (div40_plant, 5y, DV). Only load the rule pack when
    // on, so the flag-off path keeps its original cost (no extra read).
    const rulePack = featureOn(this.env, "asset_defaults")
      ? await this.loadRulePack((await this.requireProfile(userId)).rule_pack_ver)
      : null;
    for (const r of rows.results ?? []) {
      const d = this.assetDefaultsFor(r.merchant, rulePack);
      const assetId = await this.createAsset(userId, {
        label: r.merchant ? `${r.merchant} (${r.txn_date})` : `Capital asset (${r.txn_date})`,
        asset_class: d.asset_class, // seeded from hints when asset_defaults is on; else div40_plant
        cost_cents: r.cost,
        acquired_date: r.txn_date,
        property_id: r.property_id,
        effective_life_years: d.effective_life_years, // sensible default — user confirms in review
        method: d.method,
        business_use_pct: 100, // work out apportionment % later
        needs_review: 1,
      });
      const capitalClass = d.asset_class === "div43_capital_works" ? "div43" : "div40";
      await this.env.DB.prepare(
        `UPDATE transactions SET asset_id = ?, is_capital = 1, capital_class = ? WHERE id = ? AND user_id = ?`,
      )
        .bind(assetId, capitalClass, r.id, userId)
        .run();
      await this.audit(userId, "asset_linked", JSON.stringify({ txnId: r.id, assetId, cost: r.cost }));
    }
  }

  /**
   * Pick the asset class + default effective life/method for an auto-created capital asset. With
   * `rulePack` (asset_defaults flag on) it matches the merchant against asset_class_hints, falling
   * back to the pack's asset_class_default; with null it returns the legacy flat default. The
   * asset still lands needs_review — these are GENERAL-INFO starting points, not a tax decision.
   */
  private assetDefaultsFor(
    merchant: string | null,
    rulePack: typeof DEFAULT_RULE_PACK | null,
  ): { asset_class: string; effective_life_years: number; method: string } {
    const legacy = { asset_class: "div40_plant", effective_life_years: 5, method: "diminishing_value" };
    if (!rulePack) return legacy;
    // KV-override packs may predate these keys, so guard at runtime even though the bundled type has them.
    const def = rulePack.asset_class_default;
    const fallback = def
      ? { asset_class: def.asset_class, effective_life_years: def.effective_life_years, method: def.method }
      : legacy;
    const hints = rulePack.asset_class_hints;
    const m = (merchant ?? "").toLowerCase();
    if (m && Array.isArray(hints)) {
      for (const h of hints) {
        const terms = h.match.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
        if (terms.some((t) => t && m.includes(t))) {
          return { asset_class: h.asset_class, effective_life_years: h.effective_life_years, method: h.method };
        }
      }
    }
    return fallback;
  }

  /** Map an assets row into the engine's DepAsset shape. */
  private toDepAsset(row: {
    asset_class: string; cost_cents: number; acquired_date: string; effective_life_years: number | null;
    method: string | null; div43_rate: number | null; dv_rate_pct?: number | null; is_second_hand: number;
    business_use_pct: number | null; disposed_date: string | null;
  }): DepAsset {
    return {
      asset_class: row.asset_class as DepAsset["asset_class"],
      cost_cents: row.cost_cents,
      acquired_date: row.acquired_date,
      effective_life_years: row.effective_life_years,
      method: (row.method as DepAsset["method"]) ?? null,
      div43_rate: row.div43_rate,
      dv_rate_pct: row.dv_rate_pct ?? 200,
      is_second_hand: !!row.is_second_hand,
      business_use_pct: row.business_use_pct ?? 100,
      disposed_date: row.disposed_date,
    };
  }

  /**
   * Materialise (or refresh) an asset's depreciation_schedule up to `toStartYear` (default: the
   * current FY). Deterministic — re-running yields identical rows (UNIQUE(asset_id, fy) upsert).
   */
  async computeDepreciation(userId: string, assetId: string, toStartYear?: number): Promise<{ rows: number }> {
    const row = await this.env.DB.prepare(
      `SELECT asset_class, cost_cents, acquired_date, effective_life_years, method, dv_rate_pct, div43_rate,
              is_second_hand, business_use_pct, disposed_date FROM assets WHERE id = ? AND user_id = ?`,
    )
      .bind(assetId, userId)
      .first<{ asset_class: string; cost_cents: number; acquired_date: string; effective_life_years: number | null; method: string | null; dv_rate_pct: number | null; div43_rate: number | null; is_second_hand: number; business_use_pct: number | null; disposed_date: string | null }>();
    if (!row) throw new Error("asset not found");

    const target = toStartYear ?? Number(this.currentFyLabel().slice(0, 4));
    const schedule = rollSchedule(this.toDepAsset(row), target);
    const stmts = schedule.map((s) =>
      this.env.DB.prepare(
        `INSERT INTO depreciation_schedule (id, user_id, asset_id, fy, opening_adjustable_value_cents,
           days_held, deduction_cents, closing_adjustable_value_cents, method_applied)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(asset_id, fy) DO UPDATE SET
           opening_adjustable_value_cents=excluded.opening_adjustable_value_cents,
           days_held=excluded.days_held, deduction_cents=excluded.deduction_cents,
           closing_adjustable_value_cents=excluded.closing_adjustable_value_cents,
           method_applied=excluded.method_applied, computed_at=datetime('now')`,
      ).bind(crypto.randomUUID(), userId, assetId, s.fy, s.opening_adjustable_value_cents, s.days_held, s.deduction_cents, s.closing_adjustable_value_cents, s.method_applied),
    );
    for (let i = 0; i < stmts.length; i += 50) await this.env.DB.batch(stmts.slice(i, i + 50));
    await this.audit(userId, "depreciation_computed", JSON.stringify({ assetId, throughFy: fyLabel(target), rows: schedule.length }));
    return { rows: schedule.length };
  }

  /** Batch: roll every active asset's schedule into a new FY (called by the FY-rollover cron). */
  async rollForward(userId: string, toStartYear: number): Promise<{ assets: number }> {
    const assets = await this.env.DB.prepare(`SELECT id FROM assets WHERE user_id = ? AND status = 'active'`)
      .bind(userId)
      .all<{ id: string }>();
    let n = 0;
    for (const a of assets.results ?? []) {
      await this.computeDepreciation(userId, a.id, toStartYear);
      n++;
    }
    await this.audit(userId, "depreciation_rollforward", JSON.stringify({ toFy: fyLabel(toStartYear), assets: n }));
    return { assets: n };
  }

  /** Parse a quantity-surveyor depreciation schedule (PDF) → bulk-create assets + first schedules. */
  async importDepreciationSchedule(userId: string, docId: string, bytes: ArrayBuffer, mime: string): Promise<{ created: number }> {
    const profile = await this.requireProfile(userId);
    const provider = profile.inference_provider ?? this.env.DEFAULT_INFERENCE_PROVIDER;
    if (provider === "anthropic" && profile.consent_xborder !== 1) throw new Error("consent_required");
    const llm = await getLLM(this.env, profile, { userId });
    const doc = await this.env.DB.prepare(`SELECT property_id FROM documents WHERE id = ? AND user_id = ?`)
      .bind(docId, userId)
      .first<{ property_id: string | null }>();
    const ext = await extractDepreciationSchedule(llm, bytes, mime);
    let created = 0;
    for (const a of ext.assets) {
      await this.createAsset(userId, {
        label: a.label,
        asset_class: a.asset_class,
        cost_cents: a.cost_cents,
        acquired_date: a.acquired_date,
        property_id: doc?.property_id ?? null,
        effective_life_years: a.effective_life_years,
        method: a.method,
        div43_rate: a.div43_rate,
        is_second_hand: a.is_second_hand,
        source_doc_id: docId,
        needs_review: ext.confidence < CONFIDENCE_THRESHOLD ? 1 : 0,
      });
      created++;
    }
    await this.audit(userId, "depreciation_schedule_imported", JSON.stringify({ docId, created }));
    await this.notify(userId, `Imported ${created} asset(s) from the depreciation schedule — decline-in-value will appear in your report.`, null);
    return { created };
  }

  /** Dispose of an asset: record the termination value + a balancing adjustment vs adjustable value. */
  async disposeAsset(userId: string, assetId: string, disposedDate: string, disposalValueCents: number): Promise<{ balancing_adjustment_cents: number }> {
    // Set the disposal first so the engine caps days-held in the disposal FY, then materialise the
    // schedule THROUGH that FY — otherwise the adjustable value omits the disposal-year decline and
    // the balancing adjustment is computed against a stale (too-high) value.
    await this.env.DB.prepare(
      `UPDATE assets SET status='disposed', disposed_date=?, disposal_value_cents=? WHERE id=? AND user_id=?`,
    )
      .bind(disposedDate, disposalValueCents, assetId, userId)
      .run();
    const dyStart = fyStartYearOf(disposedDate);
    await this.computeDepreciation(userId, assetId, dyStart);
    const last = await this.env.DB.prepare(
      `SELECT closing_adjustable_value_cents FROM depreciation_schedule WHERE asset_id = ? AND user_id = ? AND fy = ?`,
    )
      .bind(assetId, userId, fyLabel(dyStart))
      .first<{ closing_adjustable_value_cents: number }>();
    const adjustable = last?.closing_adjustable_value_cents ?? 0;
    const bal = balancingAdjustment(adjustable, disposalValueCents);
    await this.audit(userId, "asset_disposed", JSON.stringify({ assetId, disposedDate, disposalValueCents, balancing: bal }));
    await this.notify(
      userId,
      `Asset disposed. Balancing adjustment ${bal >= 0 ? "assessable +" : "deductible "}$${(Math.abs(bal) / 100).toFixed(2)} (termination value − adjustable value). Confirm with a registered tax agent.`,
      null,
    );
    return { balancing_adjustment_cents: bal };
  }

  // ── CGT: capital gain on a disposed property (Phase 5, cross-border) ────────
  /**
   * Compute the indicative CGT position on a disposed property. Div 43 capital-works deductions
   * claimed against the property reduce its cost base; the 50% discount applies to a resident
   * individual who held >12 months; a main-residence flag gives full exemption. GENERAL-INFO —
   * residency + main-residence are judgement calls for a registered tax agent.
   */
  async computeCgt(userId: string, propertyId: string): Promise<import("./lib/cgt").CgtResult & { property_id: string }> {
    const { computeCapitalGain } = await import("./lib/cgt");
    const prop = await this.env.DB.prepare(
      `SELECT p.cost_base_cents, p.disposal_proceeds_cents, p.disposal_date, p.acquired_date,
              p.main_residence_flag, COALESCE(pe.tax_residency, 'AU') AS tax_residency
         FROM properties p LEFT JOIN persons pe ON pe.id = p.person_id
        WHERE p.id = ? AND p.user_id = ?`,
    )
      .bind(propertyId, userId)
      .first<{ cost_base_cents: number | null; disposal_proceeds_cents: number | null; disposal_date: string | null; acquired_date: string | null; main_residence_flag: number; tax_residency: string }>();
    if (!prop) throw new Error("property not found");
    if (prop.cost_base_cents == null || prop.disposal_proceeds_cents == null || !prop.disposal_date || !prop.acquired_date) {
      throw new Error("property is missing cost base, proceeds, acquired or disposal date");
    }
    // Div 43 capital-works deductions claimed against this property reduce the cost base.
    const div43 = await this.env.DB.prepare(
      `SELECT COALESCE(SUM(d.deduction_cents),0) AS total FROM depreciation_schedule d
         JOIN assets a ON a.id = d.asset_id
        WHERE d.user_id = ? AND a.property_id = ? AND d.method_applied = 'div43'`,
    )
      .bind(userId, propertyId)
      .first<{ total: number }>();
    const result = computeCapitalGain({
      cost_base_cents: prop.cost_base_cents,
      proceeds_cents: prop.disposal_proceeds_cents,
      div43_claimed_cents: div43?.total ?? 0,
      acquired_date: prop.acquired_date,
      disposal_date: prop.disposal_date,
      is_resident_individual: prop.tax_residency === "AU",
      main_residence_exempt: prop.main_residence_flag === 1,
    });
    await this.audit(userId, "cgt_computed", JSON.stringify({ propertyId, net_gain: result.net_gain_cents }));
    return { ...result, property_id: propertyId };
  }

  // ── CLAIMABILITY: deterministic rules → claim_suggestions (rules-first) ─────
  /**
   * Run the deterministic claimability rules against a context and log any matched
   * suggestions. Rules-first: the rules (from the versioned rule pack + any per-tenant D1
   * overrides) are the source of truth; defer_to_agent rules append the "confirm with a
   * registered tax agent" disclaimer. The LLM is never used to assert a deduction here.
   */
  async suggestClaims(
    userId: string,
    ctx: ClaimContext,
    refs: { txnId?: string | null; assetId?: string | null; estimatedDeductionCents?: number | null } = {},
  ): Promise<number> {
    const profile = await this.requireProfile(userId);
    const pack = await this.loadRulePack(profile.rule_pack_ver);
    const packRules = ((pack as { claimability?: ClaimRule[] }).claimability ?? []) as ClaimRule[];
    const d1 = await this.env.DB.prepare(
      `SELECT id, scope_type, scope_value, merchant_hint, ato_label, claim_type, default_method, general_info_note, defer_to_agent
         FROM claimability_rules WHERE rule_pack_ver = ?`,
    )
      .bind(profile.rule_pack_ver)
      .all<ClaimRule>();
    const matched = matchClaimRules([...packRules, ...(d1.results ?? [])], ctx);
    let n = 0;
    for (const r of matched) {
      await this.env.DB.prepare(
        `INSERT INTO claim_suggestions (id, user_id, person_id, txn_id, asset_id, rule_id, suggestion, claim_type, estimated_deduction_cents)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          crypto.randomUUID(), userId, `person_self_${userId}`, refs.txnId ?? null, refs.assetId ?? null,
          r.id ?? `${r.scope_type}:${r.scope_value}`, suggestionText(r), r.claim_type, refs.estimatedDeductionCents ?? null,
        )
        .run();
      n++;
    }
    if (n) await this.audit(userId, "claims_suggested", JSON.stringify({ txnId: refs.txnId, assetId: refs.assetId, n }));
    return n;
  }

  // ── FILING READINESS: compose the report + rules + signals into a capstone view ──
  /**
   * Read-only synthesis for the "File" page: an INDICATIVE position with reasoning, plus a
   * deterministic "things to double-check" list. Composes buildReport + the situation + matched
   * claimability rules + a few D1 signal counts, then runs the pure assessReadiness() engine. Makes
   * no LLM call (the v2 narrative layer does, behind the APP-8 gate) and mutates nothing — viewing
   * the page must never change the ledger. Writes one audit row.
   */
  async assessFilingReadiness(userId: string, startYear: number): Promise<FilingReadiness> {
    const profile = await this.requireProfile(userId);
    const fy = fyLabel(startYear);
    const { start, end } = fyBounds(startYear);
    const [report, situation] = await Promise.all([buildReport(this.env, userId, startYear), getSituation(this.env, userId, profile)]);

    // Matched situation-level claim rules (defer-to-agent ones become "judgement" findings). Iterate
    // distinct property statuses since the context carries a single property_status; occupation/
    // entity rules match regardless. Merchant-scoped rules can't fire here (no merchant) — intended.
    const pack = await this.loadRulePack(profile.rule_pack_ver);
    const packRules = ((pack as { claimability?: ClaimRule[] }).claimability ?? []) as ClaimRule[];
    const d1Rules = (
      await this.env.DB.prepare(
        `SELECT id, scope_type, scope_value, merchant_hint, ato_label, claim_type, default_method, general_info_note, defer_to_agent
           FROM claimability_rules WHERE rule_pack_ver = ?`,
      ).bind(profile.rule_pack_ver).all<ClaimRule>()
    ).results ?? [];
    const allRules = [...packRules, ...d1Rules];
    const occupations = situation.persons.map((p) => p.occupation).filter((o): o is string => !!o);
    const entity_kinds = situation.entities.map((e) => e.kind);
    const statuses = [...new Set(situation.properties.map((p) => p.status))];
    const matchedById = new Map<string, ClaimRule>();
    for (const st of statuses.length ? statuses : [null]) {
      for (const r of matchClaimRules(allRules, { property_status: st, occupations, entity_kinds })) {
        matchedById.set(r.id ?? `${r.scope_type}:${r.scope_value}`, r);
      }
    }

    // Pre-counted impure signals handed to the pure engine.
    const unknownRow = report.by_bucket.find((b) => b.bucket === "unknown");
    const confidenceFloor = 0.6;
    const [needsIncome, needsAssets, lowConf, divDoc, agentSummaryProps, disposed] = await Promise.all([
      this.env.DB.prepare(`SELECT COUNT(*) AS n FROM income WHERE user_id = ? AND fy = ? AND needs_review = 1`).bind(userId, fy).first<{ n: number }>(),
      this.env.DB.prepare(`SELECT COUNT(*) AS n FROM assets WHERE user_id = ? AND needs_review = 1 AND status = 'active'`).bind(userId).first<{ n: number }>(),
      this.env.DB.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND confidence IS NOT NULL AND confidence < ? AND txn_date >= ? AND txn_date <= ? AND ${COUNTABLE}`).bind(userId, confidenceFloor, start, end).first<{ n: number }>(),
      this.env.DB.prepare(`SELECT COUNT(*) AS n FROM documents WHERE user_id = ? AND doc_type IN ('dividend_statement','managed_fund_amma') AND (fy = ? OR fy IS NULL)`).bind(userId, fy).first<{ n: number }>(),
      this.env.DB.prepare(`SELECT DISTINCT property_id FROM documents WHERE user_id = ? AND doc_type = 'agent_rental_summary' AND property_id IS NOT NULL`).bind(userId).all<{ property_id: string }>(),
      this.env.DB.prepare(`SELECT COUNT(*) AS n FROM assets WHERE user_id = ? AND disposed_date IS NOT NULL AND disposed_date >= ? AND disposed_date <= ?`).bind(userId, start, end).first<{ n: number }>(),
    ]);
    const haveSummaryFor = new Set((agentSummaryProps.results ?? []).map((r) => r.property_id));
    const rentalPropsMissingSummary = report.per_property
      .filter((p) => p.income_cents > 0 && !haveSummaryFor.has(p.property_id))
      .map((p) => ({ property_id: p.property_id, label: p.label }));

    const thresholds = (pack as { thresholds_by_fy?: Record<string, { instant_asset_write_off_cents?: number }> }).thresholds_by_fy ?? {};
    const signals: FilingReadinessSignals = {
      unknownBucketCents: unknownRow?.total_cents ?? 0,
      unknownBucketN: unknownRow?.n ?? 0,
      lowConfidenceN: lowConf?.n ?? 0,
      needsReviewIncomeN: needsIncome?.n ?? 0,
      needsReviewAssetsN: needsAssets?.n ?? 0,
      hasDividendStatementDoc: (divDoc?.n ?? 0) > 0,
      rentalPropsMissingSummary,
      disposedAssetsN: disposed?.n ?? 0,
      instantAssetWriteOffCentsThisFy: thresholds[fy]?.instant_asset_write_off_cents ?? null,
      instantAssetWriteOffCentsPrevFy: thresholds[fyLabel(startYear - 1)]?.instant_asset_write_off_cents ?? null,
    };

    const readiness = assessReadiness({ report, situation, claimMatches: [...matchedById.values()], signals, generatedAt: new Date().toISOString() });
    await this.audit(userId, "readiness_assessed", JSON.stringify({ fy, blockers: readiness.readiness_score.blockers, review: readiness.readiness_score.review, findings: readiness.findings.length }));
    return readiness;
  }

  /** Update a claim suggestion's status (suggested|accepted|dismissed). */
  async setClaimStatus(userId: string, id: string, status: string): Promise<void> {
    await this.env.DB.prepare(`UPDATE claim_suggestions SET status = ? WHERE id = ? AND user_id = ?`).bind(status, id, userId).run();
    await this.audit(userId, "claim_status", JSON.stringify({ id, status }));
  }

  // ── FY CHECKLIST: bucket-driven kickoff/wrap-up items ──────────────────────
  /**
   * Generate the FY checklist from the tenant's situation (buckets/entities/properties).
   * Idempotent — re-running only inserts items that aren't already present for the FY (the
   * UNIQUE(user_id, person_id, fy, item_key) key + ON CONFLICT DO NOTHING). GENERAL-INFO only.
   */
  async generateChecklist(userId: string, fy?: string): Promise<{ items: number }> {
    const profile = await this.requireProfile(userId);
    const situation = await getSituation(this.env, userId, profile);
    const targetFy = fy ?? this.currentFyLabel();
    const personId = `person_self_${userId}`;
    const hasRented = situation.properties.some((p) => p.status === "rented");
    const hasVacant = situation.properties.some((p) => p.status === "vacant");
    // OWNED property only — a tenant (renting_*) has no cost base, so Div 40/43 depreciation and a QS
    // schedule don't apply to them.
    const hasOwnedProperty = situation.properties.some((p) => !p.status.startsWith("renting_"));
    const hasCompany = situation.entities.some((e) => e.kind === "company");
    let buckets: string[] = [];
    try {
      buckets = JSON.parse(profile.buckets) as string[];
    } catch {
      /* ignore */
    }
    const hasInvestments = buckets.includes("investments") || buckets.includes("shares");

    const items: { item_key: string; title: string; rationale: string; trigger_bucket: string; due_hint: string }[] = [];
    if (hasRented)
      items.push({ item_key: "rental_eofy_summary", title: "Upload this year's agent EOFY rental summary + repair receipts", rationale: "Rent received and agent-deducted expenses come from the EOFY statement — the Smart Inbox will split it per property.", trigger_bucket: "property_rented", due_hint: "After 30 June" });
    if (hasVacant)
      items.push({ item_key: "vacant_holding_costs", title: "Confirm the vacant property was genuinely available for rent; capture holding costs", rationale: "Holding costs are only deductible while the property is genuinely available for rent. Vacant land holding costs are generally not deductible since 1 July 2019.", trigger_bucket: "property_vacant", due_hint: "Before lodging" });
    if (hasOwnedProperty)
      items.push({ item_key: "qs_dep_schedule", title: "Get a quantity-surveyor depreciation schedule if you don't have one", rationale: "A QS schedule unlocks Div 40 and Div 43 deductions that carry forward each year. Upload it from Documents to bulk-import the assets.", trigger_bucket: "property_rented", due_hint: "Anytime" });
    if (hasCompany)
      items.push({ item_key: "company_equipment_review", title: "Review company equipment to depreciate (check this FY's instant asset write-off threshold)", rationale: "Eligible assets may be written off immediately or pooled. The threshold changes yearly — confirm the current-FY figure.", trigger_bucket: "company", due_hint: "Before 30 June" });
    if (hasInvestments || hasCompany)
      items.push({ item_key: "dividend_statements", title: "Upload dividend / managed-fund (AMMA) statements", rationale: "Franking credits and distribution components are captured from these — drop them in Documents.", trigger_bucket: "payg", due_hint: "After 30 June" });
    items.push({ item_key: "super_notice_of_intent", title: "Lodge your Notice of intent to claim a personal super deduction (and get the fund's acknowledgment)", rationale: "A personal super contribution is only deductible with a valid Notice of intent acknowledged by the fund — lodge before you lodge your return or by 30 June of the following year.", trigger_bucket: "payg", due_hint: "Before lodging" });

    let n = 0;
    for (const it of items) {
      const res = await this.env.DB.prepare(
        `INSERT INTO fy_checklist (id, user_id, person_id, fy, item_key, title, rationale, trigger_bucket, due_hint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, person_id, fy, item_key) DO NOTHING`,
      )
        .bind(crypto.randomUUID(), userId, personId, targetFy, it.item_key, it.title, it.rationale, it.trigger_bucket, it.due_hint)
        .run();
      n += res.meta?.changes ?? 0;
    }
    await this.audit(userId, "checklist_generated", JSON.stringify({ fy: targetFy, added: n }));
    return { items: n };
  }

  /** Update a checklist item's status (open|done|dismissed|not_applicable). */
  async setChecklistStatus(userId: string, id: string, status: string): Promise<void> {
    await this.env.DB.prepare(`UPDATE fy_checklist SET status = ? WHERE id = ? AND user_id = ?`).bind(status, id, userId).run();
    await this.audit(userId, "checklist_status", JSON.stringify({ id, status }));
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

    // If the user re-bucketed a line to 'asset', create + link its depreciating asset now.
    if (field === "bucket" && newValue === "asset") await this.linkAssetsForUser(userId);

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
      `SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND bucket = 'property_vacant' AND ${COUNTABLE}`,
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
      if (err instanceof LedgerReauthError) {
        await this.notify(userId, "A company expense is ready, but your QuickBooks authorisation expired — reconnect QuickBooks to resume.", txnId);
        await this.audit(userId, "ledger_skip_reauth", JSON.stringify({ txnId }));
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

  /**
   * Onboarding conversational front door: turn a free-text situation description into a
   * structured DRAFT (entities/properties/rules) the wizard pre-fills for the user to
   * CONFIRM. Persists nothing. Enforces the same APP-8 cross-border consent gate as
   * categorisation — sending the user's free text to the US inference API is itself a
   * cross-border disclosure, so anthropic+no-consent is refused (Bedrock/AU is fine).
   */
  async draftSituation(userId: string, message: string): Promise<SituationDraft> {
    const profile = await this.requireProfile(userId);
    const provider = profile.inference_provider ?? this.env.DEFAULT_INFERENCE_PROVIDER;
    if (provider === "anthropic" && profile.consent_xborder !== 1) {
      throw new Error("consent_required");
    }
    const llm = await getLLM(this.env, profile, { userId });
    const draft = await extractSituationDraft(llm, message.slice(0, 4000));
    await this.audit(
      userId,
      "onboarding_draft",
      JSON.stringify({ entities: draft.entities.length, properties: draft.properties.length, rules: draft.rules.length }),
    );
    return draft;
  }

  private async loadRulePack(ver: string): Promise<typeof DEFAULT_RULE_PACK> {
    const override = await this.env.RULES.get(`rulepack:${ver}`, "json");
    const pack = (override as typeof DEFAULT_RULE_PACK | null) ?? DEFAULT_RULE_PACK;
    // Warn (don't throw) if a KV override drifted from the taxonomy's known buckets.
    if (pack?.buckets) assertBucketKeys(pack.buckets);
    return pack;
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
