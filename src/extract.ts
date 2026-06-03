import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { LLM } from "./llm";
import { bytesToBase64 } from "./lib/base64";
import type { ColumnMap } from "./lib/statements";
import { BUCKETS, ENTITY_KINDS, PROPERTY_STATUSES, DOC_TYPES, ASSET_CLASSES } from "./lib/taxonomy";

export const Extracted = z.object({
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
});
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
// Validate the model's tool input with Zod (like every other extractor) rather than blind-
// casting: a credit-card PDF with no balance column / an unfamiliar table shape can make
// Haiku emit a malformed or empty tool call, and an unchecked `input as ExtractedStatement`
// then crashes downstream (`ext.lines.map` on undefined) as an uncaught Worker exception.
export const ExtractedStatementSchema = z.object({
  lines: z
    .array(
      z.object({
        date: z.string().nullable().default(null),
        description: z.string().default(""),
        amount_cents: z.number().int(),
        direction: z.enum(["debit", "credit"]),
        balance_cents: z.number().int().nullable().default(null),
      }),
    )
    .default([]),
  opening_cents: z.number().int().nullable().default(null),
  closing_cents: z.number().int().nullable().default(null),
  currency: z.string().default("AUD"),
});
export type ExtractedStatement = z.infer<typeof ExtractedStatementSchema>;

const STATEMENT_TOOL: Anthropic.Tool = {
  name: "record_statement",
  description: "Record EVERY transaction line from a bank/credit-card statement, plus the opening and closing balances, so the import can be reconciled.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["lines", "opening_cents", "closing_cents", "currency"],
    properties: {
      opening_cents: { type: ["integer", "null"], description: "Opening balance in cents (start of the statement period)." },
      closing_cents: { type: ["integer", "null"], description: "Closing balance in cents (end of the statement period)." },
      currency: { type: "string", description: "ISO-4217 currency of the statement (usually AUD)." },
      lines: {
        type: "array",
        description: "Every transaction line, in statement order. Do NOT skip, merge or invent rows — completeness matters (it is reconciled against the balances).",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["date", "description", "amount_cents", "direction", "balance_cents"],
          properties: {
            date: { type: ["string", "null"], description: "ISO date YYYY-MM-DD, or null if not shown." },
            description: { type: "string", description: "Transaction description / narrative as printed." },
            amount_cents: { type: "integer", description: "Absolute amount in cents." },
            direction: { type: "string", enum: ["debit", "credit"], description: "'debit' = money out (spend), 'credit' = money in." },
            balance_cents: { type: ["integer", "null"], description: "Running balance after this line in cents, or null if the statement has no balance column." },
          },
        },
      },
    },
  },
};

/** Extract a full statement from a PDF (or image) via Claude document input. */
export async function extractStatement(llm: LLM, bytes: ArrayBuffer, mime: string): Promise<ExtractedStatement> {
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
            { type: "text", text: "Transcribe EVERY transaction from this statement (across all pages) plus the opening and closing balances. Call record_statement once." },
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
  const result = ExtractedStatementSchema.safeParse(toolUse.input);
  if (!result.success) throw new Error("couldn't read the transaction table from this PDF — the layout wasn't recognised; try a CSV export instead");
  return result.data;
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
        description: "One categorisation per input line, in the SAME order as the input.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["bucket", "ato_label", "confidence", "reasoning"],
          properties: {
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
  bucket: string;
  ato_label: string;
  confidence: number;
  reasoning: string;
}

/** Build the message params for one categorisation batch (reused by sync + async/Batch API). */
export function batchParams(
  modelId: string,
  system: string,
  items: { merchant: string; amount_cents: number; date: string | null }[],
): Anthropic.MessageCreateParamsNonStreaming {
  const list = items
    .map((it, i) => `${i + 1}. ${it.merchant} | $${(it.amount_cents / 100).toFixed(2)}${it.date ? ` | ${it.date}` : ""}`)
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
            text: `Categorise each of these ${items.length} bank/card statement lines into a bucket + ATO label, in order (one result per line). These are descriptions only (no receipt), so prefer 'unknown' when genuinely unclear.\n\n${list}\n\nCall record_batch with exactly ${items.length} items.`,
          },
        ],
      },
    ],
  };
}

/** Pull the categorisation array out of a record_batch message. */
export function parseBatchMessage(msg: Anthropic.Message): BatchItem[] {
  const toolUse = msg.content.find((c): c is Anthropic.ToolUseBlock => c.type === "tool_use" && c.name === BATCH_TOOL.name);
  return toolUse ? ((toolUse.input as { items: BatchItem[] }).items ?? []) : [];
}

/** Categorise many statement lines in one call (synchronous path). One result per line. */
export async function extractBatch(
  llm: LLM,
  system: string,
  items: { merchant: string; amount_cents: number; date: string | null }[],
): Promise<BatchItem[]> {
  const msg = await llm.create(batchParams(llm.modelId, system, items), "statement_batch");
  return parseBatchMessage(msg).slice(0, items.length);
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
