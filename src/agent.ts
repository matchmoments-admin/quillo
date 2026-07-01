import { Agent } from "agents";
import type { Env } from "./env";
import { getProfile, getSituation, renderSituation, type Profile, type Situation, type UserRule } from "./lib/db";
import { addRule, addAccount, updateAccount, syncIncomeCgtFromComponents, clearIncomeCgt, syncPropertyDisposalToCgt, addPerson, updatePerson, addProperty, updateProperty, addEntity, updateEntity, updateRule, deleteRow, DeleteBlockedError, addPropertyOwner, addEntityRole, addIncomeActivity, addLoanProperty, updateLoanProperty, assertOwns, assertNoBlockingChildren, assertNoBlockingChildrenExcept } from "./lib/situation-write";
import type { DeleteBlocker } from "./lib/situation-write";
import { captureNoaDraft } from "./lib/noa-store";
import { ordinaryAssessableCents, validateComponents, parseAmmaComponents, type AmmaComponents } from "./lib/managed-fund";
import { QuickBooksAdapter } from "./ledger/qbo";
import { revokeAndDisconnect } from "./lib/qbo-oauth";
import { purgeTenant as purgeTenantData, exportTenant as exportTenantData, flagOldData as flagOldDataSweep, hasPendingNudge, type PurgeResult } from "./lib/retention";
import { COUNTABLE, fetchAskDigestRows, spendRunRate } from "./lib/queries";
import { billerNormalize, detectRecurrence, classifyBiller, paymentsPerYear, recurringCopy, signpostFor, insurerResetBasis, nextResetDate, weeksUntil, phiResetNudgeCopy, phiDetectedCopy, type RecurringOccurrence, type ResetBasis } from "./lib/advisory";
import { findPhisProduct } from "./lib/phis-seed";
import { matchEnergyOffer, getOfferById, buildReferralUrl, opportunityTakesEnergyCta, type PartnerDB } from "./lib/partners";
import { deriveWfhHours, generateWfhDiary, type WfhLeaveRange } from "./lib/work-use";
import { applyUserRules, RULE_CREDIT_BUCKETS } from "./lib/rules";
import { sha256hex, sha256hexBytes } from "./lib/base64";
import { getLLM, type LLM } from "./llm";
import { extractReceipt, extractReceipts, extractFromText, extractColumnMap, extractStatement, extractBatch, extractSituationDraft, extractOccupationRules, extractGuide, extractAnswer, classifyDocument, extractPayslip, extractIncomeStatement, extractNoticeOfAssessment, extractAgentStatement, extractDepreciationSchedule, extractDividend, extractHealthClaim, batchParams, parseBatchMessage, mapBatchItems, ALLOWED_NAV_ROUTES, type Extracted, type ExtractedStatement, type SituationDraft, type OccupationRulesDraft, type AnswerResult } from "./extract";
import { mapIncomeStatementToRows } from "./lib/income-statement";
import { fyForDate, buildReport, useStatusDeniedExpr, propertyUndeterminedGatedExpr } from "./lib/report";
import { runScan, type ScanResult, type ScanTxn } from "./lib/scan";
import { getProgress } from "./lib/progress";
import { buildGuidePrompt, buildAskSystem, summariseReportForAsk, renderTxnDigest } from "./lib/guide";
import { fyLabel, fyBounds, fyStartYearStr, parseFyStartYear, normaliseFyLabel } from "./lib/ledger-totals";
import { resolveJurisdictionForUser, currentFyStartYearFor, baseCurrencyOf, AU_DESCRIPTOR, type JurisdictionDescriptor } from "./lib/jurisdiction";
import { assessReadiness, type FilingReadiness, type FilingReadinessSignals } from "./lib/readiness";
import { rollSchedule, balancingAdjustment, fyStartYearOf, isLowCostAsset, looksLikePersonalTransfer, assetDepreciatesForTaxpayer, depMethodConflict, resolveDiv40Life, type DepAsset } from "./lib/depreciation";
import { matchClaimRules, suggestionText, enumerateSituationClaims, classifyClaim, uncoveredOccupations, ruleKey, type ClaimRule, type ClaimContext, type ClaimSituation } from "./lib/claimability";
import { parseCsv, applyColumnMap, lineFingerprint, deriveBalances, reconcileStatement, isLiabilityAccount, fuzzyMerchant, isTransferLike, isLoanInterestLine, classifyMovement, movementTreatment, type ColumnMap, type Reconciliation, type StatementLine, type MovementClass } from "./lib/statements";
import { groupKey, groupForClarify, rulePatternForStem, isClarifyLeftover, CLARIFY_LEFTOVER_WHERE, type ClarifyRow } from "./lib/clarify";
import { scoreClaimMatches, type ScoredTxn } from "./lib/claim-match";
import { batchStatementStatus, isStaleBatch } from "./lib/batch";
import { cleanMerchant } from "./lib/bank-parsers";
import { pdfPageCount, splitPdf, normalizePdf } from "./lib/pdf";
import { getLedger, LedgerNotConnectedError, LedgerReauthError, type LedgerExpense } from "./ledger";
import { redact } from "./lib/redact";
import { toBaseCurrency } from "./lib/fx";
import { spentTodayCents, spentTodayGlobalCents, spentThisMonthGlobalCents, noteMeteringError, usageStatements } from "./lib/usage";
import { billingPolicy, freeCreditGrantE4 } from "./lib/billing";
import { parseTransactionAlert } from "./lib/bank-parsers";
import auV1RulePack from "./rulepacks/au-v1.json";
import { assertBucketKeys, isBucket, isPropertyBucket, normalizeAtoLabel, DEDUCTIBILITY_STATES } from "./lib/taxonomy";
import { verdictForTxn } from "./lib/deductibility";
import { featureOn, categoriseMode } from "./lib/features";

const CONFIDENCE_THRESHOLD = 0.85;
// Above this many to-categorise lines, route to the async Message Batches API (~50% cheaper);
// at or below, categorise synchronously so normal imports stay instant. Used in `auto` mode.
const BATCH_THRESHOLD = 60;
// Safety ceiling for forced `live` mode: a synchronous run does one ~5–15s Claude call per 40-line
// chunk, sequentially, inside a single DO request. Past this many lines that risks DO CPU/time/
// subrequest limits (e.g. a 1,500-line backfill ≈ 38 calls), so we fall back to batch and record the
// override rather than time out mid-run. Not a silent cap — the fallback is audited + notified.
const LIVE_MAX_LINES = 200;

type RulePack = typeof auV1RulePack;

// ── Stage A return shapes (sweepMovements) ─────────────────────────────────────
// A captured bank line the deterministic matcher believes is a non-spend MOVEMENT. No verdict is
// applied until the user confirms — these are presented PRE-CHECKED for one-tap sign-off.
export interface MovementCandidate {
  id: string;
  merchant: string | null;
  raw_description: string | null;
  amount_cents: number | null;
  amount_aud_cents: number | null;
  direction: string | null;
  txn_date: string | null;
  account_id: string | null; // the source account — lets the loan-split UI pre-fill from loans_properties
  klass: MovementClass;
  reason: string;
}
// ── Stage B clarify-by-pattern return shapes ───────────────────────────────────
export interface ClarifyQuestion {
  id: string;
  fy: string;
  group_key: string;
  sample_desc: string | null;
  direction: string | null;
  n: number;
  total_cents: number;
  suggestions: import("./lib/clarify").ClarifySuggestion[];
  status: string;
}
/** A single clarify answer — one tap. The UI fills concrete fields from the chosen suggestion. */
export interface ClarifyAnswer {
  kind: import("./lib/clarify").ClarifyAnswerKind;
  bucket?: string;
  ato_label?: string;
  property_id?: string;
}

/** The sign-off pack counts a "Do my books" run hands back. */
export interface AccountantSummary {
  run_id: string;
  fy: number;
  movement_candidates: number; // non-spend lines to confirm-and-exclude (Stage A)
  property_loan_review: number; // loan lines to review (possible deductible interest)
  deductibility_stamped: number; // payg rows (re-)classified deny/apportion/suggest
  suggestions: number; // suggested_deductible rows to confirm (Stage D)
  clarify_questions: number; // grouped questions to answer (Stage B)
  claim_items: number; // open claim suggestions to attach evidence to (Stage E)
}

export interface MovementSweep {
  // Pre-checked confirm list: safe transfers/card payments, investment deposits, and non-property
  // loan repayments → excluding these as 'ignored' won't drop a deductible amount.
  ignorable: MovementCandidate[];
  // Loan/mortgage lines tied to (or plausibly tied to) a rental property — these may carry a
  // DEDUCTIBLE investment-loan interest component (s8-1), so they are surfaced for review and are
  // NEVER offered for one-tap exclusion (B3).
  property_loan_review: MovementCandidate[];
  summary: { ignorable_n: number; ignorable_total_cents: number; review_n: number };
}

// ── "Find My Claims" return shape (reviewClaims) ───────────────────────────────
// A single situational claim, GENERAL-INFO framed. `rule_id` is the stable ruleKey (D1 id or
// scope pair). No dollar figure is ever carried — this answers "what could you claim", not "how much".
export interface ClaimReviewItem {
  rule_id: string;
  scope_type: string;
  scope_value: string;
  ato_label: string | null;
  claim_type: string;
  defer_to_agent: number;
  suggestion: string;
  why_applies: string;
}
export interface ClaimReview {
  fy: string;
  capturing: ClaimReviewItem[];
  check: ClaimReviewItem[];
  defer: ClaimReviewItem[];
  uncovered_occupations: string[];
}

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
  refund_for_txn_id: "refund_for_txn_id", // #258: on a refund credit, the deductible expense it reverses
  paid_account: "paid_account", // drives reconcile-vs-push in Phase 3
};

// Default AU rule pack is the canonical JSON in src/rulepacks/ (single source of truth
// shared with the eval harness). Overridable per-version via KV `rulepack:<ver>`.
const DEFAULT_RULE_PACK: RulePack = auV1RulePack;

// Per-FY policy thresholds (instant-asset-write-off + car limit) read from the BUNDLED pack — these
// are AU policy shipped in code, used by the depreciation engine. Reading them from the bundle (not
// per-tenant KV) keeps depreciation decoupled from a loaded profile, so a single-asset schedule
// compute can't throw just because the profile row is missing (e.g. mid-deletion).
type FyThreshold = { instant_asset_write_off_cents?: number; car_limit_cents?: number; immediate_non_business_cents?: number };
const FY_THRESHOLDS: Record<string, FyThreshold> =
  (DEFAULT_RULE_PACK as { thresholds_by_fy?: Record<string, FyThreshold> }).thresholds_by_fy ?? {};

/**
 * The IAWO / car-limit thresholds for an FY. Falls back to the NEAREST known FY (by start year) when
 * the exact FY isn't in the pack, so an asset acquired outside the table's window is still BOUNDED
 * rather than fully expensed (the bug this guards). NOTE: historical "temporary full expensing"
 * (2020–2023) isn't modelled — a pre-window asset is conservatively bounded, not unbounded; refining
 * the historical timeline is a tracked follow-up.
 */
function thresholdForFy(fy: string): FyThreshold | undefined {
  if (FY_THRESHOLDS[fy]) return FY_THRESHOLDS[fy];
  const years = Object.keys(FY_THRESHOLDS);
  if (!years.length) return undefined;
  const target = Number(fy.slice(0, 4));
  let best: string | undefined;
  let bestDist = Infinity;
  for (const y of years) {
    const dist = Math.abs(Number(y.slice(0, 4)) - target);
    if (dist < bestDist) { bestDist = dist; best = y; }
  }
  return best ? FY_THRESHOLDS[best] : undefined;
}

/**
 * Deterministic per-user override. Returns the highest-priority rule whose pattern
 * matches the merchant, or null. Rules are pre-sorted by priority DESC in getSituation.
 * Pure + side-effect-free so it can be unit-tested without the API.
 */
