import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { LLM } from "./llm";
import { bytesToBase64 } from "./lib/base64";
import type { ColumnMap } from "./lib/statements";

export const Extracted = z.object({
  merchant: z.string(),
  amount_cents: z.number().int(),
  currency: z.string().default("AUD"),
  gst_cents: z.number().int().nullable(),
  txn_date: z.string().nullable(),
  bucket: z.enum(["payg", "company", "property_rented", "property_vacant", "unknown"]),
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
        enum: ["payg", "company", "property_rented", "property_vacant", "unknown"],
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
): Promise<ExtractResult> {
  const msg = await llm.client.messages.create({
    model: llm.modelId,
    max_tokens: 1024,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    tools: [RECORD_TOOL],
    tool_choice: { type: "tool", name: RECORD_TOOL.name },
    messages: [{ role: "user", content }],
  });

  const toolUse = msg.content.find(
    (c): c is Anthropic.ToolUseBlock => c.type === "tool_use" && c.name === RECORD_TOOL.name,
  );
  if (!toolUse) {
    throw new Error("model did not return a record_receipt tool call");
  }
  return { parsed: Extracted.parse(toolUse.input), raw: toolUse.input };
}

// ── PDF statement extraction (Claude document → structured lines + balances) ───
export interface ExtractedStatement {
  lines: { date: string | null; description: string; amount_cents: number; direction: "debit" | "credit"; balance_cents: number | null }[];
  opening_cents: number | null;
  closing_cents: number | null;
  currency: string;
}

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
  const msg = await llm.client.messages.create({
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
  });
  const toolUse = msg.content.find((c): c is Anthropic.ToolUseBlock => c.type === "tool_use" && c.name === STATEMENT_TOOL.name);
  if (!toolUse) throw new Error("model did not return a statement");
  return toolUse.input as ExtractedStatement;
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
  const msg = await llm.client.messages.create({
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
  });
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
  return runRecordReceipt(llm, system, [
    receiptBlock(bytes, mime),
    { type: "text", text: "Extract this receipt and categorise it using the rule pack. Call record_receipt." },
  ]);
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
  return runRecordReceipt(llm, system, [
    ...images.map((im) => receiptBlock(im.bytes, im.mime)),
    {
      type: "text",
      text: `These ${images.length} images are parts/pages of ONE receipt. Combine them into a single record_receipt call (one merchant, one total).`,
    },
  ]);
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
            bucket: { type: "string", enum: ["payg", "company", "property_rented", "property_vacant", "unknown"] },
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

/** Categorise many statement lines in one call. Returns one result per input line (by index). */
export async function extractBatch(
  llm: LLM,
  system: string,
  items: { merchant: string; amount_cents: number; date: string | null }[],
): Promise<BatchItem[]> {
  const list = items
    .map((it, i) => `${i + 1}. ${it.merchant} | $${(it.amount_cents / 100).toFixed(2)}${it.date ? ` | ${it.date}` : ""}`)
    .join("\n");
  const msg = await llm.client.messages.create({
    model: llm.modelId,
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
  });
  const toolUse = msg.content.find((c): c is Anthropic.ToolUseBlock => c.type === "tool_use" && c.name === BATCH_TOOL.name);
  if (!toolUse) throw new Error("model did not return a batch");
  return ((toolUse.input as { items: BatchItem[] }).items ?? []).slice(0, items.length);
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
  return runRecordReceipt(llm, system, [
    {
      type: "text",
      text:
        `Expense described as free text (no image): "${text}"\n` +
        `Extract and categorise it using the rule pack. Convert the amount to cents; ` +
        `use null for any field not stated (e.g. gst_cents, txn_date). Call record_receipt.`,
    },
  ]);
}
