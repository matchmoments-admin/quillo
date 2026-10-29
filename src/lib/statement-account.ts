/**
 * Which account an uploaded statement belongs to (flag statement_account_detect). The statement says so itself:
 * its institution, its kind and the last four digits of its number (src/extract.ts StatementAccount). An upload
 * with "work it out" goes to the tenant's account with the same institution and last four digits, or a new
 * account of the detected kind. This replaces two UI guesses (every new account typed "transaction", and the
 * picker defaulting to the last account used), which mis-reconciled every card and loan statement and could
 * file one bank's statement in another's account.
 *
 * A match against a bank-feed or QuickBooks account is NOT made into a second account: the caller's
 * assertCanonicalSource refuses it (ADR-0002), so the same money is never counted from two sources.
 */
import type { Env } from "../env";
import type { StatementAccount, StatementAccountKind } from "../extract";
import { tenantDb } from "./tenant-db";
import { addAccount, updateAccount } from "./situation-write";

/** accounts.type for a detected kind (offset and savings accounts are transaction accounts). */
export function accountTypeForKind(kind: StatementAccountKind | null | undefined): string {
  return kind === "credit_card" ? "credit_card" : kind === "loan" ? "loan" : "transaction";
}

export function isLiabilityKind(kind: StatementAccountKind | null | undefined): boolean {
  return kind === "credit_card" || kind === "loan";
}

const KIND_LABEL: Record<StatementAccountKind, string> = {
  everyday: "everyday account",
  savings: "savings account",
  credit_card: "credit card",
  loan: "loan",
  offset: "offset account",
};

export function kindLabel(kind: StatementAccountKind | null | undefined): string {
  return kind ? KIND_LABEL[kind] : "account";
}

/** "Westpac credit card ··4321" — the name a detected account gets. */
export function detectedAccountName(a: Pick<StatementAccount, "institution" | "kind" | "last4">): string {
  const base = [a.institution ?? "Bank", kindLabel(a.kind)].join(" ");
  return a.last4 ? `${base} ··${a.last4}` : base;
}

// Bank names as printed vary ("Commonwealth Bank of Australia" / "CommBank", "NAB" / "National Australia Bank"), and a
// first-word key collides ("Bank of Melbourne" and "Bank of Queensland" both start "bank"). So a name reduces to its
// distinctive words, then the common aliases fold together.
const NAME_NOISE = new Set(["the", "bank", "banking", "of", "australia", "australian", "limited", "ltd", "corporation", "corp", "group", "pty", "and", "co", "company"]);
const ALIASES: [RegExp, string][] = [
  [/^(commonwealth|commbank|cba)\b/, "cba"],
  [/^(national|nab)\b/, "nab"],
  [/^(anz|new zealand)\b/, "anz"],
  [/^(st george|stgeorge|st\.george)\b/, "stgeorge"],
  [/^(boq|queensland)\b/, "boq"],
  [/^(amex|american express)\b/, "amex"],
  [/^(ing|ing direct)\b/, "ing"],
];
export function institutionKey(s: string | null | undefined): string {
  const words = (s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w && !NAME_NOISE.has(w));
  const key = words.join(" ");
  for (const [re, alias] of ALIASES) if (re.test(key)) return alias;
  return key;
}

/** Two bank names agree when their first distinctive word does ("Westpac" and a typed "Westpac Choice 909"). */
export function sameInstitution(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = institutionKey(a).split(" ")[0];
  const kb = institutionKey(b).split(" ")[0];
  return !!ka && ka === kb;
}

/**
 * The bank name a new account takes: the one already on the user's accounts at the same bank, so one bank reads one
 * way ("Westpac" twice, not "Westpac" and "Westpac Banking Corporation" as two statements printed it).
 */
export function knownInstitution(accounts: Pick<AccountRow, "institution">[], printed: string | null | undefined): string | null {
  if (!printed) return null;
  return accounts.find((a) => a.institution && sameInstitution(a.institution, printed))?.institution ?? printed;
}

export interface AccountRow {
  id: string;
  institution: string | null;
  name: string;
  last4: string | null;
  type: string;
  source: string;
}

const FEED_SOURCES = new Set(["cdr_feed", "qbo_feed"]);

export type AccountDecision =
  | { action: "match"; account: AccountRow } // the account the statement names (a feed match is then refused by the caller)
  | { action: "adopt"; account: AccountRow } // an older account with no last four on file, same bank: record them
  | { action: "create" }
  | { action: "ask" }; // more than one candidate, or nothing to tell a feed account apart: the user picks

/**
 * Which of the tenant's active accounts a statement belongs to. Never a guess: an ambiguous case asks the user,
 * because filing into the wrong account, or a second account for the same money, is worse than one question.
 *   - The same last four digits on a bank-feed account ⇒ that account, whatever the bank name says (the caller's
 *     assertCanonicalSource then refuses it: ADR-0002).
 *   - The same last four digits (and a compatible bank) ⇒ that account; two ⇒ ask.
 *   - Otherwise one older statement account at the same bank with no last four recorded ⇒ adopt it; several ⇒ ask.
 *   - A statement with no last four while the tenant has a bank feed ⇒ ask (it might be the feed's account).
 *   - Otherwise a new account.
 */