// applyUserRules + the direction guard live in ./lib/rules (pure → unit-tested).

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

    // Daily AI-budget gate BEFORE storing the file or making the column-map / extraction calls — a
    // statement parse is one or more model calls (a multi-page PDF fans out per chunk), so refuse
    // cleanly when the per-user or global cap is hit instead of spending past it (C9). txnId is null
    // (no row to mark yet); the API layer maps this message to a 429.
    if (!(await this.withinBudget(userId, null))) throw new Error("ai_budget_reached");

    const fileHash = await sha256hexBytes(bytes);
    const existing = await this.env.DB.prepare(`SELECT id FROM statements WHERE user_id = ? AND file_hash = ?`)
      .bind(userId, fileHash)
      .first<{ id: string }>();
    if (existing) {
      return { statementId: existing.id, columnMap: null, preview: [], rowCount: 0, duplicate: true };
    }

    const statementId = crypto.randomUUID();
    const fileKey = `${userId}/statements/${statementId}`;

    // Resolve the LLM (validates the inference provider + any required secrets) BEFORE writing the
    // file to R2 — a misconfigured Bedrock tenant throws here, and doing it first means a config
    // error leaves nothing orphaned in R2 (S3). Anthropic path is a cheap client construct, no I/O.
    const llm = await getLLM(this.env, profile, { userId });
    await this.env.RECEIPTS.put(fileKey, bytes, { httpMetadata: { contentType: format === "pdf" ? "application/pdf" : "text/csv" } });
    await this.auditXborderInference(userId, provider, "parse_statement", llm.modelId);

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
        // retry), long enough for Cloudflare's gateway to 502 the request.
        // BUT don't let one chunk sink the whole file: when a long statement fans out to many
        // concurrent Haiku calls, a single chunk can transiently 429/529 (or hit a one-off bad
        // extraction). Promise.all would abort the entire upload on that one rejection — which is
        // exactly how a 12-page statement failed with "layout wasn't recognised". So gather with
        // allSettled, then RETRY any failed chunk once SEQUENTIALLY (no concurrency pressure the
        // second time, which clears transient overloads). Order is preserved for stitching; only a
        // genuine second failure hard-fails, so we never silently drop pages.
        const settled = await Promise.allSettled(chunks.map((c) => extractStatement(llm, c, "application/pdf", { isLiability })));
        const exts: ExtractedStatement[] = [];
        for (let i = 0; i < chunks.length; i++) {
          const s = settled[i];
          exts.push(s && s.status === "fulfilled" ? s.value : await extractStatement(llm, chunks[i]!, "application/pdf", { isLiability }));
        }
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
      const bal = deriveBalances(lines, isLiability);
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
  /**
   * Auto-run the deterministic "Do my books" pass after an import so the Sort queues (movement sweep,
   * clarify, suggestions) are populated WITHOUT the user pressing a button. Deterministic + free
   * (no LLM). Runs ONCE per distinct FY the imported lines touch (a statement can straddle 30 June),
   * and is BEST-EFFORT: a concurrent manual pass holds the per-(user,fy) in-flight lock and throws —
   * we swallow it so the import flow never errors on the auto-run (the user can always re-scan).
   * Gated on the accountant_pass flag — with it off the Sort queues aren't shown, so there's nothing
   * to populate.
   */
  private async autoAccountantPassAfterImport(userId: string, statementIds: string[]): Promise<void> {
    if (!statementIds.length || !featureOn(this.env, "accountant_pass")) return;
    const ph = statementIds.map(() => "?").join(",");
    const range = await this.env.DB.prepare(
      `SELECT MIN(txn_date) AS lo, MAX(txn_date) AS hi
         FROM transactions WHERE user_id = ? AND statement_id IN (${ph}) AND kind = 'bank_line' AND txn_date IS NOT NULL`,
    )
      .bind(userId, ...statementIds)
      .first<{ lo: string | null; hi: string | null }>();
    if (!range?.lo || !range?.hi) return;
    const fyStart = (d: string) => (Number(d.slice(5, 7)) >= 7 ? Number(d.slice(0, 4)) : Number(d.slice(0, 4)) - 1);
    // Clamp the FY window so a single mis-parsed date (e.g. an OCR'd 01/01/9999) can't blow the loop into
    // thousands of full-tenant passes and hang the DO: end no later than NEXT FY, span at most 8 FYs.
    const now = new Date();
    const curFy = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1; // getMonth: Jul = 6 = FY start
    const hiY = Math.min(fyStart(range.hi), curFy + 1);
    const loY = Math.max(fyStart(range.lo), hiY - 7);
    for (let y = loY; y <= hiY; y++) {
      try {
        await this.runAccountantPass(userId, y);
      } catch (e) {
        // Best-effort: an in-flight lock (a concurrent manual pass) is expected and fine; audit anything
        // else so a silently-failed pass is observable (the Sort page's "Re-scan" can always re-run it).
        await this.audit(userId, "accountant_pass_autorun_failed", JSON.stringify({ fy: y, error: (e as Error).message })).catch(() => {});
      }
    }
  }

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
    // The statement is denominated in the tenant's BASE currency (a UK bank statement is in GBP). AU ⇒
    // base='AUD' ⇒ byte-identical to the previous hardcoded 'AUD' literal + amount_aud_cents=amount_cents.
    const baseCur = baseCurrencyOf(this.env, await this.jurisdictionFor(userId));

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
    // Occurrence counter per (date, amount, direction, merchant): genuine same-day repeat lines on a
    // balance-less statement (credit cards) must each get a distinct fingerprint, or the unique-key
    // guard silently drops all but the first. Counted in parse order so a re-upload reproduces them.
    const occ = new Map<string, number>();
    for (const line of lines) {
      const base = `${line.date}|${line.amount_cents}|${line.direction ?? "debit"}|${cleanMerchant(line.raw_description).toLowerCase()}`;
      const occurrence = occ.get(base) ?? 0;
      occ.set(base, occurrence + 1);
      const fp = await lineFingerprint(stmt.account_id, line, occurrence);
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
        : this.deterministicCategorise(line.description, situation.rules, rulePack, { skipHints: line.direction === "credit", direction: line.direction });
      const status = transfer ? "ignored" : cat ? "extracted" : "needs_review";
      inserts.push(
        this.env.DB.prepare(
          `INSERT INTO transactions
             (id, user_id, source, status, kind, account_id, statement_id, line_fingerprint, raw_description,
              merchant, amount_cents, currency, amount_aud_cents, txn_date, direction, bucket, ato_label, confidence, property_id)
           VALUES (?, ?, 'statement', ?, 'bank_line', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          baseCur,           // statement is denominated in the tenant's base currency (AU ⇒ 'AUD')
          line.amount_cents, // base-currency statement = 1:1 (the amount IS in base)
          line.date,
          line.direction,
          cat?.bucket ?? null,
          cat?.ato_label ?? null,
          cat ? cat.confidence : null,
          cat?.property_id ?? null, // property-scoped rule re-attaches its property on import (M1)
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

    // imported_count = the statement's ACTUAL posted line count, not just this run's inserts —
    // re-confirming a statement dedup-skips every line (delta 0) and previously zeroed a correct
    // count. Also persist the reconcile result computed above so the flag reflects this import, not
    // a stale parse-time value.
    const posted = (await this.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND statement_id = ? AND kind = 'bank_line'`,
    ).bind(userId, statementId).first<{ n: number }>())?.n ?? imported;
    await this.env.DB.prepare(`UPDATE statements SET status='imported', imported_count=?, reconciled=?, recon_diff_cents=? WHERE id=?`)
      .bind(posted, recon.available ? (recon.ok ? 1 : 0) : null, recon.available ? recon.diff_cents : null, statementId)
      .run();
    await this.audit(userId, "statement_imported", JSON.stringify({ statementId, imported, skipped, posted }));

    // Batch-categorise the lines that the deterministic pass (rules+hints) didn't cover.
    const cat = await this.categoriseStatement(userId, statementId);
    // Any line a rule deterministically bucketed 'asset' becomes a depreciating asset now (the
    // LLM-categorised ones are linked when their batch applies — see categoriseStatement / poll).
    await this.linkAssetsForUser(userId);
    // Deny-by-default deductibility on deterministically-bucketed payg lines (LLM/batch-bucketed
    // lines are stamped when their batch applies — see pollBatchJobs). Covers the no-LLM-items and
    // consent-gated paths where categoriseStatement returns early before stamping.
    await this.stampDeductibility(userId);
    // Attach any existing receipts to the new lines (stops double-counting + donates GST).
    await this.matchReceiptsForUser(userId);
    // #165 — if this is a loan account whose statement itemises interest, sum those lines per FY and
    // record a statement_parsed loan-interest summary so the "Confirm loan interest" card prefills from
    // evidence (lender_summary still wins). Best-effort: never fail an import on this.
    await this.recomputeStatementLoanInterest(userId, stmt.account_id, stmt.account_type).catch((e) =>
      this.audit(userId, "loan_interest_autoparse_failed", JSON.stringify({ accountId: stmt.account_id, error: (e as Error).message })).catch(() => {}),
    );

    if (!quiet) {
      // Direct (single-statement) import: run the pass now so the Sort queues are ready. The bulk path
      // passes quiet=true and runs the pass ONCE at its own tail, so a multi-statement import doesn't
      // fire the pass per statement (which would trip the in-flight lock).
      await this.autoAccountantPassAfterImport(userId, [statementId]);
      await this.notify(
        userId,
        `Imported ${imported} transaction(s)${skipped ? ` (${skipped} already on file)` : ""}${cat.categorised ? `, categorised ${cat.categorised} with Claude` : ""}.`,
        null,
      );
    }
    return { imported, skipped };
  }

  /**
   * #165 — evidence-first loan interest from parsed statements. For a LOAN account, sum its itemised
   * "interest charged" lines per FY and upsert a `statement_parsed` loan-interest summary, so the
   * "Confirm loan interest" card prefills the real figure for the user to confirm rather than type.
   * Never overwrites a user-entered `lender_summary` (lender always wins); re-runs are idempotent
   * (the upsert replaces an earlier statement_parsed/estimate with the latest sum). Gated on
   * loan_interest_v2; a no-op for non-loan accounts.
   */
  private async recomputeStatementLoanInterest(userId: string, accountId: string, accountType: string | null): Promise<void> {
    if (!featureOn(this.env, "loan_interest_v2") || accountType !== "loan") return;
    // Only record a parsed summary for a loan that's actually tied to an income-producing property —
    // i.e. one that shows in the "Confirm loan interest" review (mirrors listLoanInterestReview's join).
    // A non-rental loan's interest isn't deductible, so don't write a figure for it.
    const linked = await this.env.DB.prepare(
      `SELECT 1 FROM loans_properties lp
         JOIN properties p ON p.id = lp.property_id AND p.user_id = lp.user_id
        WHERE lp.user_id = ? AND lp.loan_account_id = ? AND p.status IN ('rented','vacant') LIMIT 1`,
    )
      .bind(userId, accountId)
      .first();
    if (!linked) return;
    const res = await this.env.DB.prepare(
      `SELECT raw_description, merchant, txn_date, direction, amount_cents, amount_aud_cents
         FROM transactions
        WHERE user_id = ? AND account_id = ? AND kind = 'bank_line' AND txn_date IS NOT NULL`,
    )
      .bind(userId, accountId)
      .all<{ raw_description: string | null; merchant: string | null; txn_date: string; direction: string | null; amount_cents: number | null; amount_aud_cents: number | null }>();
    const fyStart = (d: string) => (Number(d.slice(5, 7)) >= 7 ? Number(d.slice(0, 4)) : Number(d.slice(0, 4)) - 1);
    const byFy = new Map<number, number>();
    for (const r of res.results ?? []) {
      // Only interest CHARGED (a debit on the loan) — never an interest credit/reversal/adjustment,
      // which would otherwise inflate the sum via abs() and over-state deductible interest.
      if ((r.direction ?? "debit") !== "debit") continue;
      if (!isLoanInterestLine(r.raw_description ?? r.merchant ?? "")) continue;
      const cents = Math.abs(r.amount_aud_cents ?? r.amount_cents ?? 0);
      if (cents <= 0) continue;
      const fy = fyStart(r.txn_date);
      byFy.set(fy, (byFy.get(fy) ?? 0) + cents);
    }
    for (const [fy, cents] of byFy) {
      // Lender summary is the user's confirmed figure — never overwrite it with a parsed estimate.
      const existing = await this.env.DB.prepare(
        `SELECT source FROM loan_interest_summaries WHERE user_id = ? AND loan_account_id = ? AND fy = ?`,
      )
        .bind(userId, accountId, String(fy))
        .first<{ source: string }>();
      if (existing?.source === "lender_summary") continue;
      await this.setLoanInterest(userId, accountId, fy, cents, "statement_parsed");
    }
    // Clear STALE statement_parsed summaries: byFy is the complete set of FYs that currently have
    // interest lines on this account, so any statement_parsed row for an FY no longer present (the user
    // deleted/corrected the lines) is orphaned and must not keep feeding the position. Never touches a
    // user lender_summary or a stored estimate.
    const parsed = await this.env.DB.prepare(
      `SELECT fy FROM loan_interest_summaries WHERE user_id = ? AND loan_account_id = ? AND source = 'statement_parsed'`,
    )
      .bind(userId, accountId)
      .all<{ fy: string }>();
    for (const row of parsed.results ?? []) {
      if (byFy.has(parseFyStartYear(row.fy))) continue;
      await this.env.DB.prepare(
        `DELETE FROM loan_interest_summaries WHERE user_id = ? AND loan_account_id = ? AND fy = ? AND source = 'statement_parsed'`,
      )
        .bind(userId, accountId, row.fy)
        .run();
    }
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
    // One pass for the whole bulk import, across every FY the imported lines touched (best-effort).
    await this.autoAccountantPassAfterImport(userId, ids);
    await this.notify(
      userId,
      `Imported ${statements} statement(s): ${imported} transaction(s)${skipped ? `, ${skipped} already on file` : ""}${errors.length ? `. ${errors.length} couldn't import (e.g. didn't reconcile) — review them.` : "."}`,
      null,
    );
    return { statements, imported, skipped, errors };
  }

  /**
   * Remove a statement record + its parsed-lines sidecar in R2.
   *
   * Default (purge=false): only a stuck 'parsed' or 'failed' upload can be removed, and imported
   * transactions are never touched — this just clears the upload record.
   *
   * purge=true: also delete this statement's imported bank_lines (and un-match any receipts that
   * pointed at them), so the statement can be cleanly RE-UPLOADED — the recovery path for the
   * credit-card de-dup fix, where past imports dropped genuine repeat/refund lines. Destructive:
   * re-importing re-runs categorisation and loses manual corrections on those lines. Audited.
   */
  async deleteStatement(userId: string, statementId: string, purge = false): Promise<{ deleted: boolean; linesRemoved: number }> {
    const stmt = await this.env.DB.prepare(`SELECT file_key, status FROM statements WHERE id = ? AND user_id = ?`)
      .bind(statementId, userId)
      .first<{ file_key: string | null; status: string }>();
    if (!stmt) return { deleted: false, linesRemoved: 0 };
    const imported = stmt.status !== "parsed" && stmt.status !== "failed";
    // An imported/categorising statement can only be removed with an explicit purge (which also
    // deletes its lines) — a bare remove would strip the R2 sidecar while leaving the ledger rows,
    // and the de-dup guard would then block re-importing them.
    if (imported && !purge) {
      throw new Error("this statement is imported — use 'Remove + re-import' to delete its transactions and re-upload");
    }
    let linesRemoved = 0;
    if (purge) {
      // Un-match receipts attached to these lines so they don't dangle (restore them to extracted),
      // then delete the bank_lines. Done before the row delete so the ids are still resolvable.
      await this.env.DB.prepare(
        `UPDATE transactions SET matched_txn_id = NULL, status = 'extracted'
          WHERE user_id = ? AND kind = 'receipt' AND matched_txn_id IN
            (SELECT id FROM transactions WHERE user_id = ? AND statement_id = ? AND kind = 'bank_line')`,
      )
        .bind(userId, userId, statementId)
        .run();
      const del = await this.env.DB.prepare(
        `DELETE FROM transactions WHERE user_id = ? AND statement_id = ? AND kind = 'bank_line'`,
      )
        .bind(userId, statementId)
        .run();
      linesRemoved = del.meta?.changes ?? 0;
    }
    if (stmt.file_key) {
      // Best-effort R2 cleanup: the original upload + the normalised-lines sidecar parse wrote.
      await this.env.RECEIPTS.delete(stmt.file_key).catch(() => {});
      await this.env.RECEIPTS.delete(`${stmt.file_key}.lines`).catch(() => {});
    }
    await this.env.DB.prepare(`DELETE FROM statements WHERE id = ? AND user_id = ?`).bind(statementId, userId).run();
    await this.audit(userId, "statement_deleted", JSON.stringify({ statementId, status: stmt.status, purge, linesRemoved }));
    return { deleted: true, linesRemoved };
  }

  /**
   * One-time repair of statements imported before fixes landed (run once via a KV-guarded cron):
   *  - statements that DROPPED lines under the old credit-card de-dup bug (actual bank_lines <
   *    row_count) are re-imported from their stored R2 sidecar with the fixed direction+occurrence
   *    fingerprint (purge existing lines + un-match receipts, then confirmImport(force,quiet)) —
   *    recovering the dropped repeats, no re-upload needed;
   *  - every other statement just has stale flags corrected in place: imported_count set to the
   *    actual line count (fixes a 0 left by a re-confirm), and a reconciled=0 flag recomputed from
   *    the sidecar (parse-time value may predate the reconcile fixes).
   * Idempotent: once actual == row_count and flags are set, a re-run changes nothing.
   */
  async repairStatements(userId: string): Promise<{ statements: number; recovered: number; flagsFixed: number }> {
    const stmts = await this.env.DB.prepare(
      `SELECT s.id, s.file_key, s.row_count, s.imported_count, s.reconciled, s.opening_cents, s.closing_cents,
              a.type AS account_type
         FROM statements s LEFT JOIN accounts a ON a.id = s.account_id AND a.user_id = s.user_id
        WHERE s.user_id = ? AND s.status = 'imported'`,
    )
      .bind(userId)
      .all<{ id: string; file_key: string | null; row_count: number; imported_count: number | null; reconciled: number | null; opening_cents: number | null; closing_cents: number | null; account_type: string | null }>();
    let statements = 0;
    let recovered = 0;
    let flagsFixed = 0;
    const recoveredIds: string[] = [];
    for (const s of stmts.results ?? []) {
      const actual = (await this.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND statement_id = ? AND kind = 'bank_line'`,
      ).bind(userId, s.id).first<{ n: number }>())?.n ?? 0;

      // Read + validate the sidecar ONCE, up front. Purging before confirming the sidecar is
      // readable/parseable would risk an empty statement if the re-read later failed — so the gap
      // branch only deletes after we hold good lines here.
      let sidecarLines: StatementLine[] | null = null;
      if (s.file_key) {
        const sc = await this.env.RECEIPTS.get(`${s.file_key}.lines`);
        if (sc) {
          try {
            const parsed = JSON.parse(await sc.text());
            if (Array.isArray(parsed)) sidecarLines = parsed as StatementLine[];
          } catch {
            /* unreadable sidecar → leave the statement untouched */
          }
        }
      }

      if (sidecarLines && sidecarLines.length && actual < s.row_count) {
        // Dropped lines → re-import from the sidecar with the fixed fingerprint. Purge existing lines
        // (un-matching any receipts first) but KEEP the record + sidecar, then confirmImport re-reads it.
        await this.env.DB.prepare(
          `UPDATE transactions SET matched_txn_id = NULL, status = 'extracted'
            WHERE user_id = ? AND kind = 'receipt' AND matched_txn_id IN
              (SELECT id FROM transactions WHERE user_id = ? AND statement_id = ? AND kind = 'bank_line')`,
        )
          .bind(userId, userId, s.id)
          .run();
        await this.env.DB.prepare(
          `DELETE FROM transactions WHERE user_id = ? AND statement_id = ? AND kind = 'bank_line'`,
        )
          .bind(userId, s.id)
          .run();
        const r = await this.confirmImport(userId, s.id, undefined, true, true); // force past the gate, quiet
        recovered += Math.max(0, r.imported - actual);
        recoveredIds.push(s.id);
        statements++;
      } else {
        // No missing lines (or no sidecar to recover from) — correct stale counters/flags in place.
        let fixed = false;
        if ((s.imported_count ?? -1) !== actual) {
          await this.env.DB.prepare(`UPDATE statements SET imported_count = ? WHERE id = ? AND user_id = ?`).bind(actual, s.id, userId).run();
          fixed = true;
        }
        if (s.reconciled !== 1 && sidecarLines) {
          const recon = reconcileStatement(sidecarLines, s.opening_cents, s.closing_cents, isLiabilityAccount(s.account_type));
          await this.env.DB.prepare(`UPDATE statements SET reconciled = ?, recon_diff_cents = ? WHERE id = ? AND user_id = ?`)
            .bind(recon.available ? (recon.ok ? 1 : 0) : null, recon.available ? recon.diff_cents : null, s.id, userId)
            .run();
          fixed = true;
        }
        if (fixed) flagsFixed++;
      }
    }
    // Recovered lines re-materialised → repopulate the Sort queues for the FYs they touch (best-effort).
    await this.autoAccountantPassAfterImport(userId, recoveredIds);
    await this.audit(userId, "statements_repaired", JSON.stringify({ statements, recovered, flagsFixed }));
    return { statements, recovered, flagsFixed };
  }

  /**
   * Batch-categorise statement bank lines the deterministic pass left as needs_review.
   * One Claude call per ~40 lines (not per line); budget-aware (stops at MAX_DAILY_COST_CENTS
   * via withinBudget) — over budget the remainder stays needs_review. Bulk jobs go async (Batch API).
   */
  async categoriseStatement(userId: string, statementId: string, opts?: { bulk?: boolean }): Promise<{ categorised: number }> {
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
    await this.auditXborderInference(userId, provider, "categorise_statement", llm.modelId);

    // Route between synchronous "live" and the async Batch API. Per-tenant `categorise_mode` (or the
    // CATEGORISE_MODE env default) can force either path so we can A/B the UX and compare measured
    // cost; `auto` keeps the size-based default. Forced `live` does ONE sequential ~5-15s Claude call
    // per 40-line chunk inside a single DO request, so two cases fall back to the async batch path to
    // avoid exhausting the DO mid-run: (1) an oversized single upload (>LIVE_MAX_LINES), and (2) the
    // bulk re-categorisation backfill (recategorise loops this over many statements in one request —
    // many sub-cap statements still sum to thousands of lines). Bulk recategorisation IS what batch is
    // for, so it stays quiet; only the interactive oversized upload tells the user why.
    // Bedrock has no Anthropic Batch API — those tenants always categorise live (sequential
    // per-chunk), regardless of size/mode. Resolve this FIRST so the user-facing copy below tells
    // the truth: a Bedrock tenant must not be told their oversized import "ran in the cheaper batch"
    // when it actually ran live at full price (S2).
    const canBatch = provider !== "bedrock";
    const mode = categoriseMode(this.env, profile);
    let useBatch = canBatch && (mode === "batch" || (mode === "auto" && items.length > BATCH_THRESHOLD));
    if (mode === "live" && (opts?.bulk || items.length > LIVE_MAX_LINES)) {
      useBatch = canBatch;
      if (!opts?.bulk) {
        await this.audit(userId, "categorise_mode_fallback", JSON.stringify({ statementId, lines: items.length, from: "live", to: useBatch ? "batch" : "live_chunked", limit: LIVE_MAX_LINES }));
        await this.notify(
          userId,
          useBatch
            ? `That import (${items.length} lines) is too large to categorise live, so it ran in the cheaper background batch instead — results will fill in shortly.`
            : `That import (${items.length} lines) is large, so it's categorising in the background — results will fill in shortly.`,
          null,
        );
      }
    }
    if (useBatch) {
      // Budget gate guards the async path too — Anthropic bills the Batch API at SUBMISSION, so an
      // un-gated submit spends real money even though results land later. Over budget, leave the
      // lines needs_review; the next run (after the daily reset) re-queues them. This is also what
      // makes the cron-driven recategorise backfill budget-aware (it loops this per statement).
      if (!(await this.withinBudget(userId, null))) {
        await this.audit(userId, "categorise_skipped_budget", JSON.stringify({ statementId, lines: items.length }));
        return { categorised: 0 };
      }
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
      for (const { id, item } of mapBatchItems(chunk.map((c) => c.id), results)) {
        updates.push(
          this.env.DB.prepare(
            `UPDATE transactions SET status='extracted', bucket=?, ato_label=?, confidence=?, reasoning=? WHERE id=? AND user_id=?`,
          ).bind(item.bucket, item.ato_label, item.confidence, item.reasoning, id, userId),
        );
        categorised++;
      }
      if (updates.length) await this.env.DB.batch(updates);
    }
    await this.audit(userId, "statement_categorised", JSON.stringify({ statementId, categorised }));
    // Deny-by-default deductibility on the freshly-categorised payg lines (statement spend is where
    // the founder's private living costs land in bulk). Scans this tenant's still-undetermined payg.
    await this.stampDeductibility(userId);
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

    // Skip statements that already have an in-flight batch (status 'submitted'): re-submitting their
    // lines would create a SECOND batch and Anthropic bills per submission, so the same work is paid
    // for twice (C6). The pending batch will categorise these lines; a later backfill tick re-queues
    // anything it leaves behind once the job has been applied/failed.
    const stmts = await this.env.DB.prepare(
      `SELECT DISTINCT t.statement_id FROM transactions t
        WHERE t.user_id = ? AND t.kind = 'bank_line' AND t.status = 'needs_review' AND t.statement_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM batch_jobs b
             WHERE b.user_id = t.user_id AND b.statement_id = t.statement_id AND b.status = 'submitted'
          )`,
    )
      .bind(userId)
      .all<{ statement_id: string }>();
    let count = 0;
    for (const s of stmts.results ?? []) {
      await this.categoriseStatement(userId, s.statement_id, { bulk: true }); // bulk → batch (never long sync runs)
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
        // Accumulate the WHOLE job's token usage and meter it ONCE, atomically with the status flip
        // below — never per-result. The Batch API already billed at submission; this only feeds the
        // spend counter/budget gate. The apply UPDATEs are idempotent (status='needs_review' guard),
        // so if a poll crashes mid-stream the job stays 'submitted', the next poll re-streams + re-
        // applies harmlessly, and metering lands exactly once when the job finally reaches 'applied'.
        // (Old code metered per-result BEFORE the flip → a mid-stream crash re-charged the batch.)
        const jobUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
        const stream = await llm.client.messages.batches.results(job.batch_id);
        for await (const res of stream) {
          if (res.result.type !== "succeeded") {
            errored++;
            continue;
          }
          const msg = res.result.message;
          if (msg.usage) {
            jobUsage.input_tokens += msg.usage.input_tokens ?? 0;
            jobUsage.output_tokens += msg.usage.output_tokens ?? 0;
            jobUsage.cache_read_input_tokens += msg.usage.cache_read_input_tokens ?? 0;
            jobUsage.cache_creation_input_tokens += msg.usage.cache_creation_input_tokens ?? 0;
          }
          const lineIds = chunkMap[res.custom_id] ?? [];
          const updates: D1PreparedStatement[] = [];
          for (const { id, item } of mapBatchItems(lineIds, parseBatchMessage(msg))) {
            updates.push(
              this.env.DB.prepare(
                // only touch still-pending lines (a receipt-matched line is already categorised)
                `UPDATE transactions SET status='extracted', bucket=?, ato_label=?, confidence=?, reasoning=? WHERE id=? AND user_id=? AND status='needs_review'`,
              ).bind(item.bucket, item.ato_label, item.confidence, item.reasoning, id, userId),
            );
            applied++;
          }
          for (let k = 0; k < updates.length; k += 50) await this.env.DB.batch(updates.slice(k, k + 50));
        }
        // Meter (if any cost was incurred) + flip the job to 'applied' + resolve the statement
        // status, all in ONE transaction. Bundling the statement update in (instead of a separate
        // .run() after the flip) closes a stuck-state window: previously a throw between the flip
        // and the statement update left the job 'applied' (never re-polled) but the statement on
        // 'categorising' forever. If the batch fails, leave the job 'submitted' to retry cleanly.
        const { cents, stmts } = usageStatements(this.env, userId, "statement_batch", llm.modelId, jobUsage, 0.5);
        try {
          await this.env.DB.batch([
            ...(cents > 0 ? stmts : []),
            this.env.DB.prepare(`UPDATE batch_jobs SET status='applied' WHERE id=?`).bind(job.id),
            // If every chunk errored and nothing applied, the import succeeded but categorisation
            // failed — mark the statement so the lines don't look stuck 'categorising'.
            this.env.DB.prepare(`UPDATE statements SET status=? WHERE id=?`).bind(batchStatementStatus(applied, errored), job.statement_id),
          ]);
        } catch (e) {
          await noteMeteringError(this.env, userId, e);
          continue; // job stays 'submitted' — retry on the next poll (no double-charge: nothing metered)
        }
        await this.audit(userId, "batch_applied", JSON.stringify({ batchId: job.batch_id, applied, errored }));
        // Async-categorised capital purchases become depreciating assets now (their bucket only
        // just landed). Idempotent — links only newly-bucketed 'asset' lines.
        await this.linkAssetsForUser(userId);
        // Deny-by-default deductibility on the payg lines this batch just bucketed.
        await this.stampDeductibility(userId);
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
    opts: { skipHints?: boolean; direction?: string | null } = {},
  ): { bucket: string; ato_label: string; confidence: number; property_id?: string | null } | null {
    const rule = applyUserRules(merchant, rules, opts.direction);
    // A property-scoped rule carries its property_id so a learned rental rule re-attaches the property
    // on future imports (without this the line re-buckets to property_rented but lands property_id=NULL
    // → counted in the individual headline, not the property's schedule).
    if (rule) return { bucket: rule.bucket, ato_label: rule.ato_label, confidence: 1, property_id: rule.property_id ?? null };
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

  /**
   * Disconnect QuickBooks: revoke the token at Intuit + delete the stored connection (and cached
   * account map), then audit it. Audited write → goes through the DO. Records only whether the
   * remote revoke succeeded, never any token value.
   */
  async disconnectQuickBooks(userId: string): Promise<{ ok: boolean; revoked: boolean }> {
    const r = await revokeAndDisconnect(this.env, userId);
    await this.audit(userId, "qbo_disconnect", JSON.stringify({ revoked: r.revoked }));
    return r;
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
    await this.auditXborderInference(userId, provider, "categorise", llm.modelId);
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
    const rule = applyUserRules(parsed.merchant, situation.rules, "debit"); // a receipt is spend
    const final: Extracted = rule
      ? {
          ...parsed,
          bucket: rule.bucket as Extracted["bucket"],
          ato_label: rule.ato_label,
          property_id: rule.property_id ?? parsed.property_id,
          confidence: 1,
        }
      : parsed;

    // Currency: AU GST only applies to base-currency (AUD) supplies — force null for anything foreign
    // (defensive, on top of the prompt rule). Convert to the tenant's BASE currency for reporting
    // (estimate; the authoritative base amount is the reconciled bank-feed line). AU ⇒ base='AUD' ⇒
    // byte-identical to the legacy `=== "AUD"` behaviour.
    const base = baseCurrencyOf(this.env, await this.jurisdictionFor(userId));
    const currency = (final.currency ?? "AUD").trim().toUpperCase();
    const gstCents = currency === base ? final.gst_cents : null;
    const fx = await toBaseCurrency(this.env, final.amount_cents, currency, base, final.txn_date);
    // A foreign amount we couldn't convert (fx_rate null) has NO base value — flag it for review so
    // it's excluded-and-surfaced rather than summed un-converted into the position.
    const fxUnconverted = currency !== base && fx.fx_rate == null;
    const status = fxUnconverted ? "needs_review" : "extracted";

    await this.env.DB.prepare(
      `UPDATE transactions SET status=?, merchant=?, amount_cents=?, currency=?,
              amount_aud_cents=?, fx_rate=?, fx_date=?, gst_cents=?, txn_date=?, bucket=?,
              ato_label=?, property_id=?, paid_account=?, confidence=?, reasoning=? WHERE id=? AND user_id=?`,
    )
      .bind(
        status,
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

    // Deny-by-default deductibility: stamp a capture verdict on this payg line so the indicative
    // position can exclude clearly-private spend now (not just at year-end review). No-op for
    // non-payg buckets. Guarded so it never overrides a user's prior decision.
    await this.stampDeductibility(userId, { txnIds: [txnId] });

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
      components?: AmmaComponents | null; // Slice B: AMMA managed-fund component breakdown (managed_fund_distribution only)
    },
  ): Promise<string> {
    const id = crypto.randomUUID();
    // A property_id reaching the income table from the untrusted POST must belong to this tenant —
    // assertOwns no-ops on null/undefined, so trusted internal callers (clarify/payslip) are unaffected.
    await assertOwns(this.env, userId, [{ table: "properties", id: inc.property_id ?? undefined, label: "property" }]);
    const currency = (inc.currency ?? "AUD").trim().toUpperCase();
    const jur = await this.jurisdictionFor(userId);
    const baseCur = baseCurrencyOf(this.env, jur); // tenant's base currency (AU 'AUD' ⇒ byte-identical)
    const fy = inc.fy ?? fyForDate(inc.txn_date ?? null, jur) ?? this.currentFyLabel(jur);
    // ── Slice B: managed-fund (AMMA) component split (flag-gated AND presence-gated). When a
    // managed_fund_distribution carries components, the row's assessable gross is the ORDINARY portion only;
    // the capital-gain buckets are materialised into the CGT engine (below) so they aren't taxed as ordinary
    // income, and the AMIT cost-base amount stays out of the position. No components / flag off ⇒ unchanged.
    let grossCents = inc.gross_cents;
    let frankingCredit = inc.franking_credit_cents ?? 0;
    let foreignTax = inc.foreign_tax_paid_cents ?? null;
    let detailJson = inc.detail_json ?? null;
    let componentNeedsReview = 0;
    let materialiseCg = false;
    const comps = inc.income_type === "managed_fund_distribution" && featureOn(this.env, "mf_components") ? inc.components ?? null : null;
    if (comps) {
      const valid = validateComponents(comps).ok;
      grossCents = ordinaryAssessableCents(comps);
      frankingCredit = comps.franking_credit_cents;
      foreignTax = comps.foreign_tax_paid_cents;
      let base: Record<string, unknown> = {};
      try { base = inc.detail_json ? (JSON.parse(inc.detail_json) as Record<string, unknown>) : {}; } catch { base = {}; }
      detailJson = JSON.stringify({ ...base, components: comps });
      // v1 safety: only split into the CGT engine when the income is in the base currency (components
      // aren't FX-converted) and personal (cgtTotals isn't entity-scoped, so an entity's CG would leak
      // into the personal headline). Otherwise record the ordinary income + components but flag for
      // review and DON'T materialise the gain. AU ⇒ base='AUD' ⇒ byte-identical.
      const safeToSplit = valid && currency === baseCur && !inc.entity_id;
      componentNeedsReview = safeToSplit ? 0 : 1;
      materialiseCg = safeToSplit;
    }
    const fx = await toBaseCurrency(this.env, grossCents, currency, baseCur, inc.txn_date ?? null);
    // Convert the non-gross money columns to the base currency with the SAME rate as gross, so the
    // reporting seam (which sums these columns directly) never mixes currencies. Base-currency income →
    // rate 1 (no-op). Franking credits are an AU imputation amount, always AUD, so they're never converted.
    // A foreign amount we couldn't convert (fx_rate null) gets NO fabricated rate: leave every base
    // column NULL and flag the row for review so the position excludes-and-surfaces it (instead of
    // counting un-converted foreign cents, or rate-1 placeholders, as base). AU ⇒ base='AUD' ⇒ identical.
    const fxUnconverted = currency !== baseCur && fx.fx_rate == null;
    const rate = currency === baseCur ? 1 : fx.fx_rate ?? null;
    const toAudCents = (c: number | null | undefined): number | null => (c == null || rate == null ? null : Math.round(c * rate));
    const needsReview = (inc.needs_review ?? 0) || (fxUnconverted ? 1 : 0) || componentNeedsReview;
    await this.env.DB.prepare(
      `INSERT INTO income (id, user_id, person_id, entity_id, property_id, income_type, ato_label, fy,
         gross_cents, net_cents, withholding_cents, franking_credit_cents, foreign_tax_paid_cents,
         currency, amount_aud_cents, fx_rate, source_doc_id, txn_date, detail_json, needs_review)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id, userId, inc.person_id ?? `person_self_${userId}`, inc.entity_id ?? null, inc.property_id ?? null,
        inc.income_type, inc.ato_label ?? null, fy, grossCents, toAudCents(inc.net_cents),
        toAudCents(inc.withholding_cents) ?? 0, frankingCredit, toAudCents(foreignTax) ?? 0,
        currency, fx.amount_aud_cents, fx.fx_rate, inc.source_doc_id ?? null, inc.txn_date ?? null,
        detailJson, needsReview,
      )
      .run();
    await this.audit(userId, "income_recorded", JSON.stringify({ id, type: inc.income_type, gross: grossCents, fy }));
    // Slice B: materialise the AMMA capital-gain components into the CGT engine (after the row exists, so
    // income_id provenance is set). Personal + AUD + valid only (guarded above).
    if (comps && materialiseCg) {
      await syncIncomeCgtFromComponents(this.env, userId, id, comps, fy, inc.person_id ?? `person_self_${userId}`, inc.ato_label ?? null, inc.txn_date ?? null);
    }
    return id;
  }

  // ── CGT (#138): holdings + disposal events. The net capital gain is computed in src/lib/cgt.ts and
  // surfaced on the report behind the cgt_engine flag. These just persist the facts (user_id-scoped). ──
  async recordCgtAsset(
    userId: string,
    a: { person_id?: string | null; asset_kind: string; code?: string | null; label?: string | null; units?: number | null; acquired_date?: string | null; cost_base_cents: number; reduced_cost_base_cents?: number | null; main_residence_exempt?: number },
  ): Promise<string> {
    const id = crypto.randomUUID();
    await this.env.DB.prepare(
      `INSERT INTO cgt_assets (id, user_id, person_id, asset_kind, code, label, units, acquired_date, cost_base_cents, reduced_cost_base_cents, main_residence_exempt, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'held')`,
    )
      .bind(id, userId, a.person_id ?? `person_self_${userId}`, a.asset_kind, a.code ?? null, a.label ?? null, a.units ?? null, a.acquired_date ?? null, a.cost_base_cents ?? 0, a.reduced_cost_base_cents ?? null, a.main_residence_exempt ?? 0)
      .run();
    await this.audit(userId, "cgt_asset_recorded", JSON.stringify({ id, kind: a.asset_kind, code: a.code }));
    return id;
  }

  async recordCgtEvent(
    userId: string,
    e: { cgt_asset_id: string; fy?: string | null; event_type?: string | null; event_date: string; proceeds_cents: number; cost_base_used_cents: number; units_disposed?: number | null; discount_eligible?: boolean | null },
  ): Promise<string> {
    const id = crypto.randomUUID();
    const jur = await this.jurisdictionFor(userId);
    const fy = e.fy ?? fyForDate(e.event_date ?? null, jur) ?? this.currentFyLabel(jur);
    await this.env.DB.prepare(
      `INSERT INTO cgt_events (id, user_id, cgt_asset_id, fy, event_type, event_date, proceeds_cents, cost_base_used_cents, units_disposed, discount_eligible)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, userId, e.cgt_asset_id, fy, e.event_type ?? "disposal", e.event_date, e.proceeds_cents ?? 0, e.cost_base_used_cents ?? 0, e.units_disposed ?? null, e.discount_eligible == null ? null : e.discount_eligible ? 1 : 0)
      .run();
    await this.audit(userId, "cgt_event_recorded", JSON.stringify({ id, asset: e.cgt_asset_id, fy }));
    return id;
  }

  // ── ESS (#141): employee share scheme grants. assessable discount computed in src/lib/ess.ts. ──
  async recordEssGrant(
    userId: string,
    g: { person_id?: string | null; employer_entity_id?: string | null; scheme_type: string; grant_date?: string | null; taxing_point_date?: string | null; shares_or_options?: string | null; units?: number | null; discount_cents: number; market_value_cents?: number | null; ownership_gt_10pct?: number },
  ): Promise<string> {
    // Cross-tenant guard: a supplied person/employer must belong to this tenant (defaults are own).
    await assertOwns(this.env, userId, [
      { table: "persons", id: g.person_id, label: "person" },
      { table: "entities", id: g.employer_entity_id, label: "employer entity" },
    ]);
    const id = crypto.randomUUID();
    await this.env.DB.prepare(
      `INSERT INTO ess_grants (id, user_id, person_id, employer_entity_id, scheme_type, grant_date, taxing_point_date, shares_or_options, units, discount_cents, market_value_cents, ownership_gt_10pct)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, userId, g.person_id ?? `person_self_${userId}`, g.employer_entity_id ?? null, g.scheme_type, g.grant_date ?? null, g.taxing_point_date ?? null, g.shares_or_options ?? null, g.units ?? null, g.discount_cents ?? 0, g.market_value_cents ?? null, g.ownership_gt_10pct ?? 0)
      .run();
    await this.audit(userId, "ess_grant_recorded", JSON.stringify({ id, scheme: g.scheme_type }));
    return id;
  }

  // ── Logbook (#142): a 12-week vehicle logbook. Higher-of vs cents-per-km surfaced on the report. ──
  async recordVehicleLogbook(
    userId: string,
    lb: { person_id?: string | null; asset_id?: string | null; fy?: string | null; start_date?: string | null; end_date?: string | null; business_km?: number | null; total_km?: number | null; running_costs_cents: number; business_use_pct?: number | null },
  ): Promise<string> {
    const id = crypto.randomUUID();
    const fy = lb.fy ?? this.currentFyLabel(await this.jurisdictionFor(userId));
    await this.env.DB.prepare(
      `INSERT INTO vehicle_logbooks (id, user_id, person_id, asset_id, fy, start_date, end_date, business_km, total_km, running_costs_cents, business_use_pct)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, userId, lb.person_id ?? `person_self_${userId}`, lb.asset_id ?? null, fy, lb.start_date ?? null, lb.end_date ?? null, lb.business_km ?? null, lb.total_km ?? null, lb.running_costs_cents ?? 0, lb.business_use_pct ?? null)
      .run();
    await this.audit(userId, "vehicle_logbook_recorded", JSON.stringify({ id, fy }));
    return id;
  }

  // ── Trust (#139): a distribution to a beneficiary, character retained (src/lib/trust.ts). ──
  async recordTrustDistribution(
    userId: string,
    d: { trust_entity_id: string; fy?: string | null; beneficiary_person_id?: string | null; beneficiary_entity_id?: string | null; share_pct?: number | null; amount_cents: number; character?: string | null; franking_credit_cents?: number },
  ): Promise<string> {
    const id = crypto.randomUUID();
    const fy = d.fy ?? this.currentFyLabel(await this.jurisdictionFor(userId));
    await this.env.DB.prepare(
      `INSERT INTO trust_distributions (id, user_id, trust_entity_id, fy, beneficiary_person_id, beneficiary_entity_id, share_pct, amount_cents, character, franking_credit_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, userId, d.trust_entity_id, fy, d.beneficiary_person_id ?? `person_self_${userId}`, d.beneficiary_entity_id ?? null, d.share_pct ?? null, d.amount_cents ?? 0, d.character ?? "ordinary", d.franking_credit_cents ?? 0)
      .run();
    await this.audit(userId, "trust_distribution_recorded", JSON.stringify({ id, trust: d.trust_entity_id, fy }));
    return id;
  }

  // Slice E: a partner's share of partnership net income — same distributions table, source_kind='partnership'.
  // partnership_entity_id is stored in the (generic) trust_entity_id column.
  async recordPartnershipDistribution(
    userId: string,
    d: { partnership_entity_id: string; fy?: string | null; beneficiary_person_id?: string | null; share_pct?: number | null; amount_cents: number; character?: string | null; franking_credit_cents?: number },
  ): Promise<string> {
    const id = crypto.randomUUID();
    const fy = d.fy ?? this.currentFyLabel(await this.jurisdictionFor(userId));
    await this.env.DB.prepare(
      `INSERT INTO trust_distributions (id, user_id, trust_entity_id, fy, beneficiary_person_id, share_pct, amount_cents, character, franking_credit_cents, source_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'partnership')`,
    )
      .bind(id, userId, d.partnership_entity_id, fy, d.beneficiary_person_id ?? `person_self_${userId}`, d.share_pct ?? null, d.amount_cents ?? 0, d.character ?? "ordinary", d.franking_credit_cents ?? 0)
      .run();
    await this.audit(userId, "partnership_distribution_recorded", JSON.stringify({ id, partnership: d.partnership_entity_id, fy }));
    return id;
  }

  // ── SMSF (#140): fund members (phase + balances) + super contributions (src/lib/smsf.ts). ──
  async recordSmsfMember(
    userId: string,
    m: { smsf_entity_id: string; person_id?: string | null; phase?: string | null; pension_balance_cents?: number; accumulation_balance_cents?: number; transfer_balance_cents?: number },
  ): Promise<string> {
    const id = crypto.randomUUID();
    await this.env.DB.prepare(
      `INSERT INTO smsf_members (id, user_id, smsf_entity_id, person_id, phase, pension_balance_cents, accumulation_balance_cents, transfer_balance_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, userId, m.smsf_entity_id, m.person_id ?? `person_self_${userId}`, m.phase ?? "accumulation", m.pension_balance_cents ?? 0, m.accumulation_balance_cents ?? 0, m.transfer_balance_cents ?? 0)
      .run();
    await this.audit(userId, "smsf_member_recorded", JSON.stringify({ id, smsf: m.smsf_entity_id, phase: m.phase }));
    return id;
  }

  async recordSuperContribution(
    userId: string,
    c: { person_id?: string | null; fy?: string | null; type?: string | null; amount_cents: number },
  ): Promise<string> {
    const id = crypto.randomUUID();
    const fy = c.fy ?? this.currentFyLabel(await this.jurisdictionFor(userId));
    await this.env.DB.prepare(
      `INSERT INTO super_contributions (id, user_id, person_id, fy, type, amount_cents) VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, userId, c.person_id ?? `person_self_${userId}`, fy, c.type ?? "concessional", c.amount_cents ?? 0)
      .run();
    await this.audit(userId, "super_contribution_recorded", JSON.stringify({ id, type: c.type, fy }));
    return id;
  }

  /** #174: record a (draft/finalised) BAS period — the actual GST/PAYG figures that override the
   * ledger-derived indicative BAS for that FY in gstTotals. Quillo never lodges; status is draft|finalised. */
  async recordBasPeriod(
    userId: string,
    b: { entity_id?: string | null; period_start: string; period_end: string; output_gst_cents?: number; input_gst_cents?: number; payg_withholding_cents?: number; payg_instalment_cents?: number; status?: string },
  ): Promise<string> {
    if (!b.period_start || !b.period_end) throw new Error("period_start and period_end are required");
    const id = crypto.randomUUID();
    await this.env.DB.prepare(
      `INSERT INTO bas_periods (id, user_id, entity_id, period_start, period_end, output_gst_cents, input_gst_cents, payg_withholding_cents, payg_instalment_cents, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, userId, b.entity_id ?? null, b.period_start, b.period_end, b.output_gst_cents ?? 0, b.input_gst_cents ?? 0, b.payg_withholding_cents ?? 0, b.payg_instalment_cents ?? 0, b.status === "finalised" ? "finalised" : "draft")
      .run();
    await this.audit(userId, "bas_period_recorded", JSON.stringify({ id, period_start: b.period_start, period_end: b.period_end }));
    return id;
  }

  /** #174: record a PAYG income-tax instalment for an FY quarter (informational; never in the position). */
  async recordPaygInstalment(
    userId: string,
    p: { entity_id?: string | null; fy?: string | null; quarter?: number | null; instalment_cents: number; basis?: string | null },
  ): Promise<string> {
    const id = crypto.randomUUID();
    const fy = p.fy ?? this.currentFyLabel(await this.jurisdictionFor(userId));
    await this.env.DB.prepare(
      `INSERT INTO payg_instalments (id, user_id, entity_id, fy, quarter, instalment_cents, basis) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, userId, p.entity_id ?? null, fy, p.quarter ?? null, p.instalment_cents ?? 0, p.basis ?? "ato_amount")
      .run();
    await this.audit(userId, "payg_instalment_recorded", JSON.stringify({ id, fy, quarter: p.quarter }));
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
    const jur = await this.jurisdictionFor(userId); // bucket the credit by the SAME period as income.fy
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
      const creditFy = fyForDate(c.txn_date, jur);
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
        claimed.add(best.inc.id); // don't offer this same income row to a later credit in this pass
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
    if (fyForDate(txn.txn_date, await this.jurisdictionFor(userId)) !== inc.fy) throw new Error("the credit and the income row are in different financial years");
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

  /** Resolved deductibility states (0011). 'undetermined' is the captured default; the rest are written by the matcher / review. */
  private static readonly DEDUCTIBILITY_STATES = new Set<string>(DEDUCTIBILITY_STATES);

  private fyBoundsFor(fy: string | undefined, descriptor: JurisdictionDescriptor = AU_DESCRIPTOR): { fy: string; start: string; end: string } {
    const label = fy ?? this.currentFyLabel(descriptor);
    const sy = Number(label.slice(0, 4));
    return { fy: label, ...fyBounds(sy, descriptor) };
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
    const { fy: label, start, end } = this.fyBoundsFor(fy, await this.jurisdictionFor(userId));
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
    const { start, end } = this.fyBoundsFor(opts.fy, await this.jurisdictionFor(userId));
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

  /**
   * Stamp a deny-by-default deductibility verdict on captured 'payg' spend (the catch-all where
   * private living spend lands), using the pure, rules-first matcher (src/lib/deductibility.ts).
   * This is what lets the indicative position EXCLUDE clearly-private spend at capture time instead
   * of waiting for the year-end review. Called after every ingest/categorise pass and after a
   * re-bucket correction.
   *
   * GUARD: never clobbers a user's explicit year-end decision. By default it only touches
   * 'undetermined' rows; with {reResolve:true} (used after a correction changes the bucket/label) it
   * also re-evaluates the matcher's own prior auto-verdicts (likely_x / needs_apportionment) but still
   * leaves user-confirmed states (confirmed_deductible/confirmed_not) untouched. Best-effort: a
   * failure here must never fail the upload/correction that already persisted.
   */
  private async stampDeductibility(userId: string, opts?: { txnIds?: string[]; reResolve?: boolean }): Promise<{ stamped: number }> {
    try {
      const pack = await this.loadRulePack((await this.requireProfile(userId)).rule_pack_ver);
      const section = (pack as { payg_deductibility?: Parameters<typeof verdictForTxn>[3] }).payg_deductibility ?? null;
      if (!section) return { stamped: 0 };
      // Only payg is classified; the guard limits what we may overwrite (see method doc).
      const guard = opts?.reResolve
        ? "deductibility NOT IN ('confirmed_deductible','confirmed_not')"
        : "(deductibility IS NULL OR deductibility = 'undetermined')";
      // Read candidate rows. When scoped to specific ids, CHUNK the IN-list: D1 caps bound params at
      // ~100/query, so a bulk re-bucket of hundreds of ids (batch correction) would otherwise throw
      // here and silently skip the re-stamp — leaving the position computed off stale deductibility.
      const rows: { id: string; bucket: string; ato_label: string | null; merchant: string | null }[] = [];
      if (opts?.txnIds?.length) {
        for (let i = 0; i < opts.txnIds.length; i += 90) {
          const chunk = opts.txnIds.slice(i, i + 90);
          const r = await this.env.DB.prepare(
            `SELECT id, bucket, ato_label, merchant FROM transactions
              WHERE user_id = ? AND bucket = 'payg' AND ${guard} AND id IN (${chunk.map(() => "?").join(",")})`,
          )
            .bind(userId, ...chunk)
            .all<{ id: string; bucket: string; ato_label: string | null; merchant: string | null }>();
          rows.push(...(r.results ?? []));
        }
      } else {
        const r = await this.env.DB.prepare(
          `SELECT id, bucket, ato_label, merchant FROM transactions WHERE user_id = ? AND bucket = 'payg' AND ${guard}`,
        )
          .bind(userId)
          .all<{ id: string; bucket: string; ato_label: string | null; merchant: string | null }>();
        rows.push(...(r.results ?? []));
      }
      const updates: D1PreparedStatement[] = [];
      for (const r of rows) {
        const v = verdictForTxn(r.bucket, r.ato_label, r.merchant, section);
        if (v.deductibility === "undetermined") continue; // nothing positively classified → leave as-is
        // deductible_amount_cents: 0 for a denied row (explicitly $0 claimable); NULL otherwise so the
        // report falls back to the full amount for a 100%-deductible label (matches resolveByLabel).
        const amt = v.deductibility === "likely_not" ? 0 : null;
        updates.push(
          this.env.DB.prepare(`UPDATE transactions SET deductibility = ?, deductible_amount_cents = ? WHERE id = ? AND user_id = ?`)
            .bind(v.deductibility, amt, r.id, userId),
        );
      }
      for (let i = 0; i < updates.length; i += 50) await this.env.DB.batch(updates.slice(i, i + 50));
      return { stamped: updates.length };
    } catch (e) {
      await this.audit(userId, "deductibility_stamp_error", JSON.stringify({ error: (e as Error).message }));
      return { stamped: 0 };
    }
  }

  /**
   * Resolve a tenant's jurisdiction descriptor (gated by jurisdiction_period; OFF ⇒ AU). Threaded into
   * write-time FY bucketing so a UK tenant's captured income/CGT/etc. get the UK FY label (Apr 6 boundary)
   * — label-keyed report reads match on that label, so mis-bucketing here would hide a UK row from its FY.
   */
  private async jurisdictionFor(userId: string): Promise<JurisdictionDescriptor> {
    return resolveJurisdictionForUser(this.env, userId);
  }

  /** Current FY label, e.g. '2025-26'. Period from the descriptor (AU Jul–Jun by default; UK Apr 6). */
  private currentFyLabel(descriptor: JurisdictionDescriptor = AU_DESCRIPTOR): string {
    return fyLabel(currentFyStartYearFor(descriptor));
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
    await this.auditXborderInference(userId, provider, "classify_document", llm.modelId);
    const cls = await classifyDocument(llm, bytes, mime);
    const propertyId = await this.resolvePropertyByHint(userId, cls.likely_property_hint);
    const lowConf = cls.confidence < 0.6;
    await this.fileDocument(userId, {
      id: docId,
      doc_type: cls.doc_type,
      r2_key: r2key,
      image_hash: imageHash,
      property_id: propertyId,
      fy: fyForDate(cls.doc_date ?? null, await this.jurisdictionFor(userId)),
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
        // A1 #304: a multi-employer ATO "Income statements" page classifies as 'payslip' too. When the
        // engine flag is ON, decompose it (all employers, lump sums, supersede guard); OFF ⇒ today's
        // single-employer path verbatim (byte-identical; the shipped upload button is unaffected).
        if (featureOn(this.env, "income_statement_multi")) {
          await this.decomposeIncomeStatement(userId, docId, bytes, mime, llm);
          return { docId, doc_type: cls.doc_type, routed: true };
        }
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
      case "notice_of_assessment": {
        // B1 (noa_capture): read the NOA into a DRAFT carry-over the user confirms in File — nothing is
        // written to the position here. OFF ⇒ fall through to file-for-review (no NOA is otherwise touched).
        if (featureOn(this.env, "noa_capture")) {
          const noa = await extractNoticeOfAssessment(llm, bytes, mime);
          await captureNoaDraft(this.env, userId, docId, noa);
          await this.notify(
            userId,
            `Read your ${fyLabel(noa.assessed_fy)} Notice of Assessment — open File (switch to ${fyLabel(noa.assessed_fy)}) to review the carry-overs and close the year. General information only.`,
            null,
          );
          return { docId, doc_type: cls.doc_type, routed: true };
        }
        const na = cls.doc_type.replace(/_/g, " ");
        await this.notify(userId, `Filed your ${na} to Documents for your records — enter any figures manually if they belong in this year's return.`, null);
        return { docId, doc_type: cls.doc_type, routed: true };
      }
      default: {
        // We recognise these types (super_statement, managed_fund_amma, loan_statement, bank_statement)
        // but have no extractor yet, so their figures do NOT enter the return. Be honest about that rather
        // than implying capture — a reassuring "filed!" toast was making users believe income/interest was
        // captured when it wasn't (#66). Extractors are tracked as the Phase-2 follow-up.
        const friendly = cls.doc_type.replace(/_/g, " ");
        await this.notify(
          userId,
          `Filed your ${friendly} to Documents for your records — I haven't read its figures into your return yet. Enter them manually if they belong in this year's return.`,
          null,
        );
        return { docId, doc_type: cls.doc_type, routed: true };
      }
    }
  }

  /**
   * Decompose an agent rental summary into 1 rent income row + N expense transactions, attributed
   * to a property, with a reconciliation assertion (Σrent − Σexpenses = net disbursed). Sub-threshold
   * extraction or a failed reconcile flags the income row needs_review rather than dropping it.
   */
  /**
   * Delete an uploaded document + CASCADE the rows it created, so a mis-uploaded doc can be removed and
   * cleanly re-uploaded (no orphaned income/transactions, and the image_hash dup guard won't block a
   * re-upload). Scoped to the tenant. Removes: the income rows it routed (source_doc_id), the receipt/
   * bank-line transactions it created (document_id), the R2 object, then the document record. Audited.
   */
  async deleteDocument(userId: string, docId: string): Promise<{ deleted: boolean; income_removed: number; txns_removed: number }> {
    const doc = await this.env.DB.prepare(`SELECT r2_key FROM documents WHERE id = ? AND user_id = ?`).bind(docId, userId).first<{ r2_key: string | null }>();
    if (!doc) return { deleted: false, income_removed: 0, txns_removed: 0 };
    const inc = await this.env.DB.prepare(`DELETE FROM income WHERE user_id = ? AND source_doc_id = ?`).bind(userId, docId).run();
    const txn = await this.env.DB.prepare(`DELETE FROM transactions WHERE user_id = ? AND document_id = ?`).bind(userId, docId).run();
    await this.env.DB.prepare(`DELETE FROM documents WHERE id = ? AND user_id = ?`).bind(docId, userId).run();
    if (doc.r2_key) await this.env.RECEIPTS.delete(doc.r2_key).catch(() => {});
    const income_removed = inc.meta?.changes ?? 0;
    const txns_removed = txn.meta?.changes ?? 0;
    await this.audit(userId, "document_deleted", JSON.stringify({ docId, income_removed, txns_removed }));
    return { deleted: true, income_removed, txns_removed };
  }

  /**
   * Feature A1 (flag income_statement_multi): a multi-employer ATO income statement → income rows.
   * One FINALISED ("Tax ready") salary row per employer at the PRINTED Total gross (mapper enforces the
   * tax-correctness: leave already inside gross, SG/RESC/RFB reference-only), plus capture-only
   * employment_lump_sum rows. The statement is AUTHORITATIVE, so a salary row SUPERSEDES prior per-period
   * payslip + hand-keyed salary rows for the same employer+FY (matched on the detail_json.employer NAME —
   * per-period/manual rows carry no ABN — so the annual gross is never ADDED on top). Deletion is audited;
   * manual rows with no employer field are never matched. Not-"Tax ready" employers are surfaced, not
   * recorded. Mirrors decomposeAgentStatement (extract → map → loop recordIncome).
   */
  async decomposeIncomeStatement(userId: string, docId: string, bytes: ArrayBuffer, mime: string, llm: LLM): Promise<void> {
    const mapped = mapIncomeStatementToRows(await extractIncomeStatement(llm, bytes, mime));
    let salary = 0;
    let lumps = 0;
    let superseded = 0;
    const unplaced = new Set<string>();
    for (const row of mapped.rows) {
      const employer = String((row.detail as { employer?: unknown }).employer ?? "");
      const fy = row.txn_date ? fyLabel(fyStartYearOf(row.txn_date)) : null;
      // Never file a row we can't place in an FY (missing period_end) — that would land it in the CURRENT
      // FY and skip the supersede below (wrong-year + double-count). Skip it; the user re-uploads / adds it
      // manually. The extractor's tool prompt asks for the period, so this is a rare read-failure.
      if (!fy) {
        unplaced.add(employer || "an employer");
        continue;
      }
      if (row.income_type === "salary_payg") {
        salary++;
        if (employer) {
          // Supersede prior per-period payslip + hand-keyed PERSONAL salary rows for this employer+FY, so the
          // authoritative annual gross replaces them (never adds on top). Scoped to person_id/entity_id NULL
          // (this statement records the tenant's OWN salary — never touch a spouse's or an entity's same-name
          // row) and to OTHER documents (`source_doc_id IS NOT` this docId, null-safe so manual rows still
          // match) so two blocks for the same employer in ONE statement coexist and re-uploads still supersede.
          const priors = await this.env.DB.prepare(
            `SELECT id FROM income WHERE user_id = ? AND income_type = 'salary_payg' AND fy = ?
               AND person_id IS NULL AND entity_id IS NULL AND source_doc_id IS NOT ?
               AND lower(json_extract(detail_json, '$.employer')) = lower(?)`,
          ).bind(userId, fy, docId, employer).all<{ id: string }>();
          const ids = (priors.results ?? []).map((p) => p.id);
          for (const id of ids) {
            await this.env.DB.prepare(`DELETE FROM income WHERE id = ? AND user_id = ?`).bind(id, userId).run();
            superseded++;
          }
          if (ids.length) await this.audit(userId, "income_superseded", JSON.stringify({ employer, fy, replaced: ids.length, docId }));
        }
      } else if (row.income_type === "employment_lump_sum") {
        lumps++;
      }
      await this.recordIncome(userId, {
        income_type: row.income_type,
        ato_label: row.ato_label,
        fy,
        gross_cents: row.gross_cents,
        withholding_cents: row.withholding_cents,
        net_cents: row.gross_cents - row.withholding_cents,
        txn_date: row.txn_date,
        source_doc_id: docId,
        detail_json: JSON.stringify(row.detail),
        needs_review: row.needs_review,
      });
    }
    const sup = superseded ? ` Replaced ${superseded} earlier salary ${superseded === 1 ? "entry" : "entries"}.` : "";
    const lp = lumps ? ` ${lumps} lump-sum ${lumps === 1 ? "amount" : "amounts"} captured (special treatment — confirm with a registered tax agent).` : "";
    const skip = mapped.skipped_employers.length
      ? ` ${mapped.skipped_employers.length} employer${mapped.skipped_employers.length === 1 ? "" : "s"} not yet "Tax ready" — re-upload once finalised.`
      : "";
    const un = unplaced.size ? ` Couldn't read the period for ${unplaced.size} — add ${unplaced.size === 1 ? "it" : "them"} manually.` : "";
    await this.notify(userId, `Income statement read: recorded salary for ${salary} employer${salary === 1 ? "" : "s"}.${sup}${lp}${skip}${un} General information only.`, null);
  }

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
    const jur = await this.jurisdictionFor(userId);
    const baseCur = baseCurrencyOf(this.env, jur); // agent statement is in the tenant's base currency (AU ⇒ 'AUD')
    const fy = fyForDate(ext.period_end ?? ext.period_start ?? null, jur) ?? this.currentFyLabel(jur);
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
         VALUES (?, ?, 'agent_statement', ?, 'receipt', ?, ?, ?, ?, ?, 'property_rented', ?, ?, ?, ?, ?, 0)`,
      )
        .bind(
          crypto.randomUUID(), userId, needsReview ? "needs_review" : "extracted", e.description,
          Math.abs(e.amount_cents), baseCur, Math.abs(e.amount_cents), e.date ?? ext.period_end ?? null,
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
      owned_by?: string | null;   // 0030: 'self' (default) | 'employer'
      reimbursed?: number;        // 0030: 1 => reimbursed, not depreciable
      is_car?: number;            // 0040 (#142): a motor vehicle (logbook method + Div 40 cost-limit)
    },
  ): Promise<string> {
    const id = crypto.randomUUID();
    // #341-followup (flag asset_life_default): never persist a div40 asset with a null effective life —
    // that silently zeroes its depreciation schedule (rollSchedule: life ?? 0 → `if (life<=0) break`).
    // Resolve the rulepack/merchant-hinted default (else legacy 5y) when the user left it blank. OFF ⇒
    // bind the raw value (today's behaviour, which is the $0 bug). A supplied life always wins.
    let effectiveLife: number | null = a.effective_life_years ?? null;
    if (featureOn(this.env, "asset_life_default") && a.asset_class === "div40_plant" && effectiveLife == null) {
      const profile = await this.requireProfile(userId);
      const rulePack = await this.loadRulePack(profile.rule_pack_ver);
      effectiveLife = resolveDiv40Life(a.asset_class, null, this.assetDefaultsFor(a.label, rulePack).effective_life_years);
    }
    await this.env.DB.prepare(
      `INSERT INTO assets (id, user_id, person_id, property_id, entity_id, label, asset_class, cost_cents,
         acquired_date, effective_life_years, method, dv_rate_pct, div43_rate, is_second_hand, business_use_pct,
         source_doc_id, status, needs_review, owned_by, reimbursed, is_car)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    )
      .bind(
        id, userId, `person_self_${userId}`, a.property_id ?? null, a.entity_id ?? null, a.label, a.asset_class,
        a.cost_cents, a.acquired_date, effectiveLife, a.method ?? null, a.dv_rate_pct ?? 200, a.div43_rate ?? null,
        a.is_second_hand ? 1 : 0, a.business_use_pct ?? 100, a.source_doc_id ?? null, a.needs_review ?? 0,
        a.owned_by ?? "self", a.reimbursed ?? 0, a.is_car ?? 0,
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
          AND COALESCE(reimbursed,0) = 0             -- 0030: reimbursed spend isn't the taxpayer's cost — never a depreciating asset
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
      // A person-to-person transfer isn't a capital asset — don't depreciate it. Send it back to
      // 'unknown' + needs_review so the user categorises it properly (this is the user's call, not ours).
      if (looksLikePersonalTransfer(r.merchant)) {
        await this.env.DB.prepare(
          `UPDATE transactions SET bucket = 'unknown', status = 'needs_review' WHERE id = ? AND user_id = ?`,
        ).bind(r.id, userId).run();
        await this.audit(userId, "asset_skipped_transfer", JSON.stringify({ txnId: r.id, merchant: r.merchant }));
        continue;
      }
      const d = this.assetDefaultsFor(r.merchant, rulePack);
      // Low-cost (≤ the FY's ~$300 immediate-deduction threshold) → write off in year one, not a
      // multi-year Div 40 schedule. Falls back to the merchant-hinted class when over the threshold.
      const immediateThreshold = thresholdForFy(fyLabel(fyStartYearOf(r.txn_date)))?.immediate_non_business_cents ?? null;
      const lowCost = isLowCostAsset(r.cost, immediateThreshold);
      const asset_class = lowCost ? "immediate" : d.asset_class;
      const assetId = await this.createAsset(userId, {
        label: r.merchant ? `${r.merchant} (${r.txn_date})` : `Capital asset (${r.txn_date})`,
        asset_class, // 'immediate' for low-cost; else hint-seeded (asset_defaults on) or div40_plant
        cost_cents: r.cost,
        acquired_date: r.txn_date,
        property_id: r.property_id,
        effective_life_years: lowCost ? null : d.effective_life_years, // immediate has no effective life
        method: lowCost ? null : d.method, // the engine derives 'immediate' from the class
        business_use_pct: 100, // work out apportionment % later
        needs_review: 1,
      });
      const capitalClass = asset_class === "div43_capital_works" ? "div43" : "div40";
      await this.env.DB.prepare(
        `UPDATE transactions SET asset_id = ?, is_capital = 1, capital_class = ? WHERE id = ? AND user_id = ?`,
      )
        .bind(assetId, capitalClass, r.id, userId)
        .run();
      await this.audit(userId, "asset_linked", JSON.stringify({ txnId: r.id, assetId, cost: r.cost, asset_class }));
    }
  }

  /**
   * One-time backfill (run once per tenant from the cron via runOnceGuarded): repair already
   * auto-created, still-needs_review assets that the v1 linker mis-handled — (a) person-to-person
   * transfers wrongly turned into depreciating assets, and (b) low-cost (≤ $300) items put on a
   * multi-year Div 40 schedule instead of an immediate write-off. Only ever touches needs_review=1
   * (auto-created, unconfirmed) rows — never a user-confirmed asset. Idempotent: a second run finds
   * nothing left to change. Makes NO model call. Reversible: re-categorising recreates assets.
   */
  async reclassMisbucketedAssets(userId: string): Promise<{ removed: number; reclassed: number }> {
    const rows = (
      await this.env.DB.prepare(
        `SELECT a.id, a.cost_cents, a.acquired_date, a.asset_class, t.id AS txn_id, t.merchant
           FROM assets a LEFT JOIN transactions t ON t.asset_id = a.id AND t.user_id = a.user_id
          WHERE a.user_id = ? AND a.needs_review = 1`,
      ).bind(userId).all<{ id: string; cost_cents: number; acquired_date: string; asset_class: string; txn_id: string | null; merchant: string | null }>()
    ).results ?? [];
    let removed = 0;
    let reclassed = 0;
    for (const r of rows) {
      if (looksLikePersonalTransfer(r.merchant)) {
        // Not a capital asset — unwind it and send the txn back to review.
        await this.env.DB.batch([
          this.env.DB.prepare(`DELETE FROM depreciation_schedule WHERE asset_id = ? AND user_id = ?`).bind(r.id, userId),
          this.env.DB.prepare(`DELETE FROM assets WHERE id = ? AND user_id = ?`).bind(r.id, userId),
          ...(r.txn_id
            ? [this.env.DB.prepare(`UPDATE transactions SET asset_id = NULL, is_capital = 0, capital_class = NULL, bucket = 'unknown', status = 'needs_review' WHERE id = ? AND user_id = ?`).bind(r.txn_id, userId)]
            : []),
        ]);
        await this.audit(userId, "asset_backfill_removed", JSON.stringify({ assetId: r.id, txnId: r.txn_id, merchant: r.merchant }));
        removed++;
        continue;
      }
      const immediateThreshold = thresholdForFy(fyLabel(fyStartYearOf(r.acquired_date)))?.immediate_non_business_cents ?? null;
      if (r.asset_class !== "immediate" && isLowCostAsset(r.cost_cents, immediateThreshold)) {
        // Low-cost → immediate write-off. Reclass, drop the old multi-year schedule, then recompute
        // via the engine (computeDepreciation upserts but won't delete now-orphaned future-FY rows).
        await this.env.DB.batch([
          this.env.DB.prepare(`UPDATE assets SET asset_class = 'immediate', method = NULL, effective_life_years = NULL WHERE id = ? AND user_id = ?`).bind(r.id, userId),
          this.env.DB.prepare(`DELETE FROM depreciation_schedule WHERE asset_id = ? AND user_id = ?`).bind(r.id, userId),
        ]);
        await this.computeDepreciation(userId, r.id);
        await this.audit(userId, "asset_backfill_reclassed", JSON.stringify({ assetId: r.id, cost: r.cost_cents }));
        reclassed++;
      }
    }
    return { removed, reclassed };
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

  /**
   * Map an assets row into the engine's DepAsset shape, attaching the per-FY policy numbers
   * (instant-asset-write-off + car limit) for the asset's FIRST-USE FY so the engine can enforce the
   * IAWO cap / car limit. The engine never hardcodes a policy number — it's all supplied here, from
   * the bundled rule pack (no profile / KV dependency, so this can't throw mid-deletion).
   */
  private toDepAsset(row: {
    asset_class: string; cost_cents: number; acquired_date: string; effective_life_years: number | null;
    method: string | null; div43_rate: number | null; dv_rate_pct?: number | null; is_second_hand: number;
    business_use_pct: number | null; disposed_date: string | null;
  }): DepAsset {
    const t = thresholdForFy(fyLabel(fyStartYearOf(row.acquired_date)));
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
      instant_asset_write_off_cents: t?.instant_asset_write_off_cents ?? null,
      car_limit_cents: t?.car_limit_cents ?? null,
      // is_car activation (column + UI) is a follow-up; until then the car cap stays inert (is_car
      // defaults false) — the engine supports it, it's just not fed yet.
    };
  }

  /**
   * Materialise (or refresh) an asset's depreciation_schedule up to `toStartYear` (default: the
   * current FY). Deterministic — re-running yields identical rows (UNIQUE(asset_id, fy) upsert).
   */
  async computeDepreciation(userId: string, assetId: string, toStartYear?: number, opts?: { overrideMethodLock?: boolean }): Promise<{ rows: number }> {
    const row = await this.env.DB.prepare(
      `SELECT asset_class, cost_cents, acquired_date, effective_life_years, method, dv_rate_pct, div43_rate,
              is_second_hand, business_use_pct, disposed_date, owned_by, reimbursed FROM assets WHERE id = ? AND user_id = ?`,
    )
      .bind(assetId, userId)
      .first<{ asset_class: string; cost_cents: number; acquired_date: string; effective_life_years: number | null; method: string | null; dv_rate_pct: number | null; div43_rate: number | null; is_second_hand: number; business_use_pct: number | null; disposed_date: string | null; owned_by: string | null; reimbursed: number | null }>();
    if (!row) throw new Error("asset not found");

    // 0030 / D.3 — fix at source: an employer-OWNED or REIMBURSED asset earns the taxpayer no
    // decline-in-value (Div 40 needs the taxpayer to own and bear the cost). Write NO schedule rows and
    // clear any stale ones, so EVERY reader (Assets page, CGT div43 cost-base, the position) is correct
    // without its own guard. Runs BEFORE the method lock — this branch deletes rows, it never re-rolls
    // elected history, so the lock must not block the cleanup.
    if (!assetDepreciatesForTaxpayer(row)) {
      await this.env.DB.prepare(`DELETE FROM depreciation_schedule WHERE asset_id = ? AND user_id = ?`).bind(assetId, userId).run();
      await this.audit(userId, "depreciation_skipped_not_owned", JSON.stringify({ assetId, owned_by: row.owned_by, reimbursed: row.reimbursed }));
      return { rows: 0 };
    }

    // dep_method_lock (audit wave 1): Div 40's DV-vs-prime-cost choice is one-per-asset (s 40-65), but
    // `assets.method` was only "locked" by a schema comment — the upsert below silently rewrote history
    // under the new method. Guard at the money chokepoint so EVERY write path (recompute, rollForward,
    // dispose, any future updateAsset) is covered: once a schedule row exists under one elected method,
    // recomputing under the other throws unless the caller passes an explicit override. The override
    // audit row is written AFTER the successful batch below — never before the re-roll actually lands.
    const lock = await this.depMethodLockState(userId, assetId, row.method);
    if (lock.conflict && !opts?.overrideMethodLock) {
      throw new Error("method_locked: this asset's depreciation method is locked — Div 40 allows one choice (diminishing value or prime cost) per asset, and a schedule already exists under the other method.");
    }

    // Depreciation period stays AU-shaped this stop (UK capital-allowance period rides with the UK rule
    // pack, Phase 6) — the default target FY intentionally uses the AU descriptor. See depreciation.ts.
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
    // The override audit records a COMPLETED re-roll, so it must follow the batch (a failed batch must
    // not leave a false "overridden" row in the evidence trail).
    if (lock.conflict) await this.audit(userId, "depreciation_method_override", JSON.stringify({ assetId, from: lock.from, to: row.method }));
    await this.audit(userId, "depreciation_computed", JSON.stringify({ assetId, throughFy: fyLabel(target), rows: schedule.length }));
    return { rows: schedule.length };
  }

  /**
   * dep_method_lock state for an asset: whether its current Div 40 election conflicts with the one its
   * materialised schedule was rolled under (earliest FY row). No flag → never a conflict. fy is a TEXT
   * label ('2024-25'), so lexicographic ORDER BY is chronologically correct for 4-digit years.
   */
  private async depMethodLockState(userId: string, assetId: string, assetMethod: string | null): Promise<{ conflict: boolean; from: string | null }> {
    if (!featureOn(this.env, "dep_method_lock")) return { conflict: false, from: null };
    const first = await this.env.DB.prepare(
      `SELECT method_applied FROM depreciation_schedule WHERE asset_id = ? AND user_id = ? ORDER BY fy LIMIT 1`,
    ).bind(assetId, userId).first<{ method_applied: string | null }>();
    return { conflict: depMethodConflict(first?.method_applied, assetMethod), from: first?.method_applied ?? null };
  }

  /** Batch: roll every active asset's schedule into a new FY (called by the FY-rollover cron). */
  async rollForward(userId: string, toStartYear: number): Promise<{ assets: number }> {
    const assets = await this.env.DB.prepare(`SELECT id FROM assets WHERE user_id = ? AND status = 'active'`)
      .bind(userId)
      .all<{ id: string }>();
    let n = 0;
    for (const a of assets.results ?? []) {
      try {
        await this.computeDepreciation(userId, a.id, toStartYear);
        n++;
      } catch (e) {
        // dep_method_lock: one conflicted asset must NOT abort the tenant's whole roll (or the cron
        // steps that follow it) — skip the asset, audit the skip, keep rolling the rest.
        if (!/^method_locked/.test((e as Error).message)) throw e;
        await this.audit(userId, "depreciation_method_conflict_skipped", JSON.stringify({ assetId: a.id, toFy: fyLabel(toStartYear) }));
      }
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
    await this.auditXborderInference(userId, provider, "import_depreciation_schedule", llm.modelId);
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
    // dep_method_lock: check BEFORE any state write — otherwise a conflicted asset would be marked
    // disposed and then fail the recompute below, wedging it half-disposed (stale adjustable value,
    // no balancing adjustment, and no retry path). Resolve the method first, then dispose.
    const methodRow = await this.env.DB.prepare(`SELECT method FROM assets WHERE id = ? AND user_id = ?`).bind(assetId, userId).first<{ method: string | null }>();
    const lock = await this.depMethodLockState(userId, assetId, methodRow?.method ?? null);
    if (lock.conflict) {
      throw new Error("method_locked: this asset's depreciation method conflicts with its existing schedule — Div 40 allows one choice (diminishing value or prime cost) per asset. Resolve the method (or recompute with an explicit override) before disposing.");
    }
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
  /**
   * The tenant's claim-rule set: the bundled/KV rule pack ∪ per-tenant D1 rows. D1 rows are scoped so
   * a global pack override (user_id IS NULL) applies to everyone, while AI gap-fill rows written by
   * addClaimabilityRules stay tenant-private — without this scope one tenant's confirmed rules would
   * leak into every tenant on the same rule_pack_ver. Single source for suggestClaims / reviewClaims /
   * assessFilingReadiness so the column list + tenant scope can't drift across the three call sites.
   */
  private async loadClaimRules(userId: string, rulePackVer: string): Promise<ClaimRule[]> {
    const pack = await this.loadRulePack(rulePackVer);
    const packRules = ((pack as { claimability?: ClaimRule[] }).claimability ?? []) as ClaimRule[];
    // NB: requires_entity_kind is a pack-only field (JSON rules); the claimability_rules table has no
    // such column — selecting it would throw "no such column". D1 rows carry no entity AND-gate.
    const d1 = (
      await this.env.DB.prepare(
        `SELECT id, scope_type, scope_value, merchant_hint, ato_label, claim_type, default_method, general_info_note, defer_to_agent
           FROM claimability_rules WHERE rule_pack_ver = ? AND (user_id IS NULL OR user_id = ?)`,
      ).bind(rulePackVer, userId).all<ClaimRule>()
    ).results ?? [];
    return [...packRules, ...d1];
  }

  // ── PHASE 3: Find & attach claim evidence (claim_links) ────────────────────
  /**
   * Score the tenant's transactions as candidate EVIDENCE for one claim_suggestion (read-only).
   * Resolves the suggestion's rule (by ruleKey across pack ∪ D1 rules) and ranks debit txns via the
   * pure scoreClaimMatches. Already-attached txns are returned separately so the UI can show them as
   * confirmed. Never writes deductibility or a dollar figure.
   */
  async matchClaim(userId: string, claimId: string): Promise<{ claim_id: string; rule_id: string | null; candidates: ScoredTxn[]; linked: string[] }> {
    const claim = await this.env.DB.prepare(
      `SELECT id, rule_id FROM claim_suggestions WHERE id = ? AND user_id = ?`,
    )
      .bind(claimId, userId)
      .first<{ id: string; rule_id: string | null }>();
    if (!claim) throw new Error("claim not found");
    const profile = await this.requireProfile(userId);
    const rules = await this.loadClaimRules(userId, profile.rule_pack_ver);
    const rule = rules.find((r) => ruleKey(r) === claim.rule_id) ?? null;
    const linkedRows = await this.env.DB.prepare(`SELECT txn_id FROM claim_links WHERE user_id = ? AND claim_id = ?`).bind(userId, claimId).all<{ txn_id: string }>();
    const linked = (linkedRows.results ?? []).map((r) => r.txn_id);
    if (!rule) return { claim_id: claimId, rule_id: claim.rule_id, candidates: [], linked };
    // Candidate pool: the tenant's debit transactions (spend) not already excluded; cap for safety.
    const txnsRes = await this.env.DB.prepare(
      `SELECT id, merchant, bucket, ato_label, direction, amount_cents, amount_aud_cents, txn_date
         FROM transactions
        WHERE user_id = ? AND COALESCE(direction,'debit') = 'debit'
          AND status NOT IN ('duplicate','ignored','matched_receipt')
        ORDER BY txn_date DESC LIMIT 1000`,
    )
      .bind(userId)
      .all<{ id: string; merchant: string | null; bucket: string | null; ato_label: string | null; direction: string | null; amount_cents: number | null; amount_aud_cents: number | null; txn_date: string | null }>();
    const linkedSet = new Set(linked);
    const candidates = scoreClaimMatches(rule, txnsRes.results ?? []).filter((c) => !linkedSet.has(c.id)).slice(0, 50);
    return { claim_id: claimId, rule_id: claim.rule_id, candidates, linked };
  }

  /** Attach a transaction as evidence for a claim → claim_links (idempotent) + claim moves to 'capturing'. */
  async attachClaim(userId: string, claimId: string, txnId: string): Promise<{ ok: boolean; status: string }> {
    const claim = await this.env.DB.prepare(`SELECT status FROM claim_suggestions WHERE id = ? AND user_id = ?`).bind(claimId, userId).first<{ status: string }>();
    if (!claim) throw new Error("claim not found");
    const txn = await this.env.DB.prepare(`SELECT id FROM transactions WHERE id = ? AND user_id = ?`).bind(txnId, userId).first<{ id: string }>();
    if (!txn) throw new Error("transaction not found");
    await this.env.DB.prepare(
      `INSERT OR IGNORE INTO claim_links (id, user_id, claim_id, txn_id) VALUES (?, ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), userId, claimId, txnId)
      .run();
    // Move to 'capturing' unless the user dismissed it (don't resurrect a dismissed claim).
    const nextStatus = claim.status === "dismissed" ? claim.status : "capturing";
    if (nextStatus !== claim.status) await this.env.DB.prepare(`UPDATE claim_suggestions SET status = 'capturing' WHERE id = ? AND user_id = ?`).bind(claimId, userId).run();
    await this.audit(userId, "claim_attach", JSON.stringify({ claimId, txnId }));
    return { ok: true, status: nextStatus };
  }

  /** Detach evidence; if a claim has no links left, revert 'capturing' → 'suggested'. */
  async detachClaim(userId: string, claimId: string, txnId: string): Promise<{ ok: boolean; status: string }> {
    await this.env.DB.prepare(`DELETE FROM claim_links WHERE user_id = ? AND claim_id = ? AND txn_id = ?`).bind(userId, claimId, txnId).run();
    const remaining = await this.env.DB.prepare(`SELECT COUNT(*) AS n FROM claim_links WHERE user_id = ? AND claim_id = ?`).bind(userId, claimId).first<{ n: number }>();
    let status = "capturing";
    if ((remaining?.n ?? 0) === 0) {
      await this.env.DB.prepare(`UPDATE claim_suggestions SET status = 'suggested' WHERE id = ? AND user_id = ? AND status = 'capturing'`).bind(claimId, userId).run();
      status = "suggested";
    }
    await this.audit(userId, "claim_detach", JSON.stringify({ claimId, txnId }));
    return { ok: true, status };
  }

  /** The transactions attached to a claim (for the evidence panel). */
  async listClaimLinks(userId: string, claimId: string): Promise<{ txn_id: string; merchant: string | null; amount_cents: number | null; txn_date: string | null }[]> {
    const res = await this.env.DB.prepare(
      `SELECT cl.txn_id, t.merchant, t.amount_cents, t.txn_date
         FROM claim_links cl JOIN transactions t ON t.id = cl.txn_id AND t.user_id = cl.user_id
        WHERE cl.user_id = ? AND cl.claim_id = ? ORDER BY t.txn_date DESC`,
    )
      .bind(userId, claimId)
      .all<{ txn_id: string; merchant: string | null; amount_cents: number | null; txn_date: string | null }>();
    return res.results ?? [];
  }

  async suggestClaims(
    userId: string,
    ctx: ClaimContext,
    refs: { txnId?: string | null; assetId?: string | null; estimatedDeductionCents?: number | null } = {},
  ): Promise<number> {
    const profile = await this.requireProfile(userId);
    const matched = matchClaimRules(await this.loadClaimRules(userId, profile.rule_pack_ver), ctx);
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

  // ── FIND MY CLAIMS: situational sweep + AI gap-fill + rule write path ──────────
  /**
   * READ-ONLY situational claim sweep for the "Find My Claims" button. Assembles the rule set the
   * tenant's *situation* could trigger (occupation/entity/property-status — merchant ignored), then
   * classifies each rule against FY spend + existing suggestions into three groups:
   *   - capturing : already has evidence (bucket spend or a fired suggestion) — on top of it.
   *   - check     : eligible but no evidence yet — "worth checking".
   *   - defer     : needs a registered tax agent's judgement (defer_to_agent rules).
   * Genuinely-new 'check' items are upserted into claim_suggestions (status='suggested',
   * source='review', estimated_deduction_cents=NULL) — idempotent on (rule_id, source='review') and
   * NEVER resurrecting a dismissed row. Mutates NO ledger table. GENERAL-INFO only; no $/refund.
   */
  async reviewClaims(userId: string, startYear: number): Promise<ClaimReview> {
    const profile = await this.requireProfile(userId);
    const fy = fyLabel(startYear);
    const [report, situation] = await Promise.all([
      buildReport(this.env, userId, startYear),
      getSituation(this.env, userId, profile),
    ]);

    // Rule set = bundled pack ∪ per-tenant D1 rows (tenant-scoped — see loadClaimRules).
    const allRules = await this.loadClaimRules(userId, profile.rule_pack_ver);

    // Situation projection (a tenant can be non-AU resident — those rules still surface, framed defer).
    const occupations = situation.persons.map((p) => p.occupation).filter((o): o is string => !!o);
    const claimSituation: ClaimSituation = {
      occupations,
      entity_kinds: situation.entities.map((e) => e.kind),
      property_statuses: [...new Set(situation.properties.map((p) => p.status))],
    };

    // AU-only rule pack: if the taxpayer isn't an Australian resident, AU deductions can't be asserted —
    // every eligible rule is pushed to 'defer' (confirm with an agent) rather than framed as claimable.
    const selfResidency = situation.persons.find((p) => p.role === "self")?.tax_residency ?? "AU";
    const nonAuResident = selfResidency.toUpperCase() !== "AU";

    // Impure signals for classification: which buckets have FY spend, and which rule ids already fired
    // from REAL evidence (a per-transaction 'ingest' suggestion) vs are dismissed. Review-sourced rows
    // are excluded — the sweep's own 'check' writes must NOT later read back as 'capturing' (no evidence
    // was added), or items would silently migrate from "worth checking" to "already capturing" on re-run.
    const bucketsWithSpend = new Set(report.by_bucket.filter((b) => b.total_cents > 0).map((b) => b.bucket));
    const suggestionRows = (
      await this.env.DB.prepare(
        `SELECT rule_id, status, source FROM claim_suggestions WHERE user_id = ?`,
      ).bind(userId).all<{ rule_id: string | null; status: string | null; source: string | null }>()
    ).results ?? [];
    const firedRuleIds = new Set(suggestionRows.filter((r) => r.status !== "dismissed" && r.source !== "review" && r.rule_id).map((r) => r.rule_id as string));
    const dismissedRuleIds = new Set(suggestionRows.filter((r) => r.status === "dismissed" && r.rule_id).map((r) => r.rule_id as string));
    // Existing review-sourced rows keep the upsert idempotent (don't re-insert what's already there).
    const reviewSourced = new Set(suggestionRows.filter((r) => r.source === "review" && r.rule_id).map((r) => r.rule_id as string));

    // Why a rule applies, in plain language (drives the UI "because you're a teacher" line).
    const whyApplies = (rule: ClaimRule): string => {
      switch (rule.scope_type) {
        case "occupation":
          return rule.scope_value === "all"
            ? "A common deduction many taxpayers can check."
            : `Because your occupation is ${rule.scope_value}.`;
        case "property_status":
          return `Because you have a property that is ${rule.scope_value.replace(/_/g, " ")}.`;
        case "entity_kind":
          return `Because you have a ${rule.scope_value.replace(/_/g, " ")} entity.`;
        default:
          return "Based on your situation.";
      }
    };

    const enumerated = enumerateSituationClaims(allRules, claimSituation);
    const capturing: ClaimReviewItem[] = [];
    const check: ClaimReviewItem[] = [];
    const defer: ClaimReviewItem[] = [];
    for (const rule of enumerated) {
      const key = ruleKey(rule);
      // Drop dismissed rules before classifying so they never resurface (helper contract).
      if (dismissedRuleIds.has(key)) continue;
      // Non-AU residents: force defer (the AU rule pack can't sanction a claim for them).
      const group = nonAuResident ? "defer" : classifyClaim(rule, { bucketsWithSpend, firedRuleIds, dismissedRuleIds });
      const item: ClaimReviewItem = {
        rule_id: key,
        scope_type: rule.scope_type,
        scope_value: rule.scope_value,
        ato_label: rule.ato_label ?? null,
        claim_type: rule.claim_type,
        defer_to_agent: nonAuResident ? 1 : (rule.defer_to_agent ?? 0),
        suggestion: nonAuResident
          ? `${rule.general_info_note} Your tax residency isn't set to Australia — confirm with a registered tax agent whether Australian deductions apply to you.`
          : suggestionText(rule),
        why_applies: whyApplies(rule),
      };
      if (group === "capturing") capturing.push(item);
      else if (group === "defer") defer.push(item);
      else check.push(item);
    }

    // Persist genuinely-new 'check' items so the Dashboard ClaimsCard syncs. Idempotent on
    // (rule_id, source='review'); estimated_deduction_cents stays NULL (situational, never a $ figure).
    let inserted = 0;
    for (const item of check) {
      if (reviewSourced.has(item.rule_id)) continue;
      await this.env.DB.prepare(
        `INSERT INTO claim_suggestions (id, user_id, person_id, rule_id, suggestion, claim_type, estimated_deduction_cents, status, source)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 'suggested', 'review')`,
      )
        .bind(crypto.randomUUID(), userId, `person_self_${userId}`, item.rule_id, item.suggestion, item.claim_type)
        .run();
      inserted++;
    }

    const uncovered = uncoveredOccupations(allRules, occupations);
    await this.audit(
      userId,
      "claims_reviewed",
      JSON.stringify({ fy, capturing: capturing.length, check: check.length, defer: defer.length, inserted, uncovered: uncovered.length }),
    );
    return { fy, capturing, check, defer, uncovered_occupations: uncovered };
  }

  /**
   * AI gap-fill for "Find My Claims": draft CANDIDATE deduction rules for an occupation that has no
   * authored rule. Clones draftSituation's gates EXACTLY — APP-8 cross-border consent + per-tenant/
   * global budget + audited cross-border inference. WRITES NOTHING: returns a draft the user confirms
   * via addClaimabilityRules. The DO will force defer_to_agent=1 on every confirmed row. GENERAL-INFO.
   */
  async draftOccupationRules(userId: string, occupation: string): Promise<OccupationRulesDraft> {
    const profile = await this.requireProfile(userId);
    const provider = profile.inference_provider ?? this.env.DEFAULT_INFERENCE_PROVIDER;
    if (provider === "anthropic" && profile.consent_xborder !== 1) {
      throw new Error("consent_required");
    }
    if (!(await this.withinBudget(userId, null))) throw new Error("ai_budget_reached");
    const llm = await getLLM(this.env, profile, { userId });
    await this.auditXborderInference(userId, provider, "claim_review_draft", llm.modelId);
    const draft = await extractOccupationRules(llm, occupation.slice(0, 200));
    await this.audit(userId, "claim_review_draft", JSON.stringify({ occupation, rules: draft.rules.length }));
    return draft;
  }

  /**
   * The MISSING write path: persist user-confirmed claimability rules. Each row's rule_pack_ver is
   * pinned to the tenant's (stays au-v1), defer_to_agent is FORCED to 1 (these are AI-sourced candidates
   * the user accepted — they always defer to a registered tax agent), and a fresh id is generated.
   * confidence_floor takes the column default. INSERT only — never updates or deletes existing rows.
   */
  async addClaimabilityRules(
    userId: string,
    rules: { scope_type: string; scope_value: string; merchant_hint?: string | null; ato_label?: string | null; claim_type: string; default_method?: string | null; general_info_note: string }[],
  ): Promise<{ inserted: number; ids: string[] }> {
    const profile = await this.requireProfile(userId);
    const ids: string[] = [];
    for (const r of rules ?? []) {
      const id = crypto.randomUUID();
      await this.env.DB.prepare(
        `INSERT INTO claimability_rules (id, rule_pack_ver, jurisdiction, scope_type, scope_value, merchant_hint, ato_label, claim_type, default_method, general_info_note, defer_to_agent, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
        .bind(
          id,
          profile.rule_pack_ver,
          profile.jurisdiction ?? "AU",
          r.scope_type,
          r.scope_value,
          r.merchant_hint ?? null,
          r.ato_label ?? null,
          r.claim_type,
          r.default_method ?? null,
          r.general_info_note,
          userId, // tenant-private — never a global override
        )
        .run();
      ids.push(id);
    }
    if (ids.length) await this.audit(userId, "claim_rules_added", JSON.stringify({ count: ids.length }));
    return { inserted: ids.length, ids };
  }

  /**
   * #256 — pre-handoff "double-check my transactions" scan. DETERMINISTIC: gathers the FY ledger rows +
   * the report's confirmed→tracked position, then runs the pure runScan() engine (rule-pack deny/suggest
   * + the report's own counting classifier). NO LLM ⇒ no APP-8/budget gate; mutates nothing (every finding
   * is a proposal the user confirms via the existing audited write endpoints). Read-only.
   */
  async scanTransactions(userId: string, startYear: number): Promise<ScanResult> {
    const profile = await this.requireProfile(userId);
    const { start, end } = fyBounds(startYear, await this.jurisdictionFor(userId));
    const [report, pack] = await Promise.all([buildReport(this.env, userId, startYear), this.loadRulePack(profile.rule_pack_ver)]);
    // Same column expressions the report uses, so "is this row counting?" matches the headline exactly.
    const rows = (await this.env.DB.prepare(
      `SELECT id, txn_date, merchant, ato_label, bucket, deductibility,
              COALESCE(amount_aud_cents, amount_cents) AS amount_cents,
              COALESCE(reimbursed,0) AS reimbursed,
              ${useStatusDeniedExpr("property_id")} AS use_status_denied,
              ${propertyUndeterminedGatedExpr(this.env, "bucket", "property_id")} AS property_undetermined
         FROM transactions
        WHERE user_id = ? AND txn_date >= ? AND txn_date <= ? AND ${COUNTABLE}
        ORDER BY COALESCE(amount_aud_cents, amount_cents) DESC
        LIMIT 500`,
    ).bind(userId, start, end).all<ScanTxn>()).results ?? [];
    const section = (pack as { payg_deductibility?: import("./lib/deductibility").DeductibilitySection }).payg_deductibility;
    const result = runScan(rows, report, section, { excludeNonDeductible: featureOn(this.env, "position_excludes_nondeductible") });
    await this.audit(userId, "txn_scan", JSON.stringify({ fy: fyLabel(startYear), findings: result.summary.finding_count }));
    return result;
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
    const { start, end } = fyBounds(startYear, await this.jurisdictionFor(userId));
    const [report, situation] = await Promise.all([buildReport(this.env, userId, startYear), getSituation(this.env, userId, profile)]);

    // Matched situation-level claim rules (defer-to-agent ones become "judgement" findings). Iterate
    // distinct property statuses since the context carries a single property_status; occupation/
    // entity rules match regardless. Merchant-scoped rules can't fire here (no merchant) — intended.
    const pack = await this.loadRulePack(profile.rule_pack_ver); // for thresholds_by_fy below
    const allRules = await this.loadClaimRules(userId, profile.rule_pack_ver);
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
    // Foreign-currency rows we couldn't convert (currency != AUD AND amount_aud_cents IS NULL): excluded
    // from the position by FX_CONVERTED, surfaced here so the excluded money stays visible. Counts the
    // income rows + the dated transactions in this FY window.
    const fxUnconvertedPredicate = "COALESCE(currency,'AUD') <> 'AUD' AND amount_aud_cents IS NULL";
    const [needsIncome, needsAssets, lowConf, divDoc, agentSummaryProps, disposed, fxIncome, fxTxns] = await Promise.all([
      this.env.DB.prepare(`SELECT COUNT(*) AS n FROM income WHERE user_id = ? AND fy = ? AND needs_review = 1`).bind(userId, fy).first<{ n: number }>(),
      this.env.DB.prepare(`SELECT COUNT(*) AS n FROM assets WHERE user_id = ? AND needs_review = 1 AND status = 'active'`).bind(userId).first<{ n: number }>(),
      this.env.DB.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND confidence IS NOT NULL AND confidence < ? AND txn_date >= ? AND txn_date <= ? AND ${COUNTABLE}`).bind(userId, confidenceFloor, start, end).first<{ n: number }>(),
      this.env.DB.prepare(`SELECT COUNT(*) AS n FROM documents WHERE user_id = ? AND doc_type IN ('dividend_statement','managed_fund_amma') AND (fy = ? OR fy IS NULL)`).bind(userId, fy).first<{ n: number }>(),
      this.env.DB.prepare(`SELECT DISTINCT property_id FROM documents WHERE user_id = ? AND doc_type = 'agent_rental_summary' AND property_id IS NOT NULL`).bind(userId).all<{ property_id: string }>(),
      this.env.DB.prepare(`SELECT COUNT(*) AS n FROM assets WHERE user_id = ? AND disposed_date IS NOT NULL AND disposed_date >= ? AND disposed_date <= ?`).bind(userId, start, end).first<{ n: number }>(),
      this.env.DB.prepare(`SELECT COUNT(*) AS n FROM income WHERE user_id = ? AND fy = ? AND ${fxUnconvertedPredicate}`).bind(userId, fy).first<{ n: number }>(),
      this.env.DB.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND txn_date >= ? AND txn_date <= ? AND status NOT IN ('duplicate','ignored') AND ${fxUnconvertedPredicate}`).bind(userId, start, end).first<{ n: number }>(),
    ]);
    const haveSummaryFor = new Set((agentSummaryProps.results ?? []).map((r) => r.property_id));
    const rentalPropsMissingSummary = report.per_property
      .filter((p) => p.income_cents > 0 && !haveSummaryFor.has(p.property_id))
      .map((p) => ({ property_id: p.property_id, label: p.label }));

    const thresholds = (pack as { thresholds_by_fy?: Record<string, { instant_asset_write_off_cents?: number; div293_threshold_cents?: number; gst_registration_threshold_cents?: number }> }).thresholds_by_fy ?? {};
    // Prior-year capital losses are an all-time carry-forward (not FY-scoped) — sum them so readiness
    // can surface a defer finding (capture-only; never applied to the headline).
    const capLoss = await this.env.DB.prepare(`SELECT COALESCE(SUM(loss_cents),0) AS total FROM capital_loss_carryins WHERE user_id = ?`).bind(userId).first<{ total: number }>();
    // F: properties flagged as a main residence and disposed in this FY — their gain is kept OUT of the
    // computed position (no auto-exemption), so readiness surfaces a defer nudge.
    const mainResDisposal = await this.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM properties WHERE user_id = ? AND main_residence_flag = 1
         AND disposal_date IS NOT NULL AND disposal_date >= ? AND disposal_date <= ?
         AND cost_base_cents IS NOT NULL AND disposal_proceeds_cents IS NOT NULL`,
    ).bind(userId, start, end).first<{ n: number }>();
    // B: net AMIT cost-base amount across this FY's managed-fund distributions (capture-only; defer nudge).
    let mfCostBaseAdjustmentCents = 0;
    if (featureOn(this.env, "mf_components")) {
      const mfRows = (await this.env.DB.prepare(
        `SELECT detail_json FROM income WHERE user_id = ? AND fy = ? AND income_type = 'managed_fund_distribution' AND detail_json IS NOT NULL`,
      ).bind(userId, fy).all<{ detail_json: string | null }>()).results ?? [];
      for (const r of mfRows) {
        const c = parseAmmaComponents(r.detail_json);
        if (c) mfCostBaseAdjustmentCents += c.amit_cost_base_net_amount_cents;
      }
    }
    // GST registration status for the turnover nudge — registered if the tenant default is set OR any
    // entity is flagged (mirrors gstTotals' registration test in ledger-totals.ts).
    const entGstReg = (await this.env.DB.prepare(`SELECT COUNT(*) AS n FROM entities WHERE user_id = ? AND COALESCE(gst_registered,0) = 1`).bind(userId).first<{ n: number }>())?.n ?? 0;
    const isGstRegistered = (profile.gst_registered ?? 0) === 1 || entGstReg > 0;
    // S2: self-declared PSI status across the user's business activities → sharpen/suppress the PSI nudge.
    const psiRows = (await this.env.DB.prepare(`SELECT psi_status FROM income_activities WHERE user_id = ? AND activity_type = 'business'`).bind(userId).all<{ psi_status: string | null }>()).results ?? [];
    const psiAppliesDeclared = psiRows.some((r) => r.psi_status === "psi_applies");
    const psiAllAssessed = psiRows.length > 0 && psiRows.every((r) => r.psi_status != null);
    // integrity_nudges (audit wave 1): populate the four extra signals ONLY when the flag is on, so
    // OFF ⇒ the readiness findings are byte-identical. Reference thresholds come from the pack (never
    // computed into $ outcomes); the rideshare heuristic looks at occupations + business-activity labels.
    const integrityOn = featureOn(this.env, "integrity_nudges");
    let rideshareGstLikely = false;
    let nonConcessionalContributedCents = 0;
    if (integrityOn) {
      const RIDESHARE_HINTS = ["uber", "didi", "ola", "rideshare", "ride-share", "ride sourcing", "ride-sourcing", "taxi"];
      const bizActivities = (await this.env.DB.prepare(
        `SELECT occupation_scope, label FROM income_activities WHERE user_id = ? AND activity_type = 'business'`,
      ).bind(userId).all<{ occupation_scope: string | null; label: string | null }>()).results ?? [];
      const looksRideshare = (s: string | null | undefined) => !!s && RIDESHARE_HINTS.some((h) => s.toLowerCase().includes(h));
      rideshareGstLikely = occupations.includes("driver")
        || bizActivities.some((a) => a.occupation_scope === "driver" || looksRideshare(a.label));
      try {
        nonConcessionalContributedCents = (await this.env.DB.prepare(
          `SELECT COALESCE(SUM(amount_cents),0) AS c FROM super_contributions WHERE user_id = ? AND fy = ? AND type = 'non_concessional'`,
        ).bind(userId, fy).first<{ c: number }>())?.c ?? 0;
      } catch (e) {
        if (!/no such table|no such column/i.test((e as Error).message)) throw e;
      }
    }
    const integrityThresholds = thresholds[fy] as { franking_holding_rule_threshold_cents?: number; fito_de_minimis_cents?: number; super_non_concessional_cap_cents?: number } | undefined;
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
      capitalLossCarryinCents: capLoss?.total ?? 0,
      fxUnconvertedN: (fxIncome?.n ?? 0) + (fxTxns?.n ?? 0),
      div293ThresholdCents: thresholds[fy]?.div293_threshold_cents ?? null,
      gstRegistrationThresholdCents: thresholds[fy]?.gst_registration_threshold_cents ?? null,
      isGstRegistered,
      psiAppliesDeclared,
      psiAllAssessed,
      mainResidenceDisposalN: mainResDisposal?.n ?? 0,
      mfCostBaseAdjustmentCents,
      ...(integrityOn ? {
        frankingHoldingThresholdCents: integrityThresholds?.franking_holding_rule_threshold_cents ?? null,
        fitoDeMinimisCents: integrityThresholds?.fito_de_minimis_cents ?? null,
        rideshareGstLikely,
        superNonConcessionalCapCents: integrityThresholds?.super_non_concessional_cap_cents ?? null,
        nonConcessionalContributedCents,
      } : {}),
    };

    const readiness = assessReadiness({ report, situation, claimMatches: [...matchedById.values()], signals, generatedAt: new Date().toISOString(), excludeNonDeductible: featureOn(this.env, "position_excludes_nondeductible"), excludePropertyUndetermined: featureOn(this.env, "position_excludes_property_undetermined"), auditFindingsV2: featureOn(this.env, "readiness_audit_v2") });
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
  /**
   * Upsert the per-FY work-use inputs (WFH hours + work-related km) that drive the computed fixed-rate /
   * cents-per-km deductions (#67). One row per (user, fy). Inert until the wfh_car_methods flag is on
   * (buildReport reads it then). Stores the raw inputs only — the $ figure is computed in report.ts.
   */
  async setWorkUseInputs(userId: string, input: { fy: number; wfh_hours: number | null; car_work_km: number | null; wfh_days_per_week?: number | null; wfh_weeks?: number | null; has_dedicated_home_office?: boolean; wfh_has_record?: boolean; wfh_weekdays?: number[] | null; wfh_leave_ranges?: WfhLeaveRange[] | null; wfh_generate_diary?: boolean }): Promise<{ ok: true }> {
    await this.requireProfile(userId);
    const days = input.wfh_days_per_week ?? null;
    const weeks = input.wfh_weeks ?? null;
    // 0058: capture-only context flags (guidance, not the $ figure).
    const office = input.has_dedicated_home_office ? 1 : 0;
    const record = input.wfh_has_record ? 1 : 0;
    // 0059: diary inputs. Normalise weekdays (ints 0..6, unique, sorted) + leave ranges (valid ISO pairs).
    const weekdays = Array.from(new Set((input.wfh_weekdays ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))).sort((a, b) => a - b);
    const leaveRanges = (input.wfh_leave_ranges ?? []).filter((r) => r && typeof r.start === "string" && typeof r.end === "string" && r.start <= r.end).map((r) => ({ start: r.start, end: r.end, ...(r.label ? { label: String(r.label).slice(0, 60) } : {}) }));
    const generateDiary = input.wfh_generate_diary ? 1 : 0;
    // Hours precedence (hours stay authoritative): an explicit edit wins; else, when the diary is on AND
    // the user isn't supplying their own record, the diary's total_hours becomes the figure; else fall
    // back to the days/week derivation. Keeps the legacy days/week path byte-identical when diary is off.
    let hours = input.wfh_hours != null ? input.wfh_hours : null;
    if (hours == null && generateDiary && !record && weekdays.length > 0) {
      // Use the SAME jurisdiction the accountant-schedule diary uses, so the stored hours and the CSV
      // diary total reconcile (AU = Jul–Jun; a non-AU period must not silently use AU bounds here).
      hours = generateWfhDiary({ fyStartYear: input.fy, weekdays, leaveRanges, descriptor: await this.jurisdictionFor(userId) }).total_hours;
    }
    if (hours == null) hours = deriveWfhHours(days, weeks);
    await this.env.DB.prepare(
      `INSERT INTO work_use_inputs (user_id, fy, wfh_hours, car_work_km, wfh_days_per_week, wfh_weeks, has_dedicated_home_office, wfh_has_record, wfh_weekdays, wfh_leave_ranges, wfh_generate_diary, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, fy) DO UPDATE SET wfh_hours = excluded.wfh_hours, car_work_km = excluded.car_work_km, wfh_days_per_week = excluded.wfh_days_per_week, wfh_weeks = excluded.wfh_weeks, has_dedicated_home_office = excluded.has_dedicated_home_office, wfh_has_record = excluded.wfh_has_record, wfh_weekdays = excluded.wfh_weekdays, wfh_leave_ranges = excluded.wfh_leave_ranges, wfh_generate_diary = excluded.wfh_generate_diary, updated_at = datetime('now')`,
    )
      .bind(userId, input.fy, hours, input.car_work_km, days, weeks, office, record, JSON.stringify(weekdays), JSON.stringify(leaveRanges), generateDiary)
      .run();
    // #245: keep the dedicated car_inputs table in sync while the legacy WFH panel still carries car km
    // (the car_methods reader prefers car_inputs). Dual-write is removed once the WFH UI is WFH-only.
    if (input.car_work_km != null) await this.setCarInputs(userId, { fy: input.fy, work_km: input.car_work_km });
    await this.audit(userId, "work_use_set", JSON.stringify({ ...input, wfh_hours: hours }));
    return { ok: true };
  }

  /**
   * Upsert the per-FY car cents-per-km input (#245). One row per (user, fy). Inert until the car_methods
   * flag is on (buildReport reads it then, preferring it over the legacy work_use_inputs.car_work_km).
   */
  async setCarInputs(userId: string, input: { fy: number; work_km: number | null }): Promise<{ ok: true }> {
    await this.requireProfile(userId);
    await this.env.DB.prepare(
      `INSERT INTO car_inputs (user_id, fy, work_km, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, fy) DO UPDATE SET work_km = excluded.work_km, updated_at = datetime('now')`,
    )
      .bind(userId, input.fy, input.work_km)
      .run();
    await this.audit(userId, "car_use_set", JSON.stringify(input));
    return { ok: true };
  }

  /**
   * Audit wave 4 (trading_stock): upsert the per-business × FY opening/closing stock values (s 70-35).
   * Manual UPDATE-then-INSERT rather than ON CONFLICT — the uniqueness is an EXPRESSION index
   * (user_id, fy, COALESCE(entity_id,'')) and a conflict target can't name it portably. Audited write.
   */
  async setTradingStock(userId: string, b: { entity_id?: string | null; fy?: string; opening_cents?: number; closing_cents?: number; valuation_basis?: string | null }): Promise<{ ok: true }> {
    await this.requireProfile(userId);
    const fy = normaliseFyLabel(b.fy) ?? this.currentFyLabel(await this.jurisdictionFor(userId));
    // '' and NULL are the SAME upsert slot (COALESCE key) but only IS NULL reaches the personal
    // position — coerce, and a non-null entity must belong to this tenant.
    const entityId = b.entity_id || null;
    await assertOwns(this.env, userId, [{ table: "entities", id: entityId ?? undefined, label: "entity" }]);
    // Finite-only clamp: JSON can carry 1e999 → Infinity, which D1 rejects as a bind (500). 0 ≤ n ≤ $10B.
    const toCents = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? Math.min(Math.max(0, Math.round(n)), 1_000_000_000_000) : 0; };
    const opening = toCents(b.opening_cents);
    const closing = toCents(b.closing_cents);
    const basis = b.valuation_basis && ["cost", "market_selling_value", "replacement"].includes(b.valuation_basis) ? b.valuation_basis : null;
    const upd = await this.env.DB.prepare(
      `UPDATE trading_stock SET opening_cents = ?, closing_cents = ?, valuation_basis = ?, updated_at = datetime('now')
        WHERE user_id = ? AND fy = ? AND COALESCE(entity_id, '') = COALESCE(?, '')`,
    ).bind(opening, closing, basis, userId, fy, entityId).run();
    if ((upd.meta?.changes ?? 0) === 0) {
      try {
        await this.env.DB.prepare(
          `INSERT INTO trading_stock (id, user_id, entity_id, fy, opening_cents, closing_cents, valuation_basis) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(crypto.randomUUID(), userId, entityId, fy, opening, closing, basis).run();
      } catch (e) {
        // Concurrent first-save race (D1 awaits leave the DO input gate open): the loser re-runs the
        // UPDATE instead of surfacing a spurious UNIQUE-constraint 500 on the happy path.
        if (!/UNIQUE constraint/i.test((e as Error).message)) throw e;
        await this.env.DB.prepare(
          `UPDATE trading_stock SET opening_cents = ?, closing_cents = ?, valuation_basis = ?, updated_at = datetime('now')
            WHERE user_id = ? AND fy = ? AND COALESCE(entity_id, '') = COALESCE(?, '')`,
        ).bind(opening, closing, basis, userId, fy, entityId).run();
      }
    }
    await this.audit(userId, "trading_stock_set", JSON.stringify({ fy, entity_id: entityId, opening_cents: opening, closing_cents: closing, valuation_basis: basis }));
    return { ok: true };
  }

  async generateChecklist(userId: string, fy?: string): Promise<{ items: number }> {
    const profile = await this.requireProfile(userId);
    const situation = await getSituation(this.env, userId, profile);
    const targetFy = normaliseFyLabel(fy) ?? this.currentFyLabel(await this.jurisdictionFor(userId));
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
    // A PAYG employee (an 'employment' entity, or just the payg bucket) — the common case whose biggest
    // claims (WFH, equipment, the "things people forget") never originate as a statement line, so they
    // were never surfaced. This branch pushes them as reminders to confirm. (D.2 / G6)
    const hasEmployment = situation.entities.some((e) => e.kind === "employment") || buckets.includes("payg");

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
    if (hasEmployment) {
      items.push({ item_key: "payg_wfh_hours", title: "Set your working-from-home days/week (the #1 work deduction)", rationale: "Home-office running costs are claimed at the ATO fixed rate for the hours you work from home. Enter your days/week on the Dashboard — keep a record of your actual hours.", trigger_bucket: "payg", due_hint: "Anytime" });
      items.push({ item_key: "payg_equipment", title: "Bought any equipment for work? (laptop, monitor, desk, chair)", rationale: "Tools and equipment you bought for work are deductible — written off immediately if they're at or under the small-item threshold, otherwise depreciated over their effective life, apportioned for private use. Add them in Assets.", trigger_bucket: "payg", due_hint: "Before lodging" });
      items.push({ item_key: "payg_income_protection", title: "Income protection insurance held outside super?", rationale: "Premiums for income-protection (salary-continuance) cover held outside super are generally deductible. Cover for life/TPD/trauma, or anything held inside super, is not.", trigger_bucket: "payg", due_hint: "Before lodging" });
      items.push({ item_key: "payg_membership", title: "Union fees or a professional membership for your work?", rationale: "Annual union fees and subscriptions to professional associations connected to your work are generally deductible.", trigger_bucket: "payg", due_hint: "Before lodging" });
      items.push({ item_key: "payg_self_education", title: "Work-related courses, subscriptions or self-education?", rationale: "Self-education and work subscriptions are deductible where they maintain or improve the skills of your CURRENT job (not to get a new one or for a separate venture). Apportion out any private use.", trigger_bucket: "payg", due_hint: "Before lodging" });
      items.push({ item_key: "payg_donations", title: "Donations of $2+ to a registered charity (DGR)?", rationale: "Gifts of $2 or more to a deductible gift recipient are generally deductible — keep the receipts. Buying raffle tickets or event tickets is not a deductible gift.", trigger_bucket: "payg", due_hint: "Before lodging" });
      items.push({ item_key: "payg_tax_agent_fee", title: "Add last year's tax-agent / accountant fee", rationale: "The cost of managing your tax affairs — registered tax agent and accountant fees — is generally deductible in the year you pay it.", trigger_bucket: "payg", due_hint: "Before lodging" });
    }
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

    // Validate categorical fields before they're written — a correction is auto-promoted into a
    // permanent per-user rule after 2 repeats, so an invalid bucket / junk label would otherwise
    // become a sticky mis-categorisation. bucket must be a known taxonomy member; ato_label must be
    // a short, safe ledger token (same hygiene the model output goes through).
    if (field === "bucket" && !isBucket(newValue)) throw new Error(`invalid bucket: ${newValue}`);
    if (field === "ato_label") {
      const clean = normalizeAtoLabel(newValue);
      if (!clean) throw new Error(`invalid ato_label: ${newValue}`);
      newValue = clean;
    }
    // #258: a refund→expense link is a cross-row FK, so validate the target like the H1 cross-tenant
    // guard (#231): it must be THIS user's transaction, an expense (debit), and not the refund itself.
    if (field === "refund_for_txn_id" && newValue) {
      if (newValue === txnId) throw new Error("a refund can't link to itself");
      const ref = await this.env.DB.prepare(`SELECT COALESCE(direction,'debit') AS direction FROM transactions WHERE id = ? AND user_id = ?`).bind(newValue, userId).first<{ direction: string }>();
      if (!ref) throw new Error("refund target expense not found");
      if (ref.direction !== "debit") throw new Error("a refund must link to an expense (a debit), not another credit");
    }
    // Clearing a property_id / refund link (e.g. unlinking) must persist as NULL, not '', or the
    // report's `IS NOT NULL` / join filters treat the dangling '' as a real reference.
    const bound: string | null = (field === "property_id" || field === "refund_for_txn_id") && !newValue ? null : newValue;

    const row = await this.env.DB.prepare(
      `SELECT ${column} AS old FROM transactions WHERE id = ? AND user_id = ?`,
    )
      .bind(txnId, userId)
      .first<{ old: string | null }>();
    if (!row) throw new Error("transaction not found");

    // A user confirm/correct is a stronger signal than any model score: stamp confidence=1.0 so the
    // row deterministically leaves NEEDS_REVIEW (whose confidence clause is guarded against
    // status='corrected', so a known-bucket confirmed row no longer matches any of its clauses).
    await this.env.DB.prepare(
      `UPDATE transactions SET ${column} = ?, status='corrected', confidence=1.0 WHERE id = ? AND user_id = ?`,
    )
      .bind(bound, txnId, userId)
      .run();
    await this.env.DB.prepare(
      `INSERT INTO corrections (id, user_id, txn_id, field, old_value, new_value)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), userId, txnId, field, row.old, bound)
      .run();

    // If the user re-bucketed a line to 'asset', create + link its depreciating asset now.
    if (field === "bucket" && newValue === "asset") await this.linkAssetsForUser(userId);

    // Re-evaluate deny-by-default deductibility when the inputs to the matcher change. reResolve so a
    // prior AUTO verdict is refreshed (e.g. re-bucketing groceries→payg:union-fees flips it from
    // denied to deductible), while a user's year-end confirmed_* state is preserved by the guard.
    if (field === "bucket" || field === "ato_label" || field === "merchant") {
      await this.stampDeductibility(userId, { txnIds: [txnId], reResolve: true });
    }

    await this.promoteToEvalCase(userId, txnId);
    await this.audit(userId, "correction", JSON.stringify({ txnId, field, newValue }));
  }

  // ── 3b. BATCH CORRECTION: one set of edits applied to many txns (bulk bar / clarify group) ──
  /**
   * Apply the SAME edit(s) to many transactions in one audited, undoable action. Replicates every
   * side effect of applyCorrection (status='corrected', re-stamp deductibility on bucket/ato_label/
   * merchant change, link assets, promote repeated corrections into eval cases / auto-rules) but
   * batched: the deductibility re-stamp and asset-link run ONCE over all changed ids. Each per-txn
   * correction row shares a `batch_id` so undoCorrectionBatch can revert the action as a unit.
   * Validates every edit up front — a bad field/value rejects the whole batch. Clamps to 500.
   */
  async applyCorrectionBatch(
    userId: string,
    txnIds: string[],
    edits: { field: string; value: string }[],
    opts: { learnRule?: boolean } = {},
  ): Promise<{ batch_id: string; updated: number; failures: { txnId: string; error: string }[]; rules_created?: number }> {
    if (!Array.isArray(txnIds) || txnIds.length === 0 || !Array.isArray(edits) || edits.length === 0)
      return { batch_id: "", updated: 0, failures: [] };
    // Validate + normalise all edits up front (mirrors applyCorrection's per-field hygiene).
    const norm: { field: string; column: string; value: string }[] = [];
    for (const e of edits) {
      const column = CORRECTABLE[e.field];
      if (!column) throw new Error(`field not correctable: ${e.field}`);
      // #258: a refund→expense link is a cross-row FK needing per-row ownership/direction validation,
      // which the batch path doesn't do — it's only ever set one-at-a-time via applyCorrection. Reject
      // it here so it can't slip through the bulk path unvalidated (cross-tenant FK guard, mirrors #231).
      if (e.field === "refund_for_txn_id") throw new Error("refund_for_txn_id is set per-transaction, not in a batch");
      let value = e.value;
      if (e.field === "bucket" && !isBucket(value)) throw new Error(`invalid bucket: ${value}`);
      if (e.field === "ato_label") {
        const clean = normalizeAtoLabel(value);
        if (!clean) throw new Error(`invalid ato_label: ${value}`);
        value = clean;
      }
      norm.push({ field: e.field, column, value });
    }
    // Invariant: a property_id may only ride on a property bucket. When this batch re-buckets the rows
    // to a NON-property bucket (e.g. property_rented → payg via BulkBar / apply-to-siblings), force the
    // property_id clear so its amount can't keep counting against that property. Covers every batch
    // write path server-side, regardless of what the client sent. (No bucket edit ⇒ a targeted
    // property correction on an already-property row ⇒ left untouched.)
    const bucketNorm = norm.find((n) => n.field === "bucket");
    if (bucketNorm && !isPropertyBucket(bucketNorm.value)) {
      const pid = norm.find((n) => n.field === "property_id");
      if (pid) pid.value = "";
      else norm.push({ field: "property_id", column: "property_id", value: "" });
    }
    const ids = txnIds.slice(0, 500);
    const batchId = crypto.randomUUID();
    const selectCols = [...new Set(norm.map((n) => n.column))];
    const setClause = norm.map((n) => `${n.column} = ?`).join(", ");
    const changedIds: string[] = [];
    const failures: { txnId: string; error: string }[] = [];
    let anyAsset = false;
    let reStampNeeded = false;
    // Build per-txn statement groups; flush in chunks WITHOUT splitting a txn's group across batches.
    let pending: D1PreparedStatement[] = [];
    const flush = async () => {
      if (pending.length) {
        await this.env.DB.batch(pending);
        pending = [];
      }
    };
    // An empty property_id clear must persist as NULL (not ''), or report's `property_id IS NOT NULL`
    // filter would treat the dangling '' as a real attribution.
    const bindVal = (n: { field: string; value: string }): string | null => (n.field === "property_id" && !n.value ? null : n.value);
    for (const txnId of ids) {
      const row = await this.env.DB.prepare(
        `SELECT ${selectCols.join(", ")} FROM transactions WHERE id = ? AND user_id = ?`,
      )
        .bind(txnId, userId)
        .first<Record<string, string | null>>();
      if (!row) {
        failures.push({ txnId, error: "not found" });
        continue;
      }
      const group: D1PreparedStatement[] = [
        this.env.DB.prepare(`UPDATE transactions SET ${setClause}, status='corrected', confidence=1.0 WHERE id = ? AND user_id = ?`).bind(...norm.map(bindVal), txnId, userId),
      ];
      for (const n of norm) {
        group.push(
          this.env.DB.prepare(
            `INSERT INTO corrections (id, user_id, txn_id, field, old_value, new_value, batch_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).bind(crypto.randomUUID(), userId, txnId, n.field, row[n.column] ?? null, bindVal(n), batchId),
        );
        if (n.field === "bucket" && n.value === "asset") anyAsset = true;
        if (n.field === "bucket" || n.field === "ato_label" || n.field === "merchant") reStampNeeded = true;
      }
      pending.push(...group);
      changedIds.push(txnId);
      if (pending.length >= 80) await flush();
    }
    await flush();

    // Side effects ONCE over all changed ids (mirrors applyCorrection, batched).
    if (anyAsset) await this.linkAssetsForUser(userId);
    if (reStampNeeded && changedIds.length) await this.stampDeductibility(userId, { txnIds: changedIds, reResolve: true });
    // Best-effort: eval-case promotion is a training side effect — a failure here must never reject
    // an already-committed correction batch (which the API would surface as a misleading error).
    for (const txnId of changedIds) {
      try {
        await this.promoteToEvalCase(userId, txnId);
      } catch (e) {
        await this.audit(userId, "promote_eval_error", JSON.stringify({ txnId, error: (e as Error).message }));
      }
    }
    // Optional rule-learning (BulkBar "remember this as a rule") — parity with apply-to-siblings, but
    // over a hand-picked multi-select: learn one rule per DISTINCT merchant stem among the changed rows,
    // so future imports of those merchants auto-apply. Only meaningful when a bucket was set; credit
    // buckets are rejected at the route (income must route through an income answer, not a re-bucket).
    let rulesCreated = 0;
    const bucketEdit = norm.find((n) => n.field === "bucket")?.value;
    if (opts.learnRule && bucketEdit && bucketEdit !== "unknown" && changedIds.length) {
      const atoLabel = norm.find((n) => n.field === "ato_label")?.value ?? "";
      const propertyId = norm.find((n) => n.field === "property_id")?.value || undefined;
      const stems = new Set<string>();
      for (const txnId of changedIds) {
        const r = await this.env.DB.prepare(`SELECT raw_description, merchant FROM transactions WHERE id = ? AND user_id = ?`)
          .bind(txnId, userId)
          .first<{ raw_description: string | null; merchant: string | null }>();
        const stem = groupKey(r?.raw_description ?? r?.merchant ?? "");
        if (stem) stems.add(stem);
      }
      for (const stem of stems) {
        if (await this.ensureClarifyRule(userId, stem, bucketEdit, atoLabel, propertyId)) rulesCreated++;
      }
    }
    await this.audit(userId, "correction_batch", JSON.stringify({ batch_id: batchId, updated: changedIds.length, edits: norm.map((n) => n.field), failures: failures.length, rules_created: rulesCreated }));
    return { batch_id: batchId, updated: changedIds.length, failures, rules_created: rulesCreated };
  }

  /**
   * Undo a batch correction as a unit: write each per-txn old_value back to its column and stamp
   * reverted_at, for the corrections of `batchId` that are still applied (reverted_at IS NULL).
   * Re-stamps deductibility on the restored rows. Idempotent (already-reverted rows are skipped).
   */
  async undoCorrectionBatch(userId: string, batchId: string): Promise<{ reverted: number }> {
    if (!batchId) return { reverted: 0 };
    const corr = await this.env.DB.prepare(
      `SELECT id, txn_id, field, old_value, new_value FROM corrections
        WHERE user_id = ? AND batch_id = ? AND reverted_at IS NULL ORDER BY created_at DESC`,
    )
      .bind(userId, batchId)
      .all<{ id: string; txn_id: string; field: string; old_value: string | null; new_value: string | null }>();
    const rows = corr.results ?? [];
    if (!rows.length) return { reverted: 0 };
    const changed = new Set<string>();
    const stmts: D1PreparedStatement[] = [];
    for (const c of rows) {
      const column = CORRECTABLE[c.field];
      if (!column) continue; // a non-correctable field never enters a batch, but guard anyway
      // Last-writer guard: only restore old_value if the column STILL holds this batch's new_value.
      // If a later correction overwrote it, undoing this batch must not clobber that newer value.
      stmts.push(
        this.env.DB.prepare(`UPDATE transactions SET ${column} = ? WHERE id = ? AND user_id = ? AND COALESCE(${column},'') = COALESCE(?,'')`).bind(c.old_value, c.txn_id, userId, c.new_value),
        this.env.DB.prepare(`UPDATE corrections SET reverted_at = datetime('now') WHERE id = ? AND user_id = ?`).bind(c.id, userId),
      );
      changed.add(c.txn_id);
    }
    for (let i = 0; i < stmts.length; i += 50) await this.env.DB.batch(stmts.slice(i, i + 50));
    if (changed.size) await this.stampDeductibility(userId, { txnIds: [...changed], reResolve: true });
    await this.audit(userId, "correction_batch_undo", JSON.stringify({ batch_id: batchId, reverted: changed.size }));
    return { reverted: changed.size };
  }

  // ── ai_edits: audited, reversible whole-entity writes (0057; Phases 3-4) ────────────────────────
  // The AI write tools (and, later, the manual Settings path) route create/update of the four core
  // entity types THROUGH here so every change is (a) serialised per tenant by the DO, (b) recorded in
  // ai_edits with full old/new snapshots for one-click undo, and (c) mirrored to the hash-chained
  // audit_log. We REUSE the existing situation-write functions unchanged — this only wraps them with
  // capture + recording, so the write itself (and its side-effects) is byte-identical to today.
  private static readonly AI_ENTITY_MAP: Record<string, { table: string }> = {
    person: { table: "persons" },
    property: { table: "properties" },
    entity: { table: "entities" },
    rule: { table: "user_rules" },
    account: { table: "accounts" },
    property_owner: { table: "property_owners" },
    entity_role: { table: "entity_roles" },
    income_activity: { table: "income_activities" },
    loan_property: { table: "loans_properties" },
  };

  // Per-entity side-effects to re-run after ANY revert (create→delete, update→restore, delete→re-insert).
  // The raw column restore/re-insert only touches the entity's own table, so a derived materialisation
  // (e.g. a property's disposal → synthetic cgt_assets/cgt_events via syncPropertyDisposalToCgt) would
  // otherwise go stale after an undo. Each hook is an idempotent rebuild keyed on the entity id, so it's
  // safe to run unconditionally in every direction: after an update/delete-re-insert it re-syncs from the
  // restored row; after a create→delete it finds no row and drops the orphaned derived rows.
  // NB: only kinds with a derived materialisation need a hook. income/cgt_assets/cgt_events stay off
  // the audited path (direct writes, not undoable) by design — if a CGT-materialising kind is ever
  // added to AI_ENTITY_MAP, it MUST get a RESTORE_HOOKS entry or undo will leave a stale projection.
  private static readonly RESTORE_HOOKS: Record<string, (env: Env, uid: string, id: string) => Promise<void>> = {
    property: (env, uid, id) => syncPropertyDisposalToCgt(env, uid, id),
  };

  // Rows addEntity/addProperty auto-seed for a parent (situation-write.ts). Undoing the parent's
  // CREATE must drop these first — they live in the parent's CHILD_REFS, so otherwise the parent's
  // own seeded child blocks the delete and the undo silently no-ops (reverted:0). Tables are a static
  // allowlist (entity_roles / income_activities) → safe to interpolate. For an entity only one of the
  // co/sal activities exists; deleting the other id is a harmless no-op.
  private static readonly AUTOSEED_CHILDREN: Record<string, (id: string) => Array<{ table: string; id: string }>> = {
    entity: (id) => [
      { table: "entity_roles", id: "erole_" + id },
      { table: "income_activities", id: "iact_co_" + id },
      { table: "income_activities", id: "iact_sal_" + id },
    ],
    property: (id) => [{ table: "income_activities", id: "iact_prop_" + id }],
  };

  private async aiEntitySnapshot(userId: string, table: string, id: string): Promise<Record<string, unknown> | null> {
    // table is from AI_ENTITY_MAP (fixed allowlist) — safe to interpolate.
    return await this.env.DB.prepare(`SELECT * FROM ${table} WHERE id = ? AND user_id = ?`).bind(id, userId).first<Record<string, unknown>>();
  }

  /**
   * Apply one AI-proposed (or manual) entity write and record it for undo. `op` is create|update only —
   * deletes stay on the direct path so DeleteBlockedError keeps its 409 shape (it wouldn't survive the
   * RPC boundary). Idempotent on `actionId`: a repeat with the same id returns the prior entity without
   * re-writing (double-confirm / retry safety). Returns the entity id + the action id.
   */
  async aiWriteEntity(
    userId: string,
    spec: { kind: string; op: "create" | "update"; id?: string; data: Record<string, unknown>; source?: "ai_confirmed" | "manual"; sessionId?: string; batchId?: string; actionId?: string },
  ): Promise<{ id: string; action_id: string; deduped?: boolean }> {
    const m = TaxAgent.AI_ENTITY_MAP[spec.kind];
    if (!m) throw new Error("unknown_entity_kind");
    const actionId = spec.actionId || crypto.randomUUID();
    const source = spec.source ?? "ai_confirmed";
    if (spec.actionId) {
      const existing = await this.env.DB.prepare(`SELECT entity_id FROM ai_edits WHERE user_id = ? AND action_id = ? AND reverted_at IS NULL ORDER BY created_at DESC LIMIT 1`).bind(userId, spec.actionId).first<{ entity_id: string }>();
      if (existing) return { id: existing.entity_id, action_id: actionId, deduped: true };
    }
    let entityId: string;
    let oldJson: string | null = null;
    if (spec.op === "update") {
      if (!spec.id) throw new Error("update_requires_id");
      const old = await this.aiEntitySnapshot(userId, m.table, spec.id);
      if (!old) throw new Error("entity_not_found");
      oldJson = JSON.stringify(old);
      entityId = spec.id;
      await this.applyEntityWrite(userId, spec.kind, "update", entityId, spec.data);
    } else {
      entityId = await this.applyEntityWrite(userId, spec.kind, "create", null, spec.data);
    }
    const newRow = await this.aiEntitySnapshot(userId, m.table, entityId);
    await this.env.DB.prepare(
      `INSERT INTO ai_edits (id, user_id, batch_id, action_id, entity_type, entity_id, op, old_json, new_json, source, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), userId, spec.batchId ?? null, actionId, spec.kind, entityId, spec.op, oldJson, newRow ? JSON.stringify(newRow) : null, source, spec.sessionId ?? null).run();
    await this.audit(userId, `ai_edit_${spec.op}`, JSON.stringify({ kind: spec.kind, entity_id: entityId, action_id: actionId, source }));
    return { id: entityId, action_id: actionId };
  }

  /**
   * Apply one entity delete and record it for undo. Snapshots the row first (old_json) so undo can
   * re-insert it. A blocked delete (RESTRICT: dependent financial records still reference the row) is
   * RETURNED as a structured `{ blocked }` result rather than thrown — DeleteBlockedError's
   * blockers/archivable payload wouldn't survive the DO RPC boundary as an exception, so api.ts
   * reconstructs the same 409 the direct path produces. Idempotent on actionId.
   */
  async aiDeleteEntity(
    userId: string,
    spec: { kind: string; id: string; source?: "ai_confirmed" | "manual"; sessionId?: string; actionId?: string },
  ): Promise<{ ok: true; action_id: string; deduped?: boolean } | { blocked: true; parentTable: string; blockers: DeleteBlocker[]; archivable: boolean; message: string }> {
    const m = TaxAgent.AI_ENTITY_MAP[spec.kind];
    if (!m) throw new Error("unknown_entity_kind");
    const actionId = spec.actionId || crypto.randomUUID();
    const source = spec.source ?? "manual";
    if (spec.actionId) {
      // Match aiWriteEntity: only a still-applied delete dedupes. A reverted (undone) delete must be
      // allowed to re-run, so the row gets deleted again rather than falsely reported as a no-op.
      const existing = await this.env.DB.prepare(`SELECT id FROM ai_edits WHERE user_id = ? AND action_id = ? AND op = 'delete' AND reverted_at IS NULL LIMIT 1`).bind(userId, spec.actionId).first<{ id: string }>();
      if (existing) return { ok: true, action_id: actionId, deduped: true };
    }
    const old = await this.aiEntitySnapshot(userId, m.table, spec.id);
    if (!old) throw new Error("entity_not_found");
    try {
      await deleteRow(this.env, userId, m.table as Parameters<typeof deleteRow>[2], spec.id);
    } catch (e) {
      if (e instanceof DeleteBlockedError) return { blocked: true, parentTable: e.parentTable, blockers: e.blockers, archivable: e.archivable, message: e.message };
      throw e;
    }
    await this.env.DB.prepare(
      `INSERT INTO ai_edits (id, user_id, batch_id, action_id, entity_type, entity_id, op, old_json, new_json, source, session_id)
       VALUES (?, ?, ?, ?, ?, ?, 'delete', ?, NULL, ?, ?)`,
    ).bind(crypto.randomUUID(), userId, null, actionId, spec.kind, spec.id, JSON.stringify(old), source, spec.sessionId ?? null).run();
    await this.audit(userId, "ai_edit_delete", JSON.stringify({ kind: spec.kind, entity_id: spec.id, action_id: actionId, source }));
    return { ok: true, action_id: actionId };
  }

  /** Dispatch to the existing situation-write add/update fn for a kind. Centralises the one place the
   *  generic ai_edits path touches typed payloads (the fns validate/normalise their own fields). */
  private async applyEntityWrite(userId: string, kind: string, op: "create" | "update", id: string | null, data: Record<string, unknown>): Promise<string> {
    // The situation-write fns validate/normalise their own fields; on create we assert the one required
    // field per kind up front so a malformed proposal fails loudly here, not with a NOT NULL deep in D1.
    const req = (k: string) => {
      if (op === "create" && (data[k] == null || data[k] === "")) throw new Error(`missing_${k}`);
    };
    if (kind === "person") { req("display_name"); return op === "create" ? addPerson(this.env, userId, data as { display_name: string }) : (await updatePerson(this.env, userId, id!, data), id!); }
    if (kind === "property") { req("label"); return op === "create" ? addProperty(this.env, userId, data as { label: string }) : (await updateProperty(this.env, userId, id!, data), id!); }
    if (kind === "entity") { req("kind"); return op === "create" ? addEntity(this.env, userId, data as { kind: string }) : (await updateEntity(this.env, userId, id!, data), id!); }
    if (kind === "rule") { req("pattern"); req("bucket"); return op === "create" ? addRule(this.env, userId, data as { pattern: string; bucket: string; ato_label: string }) : (await updateRule(this.env, userId, id!, data), id!); }
    if (kind === "account") { req("name"); return op === "create" ? addAccount(this.env, userId, data as { name: string }) : (await updateAccount(this.env, userId, id!, data), id!); }
    if (kind === "loan_property") { req("loan_account_id"); req("property_id"); return op === "create" ? addLoanProperty(this.env, userId, data as { loan_account_id: string; property_id: string }) : (await updateLoanProperty(this.env, userId, id!, data), id!); }
    // property_owner / entity_role / income_activity: create-only here (no generic update fn — their PUT
    // routes, where present, stay direct). Delete is handled generically by aiDeleteEntity via the map.
    if (kind === "property_owner") { req("property_id"); req("person_id"); if (op === "update") throw new Error("update_unsupported"); return addPropertyOwner(this.env, userId, data as { property_id: string; person_id: string }); }
    if (kind === "entity_role") { req("person_id"); req("entity_id"); req("role"); if (op === "update") throw new Error("update_unsupported"); return addEntityRole(this.env, userId, data as { person_id: string; entity_id: string; role: string }); }
    if (kind === "income_activity") { if (op === "update") throw new Error("update_unsupported"); return addIncomeActivity(this.env, userId, data); }
    throw new Error("unknown_entity_kind");
  }

  /** Undo every ai_edits row sharing this action_id (usually one), newest first. create→delete,
   *  update→restore old_json. Idempotent (skips already-reverted); a blocked delete is left applied. */
  async undoAiEdit(userId: string, actionId: string): Promise<{ reverted: number }> {
    if (!actionId) return { reverted: 0 };
    const rows = (await this.env.DB.prepare(`SELECT id, entity_type, entity_id, op, old_json FROM ai_edits WHERE user_id = ? AND action_id = ? AND reverted_at IS NULL ORDER BY created_at DESC`).bind(userId, actionId).all<{ id: string; entity_type: string; entity_id: string; op: string; old_json: string | null }>()).results ?? [];
    let reverted = 0;
    for (const r of rows) {
      if (await this.revertOneAiEdit(userId, r)) reverted++;
    }
    if (reverted) await this.audit(userId, "ai_edit_undo", JSON.stringify({ action_id: actionId, reverted }));
    return { reverted };
  }

  /** Undo a whole batch (multi-action AI change) atomically-ish, newest first. */
  async undoAiEditBatch(userId: string, batchId: string): Promise<{ reverted: number }> {
    if (!batchId) return { reverted: 0 };
    const rows = (await this.env.DB.prepare(`SELECT id, entity_type, entity_id, op, old_json FROM ai_edits WHERE user_id = ? AND batch_id = ? AND reverted_at IS NULL ORDER BY created_at DESC`).bind(userId, batchId).all<{ id: string; entity_type: string; entity_id: string; op: string; old_json: string | null }>()).results ?? [];
    let reverted = 0;
    for (const r of rows) {
      if (await this.revertOneAiEdit(userId, r)) reverted++;
    }
    if (reverted) await this.audit(userId, "ai_edit_batch_undo", JSON.stringify({ batch_id: batchId, reverted }));
    return { reverted };
  }

  private async revertOneAiEdit(userId: string, r: { id: string; entity_type: string; entity_id: string; op: string; old_json: string | null }): Promise<boolean> {
    const m = TaxAgent.AI_ENTITY_MAP[r.entity_type];
    if (!m) return false;
    try {
      if (r.op === "create") {
        // Inverse of a create is a delete. addEntity/addProperty auto-seed children that live in the
        // parent's CHILD_REFS, so a naive delete is RESTRICT-blocked → reverted:0. Faithful + atomic:
        // the parent's only permitted children are the seeded rows (anything else — real income or
        // attributions the user added since — still blocks the undo), and each seeded child must
        // itself be a leaf. Both checks pass → drop the seeded children + parent in one batch so a
        // later block can't leave a half-deleted parent.
        const seeded = TaxAgent.AUTOSEED_CHILDREN[r.entity_type]?.(r.entity_id) ?? [];
        if (seeded.length) {
          await assertNoBlockingChildrenExcept(this.env, userId, m.table, r.entity_id, seeded);
          for (const c of seeded) await assertNoBlockingChildren(this.env, userId, c.table, c.id);
          await this.env.DB.batch([
            ...seeded.map((c) => this.env.DB.prepare(`DELETE FROM ${c.table} WHERE id = ? AND user_id = ?`).bind(c.id, userId)),
            this.env.DB.prepare(`DELETE FROM ${m.table} WHERE id = ? AND user_id = ?`).bind(r.entity_id, userId),
          ]);
        } else {
          // No auto-seeded children for this kind → plain RESTRICT delete (blocked delete throws → leave applied).
          await deleteRow(this.env, userId, m.table as Parameters<typeof deleteRow>[2], r.entity_id);
        }
      } else if (r.op === "delete") {
        // Inverse of a delete is re-inserting the snapshot. A delete only succeeds on a leaf (RESTRICT
        // blocks any row with children), so a faithful single-row re-insert is safe. Columns come from
        // SELECT * (schema columns, not user input) → safe to interpolate; keep id + user_id so refs hold.
        if (!r.old_json) return false;
        const old = JSON.parse(r.old_json) as Record<string, unknown>;
        const cols = Object.keys(old);
        if (!cols.length) return false;
        await this.env.DB.prepare(`INSERT OR IGNORE INTO ${m.table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...cols.map((c) => old[c])).run();
        // Confirm the row is actually back. OR IGNORE swallows a UNIQUE conflict from an equivalent row
        // recreated since the delete — without this check we'd falsely mark the edit reverted while the
        // original snapshot was never restored. (Idempotent on retry: a prior re-insert leaves it present.)
        const restored = await this.aiEntitySnapshot(userId, m.table, r.entity_id);
        if (!restored) return false;
      } else {
        // Inverse of an update is restoring the prior snapshot. Column names come from SELECT * (schema
        // columns, not user input) → safe to interpolate. v1: an unconditional restore if the row exists.
        if (!r.old_json) return false;
        const old = JSON.parse(r.old_json) as Record<string, unknown>;
        const cols = Object.keys(old).filter((c) => c !== "id" && c !== "user_id");
        if (!cols.length) return false;
        const exists = await this.aiEntitySnapshot(userId, m.table, r.entity_id);
        if (!exists) return false;
        await this.env.DB.prepare(`UPDATE ${m.table} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ? AND user_id = ?`).bind(...cols.map((c) => old[c]), r.entity_id, userId).run();
      }
      // Re-run any derived-materialisation side-effect for this entity so an undo can't leave a stale
      // projection (e.g. a property's disposal → synthetic CGT rows). Idempotent; safe in every direction.
      const hook = TaxAgent.RESTORE_HOOKS[r.entity_type];
      if (hook) await hook(this.env, userId, r.entity_id);
      await this.env.DB.prepare(`UPDATE ai_edits SET reverted_at = datetime('now') WHERE id = ? AND user_id = ?`).bind(r.id, userId).run();
      return true;
    } catch {
      return false; // e.g. a blocked delete — leave the edit applied; the caller reports the count
    }
  }

  /** Recent entity edits for the "AI changes — undo" feed. Newest first, still-applied flagged. */
  async listAiEdits(userId: string, limit = 30): Promise<{ edits: { action_id: string; entity_type: string; entity_id: string; op: string; source: string; created_at: string; reverted_at: string | null; summary: string }[] }> {
    const rows = (await this.env.DB.prepare(
      `SELECT action_id, entity_type, entity_id, op, source, new_json, old_json, created_at, reverted_at
         FROM ai_edits WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    ).bind(userId, Math.min(Math.max(1, limit), 100)).all<{ action_id: string; entity_type: string; entity_id: string; op: string; source: string; new_json: string | null; old_json: string | null; created_at: string; reverted_at: string | null }>()).results ?? [];
    const label = (json: string | null): string => {
      if (!json) return "";
      try {
        const o = JSON.parse(json) as Record<string, unknown>;
        return String(o.label ?? o.display_name ?? o.name ?? o.pattern ?? o.id ?? "");
      } catch {
        return "";
      }
    };
    const edits = rows.map((r) => ({
      action_id: r.action_id,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      op: r.op,
      source: r.source,
      created_at: r.created_at,
      reverted_at: r.reverted_at,
      summary: `${r.op === "create" ? "Added" : r.op === "delete" ? "Removed" : "Updated"} ${r.entity_type} ${label(r.new_json) || label(r.old_json)}`.trim(),
    }));
    return { edits };
  }

  /** Hard-delete many transactions (bulk bar). Tolerant of missing ids; reuses deleteTransaction's R2 + audit path per row. */
  async deleteTransactionBatch(userId: string, txnIds: string[]): Promise<{ deleted: number }> {
    if (!Array.isArray(txnIds) || txnIds.length === 0) return { deleted: 0 };
    let deleted = 0;
    for (const txnId of txnIds.slice(0, 500)) {
      try {
        await this.deleteTransaction(userId, txnId);
        deleted++;
      } catch {
        /* missing / already gone — skip */
      }
    }
    return { deleted };
  }

  // ── STAGE A: deterministic non-spend MOVEMENT clean-up (no LLM, no consent) ──
  /**
   * Scan the tenant's captured bank lines for non-spend movements (internal transfers, card
   * payments, loan/mortgage repayments, investment-app deposits) with the pure classifyMovement
   * matcher. Returns a PRE-CHECKED confirm list (the user signs off before anything is excluded)
   * plus a separate review list for loan lines that may carry a DEDUCTIBLE investment-loan interest
   * component — those are never offered for one-tap exclusion (B3). Read-only.
   */
  async sweepMovements(userId: string): Promise<MovementSweep> {
    // Candidates: captured bank lines not already excluded/confirmed, still uncategorised or
    // low-confidence — so a row the user has confirmed (corrected / high-confidence) is never reclassified.
    const rows = await this.env.DB.prepare(
      `SELECT id, merchant, raw_description, amount_cents, amount_aud_cents, direction, txn_date, account_id
         FROM transactions
        WHERE user_id = ? AND kind = 'bank_line'
          AND status NOT IN ('ignored','duplicate','matched_receipt','corrected')
          AND (bucket IS NULL OR bucket = 'unknown' OR confidence IS NULL OR confidence < 0.85)`,
    )
      .bind(userId)
      .all<{ id: string; merchant: string | null; raw_description: string | null; amount_cents: number | null; amount_aud_cents: number | null; direction: string | null; txn_date: string | null; account_id: string | null }>();
    const ignorable: MovementCandidate[] = [];
    const property_loan_review: MovementCandidate[] = [];
    for (const r of rows.results ?? []) {
      const v = classifyMovement(r.raw_description ?? r.merchant ?? "");
      const treatment = movementTreatment(v.klass, r.direction);
      if (treatment === "skip") continue;
      const cand: MovementCandidate = {
        id: r.id,
        merchant: r.merchant,
        raw_description: r.raw_description,
        amount_cents: r.amount_cents,
        amount_aud_cents: r.amount_aud_cents,
        direction: r.direction,
        txn_date: r.txn_date,
        account_id: r.account_id,
        klass: v.klass,
        reason: v.reason,
      };
      if (treatment === "review") property_loan_review.push(cand);
      else ignorable.push(cand);
    }
    const ignorable_total_cents = ignorable.reduce((s, c) => s + (c.amount_aud_cents ?? c.amount_cents ?? 0), 0);
    return { ignorable, property_loan_review, summary: { ignorable_n: ignorable.length, ignorable_total_cents, review_n: property_loan_review.length } };
  }

  /**
   * Apply a Stage-A clean-up: mark the confirmed txn ids 'ignored' (non-spend). The server
   * RE-VERIFIES each id is genuinely movement-classified (defence in depth — a client can't ignore
   * arbitrary spend) and refuses any property-routed loan line, writes a per-txn correction
   * breadcrumb + an audit row. Idempotent (already-ignored rows are a no-op).
   */
  async applyMovementSweep(userId: string, txnIds: string[]): Promise<{ ignored: number; skipped: number }> {
    if (!Array.isArray(txnIds) || txnIds.length === 0) return { ignored: 0, skipped: 0 };
    const ids = txnIds.slice(0, 1000);
    let ignored = 0;
    let skipped = 0;
    const stmts: D1PreparedStatement[] = [];
    for (const txnId of ids) {
      const row = await this.env.DB.prepare(
        `SELECT raw_description, merchant, status, direction FROM transactions WHERE id = ? AND user_id = ?`,
      )
        .bind(txnId, userId)
        .first<{ raw_description: string | null; merchant: string | null; status: string; direction: string | null }>();
      if (!row) {
        skipped++;
        continue;
      }
      if (row.status === "ignored") {
        ignored++; // idempotent: already excluded
        continue;
      }
      // Re-verify server-side with the SAME shared treatment rule the read path used — only the
      // one-tap "ignorable" class may be excluded here. Loan lines (review) and income credits
      // (skip) are refused even if a client sends their ids (defence in depth — B3).
      const v = classifyMovement(row.raw_description ?? row.merchant ?? "");
      if (movementTreatment(v.klass, row.direction) !== "ignorable") {
        skipped++;
        continue;
      }
      stmts.push(
        this.env.DB.prepare(`UPDATE transactions SET status='ignored' WHERE id = ? AND user_id = ?`).bind(txnId, userId),
        this.env.DB.prepare(
          `INSERT INTO corrections (id, user_id, txn_id, field, old_value, new_value) VALUES (?, ?, ?, 'status', ?, 'ignored')`,
        ).bind(crypto.randomUUID(), userId, txnId, row.status),
      );
      ignored++;
    }
    // Chunk size is even and each ignored txn pushes exactly 2 statements (UPDATE then its
    // corrections INSERT), so a txn's pair is never split across two .batch() calls. Re-runs are
    // idempotent (already-'ignored' rows are a no-op above), so a partial failure is safe to retry.
    for (let i = 0; i < stmts.length; i += 50) await this.env.DB.batch(stmts.slice(i, i + 50));
    await this.audit(userId, "movement_sweep", JSON.stringify({ ignored, skipped }));
    return { ignored, skipped };
  }

  /**
   * Guided mortgage interest/principal split (Phase 5). For ONE loan/mortgage line tied to an
   * investment property, record the deductible INTEREST portion: the row keeps its gross amount_cents
   * (so statement reconciliation is untouched — one canonical money source), and deductible_amount_cents
   * is set to the interest, which the position counts ONLY when the `loan_split` flag is on (see
   * report.ts positionAmountCents). The principal is implicitly excluded. Confirm-each-pattern: the UI
   * pre-fills the % from the loan→property link but the user confirms each line. Own-home rent is
   * refused — only an income-producing property's loan interest is deductible (s8-1). General info only.
   */
  async applyLoanSplit(
    userId: string,
    txnId: string,
    opts: { property_id: string; interest_cents?: number; interest_pct?: number },
  ): Promise<{ ok: true; interest_cents: number }> {
    const row = await this.env.DB.prepare(
      `SELECT raw_description, merchant, direction, amount_cents, amount_aud_cents, account_id, status
         FROM transactions WHERE id = ? AND user_id = ? AND kind = 'bank_line'`,
    )
      .bind(txnId, userId)
      .first<{ raw_description: string | null; merchant: string | null; direction: string | null; amount_cents: number | null; amount_aud_cents: number | null; account_id: string | null; status: string }>();
    if (!row) throw new Error("transaction not found");
    // Defence in depth: re-verify server-side that this really is a loan-review line (a client can't
    // split arbitrary spend), mirroring the applyMovementSweep guard.
    const v = classifyMovement(row.raw_description ?? row.merchant ?? "");
    if (movementTreatment(v.klass, row.direction) !== "review") throw new Error("not a loan line to split");
    // The property must belong to this tenant AND be income-producing. Loan interest is only
    // deductible on a property held to earn assessable income — a rented one, or one genuinely
    // available for rent (vacant). An owner-occupied home, a property you rent as a tenant
    // (renting_*), or a sold one are all refused (their loan interest is private/capital).
    const prop = await this.env.DB.prepare(`SELECT status FROM properties WHERE id = ? AND user_id = ?`)
      .bind(opts.property_id, userId)
      .first<{ status: string | null }>();
    if (!prop) throw new Error("property not found");
    if (!["rented", "vacant"].includes(prop.status ?? ""))
      throw new Error("loan interest is only deductible on an income-producing property (rented, or genuinely available for rent) — not your own home, a property you rent, or a sold one");
    const gross = row.amount_aud_cents ?? row.amount_cents ?? 0;
    const raw = opts.interest_cents ?? Math.round((gross * (opts.interest_pct ?? 0)) / 100);
    const interest = Math.max(0, Math.min(gross, Math.round(raw))); // interest can't exceed the payment
    await this.env.DB.prepare(
      `UPDATE transactions
          SET bucket = 'property_rented', property_id = ?, deductible_amount_cents = ?,
              deductibility = 'confirmed_deductible', ato_label = 'rental:interest', status = 'corrected'
        WHERE id = ? AND user_id = ?`,
    )
      .bind(opts.property_id, interest, txnId, userId)
      .run();
    await this.env.DB.prepare(
      `INSERT INTO corrections (id, user_id, txn_id, field, old_value, new_value) VALUES (?, ?, ?, 'loan_split', ?, ?)`,
    )
      .bind(crypto.randomUUID(), userId, txnId, String(gross), String(interest))
      .run();
    // Persist the implied % back onto the loan→property link (if one exists) so the next statement's
    // matching line pre-fills with this %. This does NOT auto-apply — each line is still confirmed.
    if (row.account_id && gross > 0) {
      await this.env.DB.prepare(
        `UPDATE loans_properties SET deductible_interest_pct = ? WHERE user_id = ? AND loan_account_id = ? AND property_id = ?`,
      )
        .bind((interest / gross) * 100, userId, row.account_id, opts.property_id)
        .run();
    }
    await this.audit(userId, "loan_split", JSON.stringify({ txnId, property_id: opts.property_id, gross, interest }));
    return { ok: true, interest_cents: interest };
  }

  /**
   * Grouped loan-interest split — apply the SAME investment property + deductible-interest % to EVERY
   * loan line in a group at once (e.g. all 12 monthly "LN REPAY" lines), instead of one row at a time.
   * Loops the per-line applyLoanSplit, which re-verifies each line is a loan-review line on an
   * income-producing property, keeps the gross amount unchanged (reconciliation untouched), records
   * only the interest, and writes the % back to loans_properties. Passes the % (NOT a fixed cents
   * figure) so each line computes its interest from its OWN gross — correct even when repayments vary.
   * Already-split ('corrected') lines are skipped so a re-run is idempotent; a per-line failure (e.g. a
   * line that isn't really a loan line) is counted and skipped, never fatal to the rest of the group.
   */
  async applyLoanSplitGroup(
    userId: string,
    txnIds: string[],
    opts: { property_id: string; interest_pct: number },
  ): Promise<{ applied: number; skipped: number; interest_cents: number }> {
    if (!Array.isArray(txnIds) || txnIds.length === 0) return { applied: 0, skipped: 0, interest_cents: 0 };
    const ids = txnIds.slice(0, 1000);
    let applied = 0;
    let skipped = 0;
    let interest_cents = 0;
    for (const id of ids) {
      // Skip a line already split (status='corrected') so a double-tap / re-run can't re-split it.
      const cur = await this.env.DB.prepare(`SELECT status FROM transactions WHERE id = ? AND user_id = ? AND kind = 'bank_line'`)
        .bind(id, userId)
        .first<{ status: string }>();
      if (!cur || cur.status === "corrected") {
        skipped++;
        continue;
      }
      try {
        const r = await this.applyLoanSplit(userId, id, { property_id: opts.property_id, interest_pct: opts.interest_pct });
        applied++;
        interest_cents += r.interest_cents;
      } catch {
        skipped++; // not a loan-review line / fails the income-producing-property check — skip, don't abort
      }
    }
    await this.audit(userId, "loan_split_group", JSON.stringify({ n: ids.length, applied, skipped, property_id: opts.property_id, interest_pct: opts.interest_pct }));
    return { applied, skipped, interest_cents };
  }

  // ── STAGE B: clarify-by-pattern (group leftovers → one question per pattern) ──
  /**
   * Scan the FY's leftover bank lines (uncategorised / unknown / low-confidence, not already
   * excluded), group them by normalised merchant stem, and upsert ONE open clarify_question per
   * recurring pattern (≥K lines OR ≥$threshold). Idempotent + state-preserving: the upsert only
   * refreshes counts on rows still 'open', so an answered/dismissed question never resurrects. Stems
   * already covered by a user_rule are skipped (they auto-apply on recategorise). No LLM, no consent.
   */
  async runClarifyScan(userId: string, startYear: number): Promise<{ questions: number; groups: number }> {
    const profile = await this.requireProfile(userId);
    const situation = await getSituation(this.env, userId, profile);
    const { start, end } = fyBounds(startYear, await this.jurisdictionFor(userId));
    const rows = await this.env.DB.prepare(
      `SELECT id, raw_description, merchant, amount_cents, amount_aud_cents, direction
         FROM transactions
        WHERE user_id = ? AND kind = 'bank_line'
          AND ${CLARIFY_LEFTOVER_WHERE}
          AND txn_date >= ? AND txn_date <= ?`,
    )
      .bind(userId, start, end)
      .all<ClarifyRow>();
    // Exclude non-spend MOVEMENTS that a dedicated step already owns — internal transfers, card
    // payments and investment deposits (the movement-sweep "clean up" step) and loan repayments (the
    // loan-split step) — so a line surfaces in exactly ONE place, never ALSO as a clarify group (the
    // cause of the duplicate loan/transfer rows). Anything the sweep doesn't own classifies as "skip"
    // and stays here. Reuses the shared `isClarifyLeftover` matcher so the surfaces can't disagree.
    const leftovers = (rows.results ?? []).filter(isClarifyLeftover);
    // Tenant paying rent on their own home → clarify offers a "rent I pay (private)" answer.
    const hasTenantHome = situation.properties.some((p) => p.status === "renting_residence");
    const groups = groupForClarify(leftovers, undefined, { hasTenantHome, directionGuard: featureOn(this.env, "clarify_direction_guard") });
    let questions = 0;
    for (const g of groups) {
      // Skip a stem a DIRECTION-PURE group's user_rule already covers — those lines auto-apply on
      // recategorise, so re-asking would be noise. A MIXED group is NOT skipped: a debit expense
      // rule must not suppress asking about the credit side (and vice-versa).
      if (g.direction !== "mixed" && applyUserRules(g.group_key, situation.rules, g.direction)) continue;
      const res = await this.env.DB.prepare(
        `INSERT INTO clarify_questions (id, user_id, fy, group_key, sample_desc, direction, n, total_cents, suggested_json, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
         ON CONFLICT(user_id, fy, group_key) DO UPDATE SET
           n = excluded.n, total_cents = excluded.total_cents, sample_desc = excluded.sample_desc,
           direction = excluded.direction, suggested_json = excluded.suggested_json
         WHERE clarify_questions.status = 'open'`,
      )
        .bind(crypto.randomUUID(), userId, fyStartYearStr(startYear), g.group_key, g.sample_desc, g.direction, g.n, g.total_cents, JSON.stringify(g.suggestions))
        .run();
      questions += res.meta?.changes ?? 0;
    }
    await this.audit(userId, "clarify_scan", JSON.stringify({ fy: startYear, groups: groups.length, upserted: questions }));
    return { questions, groups: groups.length };
  }

  /** Open clarify questions (optionally scoped to one FY start year), biggest-dollar first. */
  async listClarifyQuestions(userId: string, startYear?: number): Promise<ClarifyQuestion[]> {
    const where = startYear != null ? "user_id = ? AND status = 'open' AND fy = ?" : "user_id = ? AND status = 'open'";
    const binds = startYear != null ? [userId, fyStartYearStr(startYear)] : [userId];
    const res = await this.env.DB.prepare(
      `SELECT id, fy, group_key, sample_desc, direction, n, total_cents, suggested_json, status
         FROM clarify_questions WHERE ${where} ORDER BY total_cents DESC LIMIT 200`,
    )
      .bind(...binds)
      .all<{ id: string; fy: string; group_key: string; sample_desc: string | null; direction: string | null; n: number; total_cents: number; suggested_json: string | null; status: string }>();
    return (res.results ?? [])
      // Hide questions whose group is actually a non-spend MOVEMENT — a dedicated step owns those now
      // (the loan-split / movement-sweep steps). Keeps the LIST on the SAME predicate as the scan and
      // the answer resolver, so OPEN questions created before this dedup landed (e.g. an old "Loan
      // Repayment LN REPAY" group) don't linger as a duplicate of the loan/transfer rows — or answer to
      // 0 rows. sample_desc is the raw line text, so it classifies the same way the scan rows do.
      .filter((r) => isClarifyLeftover({ raw_description: r.sample_desc, merchant: r.group_key, direction: r.direction }))
      .map((r) => ({
        id: r.id,
        fy: r.fy,
        group_key: r.group_key,
        sample_desc: r.sample_desc,
        direction: r.direction,
        n: r.n,
        total_cents: r.total_cents,
        suggestions: r.suggested_json ? (JSON.parse(r.suggested_json) as ClarifyQuestion["suggestions"]) : [],
        status: r.status,
      }));
  }

  /** Dismiss a clarify question (the user judges the pattern not worth answering). Terminal. */
  async dismissClarify(userId: string, questionId: string): Promise<{ ok: boolean }> {
    await this.env.DB.prepare(`UPDATE clarify_questions SET status = 'dismissed' WHERE id = ? AND user_id = ? AND status = 'open'`).bind(questionId, userId).run();
    return { ok: true };
  }

  /**
   * Answer ONE clarify question → (a) recategorise the whole matching group NOW, and (b) create a
   * user_rule so future matches auto-apply. Ordered + idempotent: claim the question (status='open'→
   * 'answered') FIRST and treat a non-open question as a no-op, so a double-tap or re-run can't
   * double-apply. Income answers route each credit to recordIncome (deduped via matched_income_id)
   * and exclude the bank credit (status='ignored') so the rent counts exactly once (B4/B5). Re-bucket
   * answers go through the Phase-2 applyCorrectionBatch seam (shared batch_id, deductibility re-stamp).
   */
  /**
   * Record ONE credit bank-line as income and link it (matched_income_id + status='ignored') so the
   * credit and the income row count once. Passes the NATIVE amount + currency so recordIncome does the
   * AUD conversion and preserves FX provenance. Returns the income id, or null when the line isn't an
   * eligible unlinked credit. Shared by the Clarify group answer and the single-txn "record as income".
   */
  private async recordCreditAsIncome(
    userId: string,
    r: { id: string; direction: string | null; matched_income_id: string | null; amount_cents: number | null; amount_aud_cents: number | null; currency: string | null; txn_date: string | null },
    opts: { incomeType: string; propertyId?: string | null; fy: string | null },
  ): Promise<string | null> {
    if (r.direction !== "credit") return null; // income answers act on credits only
    if (r.matched_income_id) return null; // already linked → dedupe (B4)
    const incomeId = await this.recordIncome(userId, {
      income_type: opts.incomeType,
      gross_cents: r.amount_cents ?? r.amount_aud_cents ?? 0,
      currency: r.currency ?? "AUD",
      property_id: opts.propertyId ?? null,
      txn_date: r.txn_date,
      fy: opts.fy,
    });
    await this.env.DB.prepare(`UPDATE transactions SET matched_income_id = ?, status = 'ignored' WHERE id = ? AND user_id = ?`).bind(incomeId, r.id, userId).run();
    return incomeId;
  }

  /**
   * #130: one-click — record a single rent/income credit as income for its tagged property and link
   * it (single-count). Derives income_type from the line's bucket (income_property→rent). Flag-gated
   * (`record_credit_income`) at the route. The per-txn equivalent of the Clarify group income answer.
   */
  async recordTxnAsIncome(userId: string, txnId: string): Promise<{ income_id: string | null }> {
    const r = await this.env.DB.prepare(
      `SELECT id, direction, matched_income_id, amount_cents, amount_aud_cents, currency, txn_date, bucket, property_id
         FROM transactions WHERE id = ? AND user_id = ?`,
    )
      .bind(txnId, userId)
      .first<{ id: string; direction: string | null; matched_income_id: string | null; amount_cents: number | null; amount_aud_cents: number | null; currency: string | null; txn_date: string | null; bucket: string | null; property_id: string | null }>();
    if (!r) throw new Error("transaction not found");
    if (r.direction !== "credit") throw new Error("only a money-in (credit) line can be recorded as income");
    if (r.matched_income_id) throw new Error("this line is already recorded as income");
    // Only an income-bucketed credit can be recorded as income — guard against a mis-bucketed (payg /
    // company / unknown) line being silently filed as 'personal' income.
    if (r.bucket !== "income_property" && r.bucket !== "income_business" && r.bucket !== "income_personal")
      throw new Error("categorise this as income (rental / business / personal) before recording it");
    const incomeType = r.bucket === "income_property" ? "rent" : r.bucket === "income_business" ? "business" : "personal";
    // fy: null ⇒ recordIncome derives it from the line's date (its standard fallback).
    const incomeId = await this.recordCreditAsIncome(userId, r, { incomeType, propertyId: r.property_id, fy: null });
    await this.audit(userId, "record_txn_income", JSON.stringify({ txnId, income_id: incomeId, income_type: incomeType }));
    return { income_id: incomeId };
  }

  async answerClarify(userId: string, questionId: string, answer: ClarifyAnswer): Promise<{ applied: number; income_recorded: number }> {
    const q = await this.env.DB.prepare(
      `SELECT id, fy, group_key, status FROM clarify_questions WHERE id = ? AND user_id = ?`,
    )
      .bind(questionId, userId)
      .first<{ id: string; fy: string; group_key: string; status: string }>();
    if (!q) throw new Error("clarify question not found");
    if (q.status !== "open") return { applied: 0, income_recorded: 0 }; // idempotent: already answered/dismissed
    // VALIDATE BEFORE claiming the question, so a bad answer never consumes it (no dead-ended answer).
    if (answer.kind === "income_property" && !answer.property_id) throw new Error("property_id required for rental income");
    if (answer.kind === "bucket") {
      if (!answer.bucket) throw new Error("bucket required");
      // Income/refund are money-IN buckets — they MUST go through the income_* kinds (recordIncome +
      // single-count dedupe), never the spend-oriented re-bucket seam, or the credit gets counted twice.
      if (RULE_CREDIT_BUCKETS.has(answer.bucket)) throw new Error(`use an income answer kind, not bucket='${answer.bucket}'`);
    }
    // Claim it, guarded on status='open' so only one writer proceeds.
    const claim = await this.env.DB.prepare(
      `UPDATE clarify_questions SET status = 'answered', answer_json = ? WHERE id = ? AND user_id = ? AND status = 'open'`,
    )
      .bind(JSON.stringify(answer), questionId, userId)
      .run();
    if (!(claim.meta?.changes ?? 0)) return { applied: 0, income_recorded: 0 };

    // Resolve the group's CURRENT rows using the SAME leftover filter the scan used (so the answer
    // acts only on the uncategorised/low-confidence rows the user actually saw — never re-touching a
    // row a prior correction already finalised, and never overshooting the count shown).
    const { start, end } = fyBounds(parseFyStartYear(q.fy), await this.jurisdictionFor(userId));
    const rowsRes = await this.env.DB.prepare(
      `SELECT id, raw_description, merchant, direction, amount_cents, amount_aud_cents, currency, matched_income_id, txn_date
         FROM transactions
        WHERE user_id = ? AND kind = 'bank_line'
          AND ${CLARIFY_LEFTOVER_WHERE}
          AND txn_date >= ? AND txn_date <= ?`,
    )
      .bind(userId, start, end)
      .all<{ id: string; raw_description: string | null; merchant: string | null; direction: string | null; amount_cents: number | null; amount_aud_cents: number | null; currency: string | null; matched_income_id: string | null; txn_date: string | null }>();
    // Same movement-exclusion predicate as runClarifyScan (centralised in isClarifyLeftover so the scan
    // filter and this answer filter can't drift) so the answer acts on exactly the rows the user saw —
    // never a transfer/card/loan line that a dedicated step owns.
    const group = (rowsRes.results ?? []).filter(
      (r) => groupKey(r.raw_description ?? r.merchant ?? "") === q.group_key && isClarifyLeftover(r),
    );
    // #341 (flag): when ON, ignore/bucket act on the money-OUT side only so a mixed merchant group's
    // income credits aren't silently dropped/converted. OFF ⇒ whole group (today's behaviour).
    const directionGuard = featureOn(this.env, "clarify_direction_guard");

    if (answer.kind === "income_property" || answer.kind === "income_business" || answer.kind === "income_personal") {
      const incomeType = answer.kind === "income_property" ? "rent" : answer.kind === "income_business" ? "business" : "personal";
      let income_recorded = 0;
      for (const r of group) {
        const incomeId = await this.recordCreditAsIncome(userId, r, { incomeType, propertyId: answer.property_id ?? null, fy: fyLabel(parseFyStartYear(q.fy)) });
        if (incomeId) income_recorded++;
      }
      // NB: deliberately NO user_rule for income — a bucketing rule would tag future credits
      // income_* WITHOUT recording them in the income table (the headline source), under-counting
      // future rent. Leaving them uncategorised re-surfaces the pattern next scan → recorded correctly.
      await this.audit(userId, "clarify_answer", JSON.stringify({ questionId, kind: answer.kind, income_recorded }));
      return { applied: income_recorded, income_recorded };
    }

    if (answer.kind === "ignore") {
      // DIRECTION GUARD (flag): in a MIXED group, ignore the money-OUT side only — a credit there is
      // income, not a transfer; ignoring it would silently drop it from the income table. But 'ignore'
      // is ALSO the right answer on a PURE-CREDIT group (genuine transfers-in / gifts), so only drop
      // credits when the group actually has a debit — otherwise a pure-credit 'ignore' would match no
      // rows and leave them stuck. Credits in a mixed group re-surface for an income answer / next scan.
      const hasDebit = group.some((r) => r.direction !== "credit");
      const targets = directionGuard && hasDebit ? group.filter((r) => r.direction !== "credit") : group;
      const ids = targets.map((r) => r.id);
      const stmts: D1PreparedStatement[] = [];
      for (const r of targets) {
        stmts.push(
          this.env.DB.prepare(`UPDATE transactions SET status = 'ignored' WHERE id = ? AND user_id = ?`).bind(r.id, userId),
          this.env.DB.prepare(`INSERT INTO corrections (id, user_id, txn_id, field, old_value, new_value) VALUES (?, ?, ?, 'status', 'clarify', 'ignored')`).bind(crypto.randomUUID(), userId, r.id),
        );
      }
      for (let i = 0; i < stmts.length; i += 80) await this.env.DB.batch(stmts.slice(i, i + 80));
      await this.audit(userId, "clarify_answer", JSON.stringify({ questionId, kind: "ignore", applied: ids.length }));
      return { applied: ids.length, income_recorded: 0 };
    }

    if (answer.kind === "capital") {
      // Investment / capital (a Stake/CommSec/Pearler deposit, a share purchase): not a deduction and
      // not income, but CGT-relevant. Park it EXCLUDED — status='ignored' (position-neutral: COUNTABLE
      // excludes 'ignored') — and stamp ato_label='capital:investment' so a future CGT cost-base feature
      // can find these lines. No user_rule in v1 (a re-scan re-surfaces the pattern); a real CGT ledger +
      // auto-park rule is a deferred follow-up (needs a taxonomy decision).
      //
      // DIRECTION GUARD (mirrors the income branches): capital applies to the money-OUT side only — the
      // deposit/purchase is the capital movement. Any CREDIT in the same merchant group is a dividend /
      // capital return = assessable INCOME, so it MUST NOT be ignored here (that would silently drop it
      // from income). Credits are left uncategorised for an income answer / the next scan.
      const debits = group.filter((r) => r.direction !== "credit");
      const stmts: D1PreparedStatement[] = [];
      for (const r of debits) {
        stmts.push(
          this.env.DB.prepare(`UPDATE transactions SET status = 'ignored', ato_label = 'capital:investment' WHERE id = ? AND user_id = ?`).bind(r.id, userId),
          this.env.DB.prepare(`INSERT INTO corrections (id, user_id, txn_id, field, old_value, new_value) VALUES (?, ?, ?, 'capital', 'clarify', 'capital:investment')`).bind(crypto.randomUUID(), userId, r.id),
        );
      }
      for (let i = 0; i < stmts.length; i += 80) await this.env.DB.batch(stmts.slice(i, i + 80));
      await this.audit(userId, "clarify_answer", JSON.stringify({ questionId, kind: "capital", applied: debits.length }));
      return { applied: debits.length, income_recorded: 0 };
    }

    // kind === 'bucket' → re-bucket the group via the Phase-2 batch seam + learn a rule.
    const edits: { field: string; value: string }[] = [{ field: "bucket", value: answer.bucket! }];
    if (answer.ato_label) edits.push({ field: "ato_label", value: answer.ato_label });
    if (answer.property_id) edits.push({ field: "property_id", value: answer.property_id });
    // DIRECTION GUARD (flag): re-bucket the money-OUT side only — a credit in a mixed merchant group is
    // income; rebucketing it into a spend bucket converts income into an expense. Credits are left to be
    // recorded via an income answer. Flag-OFF ⇒ whole group (byte-identical).
    const targets = directionGuard ? group.filter((r) => r.direction !== "credit") : group;
    const ids = targets.map((r) => r.id);
    const res = await this.applyCorrectionBatch(userId, ids, edits);
    await this.ensureClarifyRule(userId, q.group_key, answer.bucket!, answer.ato_label ?? "", answer.property_id);
    await this.audit(userId, "clarify_answer", JSON.stringify({ questionId, kind: "bucket", bucket: answer.bucket, applied: res.updated }));
    return { applied: res.updated, income_recorded: 0 };
  }

  /**
   * Create a per-user rule so future matches of an answered EXPENSE pattern auto-apply. The rule
   * pattern is the LONGEST token of the group stem (a real substring of the raw merchant) — the
   * stem itself is alphabetically sorted ("energy origin") and would never substring-match the raw
   * "...origin energy..." line. Single-token stems are used as-is.
   */
  private async ensureClarifyRule(userId: string, groupKeyStem: string, bucket: string, atoLabel: string, propertyId?: string): Promise<boolean> {
    if (!bucket || bucket === "unknown" || !groupKeyStem) return false;
    const pattern = rulePatternForStem(groupKeyStem);
    if (!pattern) return false;
    const profile = await this.requireProfile(userId);
    const situation = await getSituation(this.env, userId, profile);
    const dir = RULE_CREDIT_BUCKETS.has(bucket) ? "credit" : "debit";
    if (applyUserRules(pattern, situation.rules, dir)) return false; // already covered
    await addRule(this.env, userId, { pattern, match_type: "merchant_contains", bucket, ato_label: atoLabel, property_id: propertyId });
    return true;
  }

  // ── Apply-to-siblings (flag apply_to_siblings) — "edit one line → update its look-alikes" ──
  /**
   * Resolve the still-to-review SIBLINGS of one seed transaction: other bank lines that normalise to
   * the same merchant stem (groupKey), share the seed's direction, and are still clarify leftovers
   * (uncategorised / low-confidence, not owned by a movement step). NOT FY-scoped — the same merchant
   * is the same category in any year, so the answer fans out across the whole tenant. Reuses the
   * shared CLARIFY_LEFTOVER_WHERE + isClarifyLeftover so it can never act on a row a dedicated step
   * owns or a row the user already finalised. The seed itself is excluded (it's edited via the normal
   * correct path).
   */
  private async resolveSiblingLeftovers(
    userId: string,
    seed: { id: string; raw_description: string | null; merchant: string | null; direction: string | null },
  ): Promise<{ key: string | null; rows: { id: string; amount_cents: number | null; amount_aud_cents: number | null }[] }> {
    const key = groupKey(seed.raw_description ?? seed.merchant ?? "");
    if (!key) return { key: null, rows: [] };
    const res = await this.env.DB.prepare(
      `SELECT id, raw_description, merchant, direction, amount_cents, amount_aud_cents
         FROM transactions
        WHERE user_id = ? AND kind = 'bank_line' AND ${CLARIFY_LEFTOVER_WHERE}`,
    )
      .bind(userId)
      .all<{ id: string; raw_description: string | null; merchant: string | null; direction: string | null; amount_cents: number | null; amount_aud_cents: number | null }>();
    const rows = (res.results ?? []).filter(
      (r) =>
        r.id !== seed.id &&
        groupKey(r.raw_description ?? r.merchant ?? "") === key &&
        (r.direction ?? null) === (seed.direction ?? null) &&
        isClarifyLeftover(r),
    );
    return { key, rows: rows.map((r) => ({ id: r.id, amount_cents: r.amount_cents, amount_aud_cents: r.amount_aud_cents })) };
  }

  /** Count + total of a seed's still-to-review look-alikes, for the "Apply to N look-alikes" prompt. */
  async previewSiblings(userId: string, seedTxnId: string): Promise<{ n: number; total_cents: number; group_key: string | null }> {
    const seed = await this.env.DB.prepare(
      `SELECT id, raw_description, merchant, direction FROM transactions WHERE id = ? AND user_id = ?`,
    )
      .bind(seedTxnId, userId)
      .first<{ id: string; raw_description: string | null; merchant: string | null; direction: string | null }>();
    if (!seed) throw new Error("transaction not found");
    const { key, rows } = await this.resolveSiblingLeftovers(userId, seed);
    const total = rows.reduce((a, r) => a + Math.abs(r.amount_aud_cents ?? r.amount_cents ?? 0), 0);
    return { n: rows.length, total_cents: total, group_key: key };
  }

  /**
   * Apply one seed's categorisation (bucket / ato_label / property) to all its still-to-review
   * look-alikes in ONE batch (shared batch_id → one-tap Undo), and optionally learn a user_rule so
   * FUTURE imports of the same merchant auto-apply. This is the "edit one → update the other 35" path,
   * built on the SAME applyCorrectionBatch + ensureClarifyRule seams the clarify answer uses, so the
   * two paths are output-equivalent. Income/refund (money-IN) buckets are rejected — those must go
   * through the income flow (single-count dedupe), never this spend-oriented seam.
   */
  async applyToSiblings(
    userId: string,
    seedTxnId: string,
    edit: { bucket?: string; ato_label?: string; property_id?: string },
    opts: { learnRule?: boolean } = {},
  ): Promise<{ applied: number; batch_id: string; rule_created: boolean; group_key: string | null }> {
    const seed = await this.env.DB.prepare(
      `SELECT id, raw_description, merchant, direction FROM transactions WHERE id = ? AND user_id = ?`,
    )
      .bind(seedTxnId, userId)
      .first<{ id: string; raw_description: string | null; merchant: string | null; direction: string | null }>();
    if (!seed) throw new Error("transaction not found");
    if (edit.bucket) {
      if (!isBucket(edit.bucket)) throw new Error(`invalid bucket: ${edit.bucket}`);
      if (RULE_CREDIT_BUCKETS.has(edit.bucket)) throw new Error(`use an income answer, not bucket='${edit.bucket}'`);
    }
    const edits: { field: string; value: string }[] = [];
    if (edit.bucket) edits.push({ field: "bucket", value: edit.bucket });
    if (edit.ato_label) edits.push({ field: "ato_label", value: edit.ato_label });
    if (edit.property_id) edits.push({ field: "property_id", value: edit.property_id });
    if (!edits.length) throw new Error("edit must set at least one of bucket / ato_label / property_id");

    const { key, rows } = await this.resolveSiblingLeftovers(userId, seed);
    const ids = rows.map((r) => r.id);
    let applied = 0;
    let batch_id = "";
    if (ids.length) {
      const res = await this.applyCorrectionBatch(userId, ids, edits);
      applied = res.updated;
      batch_id = res.batch_id;
    }
    let rule_created = false;
    if (opts.learnRule && edit.bucket && key) {
      await this.ensureClarifyRule(userId, key, edit.bucket, edit.ato_label ?? "", edit.property_id);
      rule_created = true;
    }
    await this.audit(userId, "apply_to_siblings", JSON.stringify({ seedTxnId, group_key: key, applied, learnRule: !!opts.learnRule }));
    return { applied, batch_id, rule_created, group_key: key };
  }

  // ── Evidence-first loan interest (flag loan_interest_v2) — record the ACTUAL FY interest ──
  /**
   * Record (upsert) the actual interest charged on a loan for a financial year — the evidenced
   * figure (lender annual summary or parsed statement) that the evidence-first model prefers over a
   * rate estimate. One row per (tenant, loan account, FY). Capture-only in this slice: report.ts does
   * NOT read it yet (S5 wires the per-property contribution + the mutual-exclusion guard vs the legacy
   * loan_split), so recording a figure does NOT change the indicative position.
   */
  async setLoanInterest(
    userId: string,
    loanAccountId: string,
    fy: number,
    interestCents: number,
    source = "lender_summary",
    documentId?: string,
  ): Promise<{ ok: true; interest_cents: number; source: string }> {
    const acct = await this.env.DB.prepare(`SELECT type FROM accounts WHERE id = ? AND user_id = ?`)
      .bind(loanAccountId, userId)
      .first<{ type: string }>();
    if (!acct) throw new Error("loan account not found");
    if (acct.type !== "loan") throw new Error("interest can only be recorded against a loan account");
    const cents = Math.max(0, Math.round(Number.isFinite(interestCents) ? interestCents : 0));
    const src = ["lender_summary", "statement_parsed", "estimate"].includes(source) ? source : "lender_summary";
    await this.env.DB.prepare(
      `INSERT INTO loan_interest_summaries (id, user_id, loan_account_id, fy, interest_cents, source, document_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, loan_account_id, fy) DO UPDATE SET
         interest_cents = excluded.interest_cents, source = excluded.source, document_id = excluded.document_id`,
    )
      .bind(crypto.randomUUID(), userId, loanAccountId, String(fy), cents, src, documentId ?? null)
      .run();
    await this.audit(userId, "loan_interest_set", JSON.stringify({ loanAccountId, fy, cents, source: src }));
    return { ok: true, interest_cents: cents, source: src };
  }

  /**
   * The loan-interest "to confirm" list for the Sort flow: every loan account tied to an income-
   * producing property (loans_properties → rented/vacant) and whether its FY interest has been
   * recorded yet. Drives the "Confirm loan interest" step that replaces the retired manual split —
   * so an investor is prompted to enter the lender's actual figure in the happy path. Surfaces a
   * rate×balance ESTIMATE (when the account carries both) as a prefill suggestion, clearly labelled.
   */
  async listLoanInterestReview(
    userId: string,
    fy: number,
  ): Promise<{ loan_account_id: string; loan_name: string; properties: { id: string; label: string | null }[]; recorded_cents: number | null; source: string | null; estimate_cents: number | null }[]> {
    const res = await this.env.DB.prepare(
      `SELECT a.id AS loan_account_id, a.name AS loan_name, a.interest_rate_pct, a.balance_cents,
              p.id AS property_id, p.label AS property_label,
              lis.interest_cents AS recorded_cents, lis.source AS source
         FROM loans_properties lp
         JOIN accounts a   ON a.id = lp.loan_account_id AND a.user_id = lp.user_id AND a.type = 'loan' AND a.active = 1
         JOIN properties p ON p.id = lp.property_id     AND p.user_id = lp.user_id AND p.status IN ('rented','vacant')
         LEFT JOIN loan_interest_summaries lis ON lis.loan_account_id = a.id AND lis.user_id = a.user_id AND lis.fy = ?
        WHERE lp.user_id = ?
        ORDER BY a.name`,
    )
      .bind(String(fy), userId)
      .all<{ loan_account_id: string; loan_name: string; interest_rate_pct: number | null; balance_cents: number | null; property_id: string; property_label: string | null; recorded_cents: number | null; source: string | null }>();
    const byLoan = new Map<string, { loan_account_id: string; loan_name: string; properties: { id: string; label: string | null }[]; recorded_cents: number | null; source: string | null; estimate_cents: number | null }>();
    for (const r of res.results ?? []) {
      let row = byLoan.get(r.loan_account_id);
      if (!row) {
        const estimate_cents = r.interest_rate_pct != null && r.balance_cents != null ? Math.round((r.balance_cents * r.interest_rate_pct) / 100) : null;
        row = { loan_account_id: r.loan_account_id, loan_name: r.loan_name, properties: [], recorded_cents: r.recorded_cents, source: r.source, estimate_cents };
        byLoan.set(r.loan_account_id, row);
      }
      if (!row.properties.some((p) => p.id === r.property_id)) row.properties.push({ id: r.property_id, label: r.property_label });
    }
    return [...byLoan.values()];
  }

  /** List recorded loan-interest summaries (optionally for one FY start year). */
  async listLoanInterest(
    userId: string,
    fy?: number,
  ): Promise<{ id: string; loan_account_id: string; fy: string; interest_cents: number; source: string; document_id: string | null }[]> {
    const where = fy != null ? "user_id = ? AND fy = ?" : "user_id = ?";
    const binds = fy != null ? [userId, String(fy)] : [userId];
    const res = await this.env.DB.prepare(
      `SELECT id, loan_account_id, fy, interest_cents, source, document_id
         FROM loan_interest_summaries WHERE ${where} ORDER BY created_at DESC`,
    )
      .bind(...binds)
      .all<{ id: string; loan_account_id: string; fy: string; interest_cents: number; source: string; document_id: string | null }>();
    return res.results ?? [];
  }

  // ── PHASE 4: "Do my books" accountant pass (deterministic orchestration) ────
  /**
   * Run the accountant pass for one FY end-to-end and return a sign-off pack of counts. Orchestrates
   * the already-shipped, DETERMINISTIC stages — no LLM, no consent (Stage C's LLM remainder is gated
   * + deferred): (A) detect non-spend movements to confirm-and-exclude; (D) re-stamp deny-by-default
   * deductibility + positive SUGGESTIONS (suggested_deductible — excluded until confirmed, B1); (B)
   * group leftovers into clarify questions; (E) sweep claim suggestions. Holds a per-(user,fy)
   * in-flight lock in accountant_runs so a double-click can't start a second pass (B2). The
   * interactive cards (movement sweep / clarify / claims) let the user act on the counts.
   */
  async runAccountantPass(userId: string, startYear: number): Promise<AccountantSummary> {
    const fy = fyStartYearStr(startYear); // accountant_runs.fy is the start-year string ('2025')
    // In-flight lock (B2): refuse to start a second pass for the same (user, fy). A 'running' row
    // older than 15 min is treated as STALE (a crashed/evicted run) so the lock can't wedge forever.
    const active = await this.env.DB.prepare(
      `SELECT id FROM accountant_runs WHERE user_id = ? AND fy = ? AND status = 'running' AND started_at > datetime('now','-15 minutes')`,
    ).bind(userId, fy).first<{ id: string }>();
    if (active) throw new Error("a pass is already running for this year");
    // Mark any stale running rows for this (user, fy) as errored so they don't accumulate.
    await this.env.DB.prepare(`UPDATE accountant_runs SET status = 'error', finished_at = datetime('now') WHERE user_id = ? AND fy = ? AND status = 'running'`).bind(userId, fy).run();
    const runId = crypto.randomUUID();
    await this.env.DB.prepare(`INSERT INTO accountant_runs (id, user_id, fy, stage, status) VALUES (?, ?, ?, 'cleanup', 'running')`).bind(runId, userId, fy).run();
    const setStage = (stage: string) => this.env.DB.prepare(`UPDATE accountant_runs SET stage = ? WHERE id = ? AND user_id = ?`).bind(stage, runId, userId).run();
    try {
      const { start, end } = fyBounds(startYear, await this.jurisdictionFor(userId));
      // Stage A — surface non-spend movements (NOT auto-applied; the user confirms, B3).
      const sweep = await this.sweepMovements(userId);
      // Stage D — re-stamp deny-by-default + positive suggestions over payg (reResolve refreshes the
      // matcher's own prior auto-verdicts; user-confirmed states are preserved).
      await setStage("deductibility");
      const stamped = await this.stampDeductibility(userId, { reResolve: true });
      const suggestions = (await this.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND deductibility = 'suggested_deductible' AND txn_date >= ? AND txn_date <= ?`,
      ).bind(userId, start, end).first<{ n: number }>())?.n ?? 0;
      // Stage B — group leftovers into one-question-per-pattern.
      await setStage("clarify");
      const clarify = await this.runClarifyScan(userId, startYear);
      // Stage E — claim discovery sweep (persists claim_suggestions; auto-match attaches evidence).
      await setStage("claims");
      await this.reviewClaims(userId, startYear);
      const claimItems = (await this.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM claim_suggestions WHERE user_id = ? AND status IN ('suggested','capturing')`,
      ).bind(userId).first<{ n: number }>())?.n ?? 0;

      const summary: AccountantSummary = {
        run_id: runId,
        fy: startYear,
        movement_candidates: sweep.summary.ignorable_n,
        property_loan_review: sweep.summary.review_n,
        deductibility_stamped: stamped.stamped,
        suggestions,
        clarify_questions: clarify.questions,
        claim_items: claimItems,
      };
      await this.env.DB.prepare(`UPDATE accountant_runs SET status = 'done', stage = 'done', summary_json = ?, finished_at = datetime('now') WHERE id = ? AND user_id = ?`).bind(JSON.stringify(summary), runId, userId).run();
      await this.audit(userId, "accountant_pass", JSON.stringify(summary));
      return summary;
    } catch (e) {
      await this.env.DB.prepare(`UPDATE accountant_runs SET status = 'error', summary_json = ?, finished_at = datetime('now') WHERE id = ? AND user_id = ?`).bind(JSON.stringify({ error: (e as Error).message }), runId, userId).run();
      throw e;
    }
  }

  /** Confirm a SUGGESTED deduction (Stage D) → confirmed_deductible (it now counts). User-driven, audited. */
  async confirmSuggestedDeduction(userId: string, txnId: string): Promise<{ ok: boolean }> {
    const row = await this.env.DB.prepare(`SELECT deductibility FROM transactions WHERE id = ? AND user_id = ?`).bind(txnId, userId).first<{ deductibility: string | null }>();
    if (!row) throw new Error("transaction not found");
    if (row.deductibility !== "suggested_deductible") return { ok: false }; // only a live suggestion can be confirmed
    await this.env.DB.prepare(`UPDATE transactions SET deductibility = 'confirmed_deductible' WHERE id = ? AND user_id = ?`).bind(txnId, userId).run();
    await this.audit(userId, "confirm_deduction", JSON.stringify({ txnId }));
    return { ok: true };
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
    // Remove any claim evidence pointing at this txn (else reviewClaims folds stale links into 'capturing').
    await this.env.DB.prepare(`DELETE FROM claim_links WHERE txn_id = ? AND user_id = ?`).bind(txnId, userId).run();
    // Reverse-orphan cleanup (no FK cascade): if this row was a bank_line, any receipt matched to it
    // would dangle AND stay excluded from the position forever (COUNTABLE counts a receipt only when
    // matched_txn_id IS NULL) — un-match them back to countable, mirroring deleteStatement's purge.
    // Also drop attribution rows keyed to this txn so they don't sum against a deleted transaction.
    await this.env.DB.prepare(
      `UPDATE transactions SET matched_txn_id = NULL, status = 'extracted' WHERE user_id = ? AND matched_txn_id = ?`,
    )
      .bind(userId, txnId)
      .run();
    await this.env.DB.prepare(`DELETE FROM transaction_attributions WHERE transaction_id = ? AND user_id = ?`).bind(txnId, userId).run();
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
    if (after?.ledger_ref) {
      await this.audit(userId, "qbo_push", JSON.stringify({ txnId, ledgerRef: after.ledger_ref }));
      return { ok: true, ledgerRef: after.ledger_ref };
    }
    return { ok: false, error: "QuickBooks not connected — connect it first, then push." };
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

  /**
   * Savings & Opportunities detector (flag advisory_layer) — DETERMINISTIC, NO LLM (so no AI-spend
   * gate interaction). Runs per-tenant in the weekly sweep, bounded + idempotent: (1) backfill the
   * normalised biller_key on a bounded slice of un-keyed rows; (2) detect recurring streams (bills +
   * subscriptions) and upsert recurring_bills; (3) write FACTUAL opportunities (annualised run-rate +
   * essential-switch signposts); (4) surface ONE deduped notification. Pure detection lives in
   * src/lib/advisory.ts; this method is just the D1 plumbing around it.
   */
  async detectAdvisory(userId: string): Promise<{ recurring: number; opportunities: number }> {
    // (1) Backfill biller_key on a bounded slice (idempotent: WHERE biller_key IS NULL → naturally
    // re-runnable; subsequent ticks pick up the rest). No model call.
    const unkeyed = await this.env.DB.prepare(
      `SELECT id, merchant, raw_description FROM transactions
        WHERE user_id = ? AND biller_key IS NULL AND kind IN ('bank_line','receipt') LIMIT 2000`,
    )
      .bind(userId)
      .all<{ id: string; merchant: string | null; raw_description: string | null }>();
    const updates = (unkeyed.results ?? [])
      .map((r) => ({ id: r.id, key: billerNormalize(r.merchant, r.raw_description) ?? "" }))
      .map((u) =>
        this.env.DB.prepare(`UPDATE transactions SET biller_key = ? WHERE user_id = ? AND id = ?`).bind(u.key, userId, u.id),
      );
    await this.batchChunked(updates);

    // (2) Detect recurring streams over the last ~18 months of countable debits with a biller_key.
    const since = new Date(Date.now() - 540 * 86_400_000).toISOString().slice(0, 10);
    const rows = await this.env.DB.prepare(
      `SELECT biller_key, txn_date, COALESCE(amount_aud_cents, amount_cents) AS amt,
              COALESCE(merchant, raw_description) AS label
         FROM transactions
        WHERE user_id = ? AND ${COUNTABLE} AND biller_key IS NOT NULL AND biller_key <> ''
          AND txn_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND txn_date >= ?
        ORDER BY biller_key, txn_date LIMIT 6000`,
    )
      .bind(userId, since)
      .all<{ biller_key: string; txn_date: string; amt: number | null; label: string | null }>();

    const byBiller = new Map<string, { occ: RecurringOccurrence[]; label: string }>();
    for (const r of rows.results ?? []) {
      if (!r.amt || r.amt <= 0) continue;
      const g = byBiller.get(r.biller_key) ?? { occ: [], label: r.label ?? r.biller_key };
      g.occ.push({ date: r.txn_date, amount_cents: r.amt });
      byBiller.set(r.biller_key, g);
    }

    const billUpserts = [];
    type Detected = { biller_key: string; label: string; category: ReturnType<typeof classifyBiller>["category"]; det: NonNullable<ReturnType<typeof detectRecurrence>>; essential: boolean };
    const detected: Detected[] = [];
    for (const [biller_key, g] of byBiller) {
      const det = detectRecurrence(g.occ);
      if (!det) continue;
      const { category, essential } = classifyBiller(biller_key);
      const annual = paymentsPerYear(det.cadence) * det.typical_amount_cents;
      detected.push({ biller_key, label: g.label, category, det, essential });
      billUpserts.push(
        this.env.DB.prepare(
          `INSERT INTO recurring_bills
             (id,user_id,biller_key,label,category,cadence,typical_amount_cents,amount_variance_cents,
              annual_amount_cents,is_subscription,is_essential,occurrences,first_seen_date,last_seen_date,
              next_expected_date,status,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
           ON CONFLICT(user_id,biller_key) DO UPDATE SET
             label=excluded.label, category=excluded.category, cadence=excluded.cadence,
             typical_amount_cents=excluded.typical_amount_cents, amount_variance_cents=excluded.amount_variance_cents,
             annual_amount_cents=excluded.annual_amount_cents, is_subscription=excluded.is_subscription,
             is_essential=excluded.is_essential, occurrences=excluded.occurrences,
             first_seen_date=excluded.first_seen_date, last_seen_date=excluded.last_seen_date,
             next_expected_date=excluded.next_expected_date,
             status=CASE WHEN recurring_bills.status IN ('dismissed','ended') OR recurring_bills.pinned = 1 THEN recurring_bills.status ELSE excluded.status END,
             updated_at=datetime('now')`,
        ).bind(
          crypto.randomUUID(), userId, biller_key, g.label.slice(0, 64), category, det.cadence,
          det.typical_amount_cents, det.amount_variance_cents, annual, det.is_subscription ? 1 : 0,
          essential ? 1 : 0, det.occurrences, det.first_seen, det.last_seen, det.next_expected, det.status,
        ),
      );
    }
    await this.batchChunked(billUpserts);

    // (3) Opportunities — FACTUAL only. Current AU FY (Jul–Jun).
    const now = new Date();
    const fyStart = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
    const fyLbl = String(fyStart);
    const runRate = await spendRunRate(this.env, userId, fyStart);
    const oppUpserts = [];
    if (runRate.spent_cents > 0) {
      oppUpserts.push(
        this.upsertOpportunity(userId, "run_rate", "", {
          fy: fyLbl, category: null, title: "Your spending, annualised",
          body: runRate.body, amount_cents: runRate.annualised_cents, signpost: null, recurringBillId: null,
        }),
      );
    }
    // Essential switchable bills WITH a government comparator → a factual switch signpost (no savings claim).
    for (const d of detected) {
      if (!d.essential || d.det.status !== "confirmed") continue;
      const sp = signpostFor(d.category);
      if (!sp) continue; // only signpost where a whole-of-market government comparator exists (energy/health)
      const annual = paymentsPerYear(d.det.cadence) * d.det.typical_amount_cents;
      const label = d.label.slice(0, 40);
      oppUpserts.push(
        this.upsertOpportunity(userId, "essential_switch", d.biller_key, {
          fy: null, category: d.category,
          title: `${label} — about $${Math.round(annual / 100).toLocaleString("en-AU")} a year`,
          body: `${recurringCopy(label, d.det)} You can compare options yourself — ${sp.label}.`,
          amount_cents: annual, signpost: sp, recurringBillId: null,
        }),
      );
    }
    await this.batchChunked(oppUpserts);

    // (4) ONE quiet notification — suppress if a Savings nudge was sent in the last 25 days (read or
    // not), so the standing opportunity set isn't re-announced every weekly cron once the user has seen
    // it ("accrue quietly", non-nagging — the brief's UX rule), rather than re-firing after each read.
    if (oppUpserts.length > 0 && !(await hasPendingNudge(this.env, userId, "%Savings & Opportunities%", { withinDays: 25 }))) {
      await this.notify(
        userId,
        `Savings & Opportunities: we spotted ${detected.length} recurring payment${detected.length === 1 ? "" : "s"} and your annualised spending in the new Save tab. General information only — not financial product advice.`,
        null,
      );
    }
    await this.audit(userId, "detect_advisory", JSON.stringify({ recurring: detected.length, opportunities: oppUpserts.length }));
    return { recurring: detected.length, opportunities: oppUpserts.length };
  }

  /** Run prepared statements in chunks of 50 (D1 bounds params per batch — same pattern as elsewhere). */
  private async batchChunked(stmts: D1PreparedStatement[]): Promise<void> {
    for (let i = 0; i < stmts.length; i += 50) await this.env.DB.batch(stmts.slice(i, i + 50));
  }

  /** Idempotent opportunity upsert (natural key user_id+type+subject_key; preserves user dismiss/action). */
  private upsertOpportunity(
    userId: string,
    type: string,
    subjectKey: string,
    o: { fy: string | null; category: string | null; title: string; body: string; amount_cents: number; signpost: { label: string; url: string } | null; recurringBillId: string | null },
  ) {
    return this.env.DB.prepare(
      `INSERT INTO opportunities
         (id,user_id,opportunity_type,subject_key,fy,recurring_bill_id,category,title,body,amount_cents,
          signpost_label,signpost_url,status,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'open',datetime('now'))
       ON CONFLICT(user_id,opportunity_type,subject_key) DO UPDATE SET
         fy=excluded.fy, category=excluded.category, title=excluded.title, body=excluded.body,
         amount_cents=excluded.amount_cents, signpost_label=excluded.signpost_label, signpost_url=excluded.signpost_url,
         recurring_bill_id=excluded.recurring_bill_id,
         status=CASE WHEN opportunities.status IN ('dismissed','actioned') THEN opportunities.status ELSE 'open' END,
         updated_at=datetime('now')`,
    ).bind(
      crypto.randomUUID(), userId, type, subjectKey, o.fy, o.recurringBillId, o.category,
      o.title, o.body, o.amount_cents, o.signpost?.label ?? null, o.signpost?.url ?? null,
    );
  }

  /** Dismiss an opportunity (user action — sets terminal status so the detector won't reopen it). */
  async dismissOpportunity(userId: string, id: string): Promise<{ ok: boolean }> {
    await this.env.DB.prepare(
      `UPDATE opportunities SET status='dismissed', updated_at=datetime('now') WHERE user_id = ? AND id = ?`,
    )
      .bind(userId, id)
      .run();
    return { ok: true };
  }

  /** Dismiss a detected recurring bill (won't be resurrected by re-detection). */
  async dismissRecurringBill(userId: string, id: string): Promise<{ ok: boolean }> {
    await this.env.DB.prepare(
      `UPDATE recurring_bills SET status='dismissed', updated_at=datetime('now') WHERE user_id = ? AND id = ?`,
    )
      .bind(userId, id)
      .run();
    return { ok: true };
  }

  /** Confirm a detected recurring bill (user feedback): pin it sticky so re-detection won't downgrade it. */
  async confirmRecurringBill(userId: string, id: string): Promise<{ ok: boolean }> {
    await this.env.DB.prepare(
      `UPDATE recurring_bills SET pinned=1, status='confirmed', updated_at=datetime('now') WHERE user_id = ? AND id = ?`,
    )
      .bind(userId, id)
      .run();
    return { ok: true };
  }

  // ── Private Health Extras Tracker (engagement; gated by phi_extras_tracker at the route/cron) ──
  // Health-service categories are "sensitive information" (Privacy Act) — every WRITE below requires a
  // separate, dated health-data consent (profiles.health_extras_consent_at). This is NOT the existing
  // cross-border /consent gate; it is its own marker (set by recordHealthExtrasConsent). None of this
  // ever touches report.ts — extras tracking is display only.

  /** Record (or re-affirm) the separate health-data consent that unlocks the PHI writes. */
  async recordHealthExtrasConsent(userId: string, text: string, method: string): Promise<{ ok: true; consented_at: string }> {
    await this.env.DB.prepare(
      `UPDATE profiles SET health_extras_consent_at = datetime('now') WHERE user_id = ?`,
    ).bind(userId).run();
    const row = await this.env.DB.prepare(`SELECT health_extras_consent_at AS at FROM profiles WHERE user_id = ?`)
      .bind(userId).first<{ at: string }>();
    await this.audit(userId, "consent_health_extras", JSON.stringify({ method, text: text.slice(0, 200) }));
    return { ok: true, consented_at: row?.at ?? "" };
  }

  /** Withdraw the health-data consent (clears the marker ⇒ PHI writes blocked again). Data is kept. */
  async withdrawHealthExtrasConsent(userId: string): Promise<{ ok: true }> {
    await this.env.DB.prepare(`UPDATE profiles SET health_extras_consent_at = NULL WHERE user_id = ?`).bind(userId).run();
    await this.audit(userId, "consent_health_extras_withdrawn", "{}");
    return { ok: true };
  }

  /** Set whether the tenant holds private HOSPITAL cover (the MLS pivot; analogous to gst_registered). */
  async setPrivateHealth(userId: string, holds: boolean): Promise<{ ok: true; private_health: number }> {
    const v = holds ? 1 : 0;
    await this.env.DB.prepare(`UPDATE profiles SET private_health = ? WHERE user_id = ?`).bind(v, userId).run();
    await this.audit(userId, "private_health_set", JSON.stringify({ private_health: v }));
    return { ok: true, private_health: v };
  }

  private async requireHealthConsent(userId: string): Promise<void> {
    const row = await this.env.DB.prepare(`SELECT health_extras_consent_at AS at FROM profiles WHERE user_id = ?`)
      .bind(userId).first<{ at: string | null }>();
    if (!row?.at) throw new Error("Health-data consent required");
  }

  private async assertOwnsPolicy(userId: string, policyId: string): Promise<void> {
    const row = await this.env.DB.prepare(`SELECT 1 AS ok FROM phi_policy WHERE id = ? AND user_id = ?`)
      .bind(policyId, userId).first<{ ok: number }>();
    if (!row) throw new Error("policy not found");
  }

  /** Create or update a private-health policy (consent-gated). Returns the policy id. */
  async savePhiPolicy(
    userId: string,
    p: { id?: string | null; person_id?: string | null; insurer?: string | null; cover_type?: string | null;
         reset_basis?: string | null; reset_date?: string | null; source?: string | null },
  ): Promise<{ id: string }> {
    await this.requireHealthConsent(userId);
    // Only treat a VALID basis in the payload as "provided"; null ⇒ keep the stored basis on update
    // (don't silently recompute it from the insurer default and clobber a user-set anniversary/FY basis).
    const provided = (["calendar", "financial_year", "anniversary"].includes(p.reset_basis ?? "")
      ? p.reset_basis
      : null) as ResetBasis | null;
    if (p.id) {
      await this.assertOwnsPolicy(userId, p.id);
      await this.env.DB.prepare(
        `UPDATE phi_policy SET person_id=?, insurer=?, cover_type=?,
                reset_basis=COALESCE(?, reset_basis), reset_date=COALESCE(?, reset_date), updated_at=datetime('now')
          WHERE id = ? AND user_id = ?`,
      ).bind(p.person_id ?? null, p.insurer ?? null, p.cover_type ?? null, provided, p.reset_date ?? null, p.id, userId).run();
      await this.audit(userId, "phi_policy_updated", JSON.stringify({ id: p.id, insurer: p.insurer }));
      return { id: p.id };
    }
    const basis = provided ?? insurerResetBasis(p.insurer);
    const id = crypto.randomUUID();
    await this.env.DB.prepare(
      `INSERT INTO phi_policy (id, user_id, person_id, insurer, cover_type, reset_basis, reset_date, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, userId, p.person_id ?? null, p.insurer ?? null, p.cover_type ?? null, basis, p.reset_date ?? null, p.source ?? "manual").run();
    await this.audit(userId, "phi_policy_created", JSON.stringify({ id, insurer: p.insurer, source: p.source ?? "manual" }));
    return { id };
  }

  /** Delete a policy and its limits + usage (consent-gated). */
  async deletePhiPolicy(userId: string, id: string): Promise<{ ok: true }> {
    await this.requireHealthConsent(userId);
    await this.assertOwnsPolicy(userId, id);
    await this.env.DB.batch([
      this.env.DB.prepare(`DELETE FROM phi_benefit_usage WHERE user_id = ? AND policy_id = ?`).bind(userId, id),
      this.env.DB.prepare(`DELETE FROM phi_limit WHERE user_id = ? AND policy_id = ?`).bind(userId, id),
      this.env.DB.prepare(`DELETE FROM phi_policy WHERE user_id = ? AND id = ?`).bind(userId, id),
    ]);
    await this.audit(userId, "phi_policy_deleted", JSON.stringify({ id }));
    return { ok: true };
  }

  /** Create or update a per-category annual limit (idempotent on policy+category; consent-gated). */
  async savePhiLimit(
    userId: string,
    l: { policy_id: string; category: string; annual_limit_cents: number; period?: string | null;
         combined_group?: string | null; source?: string | null; verified?: boolean },
  ): Promise<{ id: string }> {
    await this.requireHealthConsent(userId);
    await this.assertOwnsPolicy(userId, l.policy_id);
    const cents = Math.max(0, Math.round(Number(l.annual_limit_cents) || 0));
    const group = l.combined_group ?? null;
    const source = ["manual", "sourced", "extracted"].includes(l.source ?? "") ? l.source! : "manual";
    // Manual entry is member-confirmed; sourced/extracted limits default to unverified until confirmed.
    const verified = l.verified != null ? (l.verified ? 1 : 0) : source === "manual" ? 1 : 0;
    const existing = await this.env.DB.prepare(
      `SELECT id FROM phi_limit WHERE user_id = ? AND policy_id = ? AND category = ?`,
    ).bind(userId, l.policy_id, l.category).first<{ id: string }>();
    if (existing) {
      await this.env.DB.prepare(
        `UPDATE phi_limit SET annual_limit_cents=?, period=?, combined_group=?, source=?, verified=?, updated_at=datetime('now') WHERE id = ? AND user_id = ?`,
      ).bind(cents, l.period ?? "annual", group, source, verified, existing.id, userId).run();
      await this.audit(userId, "phi_limit_updated", JSON.stringify({ id: existing.id, category: l.category, cents, source }));
      return { id: existing.id };
    }
    const id = crypto.randomUUID();
    await this.env.DB.prepare(
      `INSERT INTO phi_limit (id, user_id, policy_id, category, annual_limit_cents, period, combined_group, source, verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, userId, l.policy_id, l.category, cents, l.period ?? "annual", group, source, verified).run();
    await this.audit(userId, "phi_limit_created", JSON.stringify({ id, category: l.category, cents, source }));
    return { id };
  }

  /** Delete a per-category limit (consent-gated). */
  async deletePhiLimit(userId: string, id: string): Promise<{ ok: true }> {
    await this.requireHealthConsent(userId);
    await this.env.DB.prepare(`DELETE FROM phi_limit WHERE user_id = ? AND id = ?`).bind(userId, id).run();
    await this.audit(userId, "phi_limit_deleted", JSON.stringify({ id }));
    return { ok: true };
  }

  /** Record a benefit used against a limit (append; consent-gated). The bank debit is the out-of-pocket
   *  GAP — this is the BENEFIT the fund paid, which the user enters from their statement/app. */
  async recordPhiUsage(
    userId: string,
    u: { policy_id: string; category: string; amount_used_cents: number; txn_id?: string | null; used_on?: string | null; receipt_key?: string | null },
  ): Promise<{ id: string }> {
    await this.requireHealthConsent(userId);
    await this.assertOwnsPolicy(userId, u.policy_id);
    const id = crypto.randomUUID();
    const cents = Math.max(0, Math.round(Number(u.amount_used_cents) || 0));
    // receipt_key is tenant-scoped (only accept our own ${userId}/phi/... keys — never trust a client path).
    const receiptKey = typeof u.receipt_key === "string" && u.receipt_key.startsWith(`${userId}/phi/`) ? u.receipt_key : null;
    await this.env.DB.prepare(
      `INSERT INTO phi_benefit_usage (id, user_id, policy_id, category, amount_used_cents, txn_id, used_on, receipt_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, userId, u.policy_id, u.category, cents, u.txn_id ?? null, u.used_on ?? null, receiptKey).run();
    await this.audit(userId, "phi_usage_recorded", JSON.stringify({ id, category: u.category, cents }));
    return { id };
  }

  /**
   * Snap-to-log: read a private-health extras receipt and return a benefit-used PREFILL — writes nothing
   * to the ledger. Stores the image in R2 (evidence the user can keep if they submit the claim) and runs
   * the Claude-vision extractor. Bounded to ONE image; gated by health consent + the APP-8 cross-border
   * inference consent + the per-user $ budget (the per-tenant daily scan cap is enforced at the route).
   * Any failure throws a typed message so the UI degrades to manual typing.
   */
  async scanPhiReceipt(
    userId: string,
    bytes: ArrayBuffer,
    mime: string,
  ): Promise<{ receipt_key: string; provider: string | null; category: string | null; amount_cents: number | null; used_on: string | null; confidence: number }> {
    await this.requireHealthConsent(userId);
    const profile = await this.requireProfile(userId);
    const provider = profile.inference_provider ?? this.env.DEFAULT_INFERENCE_PROVIDER;
    if (provider === "anthropic" && profile.consent_xborder !== 1) throw new Error("consent_required");
    if (!(await this.withinBudget(userId, null))) throw new Error("ai_budget_reached");

    const llm = await getLLM(this.env, profile, { userId });
    await this.auditXborderInference(userId, provider, "phi_claim", llm.modelId);
    const claim = await extractHealthClaim(llm, bytes, mime);

    // Store the image only AFTER a successful read — a failed OCR (bad photo) leaves no orphan bytes.
    const receiptId = crypto.randomUUID();
    const key = `${userId}/phi/${receiptId}`;
    await this.env.RECEIPTS.put(key, bytes, { httpMetadata: { contentType: mime } });
    await this.audit(userId, "phi_receipt_scanned", JSON.stringify({ receiptId, category: claim.category_guess, confidence: claim.confidence }));

    // Prefer the fund rebate (what counts against the limit); fall back to the charged total. The user
    // confirms/edits before logging — the receipt's fee is not always the benefit the fund paid.
    const amount = claim.benefit_paid_cents ?? claim.amount_charged_cents ?? null;
    return {
      receipt_key: key,
      provider: claim.provider_name,
      category: claim.category_guess,
      amount_cents: amount != null ? Math.max(0, Math.round(amount)) : null,
      used_on: claim.service_date,
      confidence: claim.confidence,
    };
  }

  /**
   * Auto-fill a policy + its pooled extras schedule from a bundled PHIS product (the "auto-source" path).
   * Deterministic, NO model call, NO external fetch — the schedule is public standardised data we bundle
   * (src/lib/phis-seed.ts). Limits land source='sourced', verified=0 so the member CONFIRMS them (standard
   * product limits can differ by tier/loyalty). Consent-gated. Returns the new policy id.
   */
  async applyPhiProduct(userId: string, productId: string): Promise<{ policy_id: string; limits: number }> {
    await this.requireHealthConsent(userId);
    const found = findPhisProduct(productId);
    if (!found) throw new Error("unknown product");
    const { insurer, product } = found;
    const { id: policyId } = await this.savePhiPolicy(userId, {
      insurer: insurer.name, cover_type: product.cover_type, reset_basis: product.reset_basis, source: "sourced",
    });
    for (const l of product.limits) {
      await this.savePhiLimit(userId, {
        policy_id: policyId, category: l.category, annual_limit_cents: l.annual_limit_cents,
        combined_group: l.combined_group ?? null, source: "sourced", verified: false,
      });
    }
    await this.audit(userId, "phi_product_applied", JSON.stringify({ productId, policy_id: policyId, limits: product.limits.length }));
    return { policy_id: policyId, limits: product.limits.length };
  }

  /** Confirm all unverified (sourced/extracted) limits on a policy — the member's "these are right" step. */
  async confirmPhiPolicyLimits(userId: string, policyId: string): Promise<{ confirmed: number }> {
    await this.requireHealthConsent(userId);
    await this.assertOwnsPolicy(userId, policyId);
    const r = await this.env.DB.prepare(
      `UPDATE phi_limit SET verified=1, updated_at=datetime('now') WHERE user_id = ? AND policy_id = ? AND verified = 0`,
    ).bind(userId, policyId).run();
    const n = r.meta?.changes ?? 0;
    await this.audit(userId, "phi_limits_confirmed", JSON.stringify({ policyId, confirmed: n }));
    return { confirmed: n };
  }

  /** Delete a single recorded benefit-usage entry (consent-gated). Lets a user fix a mis-entry so the
   *  per-category balance reconciles with their fund's app — usage is otherwise append-only. */
  async deletePhiUsage(userId: string, id: string): Promise<{ ok: true }> {
    await this.requireHealthConsent(userId);
    await this.env.DB.prepare(`DELETE FROM phi_benefit_usage WHERE user_id = ? AND id = ?`).bind(userId, id).run();
    await this.audit(userId, "phi_usage_deleted", JSON.stringify({ id }));
    return { ok: true };
  }

  /**
   * Weekly (cron, gated by phi_extras_tracker): deterministic, NO-LLM. Two factual outputs:
   *  (1) a setup nudge when a private-health premium is detected but no policy is tracked yet, and
   *  (2) a reset reminder when material extras cover is unused close to the reset date.
   * Writes only to opportunities + notifications (no phi_ tables ⇒ no consent gate). De-dup guarded.
   */
  async detectBenefitsReset(userId: string): Promise<{ setups: number; resets: number }> {
    const now = new Date();
    const policies = (await this.env.DB.prepare(
      `SELECT id, insurer, reset_basis, reset_date FROM phi_policy WHERE user_id = ?`,
    ).bind(userId).all<{ id: string; insurer: string | null; reset_basis: string | null; reset_date: string | null }>()).results ?? [];

    const oppUpserts: D1PreparedStatement[] = [];
    let setups = 0;

    // (1) Setup nudge — only when NO policy is tracked yet (don't nag once they've set one up).
    if (policies.length === 0) {
      const health = (await this.env.DB.prepare(
        `SELECT biller_key, label FROM recurring_bills
          WHERE user_id = ? AND category = 'health' AND status NOT IN ('dismissed','ended')
          ORDER BY annual_amount_cents DESC LIMIT 3`,
      ).bind(userId).all<{ biller_key: string; label: string | null }>()).results ?? [];
      for (const h of health) {
        const label = (h.label ?? h.biller_key).slice(0, 40);
        oppUpserts.push(this.upsertOpportunity(userId, "phi_extras", `setup:${h.biller_key}`, {
          fy: null, category: "health", title: "Track your private-health extras",
          body: phiDetectedCopy(label), amount_cents: 0, signpost: null, recurringBillId: null,
        }));
        setups++;
      }
    }

    // (2) Reset reminder — per policy with limits: total unused + weeks-to-reset. Notify at ~6wk & ~2wk
    // when material cover is unused. Deterministic; in-app only.
    let resets = 0;
    const THRESHOLD_CENTS = 5000; // $50 — only nudge on material unused cover
    for (const p of policies) {
      const basis = ((p.reset_basis as string) || "calendar") as ResetBasis;
      const resetIso = nextResetDate(basis, p.reset_date ?? null, now);
      const weeks = weeksUntil(resetIso, now);
      const agg = await this.env.DB.prepare(
        `SELECT COALESCE((SELECT SUM(annual_limit_cents) FROM phi_limit WHERE user_id=? AND policy_id=?),0) AS lim,
                COALESCE((SELECT SUM(amount_used_cents) FROM phi_benefit_usage WHERE user_id=? AND policy_id=?),0) AS used`,
      ).bind(userId, p.id, userId, p.id).first<{ lim: number; used: number }>();
      const unused = Math.max(0, (agg?.lim ?? 0) - (agg?.used ?? 0));
      if (unused < THRESHOLD_CENTS) continue;
      // Always keep a standing dashboard/Save opportunity current (no notify spam).
      oppUpserts.push(this.upsertOpportunity(userId, "phi_extras", `reset:${p.id}`, {
        fy: null, category: "health", title: "Unused extras before reset",
        body: phiResetNudgeCopy(unused, resetIso, weeks), amount_cents: unused, signpost: null, recurringBillId: null,
      }));
      // Push a notification only inside the nudge windows, de-duped per reset cycle.
      if (weeks <= 6 && !(await hasPendingNudge(this.env, userId, "%extras cover is unused%", { withinDays: 21 }))) {
        await this.notify(userId, phiResetNudgeCopy(unused, resetIso, weeks), null);
        resets++;
      }
    }

    await this.batchChunked(oppUpserts);
    await this.audit(userId, "detect_benefits_reset", JSON.stringify({ setups, resets, policies: policies.length }));
    return { setups, resets };
  }

  /**
   * Create a Tier-1 energy referral from an opportunity the user clicked (advisory_partners_energy).
   * USER-INITIATED only (the "no cold calls" rule — this is reached solely from the consumer pressing
   * the CTA), IDEMPOTENT (UNIQUE(user_id, opportunity_id) → a re-click returns the SAME token, never a
   * second lead), AUDITED, and Tier-1 (consent_id stays NULL — no PII leaves; the user finishes on the
   * partner's site). Returns the tokened outbound URL the SPA opens. Throws if the opportunity isn't a
   * live energy one or no partner offer is live — the CTA simply isn't shown in those cases.
   */
  async createReferral(userId: string, opportunityId: string, offerId?: string): Promise<{ token: string; url: string; partner_name: string }> {
    const db = this.env.DB as unknown as PartnerDB;
    const opp = await this.env.DB.prepare(
      `SELECT id, opportunity_type, category, status FROM opportunities WHERE user_id = ? AND id = ?`,
    )
      .bind(userId, opportunityId)
      .first<{ id: string; opportunity_type: string; category: string | null; status: string }>();
    if (!opp || opp.status !== "open") throw new Error("opportunity not found");
    if (!opportunityTakesEnergyCta(opp)) throw new Error("not an energy opportunity");

    // Idempotent: a prior referral for this opportunity → re-return its token. Rebuild the URL from the
    // STORED offer (anyStatus) so a re-click is stable even if the active offer has since changed.
    const existing = await this.env.DB.prepare(
      `SELECT referral_token, partner_offer_id FROM referrals WHERE user_id = ? AND opportunity_id = ?`,
    )
      .bind(userId, opportunityId)
      .first<{ referral_token: string; partner_offer_id: string | null }>();
    if (existing) return this.referralResult(db, existing.referral_token, existing.partner_offer_id);

    // PIN to the offer the user actually saw on the CTA (offerId), falling back to the current best
    // match only if the client didn't send one — so display and lead-creation can't disagree.
    const offer = (offerId ? await getOfferById(db, offerId) : null) ?? (await matchEnergyOffer(db));
    if (!offer) throw new Error("no partner offer available");

    const id = crypto.randomUUID();
    const token = crypto.randomUUID();
    try {
      await this.env.DB.prepare(
        `INSERT INTO referrals (id, user_id, opportunity_id, partner_id, partner_offer_id, referral_token, status, consent_id, revenue_cents)
         VALUES (?, ?, ?, ?, ?, ?, 'clicked', NULL, 0)`,
      )
        .bind(id, userId, opportunityId, offer.partner_id, offer.offer_id, token)
        .run();
    } catch (e) {
      // Concurrent double-click: the UNIQUE(user_id, opportunity_id) lost the race. Re-read and return
      // the winner's token so the re-click is still a no-op (the idempotency guarantee holds under races).
      const won = await this.env.DB.prepare(
        `SELECT referral_token, partner_offer_id FROM referrals WHERE user_id = ? AND opportunity_id = ?`,
      )
        .bind(userId, opportunityId)
        .first<{ referral_token: string; partner_offer_id: string | null }>();
      if (won) return this.referralResult(db, won.referral_token, won.partner_offer_id);
      throw e;
    }
    await this.audit(userId, "referral_created", JSON.stringify({ id, opportunityId, partner_id: offer.partner_id, offer_id: offer.offer_id }));
    return { token, url: buildReferralUrl(offer.target_url, token), partner_name: offer.partner_name };
  }

  /** Build the {token,url,partner_name} result for an existing referral from its stored offer. */
  private async referralResult(db: PartnerDB, token: string, offerId: string | null): Promise<{ token: string; url: string; partner_name: string }> {
    const offer = offerId ? await getOfferById(db, offerId, { anyStatus: true }) : null;
    if (!offer) throw new Error("referral offer no longer available");
    return { token, url: buildReferralUrl(offer.target_url, token), partner_name: offer.partner_name };
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

  /**
   * Set the tenant-default GST registration flag (the fallback the GST/BAS reader uses for sole
   * traders with no company entity — gstTotals reads entities.gst_registered OR profiles.gst_registered).
   * Indicative BAS only ever surfaces when this (or an entity flag) is on AND gst_bas is enabled.
   */
  async setGstRegistered(userId: string, registered: boolean): Promise<{ ok: true; gst_registered: number }> {
    const v = registered ? 1 : 0;
    await this.env.DB.prepare(`UPDATE profiles SET gst_registered = ? WHERE user_id = ?`).bind(v, userId).run();
    await this.audit(userId, "gst_registered_set", JSON.stringify({ gst_registered: v }));
    return { ok: true, gst_registered: v };
  }

  /**
   * Withdraw APP-8 cross-border consent. Clears the flag (the consent gate then blocks the
   * anthropic path again) but keeps the recorded text/timestamp as an audit trail of what was
   * previously agreed. Audited.
   */
  async withdrawConsent(userId: string): Promise<{ ok: boolean }> {
    await this.env.DB.prepare(`UPDATE profiles SET consent_xborder = 0 WHERE user_id = ?`).bind(userId).run();
    await this.audit(userId, "consent_withdrawn", JSON.stringify({ method: "web" }));
    return { ok: true };
  }

  /**
   * APP 13 erasure: purge ALL of a tenant's data across D1 / R2 / KV + revoke QuickBooks, leaving
   * only an audit_log breadcrumb. Audited before (intent) and after (result) — both survive because
   * audit_log is the one table the purge skips. Scoped to the requesting tenant only.
   */
  async purgeTenant(userId: string): Promise<PurgeResult> {
    await this.audit(userId, "account_purge_requested", JSON.stringify({}));
    const r = await purgeTenantData(this.env, userId);
    await this.audit(userId, "account_purged", JSON.stringify(r));
    return r;
  }

  /** APP 12 access: the tenant's data as JSON, audited. */
  async exportTenant(userId: string): Promise<Record<string, unknown>> {
    const data = await exportTenantData(this.env, userId);
    await this.audit(userId, "data_exported", JSON.stringify({}));
    return data;
  }

  /** Weekly retention FLAG sweep (cron) — surfaces a nudge for records past the window; never deletes. */
  async flagOldData(userId: string): Promise<{ flagged: boolean }> {
    return { flagged: await flagOldDataSweep(this.env, userId) };
  }

  /**
   * Merge a patch into the tenant's ui_state JSON (e.g. {tour_seen:true}) and persist it — the
   * server-side store for UI flags (no localStorage). UI prefs, not PII, so not audited; written via
   * the DO like every other profile mutation. Tolerates a malformed/empty existing value.
   */
  async setUiState(userId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    const row = await this.env.DB.prepare(`SELECT ui_state FROM profiles WHERE user_id = ?`)
      .bind(userId)
      .first<{ ui_state: string | null }>();
    let current: Record<string, unknown> = {};
    try {
      current = row?.ui_state ? (JSON.parse(row.ui_state) as Record<string, unknown>) : {};
    } catch {
      current = {};
    }
    const merged = { ...current, ...patch };
    const serialized = JSON.stringify(merged);
    // ui_state is for small UI flags only — cap it so a tenant can't bloat their own hot-path
    // profile row with an oversized PATCH.
    if (serialized.length > 8192) throw new Error("ui_state too large");
    await this.env.DB.prepare(`UPDATE profiles SET ui_state = ? WHERE user_id = ?`)
      .bind(serialized, userId)
      .run();
    return merged;
  }

  /**
   * Record that a cross-border (US/Anthropic) inference disclosure occurred — once per operation,
   * with the feature + model id, NEVER any payload. No-op on the AU/Bedrock path (no disclosure to
   * audit). Keeps the hash-chained audit_log as the APP-8 disclosure record. Called inside the DO so
   * appends stay serialized.
   */
  private async auditXborderInference(userId: string, provider: string, feature: string, model: string): Promise<void> {
    if (provider === "anthropic") {
      await this.audit(userId, "xborder_inference", JSON.stringify({ feature, model }));
    }
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
    // Budget gate (per-tenant + global) — this free-text LLM call could otherwise be spammed.
    if (!(await this.withinBudget(userId, null))) throw new Error("ai_budget_reached");
    const llm = await getLLM(this.env, profile, { userId });
    await this.auditXborderInference(userId, provider, "onboarding_draft", llm.modelId);
    const draft = await extractSituationDraft(llm, message.slice(0, 4000));
    await this.audit(
      userId,
      "onboarding_draft",
      JSON.stringify({ entities: draft.entities.length, properties: draft.properties.length, rules: draft.rules.length }),
    );
    return draft;
  }

  /**
   * "Guide me": a personalised, data-grounded walkthrough for the screen the user is on. Mirrors the
   * draftSituation gates (consent + budget, metered, audited). Cached per (tab, progress signature)
   * for ~30 min so re-clicking the same screen state doesn't re-bill. GENERAL INFO ONLY.
   */
  /**
   * "Ask Quillo" (flag ask_quillo) — answer a free-text question grounded ONLY in the user's own
   * ledger. Mirrors guideMe's gates: APP-8 consent (anthropic path) runs BEFORE any model call, then
   * the daily-budget gate. Context = their situation (redacted) + the full computed FY position
   * (buildReport JSON, redacted + length-capped). Single-turn, no history, no rule-writing (that's the
   * C2 chat epic). GENERAL-INFO only — the prompt forbids advice / refund / rates.
   */
  async askQuestion(userId: string, question: string, fy: number): Promise<AnswerResult> {
    const q = (question ?? "").trim();
    if (!q) throw new Error("empty question");
    const profile = await this.requireProfile(userId);
    const provider = profile.inference_provider ?? this.env.DEFAULT_INFERENCE_PROVIDER;
    if (provider === "anthropic" && profile.consent_xborder !== 1) throw new Error("consent_required");
    if (!(await this.withinBudget(userId, null))) throw new Error("ai_budget_reached");
    const llm = await getLLM(this.env, profile, { userId });
    await this.auditXborderInference(userId, provider, "ask", llm.modelId);
    // C3 (flag ask_actions): also fetch the FY transaction digest so the model can PROPOSE one-click
    // fixes by T-code alias. Merchants in the digest are the same data category statement categorisation
    // already sends to the model, so the existing consent gate above covers it. Flag off ⇒ undefined ⇒
    // buildAskSystem/extractAnswer take their pre-C3 paths byte-identically.
    const wantActions = featureOn(this.env, "ask_actions");
    const [situation, report, digestRows] = await Promise.all([
      getSituation(this.env, userId, profile),
      buildReport(this.env, userId, fy),
      wantActions ? fetchAskDigestRows(this.env, userId, fy) : Promise.resolve(undefined),
    ]);
    const digest = digestRows ? renderTxnDigest(digestRows.rows, digestRows.total) : undefined;
    // The question is free text → redact (TFN/card/BSB) BEFORE it reaches the model (APP-8), THEN cap —
    // redact-then-slice so a truncated token can't defeat the regex. The position is a curated summary
    // of aggregates (no PII digit strings), so it is NOT redacted (redact would mangle the *_cents the
    // answer must cite). The situation text can carry names, so it stays redacted.
    const system = buildAskSystem(redact(renderSituation(situation)), summariseReportForAsk(report), digest?.text);
    const result = await extractAnswer(llm, system, [{ role: "user", content: redact(q).slice(0, 600) }], digest && { aliasToId: digest.aliasToId, propertyIds: new Set(situation.properties.map((p) => p.id)) });
    await this.audit(userId, "ask", JSON.stringify({ q_len: q.length, fy, proposals: result.proposed_actions?.length ?? 0 }));
    return result;
  }

  /**
   * Ask Quillo C2 (#173) — a multi-turn chat TURN. Same gates/grounding as askQuestion (consent +
   * budget BEFORE the model call; question redacted; situation redacted; position summary raw), plus
   * conversation history: loads the session's prior turns, sends them with the new question, and stores
   * both the user message and the assistant answer. Creates a session if none is given. GENERAL-INFO
   * only; any suggested_rule is surfaced for the UI to CONFIRM (never auto-written here).
   */
  async chatTurn(userId: string, sessionId: string | null, message: string, fy: number, pageRoute?: string): Promise<{ session_id: string } & AnswerResult> {
    const text = (message ?? "").trim();
    if (!text) throw new Error("empty message");
    // Token-bomb guard: reject an oversize prompt BEFORE any profile/grounding/model work (cheapest gate).
    const maxChars = Number(this.env.CHAT_MAX_MESSAGE_CHARS ?? 0);
    if (maxChars > 0 && text.length > maxChars) throw new Error("chat_message_too_long");
    const profile = await this.requireProfile(userId);
    const provider = profile.inference_provider ?? this.env.DEFAULT_INFERENCE_PROVIDER;
    if (provider === "anthropic" && profile.consent_xborder !== 1) throw new Error("consent_required");
    if (!(await this.withinBudget(userId, null))) throw new Error("ai_budget_reached");
    // Per-tenant rate limit (burst + daily turn count) — a fast backstop so a bad actor can't hammer
    // /api/chat and rack up spend before the daily $ budget trips. Counters live in KV; safe because the
    // DO serialises a tenant's turns (this is the only writer), so the read-increment-write is race-free.
    if (!(await this.chatRateOk(userId))) throw new Error("chat_rate_limited");

    // Resolve / create the session (validate ownership). The session PINS its grounding FY for the whole
    // conversation — so switching the global FY mid-chat can't silently mix two years' figures.
    let sid = sessionId ?? "";
    let sessionFy = fy;
    if (sid) {
      const own = await this.env.DB.prepare(`SELECT fy FROM chat_sessions WHERE id = ? AND user_id = ?`).bind(sid, userId).first<{ fy: number | null }>();
      if (!own) sid = "";
      else if (own.fy != null) sessionFy = own.fy;
    }
    if (!sid) {
      sid = crypto.randomUUID();
      await this.env.DB.prepare(`INSERT INTO chat_sessions (id, user_id, fy) VALUES (?, ?, ?)`).bind(sid, userId, sessionFy).run();
    }

    // Prior turns (cap to the last 20 to bound tokens), oldest first. Tiebreak role ASC within a second
    // (assistant<user) so after reversing, the user turn precedes its assistant reply.
    const prior = await this.env.DB.prepare(
      `SELECT role, content FROM chat_messages WHERE user_id = ? AND session_id = ? ORDER BY created_at DESC, role ASC LIMIT 20`,
    ).bind(userId, sid).all<{ role: string; content: string }>();
    const history = (prior.results ?? []).reverse().map((m) => ({ role: m.role === "assistant" ? ("assistant" as const) : ("user" as const), content: m.content }));
    // The Anthropic messages[] must start with a user turn — drop any leading assistant turns the
    // 20-row window or an orphaned half-pair might begin with.
    while (history[0]?.role === "assistant") history.shift();

    const llm = await getLLM(this.env, profile, { userId });
    await this.auditXborderInference(userId, provider, "ask", llm.modelId);
    // C3 (flag ask_actions): same digest as askQuestion, pinned to the session FY. Aliases are rebuilt
    // per turn (deterministic ORDER BY keeps them stable unless data changes mid-chat); proposals are
    // ephemeral per-turn — like suggested_rule, they are NOT persisted into chat_messages.
    const wantActions = featureOn(this.env, "ask_actions");
    // Phase 2 (chat_nav): only honour a client-supplied page route from the allowlist, so a crafted
    // request can't smuggle arbitrary text into the system prompt. Off ⇒ no nav, no page line.
    const wantNav = featureOn(this.env, "chat_nav");
    const wantEntityActions = featureOn(this.env, "ask_actions_v2");
    const pageRouteOk = wantNav && pageRoute && (ALLOWED_NAV_ROUTES as readonly string[]).includes(pageRoute) ? pageRoute : undefined;
    const [situation, report, digestRows] = await Promise.all([
      getSituation(this.env, userId, profile),
      buildReport(this.env, userId, sessionFy),
      wantActions ? fetchAskDigestRows(this.env, userId, sessionFy) : Promise.resolve(undefined),
    ]);
    const digest = digestRows ? renderTxnDigest(digestRows.rows, digestRows.total) : undefined;
    const system = buildAskSystem(redact(renderSituation(situation)), summariseReportForAsk(report), digest?.text, { pageRoute: pageRouteOk, nav: wantNav, entityWrites: wantEntityActions });
    const userMsg = redact(text).slice(0, 600);
    const result = await extractAnswer(llm, system, [...history, { role: "user", content: userMsg }], digest && { aliasToId: digest.aliasToId, propertyIds: new Set(situation.properties.map((p) => p.id)) }, wantNav, wantEntityActions);

    // Persist both turns (the redacted question + the answer — no PII in storage).
    await this.env.DB.batch([
      this.env.DB.prepare(`INSERT INTO chat_messages (id, user_id, session_id, role, content) VALUES (?, ?, ?, 'user', ?)`).bind(crypto.randomUUID(), userId, sid, userMsg),
      this.env.DB.prepare(`INSERT INTO chat_messages (id, user_id, session_id, role, content) VALUES (?, ?, ?, 'assistant', ?)`).bind(crypto.randomUUID(), userId, sid, result.answer),
    ]);
    await this.audit(userId, "chat_turn", JSON.stringify({ session: sid, fy: sessionFy, turns: history.length / 2 + 1, proposals: result.proposed_actions?.length ?? 0 }));
    return { session_id: sid, ...result };
  }

  /** Load a chat session's messages (oldest first) to hydrate the UI. */
  async chatHistory(userId: string, sessionId: string): Promise<{ messages: { role: string; content: string }[] }> {
    const res = await this.env.DB.prepare(
      `SELECT role, content FROM chat_messages WHERE user_id = ? AND session_id = ? ORDER BY created_at, role DESC`,
    ).bind(userId, sessionId).all<{ role: string; content: string }>();
    return { messages: res.results ?? [] };
  }

  async guideMe(userId: string, tab: string): Promise<{ headline: string; steps: string[] }> {
    const profile = await this.requireProfile(userId);
    const provider = profile.inference_provider ?? this.env.DEFAULT_INFERENCE_PROVIDER;
    if (provider === "anthropic" && profile.consent_xborder !== 1) throw new Error("consent_required");

    const progress = await getProgress(this.env, userId);
    // Signature = the progress numbers that change the advice; re-clicking an unchanged screen is free.
    const sig = [progress.imported.transactions, progress.categorised, progress.needs_review, progress.undated, progress.unreconciled_receipts, progress.has_qbo ? 1 : 0, progress.done ? 1 : 0].join("-");
    const cacheKey = `guide:${userId}:${tab}:${sig}`;
    const cached = await this.env.RULES.get(cacheKey, "json");
    if (cached) return cached as { headline: string; steps: string[] };

    if (!(await this.withinBudget(userId, null))) throw new Error("ai_budget_reached");
    const llm = await getLLM(this.env, profile, { userId });
    await this.auditXborderInference(userId, provider, "guide_me", llm.modelId);
    const situation = await getSituation(this.env, userId, profile);
    const { system, user } = buildGuidePrompt(tab, progress, redact(renderSituation(situation)));
    const result = await extractGuide(llm, system, user);
    await this.env.RULES.put(cacheKey, JSON.stringify(result), { expirationTtl: 60 * 30 });
    await this.audit(userId, "guide_me", JSON.stringify({ tab, steps: result.steps.length }));
    return result;
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
      "When a payg/individual line is clearly private living spend (groceries, personal shopping, ordinary meals, personal loan/credit-card repayments, gym/health), still use bucket=payg but give it a descriptive ato_label (e.g. payg:groceries, payg:personal-spend) so it can be recognised as private. Prefer 'unknown' over guessing a work-related label — deductibility is decided later; never assert it.",
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
  // ── Usage-based billing wallet (flag `billing`) ──────────────────────────────
  /** Grant the one-off free credit allowance, once per tenant (idempotent on profiles.free_grant_at). */
  async grantSignupCredits(userId: string): Promise<{ granted_e4: number }> {
    const grant = freeCreditGrantE4(this.env);
    if (grant <= 0) return { granted_e4: 0 };
    // Idempotent on the UNIQUE(user_id, ref) ledger constraint: a second concurrent grant INSERTs 0 rows.
    const ins = await this.env.DB.prepare(
      `INSERT OR IGNORE INTO credit_ledger (id, user_id, kind, amount_e4, ref) VALUES (?, ?, 'grant', ?, 'signup free allowance')`,
    ).bind(crypto.randomUUID(), userId, grant).run();
    if ((ins.meta?.changes ?? 0) === 0) return { granted_e4: 0 }; // already granted
    await this.env.DB.prepare(`UPDATE profiles SET credit_balance_e4 = credit_balance_e4 + ?, free_grant_at = datetime('now') WHERE user_id = ?`).bind(grant, userId).run();
    await this.audit(userId, "credit_granted", JSON.stringify({ amount_e4: grant }));
    return { granted_e4: grant };
  }

  /** Add credits to the wallet (a verified Stripe top-up, from the webhook). Idempotent on the
   *  UNIQUE(user_id, ref) ledger constraint so a re-delivered webhook can't double-credit. */
  async creditWallet(userId: string, amountE4: number, kind: string, ref: string | null): Promise<{ balance_e4: number }> {
    const amt = Math.max(0, Math.round(amountE4 || 0));
    if (amt > 0) {
      const ins = await this.env.DB.prepare(
        `INSERT OR IGNORE INTO credit_ledger (id, user_id, kind, amount_e4, ref) VALUES (?, ?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), userId, kind === "topup" ? "topup" : "grant", amt, ref).run();
      if ((ins.meta?.changes ?? 0) > 0) {
        await this.env.DB.prepare(`UPDATE profiles SET credit_balance_e4 = credit_balance_e4 + ? WHERE user_id = ?`).bind(amt, userId).run();
        await this.audit(userId, "credit_topup", JSON.stringify({ amount_e4: amt, kind, ref }));
        // A PAID top-up is itself a deductible expense for the customer — the fee they paid Quillo to
        // manage their tax affairs (s25-5, ATO label D10). Record it as their own claim, ONCE per Stripe
        // session (we're inside the changes>0 guard, so a re-delivered webhook can't double-record).
        // Only paid top-ups, never the free signup grant. Flag-gated: OFF ⇒ no row ⇒ byte-identical.
        if (kind === "topup" && featureOn(this.env, "quillo_fee_deduction")) {
          // Best-effort: recording the fee as a deduction must NEVER break the wallet credit or 500 the
          // Stripe webhook (a 500 forces a redelivery that — since the ledger row now exists — skips this
          // block and would lose the row anyway). On failure, log; it's backfillable from credit_ledger.
          try {
            await this.recordFeeDeduction(userId, Math.round(amt / 10_000), ref);
          } catch (e) {
            console.error(`recordFeeDeduction failed for ${userId} (ref=${ref}): ${(e as Error).message}`);
          }
        }
      }
    }
    const b = await this.env.DB.prepare(`SELECT credit_balance_e4 AS b FROM profiles WHERE user_id = ?`).bind(userId).first<{ b: number }>();
    return { balance_e4: b?.b ?? 0 };
  }

  /** Record a paid Quillo fee as the customer's own D10 "cost of managing tax affairs" deduction
   *  (flag `quillo_fee_deduction`). Writes a payg/D10/confirmed_deductible receipt row that the report
   *  counts immediately (COUNTABLE + deductionGroupForRow). `amountCents` is the gross AUD paid;
   *  `ref` is the Stripe session id (stored in ledger_ref for traceability). Called only from inside
   *  creditWallet's once-per-session idempotency guard, so no extra dedupe is needed here. */
  private async recordFeeDeduction(userId: string, amountCents: number, ref: string | null): Promise<void> {
    if (!(amountCents > 0)) return;
    // Self-idempotent: never write two fee rows for the same Stripe session (defensive — the caller
    // already guards on the once-per-session credit_ledger insert).
    if (ref) {
      const existing = await this.env.DB.prepare(
        `SELECT 1 FROM transactions WHERE user_id = ? AND ledger_ref = ? AND source = 'quillo' LIMIT 1`,
      ).bind(userId, ref).first();
      if (existing) return;
    }
    // Date the expense in Australian local time, not UTC: the financial-year boundary is 1 July local,
    // so a top-up just after midnight 1 July AEST must land in the new FY (UTC would back-date it to 30 June).
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" }); // YYYY-MM-DD
    await this.env.DB.prepare(
      `INSERT INTO transactions
         (id, user_id, source, status, kind, merchant, amount_cents, currency, amount_aud_cents, gst_cents,
          txn_date, bucket, ato_label, deductibility, deductible_amount_cents, direction, confidence, reasoning, ledger_ref)
       VALUES (?, ?, 'quillo', 'extracted', 'receipt', 'Quillo', ?, 'AUD', ?, NULL,
               ?, 'payg', 'D10', 'confirmed_deductible', ?, 'debit', 1.0, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      userId,
      amountCents,
      amountCents,
      today,
      amountCents,
      "Quillo subscription fee — cost of managing tax affairs (s25-5, label D10)",
      ref,
    ).run();
    await this.audit(userId, "fee_deduction_recorded", JSON.stringify({ amount_cents: amountCents, ato_label: "D10", ref }));
  }

  /** Billing surface: balance, the markup %, and recent grants/top-ups. `configured` = Stripe wired. */
  async getBillingOverview(userId: string): Promise<{ configured: boolean; balance_e4: number; markup_pct: number; free_grant_e4: number; ledger: { kind: string; amount_e4: number; ref: string | null; created_at: string }[] }> {
    const p = await this.env.DB.prepare(`SELECT credit_balance_e4 AS b FROM profiles WHERE user_id = ?`).bind(userId).first<{ b: number }>();
    const led = await this.env.DB.prepare(`SELECT kind, amount_e4, ref, created_at FROM credit_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`).bind(userId).all<{ kind: string; amount_e4: number; ref: string | null; created_at: string }>();
    return {
      configured: !!this.env.STRIPE_SECRET_KEY,
      balance_e4: p?.b ?? 0,
      markup_pct: billingPolicy(this.env).markupPct,
      free_grant_e4: freeCreditGrantE4(this.env),
      ledger: led.results ?? [],
    };
  }

  private async withinBudget(userId: string, txnId: string | null): Promise<boolean> {
    // Usage-based billing (flag `billing`): a model call also needs a positive credit balance (the free
    // allowance OR a Stripe top-up). The actual debit happens in usageStatements AFTER the call; this
    // gate stops the NEXT call once credits hit zero. OFF ⇒ skipped entirely ⇒ byte-identical.
    if (featureOn(this.env, "billing")) {
      const readBalance = async () => Number(
        (await this.env.DB.prepare(`SELECT credit_balance_e4 AS b FROM profiles WHERE user_id = ?`).bind(userId).first<{ b: number }>())?.b ?? 0,
      );
      let bal = await readBalance();
      if (bal <= 0) {
        // First AI use: hand out the one-off free allowance before blocking (idempotent — granted once
        // per tenant). Ensures a user who never opened the Billing page still gets their free credits at
        // the moment they first need AI, rather than hitting a $0 wall.
        await this.grantSignupCredits(userId);
        bal = await readBalance();
      }
      if (bal <= 0) {
        if (txnId) {
          await this.markStatus(txnId, "needs_review");
          await this.notify(userId, "You're out of AI credits. Top up in Billing to keep using AI features — this was saved for review until then.", txnId);
        }
        return false;
      }
    }
    // Global daily ceiling across ALL tenants — the multi-tenant backstop (N testers × the per-tenant
    // cap would otherwise be unbounded). Over it, stop spending and degrade (the app still works).
    const globalBudget = Number(this.env.MAX_DAILY_COST_CENTS_GLOBAL ?? 0);
    if (globalBudget > 0) {
      const gspent = await spentTodayGlobalCents(this.env);
      if (gspent >= globalBudget) {
        if (txnId) {
          await this.markStatus(txnId, "needs_review");
          await this.notify(userId, "AI is paused for today (the platform's daily limit was reached). Saved for review — it'll process after the daily reset.", txnId);
        }
        return false;
      }
      // Interim soft alert for the racy global counter (see recordUsage): warn ONCE/day when platform
      // spend crosses 80% of the ceiling, so a spike is visible in logs/audit before the hard cap
      // pauses every tenant. Cheap KV once-guard keeps it from spamming on every call.
      if (gspent >= globalBudget * 0.8) {
        const day = new Date().toISOString().slice(0, 10);
        const gflag = `costalert:global:${day}`;
        if (!(await this.env.RULES.get(gflag))) {
          await this.env.RULES.put(gflag, "1", { expirationTtl: 60 * 60 * 26 });
          console.warn(`platform AI spend $${(gspent / 100).toFixed(2)} of $${(globalBudget / 100).toFixed(2)} global daily ceiling (≥80%)`);
          await this.audit(userId, "global_cost_alert", JSON.stringify({ gspent_cents: gspent, ceiling_cents: globalBudget }));
        }
      }
    }
    // Platform-wide MONTHLY ceiling — a firm upper bound on AI spend beyond the daily cap (set it to,
    // say, your AWS credit budget). Over it, AI pauses for everyone until the month rolls over. The app
    // still works (data is saved for review). 0/unset ⇒ off ⇒ no extra query.
    const monthlyBudget = Number(this.env.MAX_MONTHLY_COST_CENTS_GLOBAL ?? 0);
    if (monthlyBudget > 0) {
      const mspent = await spentThisMonthGlobalCents(this.env);
      if (mspent >= monthlyBudget) {
        if (txnId) {
          await this.markStatus(txnId, "needs_review");
          await this.notify(userId, "AI is paused for the rest of the month (the platform's monthly limit was reached). Saved for review — it resumes next month.", txnId);
        }
        return false;
      }
      if (mspent >= monthlyBudget * 0.8) {
        const mflag = `costalert:globalmonth:${new Date().toISOString().slice(0, 7)}`;
        if (!(await this.env.RULES.get(mflag))) {
          await this.env.RULES.put(mflag, "1", { expirationTtl: 60 * 60 * 24 * 40 });
          console.warn(`platform AI spend $${(mspent / 100).toFixed(2)} of $${(monthlyBudget / 100).toFixed(2)} MONTHLY ceiling (≥80%)`);
          await this.audit(userId, "global_month_cost_alert", JSON.stringify({ mspent_cents: mspent, ceiling_cents: monthlyBudget }));
        }
      }
    }
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

  /**
   * Per-tenant chat rate limit (anti-abuse), enforced AFTER consent + the daily $ budget but BEFORE the
   * model call. Two windows: a per-minute burst cap and a per-day turn cap, both env-configured (0/unset
   * ⇒ that window is off). Counters are KV (TTL'd), incremented BEFORE the check so a blocked attempt
   * still counts. Race-free per tenant because the DO serialises a tenant's chatTurn calls — this DO is
   * the only writer of these keys. Returns false when a window is exceeded (caller → 429). A repeated
   * trip raises a once-per-day audit + console signal so a hammering tenant is visible to the admin view.
   */
  private async chatRateOk(userId: string): Promise<boolean> {
    const now = new Date();
    const perMin = Number(this.env.CHAT_MAX_TURNS_PER_MIN ?? 0);
    const perDay = Number(this.env.CHAT_MAX_TURNS_PER_DAY ?? 0);
    // Read-increment a KV counter; a missing/garbled value resets to 0 so the gate fails CLOSED
    // (toward counting) rather than open (Number("x")+1 = NaN, and NaN > limit is always false).
    const bump = async (k: string, ttl: number): Promise<number> => {
      const prev = Number(await this.env.RULES.get(k));
      const n = (Number.isFinite(prev) ? prev : 0) + 1;
      await this.env.RULES.put(k, String(n), { expirationTtl: ttl });
      return n;
    };
    let blocked: "minute" | "day" | null = null;
    if (perMin > 0) {
      // Fixed calendar-minute window (yyyy-mm-ddThh:mm) — a burst straddling a minute flip can briefly
      // get ~1 extra turn; the per-day cap + the $ budget are the hard ceilings, so that's acceptable.
      if ((await bump(`chatrate:min:${userId}:${now.toISOString().slice(0, 16)}`, 120)) > perMin) blocked = "minute";
    }
    if (!blocked && perDay > 0) {
      if ((await bump(`chatrate:day:${userId}:${now.toISOString().slice(0, 10)}`, 60 * 60 * 26)) > perDay) blocked = "day";
    }
    if (!blocked) return true;
    // Once-per-day signal so repeated hammering surfaces to the admin spend view + the tamper-evident log.
    const alertKey = `chatrate:alert:${userId}:${now.toISOString().slice(0, 10)}`;
    if (!(await this.env.RULES.get(alertKey))) {
      await this.env.RULES.put(alertKey, "1", { expirationTtl: 60 * 60 * 26 });
      console.warn(`chat rate limit hit (${blocked}) for tenant ${userId}`);
      await this.audit(userId, "chat_rate_limited", JSON.stringify({ window: blocked }));
    }
    return false;
  }

  private async promoteToEvalCase(userId: string, txnId: string): Promise<void> {
    // Promote to an eval case once a txn has accumulated repeated corrections from SEPARATE ACTIONS.
    // Count DISTINCT actions, not rows: a single batch correction shares one batch_id and a single
    // multi-field batch must NOT trip the "corrected twice → learn" moat from one click. Standalone
    // corrections (NULL batch_id) each count via their own id. Reverted corrections don't count.
    const count = await this.env.DB.prepare(
      `SELECT COUNT(DISTINCT COALESCE(batch_id, id)) AS n FROM corrections
        WHERE user_id = ? AND txn_id = ? AND reverted_at IS NULL`,
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
        txn.ato_label ?? "", // expected_label is NOT NULL — an uncategorised line re-bucketed without a label has none
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
    // Dedup against a direction-compatible rule only: a debit→company rule shouldn't block learning a
    // credit→refund rule for the same merchant (the new rule's direction follows its bucket).
    const dir = RULE_CREDIT_BUCKETS.has(txn.bucket) ? "credit" : "debit";
    if (applyUserRules(txn.merchant, situation.rules, dir)) return; // a rule already covers this merchant

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
