// Pure logic behind the Connect step (first-timer spec §0 step 2, #586; flag ft_journey). No React, no DOM,
// so scripts/check-units.ts tests it directly. Copy here is scanned by the tax-advice denylist.

import type { BankConnection, BankSyncRun, IncomeStatementWait, StatementInfo } from "../../types";

// ── Bank import progress (#511 run status, surfaced here) ─────────────────────────────────────────

/** What the import card shows. `none` = no run yet; `attention` = a failed / partial / interrupted run. */
export type ImportPhase = "none" | "running" | "done" | "attention";

export interface ImportProblem {
  connection_id: string;
  institution: string | null;
  kind: "failed" | "partial" | "interrupted" | "expired";
  message: string;
}

export interface ImportSummary {
  phase: ImportPhase;
  /** New lines brought in by the latest run of every connection (duplicates aren't counted). */
  imported: number;
  /** Connections still importing in the background. */
  running: number;
  /** Runs needing the user: failed, partial, or interrupted (a stale 'running' row). */
  problems: ImportProblem[];
}

const EXPIRED_RE = /consent expired|reconnect/i;

/**
 * Fold the latest run per connection into one card state. A live running run wins (the import isn't
 * finished, whatever else happened); then any problem; else done. An interrupted run (stale) is a problem
 * with a retry, never "still importing", so a dead backfill can't spin forever.
 */
export function importSummary(runs: readonly BankSyncRun[]): ImportSummary {
  const live = runs.filter((r) => r.status === "running" && !r.stale);
  const problems: ImportProblem[] = [];
  for (const r of runs) {
    if (r.status === "running" && r.stale) {
      problems.push({ connection_id: r.connection_id, institution: r.institution, kind: "interrupted", message: "The import stopped before it finished. Try again to pick up where it left off." });
    } else if (r.status === "failed") {
      const expired = EXPIRED_RE.test(r.error ?? "");
      problems.push({
        connection_id: r.connection_id,
        institution: r.institution,
        kind: expired ? "expired" : "failed",
        message: expired ? "Your bank consent has ended. Connect the bank again to keep bringing in transactions." : "The import didn't finish. Try again.",
      });
    } else if (r.status === "partial") {
      problems.push({ connection_id: r.connection_id, institution: r.institution, kind: "partial", message: "Only part of the history came in. Try again to bring in the rest." });
    }
  }
  const imported = runs.reduce((s, r) => s + (Number.isFinite(r.imported) ? Math.max(0, r.imported) : 0), 0);
  const phase: ImportPhase = runs.length === 0 ? "none" : live.length ? "running" : problems.length ? "attention" : "done";
  return { phase, imported, running: live.length, problems };
}

/** After this long showing "Importing…", the card says it's carrying on in the background. */
export const BACKGROUND_AFTER_MS = 45_000;
/** On ?connected=1, how long to keep polling for the first run row before saying nothing came through. */
export const FIRST_RUN_WAIT_MS = 30_000;

/** Poll interval for the import card: fast while a run is live (or the first one is still expected), else off. */
export function pollInterval(s: Pick<ImportSummary, "phase">, awaitingFirstRun: boolean): number | false {
  if (s.phase === "running") return 3_000;
  if (s.phase === "none" && awaitingFirstRun) return 2_000;
  return false;
}

/** The import card's heading. `elapsedMs` = how long this page has been watching the live run. */
export function importHeading(s: ImportSummary, elapsedMs: number): string {
  switch (s.phase) {
    case "running":
      return elapsedMs >= BACKGROUND_AFTER_MS ? "Still importing in the background" : "Importing your transactions…";
    case "done":
      return s.imported > 0 ? `Imported ${linesLabel(s.imported)}` : "Up to date. No new transactions.";
    case "attention":
      return s.problems.length === 1 ? "One import needs a hand" : `${s.problems.length} imports need a hand`;
    default:
      return "";
  }
}

/** "1 transaction" / "1,234 transactions". */
export function linesLabel(n: number): string {
  const v = Math.max(0, Math.floor(Number.isFinite(n) ? n : 0));
  return `${v.toLocaleString("en-AU")} transaction${v === 1 ? "" : "s"}`;
}

/** The callback's ?connected=0&reason=… as one plain line (never echoes the raw reason as markup). */
export function connectFailedCopy(reason: string | null): string {
  if (reason && /expired|invalid_or_expired_state/i.test(reason)) return "The bank connection timed out before it finished. Try connecting again.";
  if (reason && /cancel|denied|declined/i.test(reason)) return "The connection was cancelled at the bank. Nothing was shared.";
  return "The bank connection didn't finish. Nothing was imported. Try connecting again.";
}

// ── Connected accounts (simple list, per-account on/off) ───────────────────────────────────────────

