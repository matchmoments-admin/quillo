// Pure logic behind the Claims step (spec A6, #587; flag ft_journey + relevance_scan). Kept free of React
// so scripts/check-units.ts can test it directly (the repo has no browser test runner).

import type { RelevanceCard, ReviewSummaryRow } from "../types";

/** A line still waiting for the user's decision: not confirmed either way and not marked paid back. */
export function isPendingCard(c: RelevanceCard): boolean {
  return c.deductibility !== "confirmed_deductible" && c.deductibility !== "confirmed_not" && !c.reimbursed && c.status !== "dismissed";
}

export interface WorthALookGroup {
  key: string;
  rule_id: string | null;
  title: string;
  total_cents: number;
  lines: RelevanceCard[];
  /** The return labels the rule allows (the same rule ⇒ the same options for every line). */
  label_options: string[];
  needs_label: boolean;
  needs_work_use_pct: boolean;
  /** Lines over the immediate-claim limit on a depreciating rule (they go to Assets, not Claim it). */
  asset_lines: RelevanceCard[];
  /** Lines Claim it can act on. */
  claimable_lines: RelevanceCard[];
  why: string | null;
  occupation_label: string | null;
  ato_url: string | null;
  all_have_record: boolean;
}

/** Merchant text normalised for grouping: case, digits and punctuation don't split a merchant. */
export function merchantGroupKey(merchant: string | null | undefined): string {
  return (merchant ?? "").toLowerCase().replace(/[^a-z]+/g, " ").trim() || "(no description)";
}

/**
 * Group the FY's pending worth-a-look lines into one card per (rule, merchant), biggest first. Pure,
 * deterministic: ties break on the key, lines keep the server's order (newest first).
 */
export function groupWorthALook(cards: readonly RelevanceCard[]): WorthALookGroup[] {
  const m = new Map<string, WorthALookGroup>();
  for (const c of cards) {
    if (!isPendingCard(c)) continue;
    const key = `${c.rule_id ?? ""}|${merchantGroupKey(c.merchant)}`;
    let g = m.get(key);
    if (!g) {
      g = {
        key,
        rule_id: c.rule_id,
        title: c.merchant ?? "Bank line",
        total_cents: 0,
        lines: [],
        label_options: c.label_options,
        needs_label: c.label_options.length > 1,
        needs_work_use_pct: false,
        asset_lines: [],
        claimable_lines: [],
        why: c.suggestion,
        occupation_label: c.occupation_label,
        ato_url: c.ato_url,
        all_have_record: true,
      };
      m.set(key, g);
    }
    g.lines.push(c);
    g.total_cents += Math.abs(c.amount_cents);
    if (c.needs_asset) g.asset_lines.push(c);
    else {
      g.claimable_lines.push(c);
      if (c.needs_work_use_pct) g.needs_work_use_pct = true;
    }
    if (!c.has_record) g.all_have_record = false;
  }
  return [...m.values()].sort((a, b) => b.total_cents - a.total_cents || a.key.localeCompare(b.key));
}

/** A work-use share typed by the user: a whole number 1–100, else null (never guessed). */
export function parseWorkUsePct(raw: string): number | null {
  const t = raw.trim().replace(/%$/, "");
  if (!/^\d{1,3}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 100 ? n : null;
}

export interface ClaimLabelTotal {
  label: string | null;
  n: number;
  cents: number;
}

/**
 * "Your claims": what the user confirmed, per return label, for the individual (payg) bucket. The amount is
 * what was spent (the claimable part where a share was set), never an estimate of tax back.
 */
export function confirmedByLabel(rows: readonly ReviewSummaryRow[]): ClaimLabelTotal[] {
  const m = new Map<string, ClaimLabelTotal>();
  for (const r of rows) {
    if (r.bucket !== "payg" || r.deductibility !== "confirmed_deductible") continue;
    const k = r.ato_label ?? "";
    const cur = m.get(k) ?? { label: r.ato_label, n: 0, cents: 0 };
    cur.n += r.n;
    cur.cents += r.resolved_cents;
    m.set(k, cur);
  }
  return [...m.values()].sort((a, b) => b.cents - a.cents || (a.label ?? "").localeCompare(b.label ?? ""));
}

/** What a batch of confirm answers still needs, so the card asks for it rather than failing silently. */
export function summariseConfirm(
  results: readonly { ok: boolean; needs_apportionment?: boolean; needs_label?: boolean; label_options?: string[]; needs_asset?: boolean; covered_by_wfh_rate?: boolean }[],
): {
  confirmed: number;
  needs_label: string[] | null;
  needs_share: boolean;
  needs_asset: number;
  /** #587: lines the WFH fixed rate already covers (hours stated) — not claimed separately. */
  covered_by_wfh_rate: number;
  failed: number;
} {
  let confirmed = 0;
  let needs_label: string[] | null = null;
  let needs_share = false;
  let needs_asset = 0;
  let covered_by_wfh_rate = 0;
  let failed = 0;
  for (const r of results) {
    if (r.ok) confirmed++;
    else if (r.needs_label) needs_label = r.label_options ?? needs_label ?? [];
    else if (r.needs_apportionment) needs_share = true;
    else if (r.needs_asset) needs_asset++;
    else if (r.covered_by_wfh_rate) covered_by_wfh_rate++;
    else failed++;
  }
  return { confirmed, needs_label, needs_share, needs_asset, covered_by_wfh_rate, failed };
}
