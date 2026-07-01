import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { LLM } from "./llm";
import { bytesToBase64 } from "./lib/base64";
import type { ColumnMap } from "./lib/statements";
import { BUCKETS, ENTITY_KINDS, PROPERTY_STATUSES, DOC_TYPES, ASSET_CLASSES, ATO_LABEL_MAX, CLAIM_TYPES, isBucket, isPropertyBucket, normalizeAtoLabel } from "./lib/taxonomy";
import { EXTRAS_CATEGORIES } from "./lib/advisory";
import type { DigestRef } from "./lib/guide";

export const Extracted = z
  .object({
    merchant: z.string(),
    amount_cents: z.number().int(),
    currency: z.string().default("AUD"),
    gst_cents: z.number().int().nullable(),
    txn_date: z.string().nullable(),
    bucket: z.enum(BUCKETS),
    ato_label: z.string(),
    property_id: z.string().nullable(),
    paid_account: z.string().nullable(),
    confidence: z.number().min(0).max(1),
    reasoning: z.string(),
  })
  // Apply the SAME ato_label hygiene the batch + correction paths use (taxonomy.normalizeAtoLabel:
  // cap length + safe charset), falling back to the bucket name when the model emits a junk/blob
  // label. The receipt path is the highest-volume model writer, so it must go through this too —
  // otherwise the "single place hygiene is defined" guarantee would leak on the main ingest path.
  .transform((e) => ({ ...e, ato_label: normalizeAtoLabel(e.ato_label) ?? e.bucket }));
export type Extracted = z.infer<typeof Extracted>;

// Forced tool-use guarantees a schema-valid object with no prose and no markdown
// fences — replacing the plan's brittle `JSON.parse(text.replace(/```/...))`
// (review finding H4). tool_choice pins Claude to exactly this tool.
const RECORD_TOOL: Anthropic.Tool = {
  name: "record_receipt",
  description:
    "Record the extracted, categorised receipt. Call this exactly once with the fields below.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["merchant", "amount_cents", "currency", "gst_cents", "txn_date", "bucket", "ato_label", "property_id", "paid_account", "confidence", "reasoning"],
    properties: {
      merchant: { type: "string", description: "Merchant / supplier name as printed." },
      amount_cents: { type: "integer", description: "Total amount in cents, in the ORIGINAL currency shown on the receipt (GST-inclusive)." },
      currency: { type: "string", description: "ISO-4217 code of the amount as printed (e.g. AUD, USD, EUR). Default AUD only if no currency/symbol indicates otherwise; '$' alone on an Australian receipt means AUD, but USD/US$/a US merchant means USD." },
      gst_cents: {
        type: ["integer", "null"],
        description:
          "Australian GST component in cents — ONLY if the receipt shows a GST/tax line AND the supplier is Australian (has an ABN). For overseas suppliers or any non-AUD currency, GST does not apply: return null. Never assume 10%.",
      },
      txn_date: { type: ["string", "null"], description: "ISO date (YYYY-MM-DD) or null if illegible." },
      bucket: {
        type: "string",
        enum: [...BUCKETS],
        description: "Which tax bucket this expense belongs to, per the rule pack and the user's situation.",
      },
      ato_label: { type: "string", description: "ATO label / ledger category, e.g. company:expense, rental:interest, D5." },
      property_id: {
        type: ["string", "null"],
        description: "When the bucket is property_*, the id of the matching property from the user's situation; otherwise null.",
      },
      paid_account: {
        type: ["string", "null"],
        description:
          "Payment method/account if visible on the receipt (e.g. 'visa-1234' from masked card digits, 'amex', 'paypal', 'cash'); otherwise null.",
      },
      confidence: { type: "number", description: "0..1 confidence in bucket + label." },
      reasoning: { type: "string", description: "One sentence: why this bucket/label." },
    },
  },
};

const SUPPORTED_IMAGE = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** Build the vision content block for a receipt image or PDF. */
function receiptBlock(bytes: ArrayBuffer, mime: string): Anthropic.ContentBlockParam {
  const data = bytesToBase64(bytes);
  if (mime === "application/pdf") {
    return {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data },
    };
  }
  if (SUPPORTED_IMAGE.has(mime)) {
    return {
      type: "image",
      source: { type: "base64", media_type: mime as Anthropic.Base64ImageSource["media_type"], data },
    };
  }
  // Default to JPEG; Anthropic validates media_type against bytes and 400s on mismatch.
  return {
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data },
  };
}

export interface ExtractResult {
  parsed: Extracted;
  raw: unknown;
}

/**
 * Single forced-tool-use call against `RECORD_TOOL`: the model must return exactly one
 * schema-valid `record_receipt` call (no prose, no markdown — finding H4). The image and
 * text entry points differ only in the user `content`, so they share this. `system` is
 * the stable, cacheable rule-pack + profile prompt.
 */
async function runRecordReceipt(
  llm: LLM,
  system: string,
  content: Anthropic.ContentBlockParam[],
  feature: string,
): Promise<ExtractResult> {
  const msg = await llm.create(
    {
      model: llm.modelId,
      max_tokens: 1024,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      tools: [RECORD_TOOL],
      tool_choice: { type: "tool", name: RECORD_TOOL.name },
      messages: [{ role: "user", content }],
    },
    feature,
  );

  const toolUse = msg.content.find(
    (c): c is Anthropic.ToolUseBlock => c.type === "tool_use" && c.name === RECORD_TOOL.name,
  );
  if (!toolUse) {
    throw new Error("model did not return a record_receipt tool call");
  }
  return { parsed: Extracted.parse(toolUse.input), raw: toolUse.input };
}

// ── PDF statement extraction (Claude document → structured lines + balances) ───
// The model returns each amount as a NATURAL DOLLAR value (exactly as printed) plus a semantic
// debit/credit direction — far more reliable over ~150 lines than asking it to pre-multiply to
// integer cents (a frequent slip — it would emit 19.28 and fail an int() schema, rejecting the
// whole statement). We convert to absolute cents + sign ourselves. Zod validates and is lenient
// (coerce numbers, normalise the direction word, default odd rows) so one bad row never kills
// the import; the cents-based shape below is what the rest of the pipeline consumes.
export interface ExtractedStatement {
  lines: { date: string | null; description: string; amount_cents: number; direction: "debit" | "credit"; balance_cents: number | null }[];
  opening_cents: number | null;
  closing_cents: number | null;
  currency: string;
}

const DIRECTION_WORDS: Record<string, "debit" | "credit"> = {
  debit: "debit", dr: "debit", d: "debit", charge: "debit", purchase: "debit", out: "debit", withdrawal: "debit",
  credit: "credit", cr: "credit", c: "credit", payment: "credit", refund: "credit", in: "credit", deposit: "credit",
};

// Dollar-denominated tool input the model fills; converted to the cents ExtractedStatement above.
const StatementToolInput = z.object({
  lines: z
    .array(
      z.object({
        // Coerce, don't reject: the model very occasionally emits a non-string for a date or
        // description (e.g. a numeric reference as the narrative). Plain z.string() would reject
        // the line and fail the WHOLE chunk's safeParse — surfacing as "layout wasn't recognised"
        // and killing a multi-page statement. So tolerate one odd row instead of sinking the file.
        // Date: a non-string is a glitch (the model is told to emit ISO YYYY-MM-DD or null), and a
        // stringified number like "20250116" would mis-bucket the financial year downstream — so
        // map any non-string to null ("unknown date"), which the whole pipeline already handles.
        // Description is free narrative, so stringify a stray number rather than drop it.
        date: z.preprocess((v) => (typeof v === "string" ? v : null), z.string().nullable()).default(null),
        description: z.preprocess((v) => (v == null ? "" : typeof v === "string" ? v : String(v)), z.string()).default(""),
        amount: z.coerce.number(), // dollars as printed, absolute
        direction: z.preprocess(
          (v) => (typeof v === "string" ? (DIRECTION_WORDS[v.trim().toLowerCase()] ?? v.trim().toLowerCase()) : v),
          z.enum(["debit", "credit"]).catch("debit"),
        ),
        balance: z.coerce.number().nullable().default(null), // running balance in dollars, or null
      }),
    )
    .default([]),
  opening_balance: z.coerce.number().nullable().default(null),
  closing_balance: z.coerce.number().nullable().default(null),
  currency: z.string().default("AUD"),
});

const STATEMENT_TOOL: Anthropic.Tool = {
  name: "record_statement",
  description: "Record EVERY dated money transaction from a bank/credit-card statement, plus the opening and closing balances, so the import can be reconciled.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["lines", "opening_balance", "closing_balance", "currency"],
    properties: {
      opening_balance: { type: ["number", "null"], description: "Opening balance in DOLLARS (start of the statement period) as printed in the summary, or null if not shown." },
      closing_balance: { type: ["number", "null"], description: "Closing balance in DOLLARS (end of the statement period) as printed in the summary, or null if not shown." },
      currency: { type: "string", description: "ISO-4217 currency of the statement (usually AUD)." },
      lines: {
        type: "array",
        description: "Every dated money transaction, in statement order. Do NOT skip, merge or invent rows — completeness matters (it is reconciled against the balances). EXCLUDE rewards/points lines, any 'regular payments' summary list, interest-rate summary rows, and marketing text.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["date", "description", "amount", "direction", "balance"],
          properties: {
            date: { type: ["string", "null"], description: "ISO date YYYY-MM-DD, or null if not shown." },
            description: { type: "string", description: "Transaction description / narrative as printed." },
            amount: { type: "number", description: "Amount in DOLLARS exactly as printed, as a positive number (e.g. 19.28). Never negative." },
            direction: { type: "string", enum: ["debit", "credit"], description: "'debit' = money out (a purchase or charge); 'credit' = money in (a payment or refund, often printed with a trailing minus)." },
            balance: { type: ["number", "null"], description: "Running balance after this line in DOLLARS, or null if the statement has no per-line balance column." },
          },
        },
      },
    },
  },
};

