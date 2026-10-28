/**
 * Income supersession (flag `income_supersession`): when a newly read document's income row replaces rows already
 * on file, so a document never counts on top of the one it restates.
 *
 *   - Salary: an ATO income statement is the authoritative annual figure for one employer and FY. It replaces
 *     earlier payslip, hand-keyed and income-statement rows for the same employer, taxpayer and FY that came from a
 *     DIFFERENT document (two blocks for one employer in the same statement coexist). Employers match on ABN when
 *     both rows carry one, otherwise on the name.
 *   - Rent: an agent statement covers a period for one property. For the same taxpayer, FY and property (the same
 *     property_id on both rows), a statement whose period covers an existing row's period replaces it (an annual
 *     summary over the monthlies); one whose period sits inside an existing row's period adds nothing (a monthly
 *     after the annual). Anything weaker is held for review, never deleted: a partial overlap, an overlap with a
 *     row in another FY (a calendar-year summary), or a match on the statement address alone (an address key can
 *     collide across properties). Dates that aren't ISO are ignored.
 *
 * `decideSupersession` is the pure rule. `supersedeIncome` reads the rows on file and decides; `retireIncome`
 * removes what was replaced AFTER the replacing row is written (the income row through the shared income delete,
 * the transactions its document created, and a matched bank credit re-pointed to the replacement), keeping the
 * document and its original as evidence.
 */
import type { Env } from "../env";
import { tenantDb } from "./tenant-db";
import { deleteIncomeRow, deleteDocumentTransactions } from "./situation-write";
import { sameTaxpayer } from "./self-person";

export interface IncomeIdentity {
  income_type: string;
  fy: string;
  person_id?: string | null;
  entity_id?: string | null;
  property_id?: string | null;
  source_doc_id: string | null;
  employer?: string | null;
  employer_abn?: string | null;
  address_key?: string | null;
  agent?: string | null; // the managing agent named on a rent statement
  period_start?: string | null;
  period_end?: string | null;
}

export interface OnFileIncome extends IncomeIdentity {
  id: string;
}

export interface Supersession {
  /** Rows on file the incoming row replaces. */
  replace: OnFileIncome[];
  /** The incoming row restates part of a row on file: record nothing (the covering row's document stands). */
  coveredBy: OnFileIncome | null;
  /** Rows that partly overlap the incoming row's period: keep both, hold the incoming row for review. */
  overlap: OnFileIncome[];
}

const NONE: Supersession = { replace: [], coveredBy: null, overlap: [] };

const STREET_TYPES: Record<string, string> = {
  st: "st", street: "st", rd: "rd", road: "rd", ave: "ave", av: "ave", avenue: "ave", pde: "pde", parade: "pde",
  cres: "cres", crescent: "cres", ct: "ct", court: "ct", pl: "pl", place: "pl", dr: "dr", drive: "dr", hwy: "hwy",
  highway: "hwy", ln: "ln", lane: "ln", tce: "tce", terrace: "tce", cl: "cl", close: "cl", bvd: "bvd", blvd: "bvd",
  boulevard: "bvd", way: "way", cct: "cct", circuit: "cct", sq: "sq", square: "sq", gr: "gr", grove: "gr", esp: "esp", esplanade: "esp",
};

/**
 * A property address reduced to "<number> <street name> <street type>" ("12A Harbour Street, Sometown" →
 * "12a harbour st"), so two statements for one property agree while 12 and 12A, and Smith St and Smith Rd, stay
 * different. The type is left off when none is printed. Null when no street number is found.
 */
export function addressKey(hint: string | null | undefined): string | null {
  if (!hint) return null;
  const toks = hint.toLowerCase().replace(/[^a-z0-9/ ]+/g, " ").split(/\s+/).filter(Boolean);
  const i = toks.findIndex((t) => /\d/.test(t));
  if (i < 0) return null;
  const j = toks.findIndex((t, k) => k > i && /^[a-z]+$/.test(t));
  if (j < 0) return null;
  const type = toks.slice(j + 1, j + 3).map((t) => STREET_TYPES[t]).find(Boolean);
  return [toks[i], toks[j], type].filter(Boolean).join(" ");
}

const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");
const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

