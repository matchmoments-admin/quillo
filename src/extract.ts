import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { LLM } from "./llm";
import { bytesToBase64 } from "./lib/base64";
import type { ColumnMap } from "./lib/statements";
import { BUCKETS, ENTITY_KINDS, PROPERTY_STATUSES, DOC_TYPES, ASSET_CLASSES, ATO_LABEL_MAX, CLAIM_TYPES, isBucket, normalizeAtoLabel } from "./lib/taxonomy";
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
        date: z.string().nullable().default(null),
        description: z.string().default(""),
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
  | { kind: "recategorise"; title: string; rationale: string; txn_ids: string[]; bucket: string; ato_label?: string }
  | { kind: "add_rule"; title: string; rationale: string; pattern: string; bucket: string; ato_label?: string };

export interface AnswerResult {
  answer: string;
  caveats: string[];
  see_also: string[];
  suggested_rule?: { pattern: string; bucket: string; ato_label?: string };
  proposed_actions?: ProposedAction[];
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
export function validateProposedActions(raw: unknown, aliasToId: Map<string, DigestRef>): ProposedAction[] {
  if (!Array.isArray(raw)) return [];
  const out: ProposedAction[] = [];
  for (const item of raw.slice(0, MAX_PROPOSALS_PER_TURN)) {
    const a = item as { kind?: unknown; title?: unknown; rationale?: unknown; txn_refs?: unknown; state?: unknown; deductible_amount_cents?: unknown; bucket?: unknown; ato_label?: unknown; pattern?: unknown };
    if (typeof a.title !== "string" || !a.title.trim() || typeof a.rationale !== "string" || !a.rationale.trim()) continue;
    const title = a.title.trim().slice(0, 60);
    const rationale = a.rationale.trim().slice(0, 200);
    const atoLabel = typeof a.ato_label === "string" && a.ato_label.trim() ? a.ato_label.trim().slice(0, 60) : undefined;
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
      out.push({ kind: "recategorise", title, rationale, txn_ids: refs.map((r) => r.id), bucket: a.bucket as string, ...(atoLabel ? { ato_label: atoLabel } : {}) });
    } else if (a.kind === "add_rule") {
      if (typeof a.pattern !== "string" || !a.pattern.trim() || !validBucket) continue;
      out.push({ kind: "add_rule", title, rationale, pattern: a.pattern.trim().slice(0, 60), bucket: a.bucket as string, ...(atoLabel ? { ato_label: atoLabel } : {}) });
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
            pattern: { type: "string", description: "add_rule only: merchant text to match (e.g. 'Adobe')." },
          },
        },
      },
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
  actions?: { aliasToId: Map<string, DigestRef> },
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
  const input = toolUse.input as { answer?: unknown; caveats?: unknown; see_also?: unknown; suggested_rule?: unknown; proposed_actions?: unknown };
  const answer = typeof input.answer === "string" && input.answer.trim() ? input.answer.trim() : "I couldn't answer that from your records.";
  const strList = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim().length > 0).slice(0, 4) : []);
  // Only surface a suggested rule for a valid DEBIT spend bucket — never an income/refund re-bucket.
  let suggested_rule: AnswerResult["suggested_rule"];
  const sr = input.suggested_rule as { pattern?: unknown; bucket?: unknown; ato_label?: unknown } | undefined;
  if (sr && typeof sr.pattern === "string" && sr.pattern.trim() && typeof sr.bucket === "string" && isBucket(sr.bucket) && !CREDIT_OR_UNKNOWN_BUCKETS.has(sr.bucket)) {
    suggested_rule = { pattern: sr.pattern.trim().slice(0, 60), bucket: sr.bucket, ato_label: typeof sr.ato_label === "string" ? sr.ato_label.trim().slice(0, 60) : undefined };
  }
  if (!actions) return { answer, caveats: strList(input.caveats), see_also: strList(input.see_also), suggested_rule };
  // Actions mode: one confirm-card channel. A stray suggested_rule (the schema dropped it, but a model
  // can echo old-turn shapes) folds into an add_rule proposal rather than rendering a second UI path.
  let proposed_actions = validateProposedActions(input.proposed_actions, actions.aliasToId);
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
  return { answer, caveats: strList(input.caveats), see_also: strList(input.see_also), proposed_actions: proposed_actions.length ? proposed_actions : undefined };
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