/** Extract a full statement from a PDF (or image) via Claude document input. */
export async function extractStatement(
  llm: LLM,
  bytes: ArrayBuffer,
  mime: string,
  opts: { isLiability?: boolean } = {},
): Promise<ExtractedStatement> {
  // Credit-card / loan statements need extra guidance: payments are printed with a trailing
  // minus, and they carry non-transaction tables (rewards/points, a "regular payments" summary,
  // interest-rate rows) that must NOT be transcribed or they double-count the real lines.
  const liabilityNote = opts.isLiability
    ? " This is a CREDIT-CARD / loan statement: a purchase is direction \"debit\" (it increases the balance owed); a payment or refund is direction \"credit\" (it reduces it)."
    : "";
  const instructions =
    "Transcribe EVERY money transaction from this statement's dated transaction table (across all pages), " +
    "plus the opening and closing balances shown in the statement summary. Rules:\n" +
    "- amount is the value in DOLLARS exactly as printed, as a POSITIVE number (e.g. 19.28) — never negative, never in cents.\n" +
    "- direction: \"debit\" = money out (a purchase or charge); \"credit\" = money in (a payment or refund, often printed with a trailing minus like \"2,500.00-\")." +
    liabilityNote +
    "\n- EXCLUDE everything that is not a dated money transaction: rewards/points lines and summaries, any \"regular payments\" / \"helping you identify your regular payments\" list, interest-rate summary rows, and marketing text. Only transcribe rows that have a date and a dollar amount in the transaction table.\n" +
    "Call record_statement once.";
  let msg: Anthropic.Message;
  try {
    msg = await llm.create({
      model: llm.modelId,
      max_tokens: 8192,
      tools: [STATEMENT_TOOL],
      tool_choice: { type: "tool", name: STATEMENT_TOOL.name },
      messages: [
        {
          role: "user",
          content: [
            receiptBlock(bytes, mime),
            { type: "text", text: instructions },
          ],
        },
      ],
    }, "statement_pdf");
  } catch (e) {
    // Translate Anthropic API failures (PDF too large/unsupported, rate-limit, overload) into
    // a message the upload UI can show, instead of letting the SDK error bubble as a 1101.
    const status = (e as { status?: number }).status;
    throw new Error(`couldn't read this PDF statement${status ? ` (inference error ${status})` : ""} — try a CSV export, or a clearer/smaller PDF`);
  }
  const toolUse = msg.content.find((c): c is Anthropic.ToolUseBlock => c.type === "tool_use" && c.name === STATEMENT_TOOL.name);
  if (!toolUse) throw new Error("couldn't read the transaction table from this PDF — try a CSV export instead");
  const parsed = StatementToolInput.safeParse(toolUse.input);
  if (!parsed.success) {
    // Log WHY so a future mismatch is diagnosable from Workers Logs (don't guess again).
    console.error(`statement schema mismatch: ${JSON.stringify(parsed.error.issues).slice(0, 600)}`);
    throw new Error("couldn't read the transaction table from this PDF — the layout wasn't recognised; try a CSV export instead");
  }
  const d = parsed.data;
  const cents = (n: number) => Math.round(n * 100);
  return {
    lines: d.lines
      .filter((l) => Number.isFinite(l.amount) && l.amount !== 0) // drop $0 "fee saved" rows and any unparseable amount
      .map((l) => ({
        date: l.date,
        description: l.description,
        amount_cents: Math.abs(cents(l.amount)),
        direction: l.direction,
        balance_cents: l.balance != null && Number.isFinite(l.balance) ? cents(l.balance) : null,
      })),
    opening_cents: d.opening_balance != null && Number.isFinite(d.opening_balance) ? cents(d.opening_balance) : null,
    closing_cents: d.closing_balance != null && Number.isFinite(d.closing_balance) ? cents(d.closing_balance) : null,
    currency: d.currency,
  };
}

// ── Statement CSV column mapping (one cheap Claude call per file) ──────────────
const COLUMN_MAP_TOOL: Anthropic.Tool = {
  name: "record_column_map",
  description: "Map a bank/credit-card statement CSV's columns so the rows can be parsed deterministically.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["header_row", "date_col", "description_col", "sign_convention"],
    properties: {
      header_row: { type: "integer", description: "0-based index of the header row. Some banks (CommBank) put account metadata rows ABOVE the header — skip them. Use the first data row's index if there is no header." },
      date_col: { type: "integer", description: "0-based column index of the transaction date." },
      description_col: { type: "integer", description: "0-based column index of the description / narrative." },
      amount_col: { type: ["integer", "null"], description: "0-based index of a SINGLE signed amount column, or null if debit & credit are separate columns." },
      debit_col: { type: ["integer", "null"], description: "0-based index of a separate debit column, or null." },
      credit_col: { type: ["integer", "null"], description: "0-based index of a separate credit column, or null." },
      balance_col: { type: ["integer", "null"], description: "0-based index of the running balance column, or null." },
      sign_convention: { type: "string", enum: ["negative_is_debit", "positive_is_debit", "split"], description: "For a single amount column: is a NEGATIVE number a debit (spend)? Use 'split' when debit/credit are separate columns." },
    },
  },
};

export async function extractColumnMap(llm: LLM, rows: string[][]): Promise<ColumnMap> {
  const sample = rows.slice(0, 6).map((r, i) => `row ${i}: ${JSON.stringify(r)}`).join("\n");
  const msg = await llm.create({
    model: llm.modelId,
    max_tokens: 512,
    tools: [COLUMN_MAP_TOOL],
    tool_choice: { type: "tool", name: COLUMN_MAP_TOOL.name },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Top rows of a bank/credit-card statement CSV (each row is a JSON array of cells). Identify the columns and call record_column_map.\n\n${sample}`,
          },
        ],
      },
    ],
  }, "statement_columns");
  const toolUse = msg.content.find(
    (c): c is Anthropic.ToolUseBlock => c.type === "tool_use" && c.name === COLUMN_MAP_TOOL.name,
  );
  if (!toolUse) throw new Error("model did not return a column map");
  return toolUse.input as ColumnMap;
}

/** Extract + categorise a receipt image/PDF (Claude vision = OCR). */
export async function extractReceipt(
  llm: LLM,
  system: string,
  bytes: ArrayBuffer,
  mime: string,
): Promise<ExtractResult> {
  return runRecordReceipt(
    llm,
    system,
    [receiptBlock(bytes, mime), { type: "text", text: "Extract this receipt and categorise it using the rule pack. Call record_receipt." }],
    "receipt",
  );
}

/**
 * Extract + categorise a receipt that spans MULTIPLE images (e.g. several screenshots
 * or a multi-page PDF) as ONE transaction. All image blocks go into a single tool call so
 * the model combines them into one record.
 */
export async function extractReceipts(
  llm: LLM,
  system: string,
  images: { bytes: ArrayBuffer; mime: string }[],
): Promise<ExtractResult> {
  return runRecordReceipt(
    llm,
    system,
    [
      ...images.map((im) => receiptBlock(im.bytes, im.mime)),
      { type: "text", text: `These ${images.length} images are parts/pages of ONE receipt. Combine them into a single record_receipt call (one merchant, one total).` },
    ],
    "receipt",
  );
}

// ── Batch categorisation of statement lines (one Claude call per ~50 lines) ────
const BATCH_TOOL: Anthropic.Tool = {
  name: "record_batch",
  description: "Categorise EACH statement line in order. Return exactly one result per input line.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        description: "One categorisation per input line. Echo each line's number in `line`.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["line", "bucket", "ato_label", "confidence", "reasoning"],
          properties: {
            line: { type: "integer", description: "The 1-based line number from the input list this categorisation is for." },
            bucket: { type: "string", enum: [...BUCKETS] },
            ato_label: { type: "string" },
            confidence: { type: "number" },
            reasoning: { type: "string", description: "One short clause: why this bucket." },
          },
        },
      },
    },
  },
};

export interface BatchItem {
  line: number | null; // 1-based input line the model says this is for (null if it omitted it)
  bucket: string;      // guaranteed a valid BUCKETS member (invalid ones are dropped)
  ato_label: string;
  confidence: number;
  reasoning: string;
}

/**
 * Validate + sanitise ONE raw batch categorisation from the model. The batch path used to cast the
 * tool output straight to the DB (the receipt path Zod-validates), so a hallucinated bucket could
 * flow into money totals and even be promoted into a permanent user rule (review High #1). We now:
 *  - DROP the item if `bucket` isn't a real BUCKETS member (money-affecting → leave the line
 *    needs_review rather than mis-bucket it),
 *  - sanitise `ato_label` to a safe ledger token (fall back to the bucket name) — label sprawl,
 *  - clamp `confidence` to 0..1 and cap `reasoning`.
 */
function coerceBatchItem(raw: unknown): BatchItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const bucket = typeof r.bucket === "string" ? r.bucket : "";
  if (!isBucket(bucket)) return null; // unknown/hallucinated bucket — drop, don't guess
  const line = typeof r.line === "number" && Number.isInteger(r.line) ? r.line : null;
  const label = normalizeAtoLabel(typeof r.ato_label === "string" ? r.ato_label : null);
  const conf = typeof r.confidence === "number" && Number.isFinite(r.confidence) ? r.confidence : 0;
  const reasoning = typeof r.reasoning === "string" ? r.reasoning.slice(0, 280) : "";
  return {
    line,
    bucket,
    ato_label: (label ?? bucket).slice(0, ATO_LABEL_MAX),
    confidence: Math.max(0, Math.min(1, conf)),
    reasoning,
  };
}

/** Build the message params for one categorisation batch (reused by sync + async/Batch API). */
export function batchParams(
  modelId: string,
  system: string,
  items: { merchant: string; amount_cents: number; date: string | null; direction?: "debit" | "credit" | null }[],
): Anthropic.MessageCreateParamsNonStreaming {
  // Mark each line money OUT/IN so the model picks an expense bucket for debits and an
  // income_* / refund bucket for credits (direction is known from the statement, not guessed).
  const list = items
    .map(
      (it, i) =>
        `${i + 1}. [${it.direction === "credit" ? "IN" : "OUT"}] ${it.merchant} | $${(it.amount_cents / 100).toFixed(2)}${it.date ? ` | ${it.date}` : ""}`,
    )
    .join("\n");
  return {
    model: modelId,
    max_tokens: 4096,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    tools: [BATCH_TOOL],
    tool_choice: { type: "tool", name: BATCH_TOOL.name },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Categorise each of these ${items.length} bank/card statement lines into a bucket + ATO label (one result per line). For each result set \`line\` to the line number shown (1..${items.length}). [OUT] = money out (spend) → an expense bucket; [IN] = money in → an income_* bucket, or 'refund' if it reverses a prior expense. These are descriptions only (no receipt), so prefer 'unknown' when genuinely unclear.\n\n${list}\n\nCall record_batch with exactly ${items.length} items.`,
          },
        ],
      },
    ],
  };
}

/** Pull the categorisation array out of a record_batch message, validated + sanitised. */
export function parseBatchMessage(msg: Anthropic.Message): BatchItem[] {
  const toolUse = msg.content.find((c): c is Anthropic.ToolUseBlock => c.type === "tool_use" && c.name === BATCH_TOOL.name);
  const rawItems = toolUse ? ((toolUse.input as { items?: unknown[] }).items ?? []) : [];
  if (!Array.isArray(rawItems)) return [];
  const out: BatchItem[] = [];
  for (const raw of rawItems) {
    const item = coerceBatchItem(raw);
    if (item) out.push(item);
  }
  return out;
}