export function decideStatementAccount(accounts: AccountRow[], detected: StatementAccount | undefined): AccountDecision {
  const inst = institutionKey(detected?.institution);
  const sameBank = (a: AccountRow) => !inst || !a.institution || sameInstitution(a.institution, detected?.institution);
  const uploads = accounts.filter((a) => !FEED_SOURCES.has(a.source));
  if (detected?.last4) {
    const feed = accounts.find((a) => FEED_SOURCES.has(a.source) && a.last4 === detected.last4);
    if (feed) return { action: "match", account: feed };
    const hits = uploads.filter((a) => a.last4 === detected.last4 && sameBank(a));
    if (hits.length === 1) return { action: "match", account: hits[0]! };
    if (hits.length > 1) return { action: "ask" };
  } else if (accounts.some((a) => FEED_SOURCES.has(a.source))) {
    return { action: "ask" };
  }
  if (inst) {
    const sameInst = uploads.filter((a) => sameInstitution(a.institution, detected?.institution));
    const unnumbered = sameInst.filter((a) => !a.last4);
    if (unnumbered.length === 1 && (detected?.last4 || sameInst.length === 1)) return { action: "adopt", account: unnumbered[0]! };
    if (unnumbered.length > 1 || (!detected?.last4 && sameInst.length > 0)) return { action: "ask" };
  }
  return { action: "create" };
}

/** True when an account's type says something different from what its statement says. */
export function kindMismatch(type: string, detected: StatementAccount | undefined): boolean {
  if (!detected?.kind) return false;
  return accountTypeForKind(detected.kind) !== (type === "investment" ? "transaction" : type);
}

export interface ResolvedAccount {
  id: string;
  name: string;
  type: string;
  kind: StatementAccountKind | null;
  created: boolean;
  kindMismatch: boolean;
}

/**
 * Resolve "work it out from the statement": the matched account, or a new one of the detected kind. A new loan
 * also gets the printed closing balance and current rate (the loan-interest fallback inputs, 0044) so nobody types
 * them in. `closingCents` is the statement's closing balance (a loan's may be printed negative).
 */
export const ASK_FOR_ACCOUNT = "We couldn't tell which of your accounts this statement is for. Choose the account above, then upload it again.";

/**
 * Resolve "work it out from the statement" (decideStatementAccount). A new loan also gets the printed closing balance
 * and current rate (the loan-interest fallback inputs, 0044) so nobody types them in. Throws ASK_FOR_ACCOUNT when the
 * user has to pick.
 */
export async function resolveStatementAccount(env: Env, userId: string, detected: StatementAccount | undefined, closingCents: number | null): Promise<ResolvedAccount> {
  const rows = await tenantDb(env, userId)
    .prepare(`SELECT id, institution, name, last4, type, source FROM accounts WHERE user_id = ? AND active = 1`)
    .all<AccountRow>();
  const d = decideStatementAccount(rows.results ?? [], detected);
  if (d.action === "ask") throw new Error(ASK_FOR_ACCOUNT);
  if (d.action === "match" || d.action === "adopt") {
    if (d.action === "adopt" && detected?.last4) await updateAccount(env, userId, d.account.id, { last4: detected.last4 });
    return { id: d.account.id, name: d.account.name, type: d.account.type, kind: detected?.kind ?? null, created: false, kindMismatch: kindMismatch(d.account.type, detected) };
  }
  const type = accountTypeForKind(detected?.kind);
  const institution = knownInstitution(rows.results ?? [], detected?.institution);
  const name = detectedAccountName({ institution, kind: detected?.kind ?? null, last4: detected?.last4 ?? null });
  const id = await addAccount(env, userId, { name, institution: institution ?? undefined, last4: detected?.last4 ?? undefined, type, source: "statement" });
  if (type === "loan" && (closingCents != null || detected?.interest_rate_pct != null)) {
    await updateAccount(env, userId, id, { balance_cents: closingCents != null ? Math.abs(closingCents) : undefined, interest_rate_pct: detected?.interest_rate_pct ?? undefined });
  }
  return { id, name, type, kind: detected?.kind ?? null, created: true, kindMismatch: false };
}

/** Undo a just-created account when the upload that made it fails (only if nothing points at it yet). */
export async function discardCreatedAccount(env: Env, userId: string, accountId: string): Promise<void> {
  const used = await tenantDb(env, userId).prepare(`SELECT 1 AS x FROM statements WHERE user_id = ? AND account_id = ? LIMIT 1`).bind(accountId).first<{ x: number }>();
  if (!used) await tenantDb(env, userId).prepare(`DELETE FROM accounts WHERE user_id = ? AND id = ?`).bind(accountId).run();
}

/** A loan account's blank balance / rate filled from its statement (0044 fallback inputs). Never overwrites a value. */
export async function fillLoanFacts(env: Env, userId: string, accountId: string, closingCents: number | null, detected: StatementAccount | undefined): Promise<void> {
  const a = await tenantDb(env, userId)
    .prepare(`SELECT type, balance_cents, interest_rate_pct FROM accounts WHERE id = ? AND user_id = ?`)
    .bind(accountId)
    .first<{ type: string; balance_cents: number | null; interest_rate_pct: number | null }>();
  if (!a || a.type !== "loan") return;
  const balance = a.balance_cents == null && closingCents != null ? Math.abs(closingCents) : undefined;
  const rate = a.interest_rate_pct == null && detected?.interest_rate_pct != null ? detected.interest_rate_pct : undefined;
  if (balance !== undefined || rate !== undefined) await updateAccount(env, userId, accountId, { balance_cents: balance, interest_rate_pct: rate });
}