function sameEmployer(a: IncomeIdentity, b: IncomeIdentity): boolean {
  const abnA = digits(a.employer_abn);
  const abnB = digits(b.employer_abn);
  if (abnA.length === 11 && abnB.length === 11) return abnA === abnB;
  return !!norm(a.employer) && norm(a.employer) === norm(b.employer);
}

/** "same" = both rows carry the same property; "address" = they don't both carry one and the statement addresses
 *  agree (only ever grounds for review). Two different properties never match. */
function propertyMatch(a: IncomeIdentity, b: IncomeIdentity): "same" | "address" | null {
  if (a.property_id && b.property_id) return a.property_id === b.property_id ? "same" : null;
  return a.address_key && a.address_key === b.address_key ? "address" : null;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const iso = (d: string | null | undefined): d is string => !!d && ISO.test(d);

export function decideSupersession(userId: string, incoming: IncomeIdentity, onFile: OnFileIncome[]): Supersession {
  const peers = onFile.filter(
    (r) =>
      r.income_type === incoming.income_type &&
      (r.source_doc_id == null || r.source_doc_id !== incoming.source_doc_id) &&
      sameTaxpayer(userId, r, incoming),
  );
  if (incoming.income_type === "salary_payg") {
    if (!incoming.employer && !incoming.employer_abn) return NONE;
    return { ...NONE, replace: peers.filter((r) => r.fy === incoming.fy && sameEmployer(r, incoming)) };
  }
  if (incoming.income_type !== "rent" || !iso(incoming.period_start) || !iso(incoming.period_end)) return NONE;
  const out: Supersession = { replace: [], coveredBy: null, overlap: [] };
  for (const r of peers) {
    const match = propertyMatch(r, incoming);
    if (!match || !iso(r.period_start) || !iso(r.period_end)) continue;
    if (incoming.period_start > r.period_end || r.period_start > incoming.period_end) continue; // disjoint
    // Only a same-property, same-FY containment acts on its own; everything else that overlaps is reviewed.
    const decisive = match === "same" && r.fy === incoming.fy;
    if (decisive && incoming.period_start <= r.period_start && incoming.period_end >= r.period_end) out.replace.push(r);
    else if (decisive && r.period_start <= incoming.period_start && r.period_end >= incoming.period_end) out.coveredBy ??= r;
    else out.overlap.push(r);
  }
  // A row that is covered replaces nothing: the covering row already restates everything it would.
  return out.coveredBy ? { replace: [], coveredBy: out.coveredBy, overlap: [] } : out;
}

interface IncomeRow {
  id: string;
  income_type: string;
  fy: string;
  person_id: string | null;
  entity_id: string | null;
  property_id: string | null;
  source_doc_id: string | null;
  detail_json: string | null;
}

/** The identity a stored income row carries (its detail_json holds the employer, ABN, period and address). */
export function identityOf(row: IncomeRow): OnFileIncome {
  let d: Record<string, unknown> = {};
  try {
    d = row.detail_json ? (JSON.parse(row.detail_json) as Record<string, unknown>) : {};
  } catch {
    d = {};
  }
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const period = Array.isArray(d.period) ? d.period : [];
  return {
    id: row.id,
    income_type: row.income_type,
    fy: row.fy,
    person_id: row.person_id,
    entity_id: row.entity_id,
    property_id: row.property_id,
    source_doc_id: row.source_doc_id,
    employer: str(d.employer),
    employer_abn: str(d.employer_abn),
    address_key: str(d.address_key),
    agent: str(d.agent),
    period_start: str(d.period_start) ?? str(period[0]),
    period_end: str(d.period_end) ?? str(period[1]),
  };
}

/** Read the incoming row's peers on file and decide. */
export async function supersedeIncome(env: Env, userId: string, incoming: IncomeIdentity): Promise<Supersession> {
  const rows = await tenantDb(env, userId)
    .prepare(
      // Rent is compared across FYs (a calendar-year summary overlaps two); salary only within its FY.
      `SELECT id, income_type, fy, person_id, entity_id, property_id, source_doc_id, detail_json
         FROM income WHERE user_id = ? AND income_type = ?${incoming.income_type === "rent" ? "" : " AND fy = ?"}`,
    )
    .bind(...(incoming.income_type === "rent" ? [incoming.income_type] : [incoming.income_type, incoming.fy]))
    .all<IncomeRow>();
  return decideSupersession(userId, incoming, (rows.results ?? []).map(identityOf));
}

export interface RetiredIncome {
  id: string;
  income_type: string;
  fy: string;
  source_doc_id: string | null;
  period_start: string | null;
  period_end: string | null;
  txns_removed: number;
}

/**
 * Remove replaced income rows, AFTER the replacing row is written (so a failure part-way never loses the income).
 * Each row goes through the shared income delete, with a bank credit matched to it re-pointed to `replacementId`
 * first. For a document-sourced rent row, the transactions that document created go too (the replacing statement
 * restates them) and the document is marked superseded; its record and original stay as evidence. Returns what
 * was removed, for the audit record.
 */
export async function retireIncome(env: Env, userId: string, rows: OnFileIncome[], replacementId: string, byDocId: string | null): Promise<RetiredIncome[]> {
  const out: RetiredIncome[] = [];
  for (const r of rows) {
    await tenantDb(env, userId).prepare(`UPDATE transactions SET matched_income_id = ? WHERE user_id = ? AND matched_income_id = ?`).bind(replacementId, r.id).run();
    await deleteIncomeRow(env, userId, r.id);
    let txns_removed = 0;
    if (r.income_type === "rent" && r.source_doc_id) {
      txns_removed = await deleteDocumentTransactions(env, userId, r.source_doc_id);
      await markSuperseded(env, userId, r.source_doc_id, byDocId);
    }
    out.push({ id: r.id, income_type: r.income_type, fy: r.fy, source_doc_id: r.source_doc_id, period_start: r.period_start ?? null, period_end: r.period_end ?? null, txns_removed });
  }
  return out;
}

/** Note on a document's extracted_json that another document restates it (it no longer counts). Skipped when the
 *  stored JSON isn't valid, rather than throwing part-way through a supersession. */
export async function markSuperseded(env: Env, userId: string, docId: string, byDocId: string | null): Promise<void> {
  await tenantDb(env, userId)
    .prepare(
      `UPDATE documents SET extracted_json = json_set(COALESCE(extracted_json, '{}'), '$.superseded_by', ?)
        WHERE user_id = ? AND id = ? AND json_valid(COALESCE(extracted_json, '{}'))`,
    )
    .bind(byDocId, docId)
    .run();
}

/**
 * Settle one property's rent after rows were filed under it (property_from_statement: a statement's address
 * became a property). Rows that matched only by address were held for review; now that they share a property,
 * the same rule decides: longest period first, each row replaces the same-FY rows it covers. Returns what was
 * retired (for the audit record).
 */
export async function settlePropertyRent(env: Env, userId: string, propertyId: string): Promise<RetiredIncome[]> {
  const rows = await tenantDb(env, userId)
    .prepare(
      `SELECT id, income_type, fy, person_id, entity_id, property_id, source_doc_id, detail_json
         FROM income WHERE user_id = ? AND income_type = 'rent' AND property_id = ?`,
    )
    .bind(propertyId)
    .all<IncomeRow>();
  const span = (r: OnFileIncome) => (iso(r.period_start) && iso(r.period_end) ? Date.parse(r.period_end) - Date.parse(r.period_start) : -1);
  let live = (rows.results ?? []).map(identityOf).sort((a, b) => span(b) - span(a));
  const retired: RetiredIncome[] = [];
  for (const r of [...live]) {
    if (!live.some((x) => x.id === r.id)) continue; // already replaced by a longer statement
    // Rows filed under one property by their address alone may still be two properties whose keys collide, so
    // settling acts only between statements with the same address AND the same managing agent; anything else
    // stays as it is (both visible), never deleted (ADR-0006).
    const sameSource = (x: OnFileIncome) => x.id !== r.id && !!x.address_key && x.address_key === r.address_key && norm(x.agent) === norm(r.agent) && !!norm(r.agent);
    const d = decideSupersession(userId, r, live.filter(sameSource));
    if (!d.replace.length) continue;
    retired.push(...(await retireIncome(env, userId, d.replace, r.id, r.source_doc_id)));
    live = live.filter((x) => !d.replace.some((y) => y.id === x.id));
  }
  return retired;
}