/**
 * Match validated batch categorisations back to the input line ids. Prefers the model-echoed
 * 1-based `line` number so a dropped/reordered item mis-assigns at most ITSELF — not the whole
 * tail, as positional matching did (review Medium: "batch results map to lines by array index").
 * Falls back to positional order only when the model omitted line numbers entirely.
 */
export function mapBatchItems<T>(lineIds: T[], items: BatchItem[]): { id: T; item: BatchItem }[] {
  const inRange = (n: number | null): n is number => n != null && n >= 1 && n <= lineIds.length;
  const out: { id: T; item: BatchItem }[] = [];
  const seen = new Set<number>();
  const byLine = (it: BatchItem) => {
    const idx = it.line! - 1;
    if (seen.has(idx)) return; // ignore a duplicate line claim
    seen.add(idx);
    out.push({ id: lineIds[idx]!, item: it });
  };

  if (items.length > 0 && items.every((it) => inRange(it.line))) {
    // Every item carries a valid line → map by it (a dropped/reordered item costs only itself).
    for (const it of items) byLine(it);
    return out;
  }
  // Positional matching is ONLY safe when the model omitted line numbers ENTIRELY (legacy/back-compat)
  // AND returned exactly one item per input line. If ANY item carries a usable line, the model IS
  // using line numbers, so a position-based map would silently mis-assign whenever items are reordered
  // or one is dropped (parseBatchMessage drops invalid-bucket items, so a length match can still hide a
  // reorder). In the mixed/partial case, map only the items that DID carry a valid line and leave the
  // rest needs_review rather than mis-bucket money against the wrong transaction.
  const anyLined = items.some((it) => inRange(it.line));
  if (!anyLined && items.length === lineIds.length) {
    for (let j = 0; j < lineIds.length; j++) out.push({ id: lineIds[j]!, item: items[j]! });
    return out;
  }
  for (const it of items) if (inRange(it.line)) byLine(it);
  return out;
}

/** Categorise many statement lines in one call (synchronous path). One result per line. */
export async function extractBatch(
  llm: LLM,
  system: string,
  items: { merchant: string; amount_cents: number; date: string | null; direction?: "debit" | "credit" | null }[],
): Promise<BatchItem[]> {
  const msg = await llm.create(batchParams(llm.modelId, system, items), "statement_batch");
  return parseBatchMessage(msg);
}

/**
 * Categorise a typed / free-text expense (no image) — same tool + schema as
 * `extractReceipt`, so a typed line still gets a fully-bucketed result. Used by the
 * text-ingest path so typed expenses get a real bucket + ato_label.
 */
export async function extractFromText(
  llm: LLM,
  system: string,
  text: string,
): Promise<ExtractResult> {
  return runRecordReceipt(
    llm,
    system,
    [
      {
        type: "text",
        text:
          `Expense described as free text (no image): "${text}"\n` +
          `Extract and categorise it using the rule pack. Convert the amount to cents; ` +
          `use null for any field not stated (e.g. gst_cents, txn_date). Call record_receipt.`,
      },
    ],
    "text",
  );
}

// ── Smart Inbox: document classification (capture → CLASSIFY → dispatch) ───────
// Single forced tool. Self-documenting enum field names; the result is validated by Zod
// before any routing (schema enforcement guarantees shape, not truth). The confidence gate +
// human-confirm in the DO is the defence-in-depth against the ~2% production misclassification.

export const Classification = z.object({
  doc_type: z.enum(DOC_TYPES),
  confidence: z.number().min(0).max(1),
  doc_date: z.string().nullable().default(null),
  issuer: z.string().nullable().default(null),
  likely_property_hint: z.string().nullable().default(null),
  likely_entity_hint: z.string().nullable().default(null),
  decomposable: z.boolean(),
  reasoning: z.string(),
});
export type Classification = z.infer<typeof Classification>;

const CLASSIFY_TOOL: Anthropic.Tool = {
  name: "classify_document",
  description:
    "Classify a single uploaded document so it can be routed to the right object. Call exactly once.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["doc_type", "confidence", "decomposable", "reasoning"],
    properties: {
      doc_type: { type: "string", enum: [...DOC_TYPES], description: "The document type. Use 'unknown' when genuinely unclear." },
      confidence: { type: "number", description: "0..1 confidence in doc_type." },
      doc_date: { type: ["string", "null"], description: "ISO date (YYYY-MM-DD) shown on the document, or null." },
      issuer: { type: ["string", "null"], description: "Agent/employer/registry name that issued it, or null." },
      likely_property_hint: { type: ["string", "null"], description: "Any property address/label text seen, or null." },
      likely_entity_hint: { type: ["string", "null"], description: "Any company/employer text seen, or null." },
      decomposable: { type: "boolean", description: "True when this document contains MULTIPLE records to split out (agent rental summary, AMMA, multi-line payslip)." },
      reasoning: { type: "string", description: "One sentence: why this classification." },
    },
  },
};

/** Classify a document (image/PDF) into a doc_type for Smart-Inbox routing. */
export async function classifyDocument(llm: LLM, bytes: ArrayBuffer, mime: string): Promise<Classification> {
  const msg = await llm.create(
    {
      model: llm.modelId,
      max_tokens: 512,
      tools: [CLASSIFY_TOOL],
      tool_choice: { type: "tool", name: CLASSIFY_TOOL.name },
      messages: [
        {
          role: "user",
          content: [receiptBlock(bytes, mime), { type: "text", text: "Classify this document. Call classify_document once." }],
        },
      ],
    },
    "classify",
  );
  const toolUse = msg.content.find((c): c is Anthropic.ToolUseBlock => c.type === "tool_use" && c.name === CLASSIFY_TOOL.name);
  if (!toolUse) throw new Error("model did not return a classify_document call");
  return Classification.parse(toolUse.input);
}

// ── Payslip extractor → one salary_payg income row ─────────────────────────────
export const ExtractedPayslip = z.object({
  employer: z.string(),
  pay_date: z.string().nullable().default(null),
  gross_cents: z.number().int(),
  tax_withheld_cents: z.number().int(),
  super_cents: z.number().int().nullable().default(null),
  rfba_cents: z.number().int().nullable().default(null),
  currency: z.string().default("AUD"),
  confidence: z.number().min(0).max(1),
});
export type ExtractedPayslip = z.infer<typeof ExtractedPayslip>;

const PAYSLIP_TOOL: Anthropic.Tool = {
  name: "record_payslip",
  description: "Record a payslip / income statement as one salary income record. Call once.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["employer", "pay_date", "gross_cents", "tax_withheld_cents", "super_cents", "rfba_cents", "currency", "confidence"],
    properties: {
      employer: { type: "string", description: "Employer name as printed." },
      pay_date: { type: ["string", "null"], description: "Pay/period-end date ISO YYYY-MM-DD, or null." },
      gross_cents: { type: "integer", description: "Gross earnings in cents (before tax). Use YTD if this is an income statement / EOFY summary." },
      tax_withheld_cents: { type: "integer", description: "PAYG tax withheld in cents." },
      super_cents: { type: ["integer", "null"], description: "Superannuation in cents, or null." },
      rfba_cents: { type: ["integer", "null"], description: "Reportable Fringe Benefits Amount in cents (e.g. a novated lease), or null." },
      currency: { type: "string", description: "ISO-4217 (usually AUD)." },
      confidence: { type: "number", description: "0..1 confidence." },
    },
  },
};

/** Extract a payslip / income statement → one salary_payg income record. */
export async function extractPayslip(llm: LLM, bytes: ArrayBuffer, mime: string): Promise<ExtractedPayslip> {
  const msg = await llm.create(
    {
      model: llm.modelId,
      max_tokens: 1024,
      tools: [PAYSLIP_TOOL],
      tool_choice: { type: "tool", name: PAYSLIP_TOOL.name },
      messages: [
        { role: "user", content: [receiptBlock(bytes, mime), { type: "text", text: "Extract this payslip / income statement. Call record_payslip once." }] },
      ],
    },
    "payslip",
  );
  const toolUse = msg.content.find((c): c is Anthropic.ToolUseBlock => c.type === "tool_use" && c.name === PAYSLIP_TOOL.name);
  if (!toolUse) throw new Error("model did not return a record_payslip call");
  return ExtractedPayslip.parse(toolUse.input);
}

// ── Income-statement extractor (MULTI-employer myGov "Income statements") → mapped by lib/income-statement ─
// Feature A1 increment 2 (flag income_statement_multi). The ATO "Income statements" page lists EVERY employer
// for the FY; this returns them all so decomposeIncomeStatement can record one FINALISED salary row each +
// capture-only lump sums. The tax-correctness (Total gross AS PRINTED, SG/RESC/RFB not income) is enforced
// both in the tool description here AND in the pure mapper (lib/income-statement.ts mapIncomeStatementToRows).
const EmployerBlock = z.object({
  employer: z.string(),
  employer_abn: z.string().nullable().default(null),
  tax_ready: z.boolean().default(false),
  period_start: z.string().nullable().default(null),
  period_end: z.string().nullable().default(null),
  bms_id: z.string().nullable().default(null),
  total_gross_cents: z.number().int(),
  paygw_cents: z.number().int().default(0),
  leave_detail: z.array(z.object({ type: z.string(), cents: z.number().int() })).default([]),
  lump_sums: z.array(z.object({ type: z.enum(["A", "B", "D", "E", "W"]), cents: z.number().int() })).default([]),
  allowances: z.array(z.object({ label: z.string(), cents: z.number().int() })).default([]),
  resc_cents: z.number().int().default(0),
  rfb_cents: z.number().int().default(0),
  sg_cents: z.number().int().default(0),
  confidence: z.number().min(0).max(1),
});
export const ExtractedIncomeStatement = z.object({ employers: z.array(EmployerBlock) });
export type ExtractedIncomeStatement = z.infer<typeof ExtractedIncomeStatement>;

