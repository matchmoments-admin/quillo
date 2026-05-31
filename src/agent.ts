import { Agent } from "agents";
import type { Env } from "./env";
import { getProfile, getSituation, renderSituation, type Profile, type Situation, type UserRule } from "./lib/db";
import { sha256hex } from "./lib/base64";
import { getLLM } from "./llm";
import { extractReceipt, type Extracted } from "./extract";
import { getLedger, LedgerNotConnectedError, type LedgerExpense } from "./ledger";
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

  /** Email-body fallback when an email has no attachment. */
  async ingestText(userId: string, source: string, text: string): Promise<string> {
    const txnId = crypto.randomUUID();
    await this.env.DB.prepare(
      `INSERT INTO transactions (id, user_id, source, status) VALUES (?, ?, ?, 'needs_review')`,
    )
      .bind(txnId, userId, source)
      .run();
    await this.audit(userId, "ingest_text", JSON.stringify({ txnId, source }));
    await this.notify(userId, "Received an email with no receipt attachment — left for manual review.", txnId);
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
    const profile = await this.requireProfile(userId);

    // APP-8 gate (fix H7): a US (anthropic) inference call on personal tax data
    // requires explicit, recorded cross-border consent. Bedrock (AU) does not.
    const provider = profile.inference_provider ?? this.env.DEFAULT_INFERENCE_PROVIDER;
    if (provider === "anthropic" && profile.consent_xborder !== 1) {
      await this.markStatus(txnId, "blocked_consent");
      await this.notify(
        userId,
        "Cross-border processing consent (APP 8) is required before this receipt can be read by the US inference API. Record consent to proceed.",
        txnId,
      );
      return;
    }

    const rulePack = await this.loadRulePack(profile.rule_pack_ver);
    const situation = await getSituation(this.env, userId, profile);
    const system = this.buildSystemPrompt(rulePack, profile, situation, bucketHint);
    const llm = getLLM(this.env, profile);

    const { parsed, raw } = await extractReceipt(llm, system, bytes, mime);

    // Deterministic per-user rule wins over the model's guess (confidence 1.0).
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

    // DESIGN DECISION (reader/reconciler): the agent does NOT auto-create Purchase
    // objects in QuickBooks for company-bucket transactions. Bank feeds are the
    // source of truth in QuickBooks Online — auto-creating a Purchase here would
    // create a duplicate posting against what the bank feed brings in. Instead, we
    // notify the founder and leave the transaction for reconciliation against the
    // bank feed in QBO. pushToLedger() is retained below for cash / non-feed
    // expenses only (see comment on that method).
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
