import { Agent } from "agents";
import type { Env } from "./env";
import { getProfile, getSituation, renderSituation, type Profile, type Situation, type UserRule } from "./lib/db";
import { sha256hex } from "./lib/base64";
import { getLLM, type LLM } from "./llm";
import { extractReceipt, extractFromText, type Extracted } from "./extract";
import { getLedger, LedgerNotConnectedError, type LedgerExpense } from "./ledger";
import { redact } from "./lib/redact";
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
  merchant: "merchant",
  property_id: "property_id",
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
    await this.env.DB.prepare(
      `INSERT INTO transactions (id, user_id, source, status, receipt_key)
       VALUES (?, ?, ?, 'needs_extraction', ?)`,
    )
      .bind(txnId, userId, source, key)
      .run();
    await this.audit(userId, "ingest", JSON.stringify({ txnId, source, bucketHint }));

    // Run extraction within the DO's active lifetime (NOT ctx.waitUntil — that is a
    // no-op in Durable Objects, finding H3). Awaiting keeps the DO alive for the call.
    await this.extractAndCategorise(userId, txnId, bytes, mime, bucketHint);
    return txnId;
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

    const rulePack = await this.loadRulePack(profile.rule_pack_ver);
    const situation = await getSituation(this.env, userId, profile);
    const system = this.buildSystemPrompt(rulePack, profile, situation, bucketHint);
    const llm = getLLM(this.env, profile);
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

    await this.env.DB.prepare(
      `UPDATE transactions SET status='extracted', merchant=?, amount_cents=?, gst_cents=?,
              txn_date=?, bucket=?, ato_label=?, property_id=?, confidence=? WHERE id=? AND user_id=?`,
    )
      .bind(
        final.merchant,
        final.amount_cents,
        final.gst_cents,
        final.txn_date,
        final.bucket,
        final.ato_label,
        final.property_id,
        final.confidence,
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

  // ── 4. PROACTIVE engine (called by cron) ───────────────────────────────────
  async runProactiveScan(userId: string): Promise<void> {
    const suggestions: string[] = [];

    const uncategorised = await this.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND bucket IN ('unknown') OR status='needs_review'`,
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
    return [
      "You extract and categorise AU expense receipts. General information only — not tax advice.",
      `Tenant jurisdiction: ${profile.jurisdiction}. GST registered: ${profile.gst_registered ? "yes" : "no"}.`,
      `Rule pack ${rulePack.version}:`,
      ...Object.entries(rulePack.buckets).map(([k, v]) => `  - ${k}: ${v}`),
      rulePack.guidance,
      renderSituation(situation),
      hint,
    ].join("\n");
  }

  private async markStatus(txnId: string, status: string): Promise<void> {
    await this.env.DB.prepare(`UPDATE transactions SET status = ? WHERE id = ?`).bind(status, txnId).run();
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
      `SELECT merchant, amount_cents, gst_cents, bucket, ato_label, rule_pack_ver
         FROM transactions JOIN profiles USING (user_id) WHERE transactions.id = ?`,
    )
      .bind(txnId)
      .first<{ merchant: string; amount_cents: number; gst_cents: number | null; bucket: string; ato_label: string; rule_pack_ver: string }>();
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