const INCOME_STATEMENT_TOOL: Anthropic.Tool = {
  name: "record_income_statement",
  description:
    "Record an ATO 'Income statements' page: one entry per employer for the financial year. For EACH employer return the PRINTED 'Total gross amount' as total_gross_cents — do NOT re-sum the base gross plus the leave lines (the total already includes them). PAYGW amount → paygw_cents. Put each 'Lump sum payment A/B/D/E/W' as a separate lump_sums entry (omit $0 ones). tax_ready = true only when the block's Status is 'Tax ready'. The 'Employer superannuation contribution liability' (ordinary SG) is NOT income — put it in sg_cents for reference only. 'Reportable Employer Super Contribution' → resc_cents and 'Reportable fringe benefits - total' → rfb_cents (both reportable, NOT assessable income — never fold into gross). Call once with all employers.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["employers"],
    properties: {
      employers: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["employer", "tax_ready", "total_gross_cents", "paygw_cents", "confidence"],
          properties: {
            employer: { type: "string", description: "Employer name as printed." },
            employer_abn: { type: ["string", "null"], description: "Employer ABN (digits) or null." },
            tax_ready: { type: "boolean", description: "True only when Status is 'Tax ready' (finalised)." },
            period_start: { type: ["string", "null"], description: "Period start ISO YYYY-MM-DD or null." },
            period_end: { type: ["string", "null"], description: "Period end ISO YYYY-MM-DD or null." },
            bms_id: { type: ["string", "null"], description: "BMS ID or null." },
            total_gross_cents: { type: "integer", description: "PRINTED Total gross amount in cents (already includes leave lines — do NOT re-sum)." },
            paygw_cents: { type: "integer", description: "PAYGW amount (tax withheld) in cents." },
            leave_detail: { type: "array", description: "Leave lines for reference (already inside total gross).", items: { type: "object", additionalProperties: false, required: ["type", "cents"], properties: { type: { type: "string" }, cents: { type: "integer" } } } },
            lump_sums: { type: "array", description: "Non-zero Lump sum payments.", items: { type: "object", additionalProperties: false, required: ["type", "cents"], properties: { type: { type: "string", enum: ["A", "B", "D", "E", "W"] }, cents: { type: "integer" } } } },
            allowances: { type: "array", description: "Allowances (reference; not summed into gross).", items: { type: "object", additionalProperties: false, required: ["label", "cents"], properties: { label: { type: "string" }, cents: { type: "integer" } } } },
            resc_cents: { type: "integer", description: "Reportable Employer Super Contribution in cents (NOT income)." },
            rfb_cents: { type: "integer", description: "Reportable fringe benefits total in cents (NOT income)." },
            sg_cents: { type: "integer", description: "Ordinary employer SG liability in cents (reference only, NOT income)." },
            confidence: { type: "number", description: "0..1 confidence for this employer block." },
          },
        },
      },
    },
  },
};

/** Extract a multi-employer ATO income statement → all employer blocks (mapped by lib/income-statement). */
export async function extractIncomeStatement(llm: LLM, bytes: ArrayBuffer, mime: string): Promise<ExtractedIncomeStatement> {
  const msg = await llm.create(
    {
      model: llm.modelId,
      max_tokens: 2048,
      tools: [INCOME_STATEMENT_TOOL],
      tool_choice: { type: "tool", name: INCOME_STATEMENT_TOOL.name },
      messages: [
        { role: "user", content: [receiptBlock(bytes, mime), { type: "text", text: "Extract this ATO income statement. Return every employer. Call record_income_statement once." }] },
      ],
    },
    "income_statement",
  );
  const toolUse = msg.content.find((c): c is Anthropic.ToolUseBlock => c.type === "tool_use" && c.name === INCOME_STATEMENT_TOOL.name);
  if (!toolUse) throw new Error("model did not return a record_income_statement call");
  return ExtractedIncomeStatement.parse(toolUse.input);
}

// ── Notice of Assessment extractor (B1 noa_capture, #71/#304) ────────────────────
// An ATO NOA finalises a lodged year: taxable income, tax assessed, carried-forward losses (net capital
// + ordinary tax losses), HELP/HECS balance, MLS, and any franking refund. We read these as reference
// facts for a confirm-before-write FY close — we NEVER compute a refund/liability from them.
export const ExtractedNoticeOfAssessment = z.object({
  assessed_fy: z.number().int(), // FY start year, e.g. 2024 for the 2024-25 year
  taxable_income_cents: z.number().int().default(0),
  tax_assessed_cents: z.number().int().default(0),
  net_capital_losses_cf_cents: z.number().int().default(0),
  prior_year_tax_losses_cf_cents: z.number().int().default(0),
  opening_depreciation_cents: z.number().int().default(0),
  hecs_balance_cents: z.number().int().nullable().default(null),
  mls_debt_cents: z.number().int().nullable().default(null),
  franking_refund_cents: z.number().int().nullable().default(null),
  confidence: z.number().min(0).max(1),
});
export type ExtractedNoticeOfAssessment = z.infer<typeof ExtractedNoticeOfAssessment>;

const NOTICE_OF_ASSESSMENT_TOOL: Anthropic.Tool = {
  name: "record_notice_of_assessment",
  description:
    "Record an ATO Notice of Assessment (NOA). assessed_fy is the FINANCIAL-YEAR START YEAR of the year being assessed — for the 2024-25 year return 2024. taxable_income_cents = the 'Taxable income' line; tax_assessed_cents = tax assessed / 'Tax on your taxable income'. Carried-forward losses: net_capital_losses_cf_cents = net capital losses carried forward; prior_year_tax_losses_cf_cents = tax (revenue) losses carried forward — return 0 if a line is absent. hecs_balance_cents / mls_debt_cents = HELP-HECS account balance and Medicare levy surcharge if shown, else null. franking_refund_cents = any franking/imputation credit refund, else null. opening_depreciation_cents is almost never on a NOA — return 0 unless explicitly stated. Amounts in cents. Call once.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["assessed_fy", "confidence"],
    properties: {
      assessed_fy: { type: "integer", description: "FY start year of the assessed year (2024 = the 2024-25 year)." },
      taxable_income_cents: { type: "integer", description: "'Taxable income' in cents." },
      tax_assessed_cents: { type: "integer", description: "Tax assessed on taxable income, in cents." },
      net_capital_losses_cf_cents: { type: "integer", description: "Net capital losses carried forward, in cents (0 if none)." },
      prior_year_tax_losses_cf_cents: { type: "integer", description: "Tax (revenue) losses carried forward, in cents (0 if none)." },
      opening_depreciation_cents: { type: "integer", description: "Opening adjustable value if stated (rare on a NOA); else 0." },
      hecs_balance_cents: { type: ["integer", "null"], description: "HELP/HECS account balance in cents, or null." },
      mls_debt_cents: { type: ["integer", "null"], description: "Medicare levy surcharge in cents, or null." },
      franking_refund_cents: { type: ["integer", "null"], description: "Franking/imputation credit refund in cents, or null." },
      confidence: { type: "number", description: "0..1 confidence in the read." },
    },
  },
};

export async function extractNoticeOfAssessment(llm: LLM, bytes: ArrayBuffer, mime: string): Promise<ExtractedNoticeOfAssessment> {
  const msg = await llm.create(
    {
      model: llm.modelId,
      max_tokens: 1024,
      tools: [NOTICE_OF_ASSESSMENT_TOOL],
      tool_choice: { type: "tool", name: NOTICE_OF_ASSESSMENT_TOOL.name },
      messages: [
        { role: "user", content: [receiptBlock(bytes, mime), { type: "text", text: "Extract this ATO Notice of Assessment. Call record_notice_of_assessment once." }] },
      ],
    },
    "notice_of_assessment",
  );
  const toolUse = msg.content.find((c): c is Anthropic.ToolUseBlock => c.type === "tool_use" && c.name === NOTICE_OF_ASSESSMENT_TOOL.name);
  if (!toolUse) throw new Error("model did not return a record_notice_of_assessment call");
  return ExtractedNoticeOfAssessment.parse(toolUse.input);
}

// ── Agent rental summary extractor (DECOMPOSABLE → income + expense lines) ──────
export const ExtractedAgentStatement = z.object({
  agent_name: z.string().nullable().default(null),
  property_hint: z.string().nullable().default(null),
  period_start: z.string().nullable().default(null),
  period_end: z.string().nullable().default(null),
  income_lines: z.array(z.object({ description: z.string(), amount_cents: z.number().int(), date: z.string().nullable().default(null) })).default([]),
  expense_lines: z
    .array(z.object({ description: z.string(), amount_cents: z.number().int(), date: z.string().nullable().default(null), category: z.string().nullable().default(null) }))
    .default([]),
  net_disbursed_cents: z.number().int().nullable().default(null),
  confidence: z.number().min(0).max(1),
});
export type ExtractedAgentStatement = z.infer<typeof ExtractedAgentStatement>;

const AGENT_STATEMENT_TOOL: Anthropic.Tool = {
  name: "record_agent_statement",
  description:
    "Decompose a real-estate agent's rental summary into rent income lines and expense lines (commission, letting fee, repairs, water, council, body corporate). Call once. Completeness matters — it is reconciled (Σrent − Σexpenses = net disbursed).",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["agent_name", "property_hint", "period_start", "period_end", "income_lines", "expense_lines", "net_disbursed_cents", "confidence"],
    properties: {
      agent_name: { type: ["string", "null"], description: "Managing agent name, or null." },
      property_hint: { type: ["string", "null"], description: "Property address/label as printed, or null." },
      period_start: { type: ["string", "null"], description: "Statement period start ISO YYYY-MM-DD, or null." },
      period_end: { type: ["string", "null"], description: "Statement period end ISO YYYY-MM-DD, or null." },
      income_lines: {
        type: "array",
        description: "Rent received lines.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["description", "amount_cents", "date"],
          properties: {
            description: { type: "string" },
            amount_cents: { type: "integer", description: "Rent amount in cents (positive)." },
            date: { type: ["string", "null"], description: "ISO date or null." },
          },
        },
      },
      expense_lines: {
        type: "array",
        description: "Agent-deducted expense lines (commission, letting fee, repairs, water, council, body corporate).",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["description", "amount_cents", "date", "category"],
          properties: {
            description: { type: "string" },
            amount_cents: { type: "integer", description: "Expense amount in cents (positive)." },
            date: { type: ["string", "null"], description: "ISO date or null." },
            category: { type: ["string", "null"], description: "e.g. commission, letting_fee, repairs, water, council, body_corporate, or null." },
          },
        },
      },
      net_disbursed_cents: { type: ["integer", "null"], description: "Net amount disbursed to the owner in cents, or null." },
      confidence: { type: "number", description: "0..1 confidence." },
    },
  },
};

/** Extract + decompose a real-estate agent rental summary. */
export async function extractAgentStatement(llm: LLM, bytes: ArrayBuffer, mime: string): Promise<ExtractedAgentStatement> {
  const msg = await llm.create(
    {
      model: llm.modelId,
      max_tokens: 4096,
      tools: [AGENT_STATEMENT_TOOL],
      tool_choice: { type: "tool", name: AGENT_STATEMENT_TOOL.name },
      messages: [
        { role: "user", content: [receiptBlock(bytes, mime), { type: "text", text: "Decompose this agent rental summary into rent income lines and expense lines. Call record_agent_statement once." }] },
      ],
    },
    "agent_statement",
  );
  const toolUse = msg.content.find((c): c is Anthropic.ToolUseBlock => c.type === "tool_use" && c.name === AGENT_STATEMENT_TOOL.name);
  if (!toolUse) throw new Error("model did not return a record_agent_statement call");
  return ExtractedAgentStatement.parse(toolUse.input);
}

