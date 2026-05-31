import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { LLM } from "./llm";
import { bytesToBase64 } from "./lib/base64";

export const Extracted = z.object({
  merchant: z.string(),
  amount_cents: z.number().int(),
  gst_cents: z.number().int().nullable(),
  txn_date: z.string().nullable(),
  bucket: z.enum(["payg", "company", "property_rented", "property_vacant", "unknown"]),
  ato_label: z.string(),
  property_id: z.string().nullable(),
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
    required: ["merchant", "amount_cents", "gst_cents", "txn_date", "bucket", "ato_label", "property_id", "confidence", "reasoning"],
    properties: {
      merchant: { type: "string", description: "Merchant / supplier name as printed." },
      amount_cents: { type: "integer", description: "Total amount in cents (GST-inclusive)." },
      gst_cents: { type: ["integer", "null"], description: "GST component in cents, or null if not shown." },
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
