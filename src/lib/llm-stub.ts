import type Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../env";

/**
 * QA-only inference stub (ticket #699): lets the browser QA suite (`npm run qa:browser`, scripts/qa/)
 * drive every journey under `wrangler dev` without ever calling a paid model.
 *
 * It is reachable ONLY when all three hold, and production can satisfy none of the last two:
 *   - QA_LLM_STUB === "1"        — the suite passes it with `--var QA_LLM_STUB:1`;
 *   - DEV_AUTH_BYPASS === "1"    — the local-dev auth bypass, set only in a local env file;
 *   - CLERK_ISSUER is unset/empty — production sets it in wrangler.toml, and requireClerk refuses
 *                                   every request without it unless DEV_AUTH_BYPASS is "1".
 * Exact-string compares, like requireClerk: a "true"/"yes" never switches it on.
 *
 * The replies are deterministic and deliberately thin. A forced tool call gets the smallest valid
 * input we can build for that tool (a heuristic CSV column map, a low-confidence categorisation so lines
 * still reach Review, a fixed general-information answer); an unknown tool gets `{}` so its caller's
 * own validation fails the way a bad model reply would. Usage is zero, so nothing is costed.
 */
export function llmStubEnabled(env: Pick<Env, "QA_LLM_STUB" | "DEV_AUTH_BYPASS" | "CLERK_ISSUER">): boolean {
  return env.QA_LLM_STUB === "1" && env.DEV_AUTH_BYPASS === "1" && !(env.CLERK_ISSUER ?? "").trim();
}

export const STUB_MODEL_ID = "qa-stub";
export const STUB_ANSWER =
  "QA stub reply: no model was called. This is general information only, not tax advice. Confirm with a registered tax agent.";

type Block = Anthropic.Messages.MessageParam["content"];

function promptText(params: Anthropic.MessageCreateParamsNonStreaming): string {
  const parts: string[] = [];
  for (const m of params.messages) {
    const c = m.content as Block;
    if (typeof c === "string") parts.push(c);
    else for (const b of c) if (b.type === "text") parts.push(b.text);
  }
  return parts.join("\n");
}

/** Column map from the header row of the `row 0: [...]` sample extractColumnMap sends. */
export function stubColumnMap(prompt: string): Record<string, unknown> {
  const rows = [...prompt.matchAll(/^row (\d+): (\[.*\])$/gm)].map((m) => {
    try { return JSON.parse(m[2]!) as unknown[]; } catch { return []; }
  });
  const headerIdx = Math.max(0, rows.findIndex((r) => r.some((c) => /date/i.test(String(c)))));
  const header = (rows[headerIdx] ?? []).map((c) => String(c).toLowerCase());
  const find = (re: RegExp) => { const i = header.findIndex((h) => re.test(h)); return i >= 0 ? i : null; };
  const debit = find(/debit|withdraw/);
  const credit = find(/credit|deposit/);
  const amount = debit == null || credit == null ? find(/amount|value/) : null;
  return {
    header_row: headerIdx,
    date_col: find(/date/) ?? 0,
    description_col: find(/desc|narr|detail|particular|transaction/) ?? 1,
    amount_col: amount,
    debit_col: amount == null ? debit : null,
    credit_col: amount == null ? credit : null,
    balance_col: find(/balance/),
    sign_convention: amount == null ? "split" : "negative_is_debit",
  };
}

/**
 * The categoriser's reply, mirroring the fixed outcome scripts/e2e-first-timer.ts replays: money in ⇒
 * income_personal, money out ⇒ unknown, both at low confidence so every line still reaches Review.
 * Lines are the `N. [IN|OUT] merchant | $x` list batchParams sends.
 */
export function stubBatchItems(prompt: string): Record<string, unknown>[] {
  return [...prompt.matchAll(/^(\d+)\. \[(IN|OUT)\]/gm)].map((m) => ({
    line: Number(m[1]),
    bucket: m[2] === "IN" ? "income_personal" : "unknown",
    ato_label: m[2] === "IN" ? "income_personal" : "unknown",
    confidence: 0.3,
    reasoning: "QA stub",
  }));
}

function stubToolInput(name: string, prompt: string): Record<string, unknown> {
  switch (name) {
    case "record_column_map": return stubColumnMap(prompt);
    case "record_batch": return { items: stubBatchItems(prompt) };
    case "give_answer": return { answer: STUB_ANSWER, caveats: ["QA stub: confirm with a registered tax agent."], see_also: [] };
    case "give_guide": return { headline: "QA stub walkthrough", steps: ["Add your accounts.", "Upload a statement.", "Review what needs sorting."] };
    default: return {};
  }
}

/** The stub's create(): same Message shape as the SDK, zero usage. */
export function stubMessage(params: Anthropic.MessageCreateParamsNonStreaming): Anthropic.Message {
  const choice = params.tool_choice as { type?: string; name?: string } | undefined;
  const toolName = choice?.type === "tool" ? choice.name : undefined;
  const content = toolName
    ? [{ type: "tool_use", id: "toolu_qa_stub", name: toolName, input: stubToolInput(toolName, promptText(params)) }]
    : [{ type: "text", text: STUB_ANSWER, citations: null }];
  return {
    id: "msg_qa_stub",
    type: "message",
    role: "assistant",
    model: STUB_MODEL_ID,
    content,
    stop_reason: toolName ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  } as unknown as Anthropic.Message;
}