// ── Dividend statement → one dividend income row (with franking credit) ────────
export const ExtractedDividend = z.object({
  payer: z.string().nullable().default(null),
  payment_date: z.string().nullable().default(null),
  franked_cents: z.number().int().default(0),
  unfranked_cents: z.number().int().default(0),
  franking_credit_cents: z.number().int().default(0),
  currency: z.string().default("AUD"),
  confidence: z.number().min(0).max(1),
});
export type ExtractedDividend = z.infer<typeof ExtractedDividend>;

const DIVIDEND_TOOL: Anthropic.Tool = {
  name: "record_dividend",
  description: "Record a dividend / distribution statement as one income record. Call once.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["payer", "payment_date", "franked_cents", "unfranked_cents", "franking_credit_cents", "currency", "confidence"],
    properties: {
      payer: { type: ["string", "null"], description: "Company / fund paying the dividend, or null." },
      payment_date: { type: ["string", "null"], description: "Payment date ISO YYYY-MM-DD, or null." },
      franked_cents: { type: "integer", description: "Franked amount in cents (0 if none)." },
      unfranked_cents: { type: "integer", description: "Unfranked amount in cents (0 if none)." },
      franking_credit_cents: { type: "integer", description: "Franking (imputation) credit in cents (0 if none)." },
      currency: { type: "string", description: "ISO-4217 (usually AUD)." },
      confidence: { type: "number", description: "0..1 confidence." },
    },
  },
};

/** Extract a dividend statement → one dividend income record. */
export async function extractDividend(llm: LLM, bytes: ArrayBuffer, mime: string): Promise<ExtractedDividend> {
  const msg = await llm.create(
    {
      model: llm.modelId,
      max_tokens: 1024,
      tools: [DIVIDEND_TOOL],
      tool_choice: { type: "tool", name: DIVIDEND_TOOL.name },
      messages: [{ role: "user", content: [receiptBlock(bytes, mime), { type: "text", text: "Extract this dividend/distribution statement. Call record_dividend once." }] }],
    },
    "dividend",
  );
  const toolUse = msg.content.find((c): c is Anthropic.ToolUseBlock => c.type === "tool_use" && c.name === DIVIDEND_TOOL.name);
  if (!toolUse) throw new Error("model did not return a record_dividend call");
  return ExtractedDividend.parse(toolUse.input);
}

// ── Private-health EXTRAS claim (HICAPS slip / provider receipt → a benefit-used prefill) ──────────
// Powers "snap a receipt → log a claim" on the Extras page. Distinct from record_receipt: an extras
// claim tracks the BENEFIT the fund paid (what counts against the limit), not the tax-deductible spend.
export const ExtractedHealthClaim = z.object({
  provider_name: z.string().nullable(),
  service_date: z.string().nullable(),
  category_guess: z.enum(EXTRAS_CATEGORIES).nullable().catch(null),
  benefit_paid_cents: z.number().int().nullable(),
  amount_charged_cents: z.number().int().nullable(),
  confidence: z.number().min(0).max(1),
});
export type ExtractedHealthClaim = z.infer<typeof ExtractedHealthClaim>;

const HEALTH_CLAIM_TOOL: Anthropic.Tool = {
  name: "record_health_claim",
  description:
    "Read a private-health EXTRAS receipt or HICAPS slip and record it as one benefit-used claim. Call exactly once.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["provider_name", "service_date", "category_guess", "benefit_paid_cents", "amount_charged_cents", "confidence"],
    properties: {
      provider_name: { type: ["string", "null"], description: "Clinic / provider name as printed, or null." },
      service_date: { type: ["string", "null"], description: "Service date ISO YYYY-MM-DD, or null if not shown." },
      category_guess: {
        type: ["string", "null"],
        enum: [...EXTRAS_CATEGORIES, null],
        description: "Best-match extras benefit category from the allowed list, or null if unclear from the receipt.",
      },
      benefit_paid_cents: {
        type: ["integer", "null"],
        description:
          "The HEALTH-FUND BENEFIT/REBATE paid, in cents — the 'Health Fund' / 'Benefit' / HICAPS rebate line. This is what counts against an extras limit. Null if the receipt does not show a fund rebate.",
      },
      amount_charged_cents: { type: ["integer", "null"], description: "Total fee charged in cents, if shown; else null." },
      confidence: { type: "number", description: "0..1 confidence in the category + amounts." },
    },
  },
};

/** Extract a private-health extras receipt → a benefit-used prefill. Single forced-tool-use call. */
export async function extractHealthClaim(llm: LLM, bytes: ArrayBuffer, mime: string): Promise<ExtractedHealthClaim> {
  const msg = await llm.create(
    {
      model: llm.modelId,
      max_tokens: 512,
      tools: [HEALTH_CLAIM_TOOL],
      tool_choice: { type: "tool", name: HEALTH_CLAIM_TOOL.name },
      messages: [{
        role: "user",
        content: [
          receiptBlock(bytes, mime),
          { type: "text", text: "Read this private-health extras receipt. Prefer the health-fund benefit/rebate amount (what the fund paid) for benefit_paid_cents — that is what counts against an extras limit. Call record_health_claim once." },
        ],
      }],
    },
    "phi_claim",
  );
  const toolUse = msg.content.find((c): c is Anthropic.ToolUseBlock => c.type === "tool_use" && c.name === HEALTH_CLAIM_TOOL.name);
  if (!toolUse) throw new Error("model did not return a record_health_claim call");
  return ExtractedHealthClaim.parse(toolUse.input);
}

// ── Quantity-surveyor depreciation schedule → bulk assets ──────────────────────
export const ExtractedDepreciationSchedule = z.object({
  assets: z
    .array(
      z.object({
        label: z.string(),
        asset_class: z.enum(ASSET_CLASSES),
        cost_cents: z.number().int(),
        acquired_date: z.string(),
        effective_life_years: z.number().nullable().default(null),
        method: z.enum(["diminishing_value", "prime_cost"]).nullable().default(null),
        div43_rate: z.number().nullable().default(null),
        is_second_hand: z.boolean().default(false),
      }),
    )
    .default([]),
  confidence: z.number().min(0).max(1),
});
export type ExtractedDepreciationSchedule = z.infer<typeof ExtractedDepreciationSchedule>;

const DEP_SCHEDULE_TOOL: Anthropic.Tool = {
  name: "record_depreciation_schedule",
  description:
    "Extract every line of a quantity-surveyor depreciation schedule as assets (Div 40 plant + Div 43 capital works). Call once.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["assets", "confidence"],
    properties: {
      assets: {
        type: "array",
        description: "One per schedule line.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["label", "asset_class", "cost_cents", "acquired_date", "effective_life_years", "method", "div43_rate", "is_second_hand"],
          properties: {
            label: { type: "string", description: "Asset/description as printed." },
            asset_class: { type: "string", enum: [...ASSET_CLASSES], description: "div40_plant for plant & equipment; div43_capital_works for the building/structure." },
            cost_cents: { type: "integer", description: "Cost / construction expenditure in cents." },
            acquired_date: { type: "string", description: "Acquisition / start date ISO YYYY-MM-DD." },
            effective_life_years: { type: ["number", "null"], description: "Div 40 effective life in years, or null for Div 43." },
            method: { type: ["string", "null"], enum: ["diminishing_value", "prime_cost", null], description: "Div 40 method, or null for Div 43." },
            div43_rate: { type: ["number", "null"], description: "Div 43 rate 0.025 or 0.04, or null for Div 40." },
            is_second_hand: { type: "boolean", description: "True if previously-used second-hand residential plant." },
          },
        },
      },
      confidence: { type: "number", description: "0..1 confidence." },
    },
  },
};

/** Parse a QS depreciation schedule (PDF) into a list of assets to bulk-create. */
export async function extractDepreciationSchedule(llm: LLM, bytes: ArrayBuffer, mime: string): Promise<ExtractedDepreciationSchedule> {
  const msg = await llm.create(
    {
      model: llm.modelId,
      max_tokens: 8192,
      tools: [DEP_SCHEDULE_TOOL],
      tool_choice: { type: "tool", name: DEP_SCHEDULE_TOOL.name },
      messages: [
        { role: "user", content: [receiptBlock(bytes, mime), { type: "text", text: "Extract every asset line from this depreciation schedule. Call record_depreciation_schedule once." }] },
      ],
    },
    "depreciation_schedule",
  );
  const toolUse = msg.content.find((c): c is Anthropic.ToolUseBlock => c.type === "tool_use" && c.name === DEP_SCHEDULE_TOOL.name);
  if (!toolUse) throw new Error("model did not return a record_depreciation_schedule call");
  return ExtractedDepreciationSchedule.parse(toolUse.input);
}

// ── Onboarding: free-text "tell me about yourself" → structured situation draft ──
// The wizard turns this draft into entities/properties/rules the user then CONFIRMS —
// nothing here is persisted directly. Shapes mirror the addEntity/addProperty/addRule
// request bodies so the UI can submit them verbatim after confirmation.
export const SituationDraft = z.object({
  entities: z
    .array(
      z.object({
        kind: z.enum(ENTITY_KINDS),
        name: z.string().nullable().default(null),
        detail: z
          .object({
            abn: z.string().nullable().optional(),
            gst_registered: z.boolean().nullable().optional(),
            employer: z.string().nullable().optional(),
            vehicle: z.string().nullable().optional(),
            provider: z.string().nullable().optional(),
          })
          .default({}),
      }),
    )
    .default([]),
  properties: z
    .array(
      z.object({
        label: z.string(),
        address: z.string().nullable().default(null),
        status: z.enum(PROPERTY_STATUSES).default("rented"),
        ownership_pct: z.number().nullable().default(null),
      }),
    )
    .default([]),
  rules: z
    .array(
      z.object({
        pattern: z.string(),
        bucket: z.enum(BUCKETS),
        ato_label: z.string(),
      }),
    )
    .default([]),
});
export type SituationDraft = z.infer<typeof SituationDraft>;