export interface ConnectedAccountRow {
  provider_account_id: string;
  id: string;
  name: string;
  masked: string | null;
  institution: string;
  on: boolean;
  /** The Quillo account it feeds (null until the first save). */
  account_id: string | null;
  mapped_name: string | null;
  connection_status: string;
}

/** Live connections only (a withdrawn one's lines are gone), flattened to one row per bank account. */
export function connectedAccounts(conns: readonly BankConnection[]): ConnectedAccountRow[] {
  return conns
    .filter((c) => c.status !== "revoked")
    .flatMap((c) =>
      c.accounts.map((a) => ({
        provider_account_id: a.provider_account_id,
        id: a.id,
        name: a.name ?? "Bank account",
        masked: a.masked_number,
        institution: c.institution ?? c.institution_id ?? c.provider,
        on: a.selected === 1,
        account_id: a.account_id,
        mapped_name: a.mapped_account_name,
        connection_status: c.status,
      })),
    );
}

/**
 * The selection a toggle sends. ON keeps an existing mapping or creates the matching Quillo account
 * ("new", the same path the bank callback uses); OFF clears `selected` and the server KEEPS the mapping
 * (#576), so lines already collected stay findable by a later withdraw.
 */
export function toggleSelection(row: Pick<ConnectedAccountRow, "provider_account_id" | "account_id">, on: boolean): { providerAccountId: string; selected: boolean; accountId: string | null } {
  return on
    ? { providerAccountId: row.provider_account_id, selected: true, accountId: row.account_id ?? "new" }
    : { providerAccountId: row.provider_account_id, selected: false, accountId: null };
}

// ── Statement uploads ────────────────────────────────────────────────────────────────────────────

export type StatementView = { label: string; tone: "ok" | "warn" | "danger" | "neutral"; action: "import" | "force" | null };

/**
 * One uploaded statement's line: what state it's in and the one action it offers. A statement that
 * doesn't balance offers "Import anyway" (the server refuses a plain import); one that couldn't be
 * checked offers a plain import with a "check the lines" note.
 */
export function statementView(s: Pick<StatementInfo, "status" | "reconciled" | "row_count" | "imported_count" | "total_lines" | "categorised_count">): StatementView {
  const rows = s.row_count ?? 0;
  switch (s.status) {
    case "parsed":
      if (s.reconciled === 0) return { label: "Doesn't add up to the statement's balance. Check it before importing.", tone: "danger", action: "force" };
      if (s.reconciled === 1) return { label: `Ready: ${linesLabel(rows)}, balances`, tone: "ok", action: "import" };
      return { label: `Ready: ${linesLabel(rows)}. No running balance, so check the lines look right.`, tone: "warn", action: "import" };
    case "categorising": {
      const done = s.categorised_count ?? 0;
      const total = s.total_lines ?? s.imported_count ?? 0;
      return { label: total ? `Imported. Sorting ${done} of ${total}…` : "Imported. Sorting…", tone: "neutral", action: null };
    }
    case "imported":
      return { label: `Imported: ${linesLabel(s.imported_count ?? rows)}`, tone: "ok", action: null };
    case "failed":
      return { label: "Couldn't read this file", tone: "danger", action: null };
    default:
      return { label: s.status, tone: "neutral", action: null };
  }
}

// ── Income statement: a WAITING item until the employer marks it Tax ready ─────────────────────────

export interface IncomeWaitItem {
  key: string;
  title: string;
  body: string;
  state: "waiting" | "added";
  /** "ask your employer" line, only once it's past the pack's chase date. */
  chase: string | null;
}

/**
 * The waiting items. Quillo can't see myGov, so an employer's statement is WAITING until one naming that
 * employer is added; it never says a statement IS tax ready. With no known employer and nothing recorded, one
 * generic item ("if you had a job"). Dates are the pack's copy, never a TS literal.
 */
export function incomeWaitItems(w: IncomeStatementWait): IncomeWaitItem[] {
  const waitingBody = `Your employer finalises it in myGov by ${w.finalise_by}. When it says "Tax ready", add it here. Your bank shows take-home pay; the statement has your gross pay and the tax withheld.`;
  const chase = (who: string) => (w.chase_now ? `Still not Tax ready after ${w.chase_after}? Ask ${who} to finalise it.` : null);
  if (w.employers.length === 0) {
    if (w.wage_rows > 0) return [{ key: "added", title: "Income statement added", body: "Quillo uses its gross pay and tax withheld.", state: "added", chase: null }];
    return [{ key: "generic", title: "Had a job? Your income statement", body: waitingBody, state: "waiting", chase: chase("your employer") }];
  }
  return w.employers.map((e) =>
    e.covered
      ? { key: e.name, title: `Income statement from ${e.name}: added`, body: "Quillo uses its gross pay and tax withheld.", state: "added" as const, chase: null }
      : { key: e.name, title: `Waiting on your income statement from ${e.name}`, body: waitingBody, state: "waiting" as const, chase: chase(e.name) },
  );
}