const SITUATION_TOOL: Anthropic.Tool = {
  name: "record_situation",
  description:
    "Record the user's tax situation as structured entities, properties and (optionally) categorisation rules. " +
    "Call exactly once. NEVER invent data the user didn't state — leave ABN/address/ownership null when unstated.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["entities", "properties", "rules"],
    properties: {
      entities: {
        type: "array",
        description: "Tax entities the user mentioned (company, PAYG employment, novated lease, etc.). Empty array if none.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "name", "detail"],
          properties: {
            kind: { type: "string", enum: [...ENTITY_KINDS] },
            name: { type: ["string", "null"], description: "Company/trust name, or employer name for employment, or a label for a lease." },
            detail: {
              type: "object",
              additionalProperties: false,
              properties: {
                abn: { type: ["string", "null"], description: "11-digit ABN if stated; else null. Do not guess." },
                gst_registered: { type: ["boolean", "null"], description: "True only if the user says GST-registered." },
                employer: { type: ["string", "null"], description: "Employer name for kind=employment." },
                vehicle: { type: ["string", "null"], description: "Vehicle for kind=novated_lease." },
                provider: { type: ["string", "null"], description: "Lease provider for kind=novated_lease." },
              },
            },
          },
        },
      },
      properties: {
        type: "array",
        description: "Investment/owned properties the user mentioned. Empty array if none.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["label", "address", "status", "ownership_pct"],
          properties: {
            label: { type: "string", description: "Short label, e.g. 'Rental 1' or a suburb if no name given." },
            address: { type: ["string", "null"], description: "Full address if stated; else null." },
            status: { type: "string", enum: [...PROPERTY_STATUSES] },
            ownership_pct: { type: ["number", "null"], description: "User's ownership share 1-100 if stated; else null." },
          },
        },
      },
      rules: {
        type: "array",
        description: "Optional obvious merchant→bucket rules the user implied (e.g. 'Ray White is my rental agent'). Empty array if none.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["pattern", "bucket", "ato_label"],
          properties: {
            pattern: { type: "string", description: "Merchant-contains substring." },
            bucket: { type: "string", enum: [...BUCKETS] },
            ato_label: { type: "string" },
          },
        },
      },
    },
  },
};

const SITUATION_SYSTEM =
  "You are an onboarding assistant for an Australian tax-categorisation app. The user describes their work and " +
  "property situation in free text. Extract it into structured entities, properties and (optionally) rules by " +
  "calling record_situation exactly once. Only record facts the user actually stated — never fabricate an ABN, " +
  "address, GST status or ownership percentage. The user will review and confirm everything before it is saved.";

/**
 * Best-effort extraction of a tax situation from free text, for the onboarding wizard's
 * conversational front door. Returns a DRAFT — the caller must have the user confirm it
 * before persisting. Metered under the "onboarding" feature. Forced tool-use (no prose).
 */
export async function extractSituationDraft(llm: LLM, message: string): Promise<SituationDraft> {
  const msg = await llm.create(
    {
      model: llm.modelId,
      max_tokens: 1024,
      system: [{ type: "text", text: SITUATION_SYSTEM, cache_control: { type: "ephemeral" } }],
      tools: [SITUATION_TOOL],
      tool_choice: { type: "tool", name: SITUATION_TOOL.name },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `The user described their situation:\n"${message}"\n\nExtract it and call record_situation. Leave any field the user did not state as null.`,
            },
          ],
        },
      ],
    },
    "onboarding",
  );

  const toolUse = msg.content.find(
    (c): c is Anthropic.ToolUseBlock => c.type === "tool_use" && c.name === SITUATION_TOOL.name,
  );
  if (!toolUse) throw new Error("model did not return a record_situation tool call");
  return SituationDraft.parse(toolUse.input);
}

// ── "Find My Claims" — AI gap-fill for occupations with no authored rule ────────────────────────
// The deterministic sweep (reviewClaims) covers authored occupations. Where the tenant's occupation
// has NO scope_type='occupation' rule, this drafts CANDIDATE rules from ATO general guidance for the
// user to CONFIRM — the LLM never asserts a deduction. Every candidate is GENERAL-INFO, carries no $
// figure, and is forced to defer_to_agent=1 server-side (the model is told not to emit that field).

// A single drafted candidate rule. defer_to_agent is DELIBERATELY absent from the model schema — the
// DO forces it to 1 on every row before anything is persisted (rules-first: the model never decides
// deductibility). scope_type is pinned to 'occupation' so a draft can only ever broaden occupation cover.
export const OccupationRulesDraft = z.object({
  rules: z
    .array(
      z.object({
        scope_type: z.literal("occupation"),
        scope_value: z.string(),
        merchant_hint: z.string().nullable().default(null),
        ato_label: z.string().nullable().default(null),
        claim_type: z.enum(CLAIM_TYPES),
        general_info_note: z.string(),
      }),
    )
    .default([]),
});
export type OccupationRulesDraft = z.infer<typeof OccupationRulesDraft>;

const OCCUPATION_RULES_TOOL: Anthropic.Tool = {
  name: "draft_occupation_rules",
  description:
    "Draft CANDIDATE deduction-category rules for an Australian occupation, for the user to confirm. " +
    "Call exactly once. Output candidates only — NEVER assert a dollar amount, NEVER guarantee " +
    "deductibility. The user reviews and confirms every rule before it is used.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["rules"],
    properties: {
      rules: {
        type: "array",
        description: "Candidate occupation deduction categories. Empty array if you can't list any.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["scope_type", "scope_value", "merchant_hint", "ato_label", "claim_type", "general_info_note"],
          properties: {
            scope_type: { type: "string", enum: ["occupation"], description: "Always 'occupation'." },
            scope_value: { type: "string", description: "The occupation key these rules apply to (echo the one given)." },
            merchant_hint: { type: ["string", "null"], description: "Optional comma-separated merchant substrings, or null." },
            ato_label: { type: ["string", "null"], description: "ATO deduction label (e.g. 'D5 Other work-related expenses'), or null." },
            claim_type: { type: "string", enum: [...CLAIM_TYPES], description: "How the claim is treated; use 'immediate' for ordinary work expenses." },
            general_info_note: { type: "string", description: "One GENERAL-INFO sentence describing the category. No dollar figures. No guarantee of deductibility." },
          },
        },
      },
    },
  },
};

function occupationRulesSystem(occupation: string): string {
  return (
    `You list the COMMON, ATO-published, GENERAL-INFO deduction categories that an Australian ${occupation} ` +
    "may be able to claim. Call draft_occupation_rules exactly once with candidate rules only. " +
    "NEVER assert or imply a dollar amount, and NEVER guarantee that anything is deductible — these are " +
    "candidates the user must confirm with a registered tax agent before relying on them. " +
    "Keep each general_info_note to one plain sentence describing the category (e.g. 'work-related " +
    "clothing and laundry for compulsory uniforms'). Output nothing the ATO would not publish as general guidance."
  );
}

/**
 * Draft candidate occupation deduction rules for the "Find My Claims" gap-fill step. Returns a DRAFT —
 * the DO forces defer_to_agent=1 on every row and the user confirms before anything is persisted.
 * Forced tool-use (no prose), ephemeral-cached system prompt, metered under "claim_review".
 */
export async function extractOccupationRules(llm: LLM, occupation: string): Promise<OccupationRulesDraft> {
  const msg = await llm.create(
    {
      model: llm.modelId,
      max_tokens: 1024,
      system: [{ type: "text", text: occupationRulesSystem(occupation), cache_control: { type: "ephemeral" } }],
      tools: [OCCUPATION_RULES_TOOL],
      tool_choice: { type: "tool", name: OCCUPATION_RULES_TOOL.name },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Occupation: "${occupation}". List the common ATO deduction categories for this occupation and call draft_occupation_rules. Echo "${occupation}" as scope_value on every rule.`,
            },
          ],
        },
      ],
    },
    "claim_review",
  );

  const toolUse = msg.content.find(
    (c): c is Anthropic.ToolUseBlock => c.type === "tool_use" && c.name === OCCUPATION_RULES_TOOL.name,
  );
  if (!toolUse) throw new Error("model did not return a draft_occupation_rules tool call");
  return OccupationRulesDraft.parse(toolUse.input);
}

// ── "Guide me" — personalised in-app walkthrough (forced tool-use → a clean steps array) ─────────
const GUIDE_TOOL: Anthropic.Tool = {
  name: "give_guide",
  description: "Return a short personalised walkthrough for the user's current screen: a one-line headline + 3–6 concrete steps grounded in their data. Call exactly once.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["headline", "steps"],
    properties: {
      headline: { type: "string", description: "One short, encouraging line." },
      steps: { type: "array", items: { type: "string" }, description: "3–6 short, concrete next steps tailored to THIS user's numbers." },
    },
  },
};

export interface GuideResult {
  headline: string;
  steps: string[];
}

// Phase 2 (flag chat_nav): the routes the chat agent may propose navigating to. An ENUM in the tool
// schema is the first allowlist (the model literally cannot emit an off-list route); chatTurn also
// re-checks server-side. Gated, specialised, or role-locked routes (/admin, /partner, /onboarding,
// /quickbooks, /txn/:id) are deliberately excluded.
export const ALLOWED_NAV_ROUTES = [
  "/dashboard", "/inbox", "/transactions", "/income", "/assets", "/documents",
  "/accounts", "/reconcile", "/reports", "/savings", "/review", "/filing", "/settings", "/glossary",
] as const;
export type NavRoute = (typeof ALLOWED_NAV_ROUTES)[number];

// Shared `navigate` property — added to both answer tools so the schema is byte-stable; the model is
// only INSTRUCTED to use it when chat_nav is on (buildAskSystem), and chatTurn drops it when off, so
// flag OFF ⇒ no navigate in the output ⇒ byte-identical.
const NAVIGATE_PROP = {
  type: "object",
  additionalProperties: false,
  required: ["route", "reason"],
  description: "ONLY when the user clearly wants to GO to a screen ('take me to my properties', 'show my transactions'). Renders as a 'Take me to …' button — never a silent jump. Omit for everything else.",
  properties: {
    route: { type: "string", enum: ALLOWED_NAV_ROUTES as unknown as string[], description: "The screen to open." },
    reason: { type: "string", description: "Short human label for the button target, e.g. 'your transactions'." },
  },
} as const;

// Phase 3 (flag ask_actions_v2): the chat agent may PROPOSE creating/editing one of the four core
// setup records. The user confirms a card; execution routes through the audited DO path
// (aiWriteEntity → ai_edits + audit_log), never autonomously. `fields` is a flat allowlist (the union
// of the four entities' editable fields) so the model can only set known columns; the server
// re-allowlists per kind before applying. Edits carry entity_id.
export const ENTITY_ACTION_KINDS = [
  "create_person", "edit_person", "create_property", "edit_property",
  "create_entity", "edit_entity", "create_rule",
] as const;
export type EntityActionKind = (typeof ENTITY_ACTION_KINDS)[number];
export interface EntityAction {
  kind: EntityActionKind;
  title: string;
  rationale: string;
  entity_id?: string;
  fields: Record<string, unknown>;
}
const ENTITY_ACTIONS_PROP = {
  type: "array",
  maxItems: 3,
  description: "ONLY when the user clearly asks to ADD or CHANGE a setup record from their own words (e.g. 'I rented out 12 Smith St from August', 'add my company ACME Pty Ltd'). Up to 3 changes the user will CONFIRM before anything is written. Edits must include entity_id (an id from the situation above).",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "title", "rationale", "fields"],
    properties: {
      kind: { type: "string", enum: [...ENTITY_ACTION_KINDS] },
      title: { type: "string", description: "Short human label, e.g. 'Add rental: 12 Smith St'." },
      rationale: { type: "string", description: "One line grounded in the user's words." },
      entity_id: { type: "string", description: "Edits only: the id of the record to change (from the situation)." },
      fields: {
        type: "object",
        additionalProperties: false,
        description: "The values to set. Only include fields you have a value for.",
        properties: {
          display_name: { type: "string" }, role: { type: "string" }, occupation: { type: "string" }, tax_residency: { type: "string" }, tfn_last4: { type: "string" },
          label: { type: "string" }, address: { type: "string" }, status: { type: "string", description: "rented | vacant | owner_occupied" }, use_status: { type: "string" }, ownership_pct: { type: "number" }, acquired_date: { type: "string" }, notes: { type: "string" },
          kind: { type: "string", description: "entity kind: employment | company | novated_lease" }, name: { type: "string" }, detail: { type: "string" },
          pattern: { type: "string" }, bucket: { type: "string" }, ato_label: { type: "string" }, property_id: { type: "string" },
        },
      },
    },
  },
} as const;

const ANSWER_TOOL: Anthropic.Tool = {
  name: "give_answer",
  description: "Answer the user's question about their OWN tax records: a direct answer grounded only in their data, plus caveats, related screens, and optionally a categorisation rule to remember. Call exactly once.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["answer"],
    properties: {
      answer: { type: "string", description: "A direct, plain-language answer grounded ONLY in the user's data. General information — never advice, a refund/tax-payable figure, or tax rates." },
      caveats: { type: "array", items: { type: "string" }, description: "0–4 short caveats: what to confirm with a registered tax agent, or what's missing from their data." },
      see_also: { type: "array", items: { type: "string" }, description: "0–4 app screens/actions that help (e.g. 'Assets — add the laptop to start depreciating it')." },
      suggested_rule: {
        type: "object",
        additionalProperties: false,
        description: "ONLY when the user clearly wants a repeating merchant always categorised a certain way. A DEBIT spend category only (never income/refund).",
        properties: {
          pattern: { type: "string", description: "Merchant text to match (e.g. 'Adobe')." },
          bucket: { type: "string", description: "A spend bucket: payg | company | property_rented | property_vacant | asset." },
          ato_label: { type: "string", description: "Optional ATO label / deduction category." },
        },
      },
      navigate: NAVIGATE_PROP,
      entity_actions: ENTITY_ACTIONS_PROP,
    },
  },
};

// ── Ask Quillo C3 (flag ask_actions): model-PROPOSED one-click fixes ──────────
// The model references transactions by the short T-code aliases in the prompt digest; the server
// resolves aliases → real ids via the per-turn map, so a hallucinated code resolves to nothing and the
// model never sees (or can name) a real transaction id. Proposals are SUGGESTIONS — the UI renders a
// confirm card and the user's click calls the EXISTING audited write endpoint. Never autonomous.

// The deductibility states a proposal may carry — a SUBSET of taxonomy's DEDUCTIBILITY_STATES:
// suggestion/undetermined states are pointless to propose, and likely_deductible would imply assurance
// the model must not give. confirmed_deductible is allowed but the prompt gates it hard (user must have
// explicitly said the expense is work-related) and the user still confirms in the UI.
export const PROPOSABLE_DEDUCTIBILITY_STATES = ["confirmed_deductible", "confirmed_not", "likely_not", "needs_apportionment"] as const;
export type ProposableDeductibility = (typeof PROPOSABLE_DEDUCTIBILITY_STATES)[number];

export type ProposedAction =
  | { kind: "set_deductibility"; title: string; rationale: string; txn_ids: string[]; state: ProposableDeductibility; deductible_amount_cents?: number }
  | { kind: "recategorise"; title: string; rationale: string; txn_ids: string[]; bucket: string; ato_label?: string; property_id?: string }
  | { kind: "add_rule"; title: string; rationale: string; pattern: string; bucket: string; ato_label?: string; property_id?: string };

export interface AnswerResult {
  answer: string;
  caveats: string[];
  see_also: string[];
  suggested_rule?: { pattern: string; bucket: string; ato_label?: string };
  proposed_actions?: ProposedAction[];
  navigate?: { route: NavRoute; reason: string };
  entity_actions?: EntityAction[];
}

// Per-entity field allowlists — the server-side second guard (the tool schema is the first). A
// proposal's `fields` are filtered to these before anything reaches the audited write path, so a
// model (or a tampered client) can't set a column outside the editable set for that kind.
const ENTITY_ACTION_SPECS: Record<EntityActionKind, { entity: "person" | "property" | "entity" | "rule"; op: "create" | "update"; fields: readonly string[] }> = {
  create_person: { entity: "person", op: "create", fields: ["display_name", "role", "occupation", "tax_residency", "tfn_last4"] },
  edit_person: { entity: "person", op: "update", fields: ["display_name", "role", "occupation", "tax_residency", "tfn_last4"] },
  create_property: { entity: "property", op: "create", fields: ["label", "address", "status", "use_status", "ownership_pct", "acquired_date", "notes"] },
  edit_property: { entity: "property", op: "update", fields: ["label", "address", "status", "use_status", "ownership_pct", "acquired_date", "notes"] },
  create_entity: { entity: "entity", op: "create", fields: ["kind", "name", "detail"] },
  edit_entity: { entity: "entity", op: "update", fields: ["kind", "name", "detail"] },
  create_rule: { entity: "rule", op: "create", fields: ["pattern", "bucket", "ato_label", "property_id"] },
};

/** Validate a model `entity_actions` array: known kind, edits carry entity_id, fields allowlisted per
 *  kind, required create field present. Returns only well-formed proposals (≤3) — never throws. */
export function validateEntityActions(raw: unknown): EntityAction[] {
  if (!Array.isArray(raw)) return [];
  const out: EntityAction[] = [];
  for (const a of raw.slice(0, 3)) {
    if (!a || typeof a !== "object") continue;
    const o = a as Record<string, unknown>;
    const kind = o.kind as EntityActionKind;
    const spec = ENTITY_ACTION_SPECS[kind];
    if (!spec) continue;
    if (spec.op === "update" && (typeof o.entity_id !== "string" || !o.entity_id)) continue;
    const rawFields = (o.fields ?? {}) as Record<string, unknown>;
    const fields: Record<string, unknown> = {};
    for (const f of spec.fields) {
      const v = rawFields[f];
      if (v !== undefined && v !== null && v !== "") fields[f] = v;
    }
    // A create must carry its one required identifying field, else it's a NOT-NULL waiting to happen.
    const requiredCreate: Record<string, string> = { person: "display_name", property: "label", entity: "kind", rule: "pattern" };
    const reqField = requiredCreate[spec.entity];
    if (spec.op === "create" && (!reqField || !fields[reqField])) continue;
    if (!Object.keys(fields).length) continue;
    out.push({
      kind,
      title: typeof o.title === "string" ? o.title.slice(0, 120) : kind,
      rationale: typeof o.rationale === "string" ? o.rationale.slice(0, 200) : "",
      ...(spec.op === "update" ? { entity_id: o.entity_id as string } : {}),
      fields,
    });
  }
  return out;
}

/** Resolve an EntityAction kind to the audited-write spec (entity kind + op). Used by the apply path. */
export function entityActionSpec(kind: string): { entity: "person" | "property" | "entity" | "rule"; op: "create" | "update"; fields: readonly string[] } | undefined {
  return ENTITY_ACTION_SPECS[kind as EntityActionKind];
}

const CREDIT_OR_UNKNOWN_BUCKETS = new Set(["income_business", "income_property", "income_personal", "refund", "unknown"]);

export const MAX_PROPOSALS_PER_TURN = 3;
export const MAX_TXN_REFS_PER_PROPOSAL = 50;

/**
 * Validate + resolve the model's raw proposed_actions (pure — unit-tested in check-units). Drops
 * anything that can't be executed exactly as described: unknown kinds, T-codes not in this turn's
 * digest, credit/unknown buckets, non-proposable states. Refs are DEDUPED first, then an action with
 * more than the ref cap of DISTINCT targets is dropped WHOLE (truncating it would silently apply a
 * different change than the title describes).
 */
export function validateProposedActions(raw: unknown, aliasToId: Map<string, DigestRef>, validPropertyIds?: Set<string>): ProposedAction[] {
  if (!Array.isArray(raw)) return [];
  const out: ProposedAction[] = [];
  for (const item of raw.slice(0, MAX_PROPOSALS_PER_TURN)) {
    const a = item as { kind?: unknown; title?: unknown; rationale?: unknown; txn_refs?: unknown; state?: unknown; deductible_amount_cents?: unknown; bucket?: unknown; ato_label?: unknown; pattern?: unknown; property_id?: unknown };
    if (typeof a.title !== "string" || !a.title.trim() || typeof a.rationale !== "string" || !a.rationale.trim()) continue;
    const title = a.title.trim().slice(0, 60);
    const rationale = a.rationale.trim().slice(0, 200);
    const atoLabel = typeof a.ato_label === "string" && a.ato_label.trim() ? a.ato_label.trim().slice(0, 60) : undefined;
    // A property_id is honoured ONLY for a property bucket AND only when it's one the tenant owns —
    // otherwise dropped (the action still applies, just without an attribution). Guards a hallucinated
    // or cross-tenant id from ever reaching the write path.
    const propertyIdFor = (bucket: string): string | undefined =>
      typeof a.property_id === "string" && isPropertyBucket(bucket) && validPropertyIds?.has(a.property_id) ? a.property_id : undefined;
    const resolveRefs = (): DigestRef[] | null => {
      if (!Array.isArray(a.txn_refs)) return null;
      const seen = new Map<string, DigestRef>();
      for (const r of a.txn_refs) {
        if (typeof r !== "string") continue;
        const ref = aliasToId.get(r.trim());
        if (ref) seen.set(ref.id, ref); // unknown alias (incl. one sliced from the digest text) resolves to nothing
      }
      if (seen.size === 0 || seen.size > MAX_TXN_REFS_PER_PROPOSAL) return null; // over cap ⇒ drop whole action
      return [...seen.values()];
    };
    const validBucket = typeof a.bucket === "string" && isBucket(a.bucket) && !CREDIT_OR_UNKNOWN_BUCKETS.has(a.bucket);
    if (a.kind === "set_deductibility") {
      const refs = resolveRefs();
      if (!refs) continue;
      if (typeof a.state !== "string" || !(PROPOSABLE_DEDUCTIBILITY_STATES as readonly string[]).includes(a.state)) continue;
      const state = a.state as ProposableDeductibility;
      // An apportioned amount is only meaningful on a SINGLE confirmed claim: setDeductibility stamps
      // the SAME deductible_amount_cents on every txn in the list, so a multi-txn amount would
      // multiply the claim. It must also not exceed that transaction's gross. Otherwise strip it —
      // NULL falls back to the full amount, the standard behaviour.
      const amt =
        state === "confirmed_deductible" && refs.length === 1 &&
        typeof a.deductible_amount_cents === "number" && Number.isInteger(a.deductible_amount_cents) &&
        a.deductible_amount_cents > 0 && a.deductible_amount_cents <= refs[0]!.amount_cents
          ? a.deductible_amount_cents
          : undefined;
      out.push({ kind: "set_deductibility", title, rationale, txn_ids: refs.map((r) => r.id), state, ...(amt != null ? { deductible_amount_cents: amt } : {}) });
    } else if (a.kind === "recategorise") {
      const refs = resolveRefs();
      if (!refs || !validBucket) continue;
      const propertyId = propertyIdFor(a.bucket as string);
      out.push({ kind: "recategorise", title, rationale, txn_ids: refs.map((r) => r.id), bucket: a.bucket as string, ...(atoLabel ? { ato_label: atoLabel } : {}), ...(propertyId ? { property_id: propertyId } : {}) });
    } else if (a.kind === "add_rule") {
      if (typeof a.pattern !== "string" || !a.pattern.trim() || !validBucket) continue;
      const propertyId = propertyIdFor(a.bucket as string);
      out.push({ kind: "add_rule", title, rationale, pattern: a.pattern.trim().slice(0, 60), bucket: a.bucket as string, ...(atoLabel ? { ato_label: atoLabel } : {}), ...(propertyId ? { property_id: propertyId } : {}) });
    }
  }
  return out;
}

// The with-actions variant of ANSWER_TOOL (flag ask_actions). ANSWER_TOOL itself is untouched so the
// flag-off request is byte-identical (prompt-cache keys included). suggested_rule is REMOVED here —
// rules arrive as add_rule proposed actions, one consistent confirm-card channel for the UI.
const ANSWER_TOOL_WITH_ACTIONS: Anthropic.Tool = {
  name: "give_answer",
  description: ANSWER_TOOL.description,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["answer"],
    properties: {
      answer: (ANSWER_TOOL.input_schema as { properties: Record<string, unknown> }).properties.answer,
      caveats: (ANSWER_TOOL.input_schema as { properties: Record<string, unknown> }).properties.caveats,
      see_also: (ANSWER_TOOL.input_schema as { properties: Record<string, unknown> }).properties.see_also,
      proposed_actions: {
        type: "array",
        maxItems: MAX_PROPOSALS_PER_TURN,
        description: "ONLY when the user asks to fix/update their records: up to 3 one-click fixes the user will confirm. Reference transactions ONLY by the T-codes in the digest.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "title", "rationale"],
          properties: {
            kind: { type: "string", enum: ["set_deductibility", "recategorise", "add_rule"] },
            title: { type: "string", description: "Short human label, e.g. 'Mark 14 Uber rides not deductible'." },
            rationale: { type: "string", description: "One line: why, grounded in the user's words and data." },
            txn_refs: { type: "array", items: { type: "string" }, maxItems: MAX_TXN_REFS_PER_PROPOSAL, description: "T-codes from the digest (set_deductibility / recategorise only)." },
            state: { type: "string", enum: [...PROPOSABLE_DEDUCTIBILITY_STATES], description: "set_deductibility only. confirmed_deductible ONLY when the user explicitly said it's work-related." },
            deductible_amount_cents: { type: "integer", description: "Optional partial claim, only with confirmed_deductible." },
            bucket: { type: "string", description: "Debit spend bucket (recategorise / add_rule): payg | company | property_rented | property_vacant | asset." },
            ato_label: { type: "string", description: "Optional ATO label / deduction category." },
            property_id: { type: "string", description: "Optional, recategorise / add_rule with a property_rented or property_vacant bucket ONLY: the id of one of the user's KNOWN properties to attribute the expense to. Never invent an id." },
            pattern: { type: "string", description: "add_rule only: merchant text to match (e.g. 'Adobe')." },
          },
        },
      },
      navigate: NAVIGATE_PROP,
      entity_actions: ENTITY_ACTIONS_PROP,
    },
  },
};

/** One metered Haiku call → a grounded answer to a question about the user's own ledger, with prior
 * turns as context (single-turn callers pass a one-element messages array).
 * C3 (`actions` set, flag ask_actions): the with-actions tool variant + a higher output cap (three
 * proposals × fifty T-codes plus prose doesn't fit in 700), proposals validated/resolved against this
 * turn's alias map. `actions` ABSENT ⇒ the pre-C3 request byte-for-byte. */
export async function extractAnswer(
  llm: LLM,
  system: string,
  messages: { role: "user" | "assistant"; content: string }[],
  actions?: { aliasToId: Map<string, DigestRef>; propertyIds?: Set<string> },
  nav?: boolean,
  entityActions?: boolean,
): Promise<AnswerResult> {
  const msg = await llm.create(
    {
      model: llm.modelId,
      max_tokens: actions ? 1100 : 700,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      tools: [actions ? ANSWER_TOOL_WITH_ACTIONS : ANSWER_TOOL],
      tool_choice: { type: "tool", name: ANSWER_TOOL.name },
      messages: messages.map((m) => ({ role: m.role, content: [{ type: "text" as const, text: m.content }] })),
    },
    "ask",
  );
  const toolUse = msg.content.find((c): c is Anthropic.ToolUseBlock => c.type === "tool_use" && c.name === ANSWER_TOOL.name);
  if (!toolUse) throw new Error("model did not return a give_answer tool call");
  const input = toolUse.input as { answer?: unknown; caveats?: unknown; see_also?: unknown; suggested_rule?: unknown; proposed_actions?: unknown; navigate?: unknown; entity_actions?: unknown };
  // Phase 3: validated entity-write proposals (only when ask_actions_v2 is on). Off ⇒ never returned.
  const entity_actions = entityActions ? validateEntityActions(input.entity_actions) : [];
  const withEntityActions = entity_actions.length ? { entity_actions } : {};
  const answer = typeof input.answer === "string" && input.answer.trim() ? input.answer.trim() : "I couldn't answer that from your records.";
  const strList = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim().length > 0).slice(0, 4) : []);
  // Phase 2 (nav): only surface a navigation when chat_nav is on AND the route is on the allowlist —
  // a second guard behind the schema enum. Off ⇒ navigate is never returned ⇒ byte-identical.
  let navigate: AnswerResult["navigate"];
  if (nav) {
    const nv = input.navigate as { route?: unknown; reason?: unknown } | undefined;
    if (nv && typeof nv.route === "string" && (ALLOWED_NAV_ROUTES as readonly string[]).includes(nv.route)) {
      navigate = { route: nv.route as NavRoute, reason: typeof nv.reason === "string" ? nv.reason.trim().slice(0, 60) : "" };
    }
  }
  // Only surface a suggested rule for a valid DEBIT spend bucket — never an income/refund re-bucket.
  let suggested_rule: AnswerResult["suggested_rule"];
  const sr = input.suggested_rule as { pattern?: unknown; bucket?: unknown; ato_label?: unknown } | undefined;
  if (sr && typeof sr.pattern === "string" && sr.pattern.trim() && typeof sr.bucket === "string" && isBucket(sr.bucket) && !CREDIT_OR_UNKNOWN_BUCKETS.has(sr.bucket)) {
    suggested_rule = { pattern: sr.pattern.trim().slice(0, 60), bucket: sr.bucket, ato_label: typeof sr.ato_label === "string" ? sr.ato_label.trim().slice(0, 60) : undefined };
  }
  if (!actions) return { answer, caveats: strList(input.caveats), see_also: strList(input.see_also), suggested_rule, navigate, ...withEntityActions };
  // Actions mode: one confirm-card channel. A stray suggested_rule (the schema dropped it, but a model
  // can echo old-turn shapes) folds into an add_rule proposal rather than rendering a second UI path.
  let proposed_actions = validateProposedActions(input.proposed_actions, actions.aliasToId, actions.propertyIds);
  if (suggested_rule && proposed_actions.length < MAX_PROPOSALS_PER_TURN && !proposed_actions.some((p) => p.kind === "add_rule")) {
    proposed_actions = [...proposed_actions, {
      kind: "add_rule",
      title: `Always file “${suggested_rule.pattern}” the same way`,
      rationale: "Remember this merchant's category for future imports.",
      pattern: suggested_rule.pattern,
      bucket: suggested_rule.bucket,
      ...(suggested_rule.ato_label ? { ato_label: suggested_rule.ato_label } : {}),
    }];
  }
  return { answer, caveats: strList(input.caveats), see_also: strList(input.see_also), proposed_actions: proposed_actions.length ? proposed_actions : undefined, navigate, ...withEntityActions };
}

/** One metered Haiku call → a short personalised walkthrough. Plain structured output, no prose parsing. */
export async function extractGuide(llm: LLM, system: string, user: string): Promise<GuideResult> {
  const msg = await llm.create(
    {
      model: llm.modelId,
      max_tokens: 700,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      tools: [GUIDE_TOOL],
      tool_choice: { type: "tool", name: GUIDE_TOOL.name },
      messages: [{ role: "user", content: [{ type: "text", text: user }] }],
    },
    "guide_me",
  );
  const toolUse = msg.content.find((c): c is Anthropic.ToolUseBlock => c.type === "tool_use" && c.name === GUIDE_TOOL.name);
  if (!toolUse) throw new Error("model did not return a give_guide tool call");
  const input = toolUse.input as { headline?: unknown; steps?: unknown };
  const headline = typeof input.headline === "string" && input.headline.trim() ? input.headline.trim() : "Here's what to do next";
  const steps = Array.isArray(input.steps) ? input.steps.filter((s): s is string => typeof s === "string" && s.trim().length > 0).slice(0, 6) : [];
  return { headline, steps };
}
