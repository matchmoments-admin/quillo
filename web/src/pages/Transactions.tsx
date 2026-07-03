import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Panel, PanelHead, Card, BucketPill, Input, Spinner, money, BUCKET_LABEL } from "../components/ui";
import { useActiveFy } from "../lib/activeFy";
import { BulkBar, type BulkDone } from "../components/BulkBar";
import { UndoToast } from "../components/UndoToast";
import { ReviewView } from "../components/ReviewView";
import { useFeatures } from "../lib/features";
import { BUCKETS } from "../types";
import type { Txn } from "../types";

/**
 * Transactions — the browse-everything view (distinct from the Inbox review queue). Search, filter by
 * tax year (the same ← FY → switcher used across the app) / date range / category / property, and
 * group by category·property·account·month. Loads ALL transactions for the scope (paging the
 * 500-capped list endpoint) so search/filter/group run client-side. Drill-through from the Dashboard
 * breakdowns lands here with ?bucket= / ?property= pre-applied. Read-only — each row opens TxnDetail.
 * General information only.
 */

const GROUP_OPTS = [
  { key: "none", label: "None" },
  { key: "bucket", label: "Category" },
  { key: "property", label: "Property" },
  { key: "account", label: "Account" },
  { key: "month", label: "Month" },
] as const;
type GroupKey = (typeof GROUP_OPTS)[number]["key"];

// Page the 500-capped endpoint until exhausted, so the whole scope is in memory for client-side work.
async function fetchAll(opts: { fy?: number; countable?: boolean }): Promise<Txn[]> {
  const all: Txn[] = [];
  for (let offset = 0; offset <= 20000; offset += 500) {
    const page = await api.transactions({ ...opts, limit: 500, offset });
    all.push(...page);
    if (page.length < 500) break;
  }
  return all;
}

const amt = (t: Txn) => t.amount_aud_cents ?? t.amount_cents ?? 0;
const isCredit = (t: Txn) => (t.direction ?? "debit") === "credit";

export function Transactions() {
  const { fy: activeFy, label: fyLabelStr } = useActiveFy();
  const { has } = useFeatures();
  const qc = useQueryClient();
  const bulk = has("txn_bulk_edit"); // #252: multi-select + BulkBar on this page
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [flash, setFlash] = useState<BulkDone | null>(null);
  const [params, setSearchParams] = useSearchParams();
  const [allYears, setAllYears] = useState(false);
  const [showExcluded, setShowExcluded] = useState(false);
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // Seed category/property from a Dashboard drill-through (?bucket= / ?property=).
  const [bucket, setBucket] = useState(params.get("bucket") ?? "");
  const [propertyId, setPropertyId] = useState(params.get("property") ?? "");
  // ?undated=true lands here from the Dashboard "add dates" CTA — show only items missing a date so the
  // user can open each and add one (the CTA used to point at the read-only report, where they couldn't).
  const [undatedOnly, setUndatedOnly] = useState(params.get("undated") === "true");
  const [kind, setKind] = useState(""); // "" | "receipt" | "bank_line" — absorbs the old Inbox Receipts/Bank-lines tabs
  const [group, setGroup] = useState<GroupKey>("none");

  // Needs review (default) / All segmented control, persisted in ?view=. Default to review unless a
  // Dashboard drill-through (?bucket= / ?property=) is present, which lands on the browse view.
  const drill = !!(params.get("bucket") || params.get("property") || params.get("undated"));
  const viewParam = params.get("view");
  const view: "review" | "all" = viewParam === "all" ? "all" : viewParam === "review" ? "review" : drill ? "all" : "review";
  const setView = (v: "review" | "all") =>
    setSearchParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        n.set("view", v);
        return n;
      },
      { replace: true },
    );

  const { data: situation } = useQuery({ queryKey: ["situation"], queryFn: api.situation });
  const { data: accounts } = useQuery({ queryKey: ["accounts"], queryFn: api.accounts });
  const properties = situation?.properties ?? [];
  const propLabel = (id: string | null | undefined) => (id ? properties.find((p) => p.id === id)?.label ?? id : null);
  const acctLabel = (id: string | null | undefined) => (id ? accounts?.find((a) => a.id === id)?.name ?? null : null);

  const { data, isLoading, error } = useQuery({
    // countable here only drops duplicate/ignored (keeps both directions) — see listTransactions.
    // Undated items belong to no FY, so the FY-scoped fetch would never include them — load all years
    // when filtering to undated.
    queryKey: ["transactions-all", allYears || undatedOnly ? "all" : activeFy, showExcluded],
    queryFn: () => fetchAll({ fy: allYears || undatedOnly ? undefined : activeFy, countable: !showExcluded }),
    // Skip the full-scope load while the review tab is showing (it has its own all-time query).
    enabled: view === "all",
  });

  const all = useMemo(() => data ?? [], [data]); // stable ref so `filtered` only recomputes on new data or filter change

  // Client-side search + date-range + category + property filters over the loaded scope.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all.filter((t) => {
      if (bucket && t.bucket !== bucket) return false;
      if (propertyId && t.property_id !== propertyId) return false;
      if (undatedOnly && t.txn_date) return false;
      if (kind && t.kind !== kind) return false;
      if (from && (!t.txn_date || t.txn_date < from)) return false;
      if (to && (!t.txn_date || t.txn_date > to)) return false;
      if (q) {
        const hay = `${t.merchant ?? ""} ${t.raw_description ?? ""} ${t.ato_label ?? ""} ${BUCKET_LABEL[t.bucket ?? ""] ?? t.bucket ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [all, search, from, to, bucket, propertyId, kind, undatedOnly]);

  // Headline: count + spend/income split (summing across directions would be meaningless).
  const spend = filtered.filter((t) => !isCredit(t)).reduce((s, t) => s + Math.abs(amt(t)), 0);
  const income = filtered.filter(isCredit).reduce((s, t) => s + Math.abs(amt(t)), 0);

  const groupOf = (t: Txn): string => {
    switch (group) {
      case "bucket": return BUCKET_LABEL[t.bucket ?? ""] ?? t.bucket ?? "Uncategorised";
      case "property": return propLabel(t.property_id) ?? "No property";
      case "account": return acctLabel(t.account_id) ?? (t.source === "receipt" ? "Receipt" : "No account");
      case "month": return t.txn_date ? t.txn_date.slice(0, 7) : "Undated";
      default: return "";
    }
  };

  // Group the FULL filtered set so each group's subtotal/count is accurate (no windowing — the user
  // wants everything loaded; the scope is one FY's lines, comfortably renderable).
  const groups = useMemo(() => {
    if (group === "none") return [{ key: "", rows: filtered }];
    const m = new Map<string, Txn[]>();
    for (const t of filtered) {
      const k = groupOf(t);
      (m.get(k) ?? m.set(k, []).get(k)!).push(t);
    }
    return [...m.entries()].map(([key, rows]) => ({ key, rows }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, group, situation, accounts]);

  // #252: selection helpers for bulk edit (flag txn_bulk_edit).
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const selectAll = () => setSelected(new Set(filtered.map((t) => t.id)));
  const clearSel = () => setSelected(new Set());

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Transactions</h1>
        {/* #251: no page-level FY switcher — the global one in the app header is the single canonical
            year control. "All years" below is the only page-scoped year toggle. */}
      </div>

      {/* One transaction surface with a Needs review / All
          segmented control — matches Xero/QBO/MYOB. Needs review is the all-time backlog; All is the
          FY-scoped browse. Hidden (flag OFF) ⇒ this page is the browse view exactly as before. */}
      <div className="inline-flex rounded-lg border border-line p-0.5 text-sm" role="tablist" aria-label="Transaction view">
          {(["review", "all"] as const).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className={`rounded-md px-3 py-1.5 font-medium transition ${view === v ? "bg-ink text-white" : "text-muted hover:text-ink"}`}
            >
              {v === "review" ? "Needs review" : "All"}
            </button>
          ))}
        </div>

      {view === "review" ? (
        <ReviewView />
      ) : (
        <>
      {/* Toolbar — search, date range, category/property filters, group-by, scope toggles. */}
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={search}
            onChange={(e) => { setSearch(e.target.value); }}
            placeholder="Search merchant, description, category…"
            aria-label="Search transactions"
            className="min-w-[14rem] flex-1"
          />
          <select value={group} onChange={(e) => setGroup(e.target.value as GroupKey)} aria-label="Group by" className="rounded-lg border border-line bg-card px-2 py-2 text-sm">
            {GROUP_OPTS.map((g) => <option key={g.key} value={g.key}>{g.key === "none" ? "Group: none" : `Group: ${g.label}`}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <select value={bucket} onChange={(e) => { setBucket(e.target.value); }} aria-label="Category" className="rounded-lg border border-line bg-card px-2 py-2">
            <option value="">All categories</option>
            {BUCKETS.map((b) => <option key={b} value={b}>{BUCKET_LABEL[b] ?? b}</option>)}
          </select>
          {properties.length > 0 && (
            <select value={propertyId} onChange={(e) => { setPropertyId(e.target.value); }} aria-label="Property" className="rounded-lg border border-line bg-card px-2 py-2">
              <option value="">All properties</option>
              {properties.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          )}
          {/* Kind filter — absorbs the old Inbox Receipts / Bank-lines tabs into the one browse view. */}
          <select value={kind} onChange={(e) => { setKind(e.target.value); }} aria-label="Kind" className="rounded-lg border border-line bg-card px-2 py-2">
            <option value="">All kinds</option>
            <option value="receipt">Receipts</option>
            <option value="bank_line">Bank lines</option>
          </select>
          <label className="flex items-center gap-1.5 text-xs text-muted">From <Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); }} className="px-2 py-1.5" /></label>
          <label className="flex items-center gap-1.5 text-xs text-muted">to <Input type="date" value={to} onChange={(e) => { setTo(e.target.value); }} className="px-2 py-1.5" /></label>
          {undatedOnly && (
            <span className="inline-flex items-center gap-1 rounded-full bg-warn/10 px-2 py-0.5 text-xs font-medium text-warn">
              Undated only
              <button onClick={() => setUndatedOnly(false)} aria-label="Clear undated filter" className="hover:text-ink">✕</button>
            </span>
          )}
          {(search || from || to || bucket || propertyId || kind || undatedOnly) && (
            <button onClick={() => { setSearch(""); setFrom(""); setTo(""); setBucket(""); setPropertyId(""); setKind(""); setUndatedOnly(false); }} className="text-xs font-medium text-muted hover:text-ink">
              Clear filters ✕
            </button>
          )}
          <span className="flex-1" />
          <label className="flex items-center gap-1.5 text-xs text-muted" title="Load every year instead of the selected FY">
            <input type="checkbox" checked={allYears} onChange={(e) => setAllYears(e.target.checked)} className="h-3.5 w-3.5" /> All years
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted" title="Include transfers, repayments and duplicates that are normally excluded from your totals">
            <input type="checkbox" checked={showExcluded} onChange={(e) => setShowExcluded(e.target.checked)} className="h-3.5 w-3.5" /> Show excluded
          </label>
        </div>
      </Card>

      {isLoading ? (
        <Spinner />
      ) : error ? (
        <Card className="p-6 text-sm text-muted">Couldn't load: {(error as Error).message}</Card>
      ) : (
        <Panel>
          <PanelHead
            title="All transactions"
            sub={`${filtered.length} shown · ${all.length} ${allYears ? "across all years" : `in FY ${fyLabelStr}`}${showExcluded ? " · incl. excluded" : ""} · spend ${money(spend)} · income ${money(income)}`}
            right={
              bulk && filtered.length > 0
                ? selected.size > 0
                  ? <button onClick={clearSel} className="text-xs font-medium text-muted hover:text-ink">Clear selection ({selected.size})</button>
                  : <button onClick={selectAll} className="text-xs font-medium text-muted hover:text-ink">Select all ({filtered.length})</button>
                : undefined
            }
          />
          {filtered.length === 0 ? (
            <div className="py-6 text-sm text-muted">No transactions match these filters.</div>
          ) : (
            <div className="space-y-4">
              {groups.map((g) => (
                <div key={g.key || "all"}>
                  {group !== "none" && (
                    <div className="flex items-baseline justify-between gap-3 border-b border-line px-1 pb-1 pt-2">
                      <span className="text-sm font-semibold">{g.key || "—"}</span>
                      <span className="text-xs text-muted tabular-nums">{g.rows.length} · {money(g.rows.reduce((s, t) => s + Math.abs(amt(t)), 0))}</span>
                    </div>
                  )}
                  <ul className="divide-y divide-line">
                    {g.rows.map((t) => (
                      <li key={t.id} className="flex items-center gap-2">
                        {bulk && (
                          <input
                            type="checkbox"
                            checked={selected.has(t.id)}
                            onChange={() => toggle(t.id)}
                            aria-label={`Select ${t.merchant ?? "transaction"}`}
                            className="h-4 w-4 shrink-0"
                          />
                        )}
                        <div className="min-w-0 flex-1">
                          <TxnRow t={t} propLabel={propLabel(t.property_id)} acctLabel={acctLabel(t.account_id)} />
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </Panel>
      )}

      {/* #252: bulk re-categorise — select look-alikes (search/filter/group above isolate them) and
          apply a category + property in one audited, undoable batch, optionally learning a rule. */}
      {bulk && selected.size > 0 && (
        <BulkBar
          ids={[...selected]}
          onClear={clearSel}
          onDone={(d) => { qc.invalidateQueries({ queryKey: ["transactions-all"] }); setFlash(d); }}
        />
      )}
      {flash && <UndoToast flash={flash} onClose={() => setFlash(null)} />}
        </>
      )}
    </div>
  );
}

function TxnRow({ t, propLabel, acctLabel }: { t: Txn; propLabel: string | null; acctLabel: string | null }) {
  const credit = isCredit(t);
  return (
    <Link to={`/txn/${t.id}`} className="flex items-center gap-3 py-2.5 transition hover:opacity-70">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{t.merchant ?? t.raw_description ?? "Unknown"}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
          <BucketPill bucket={t.bucket} />
          {propLabel && <span className="rounded-full bg-surface px-2 py-0.5">{propLabel}</span>}
          {acctLabel && <span className="rounded-full bg-surface px-2 py-0.5">{acctLabel}</span>}
          <span className={t.txn_date ? "" : "text-warn"}>{t.txn_date ?? "undated"}</span>
          {(t.status === "duplicate" || t.status === "ignored") && (
            <span className="rounded-full bg-warn/10 px-2 py-0.5 font-medium text-warn">{t.status}</span>
          )}
        </div>
      </div>
      <div className={`flex-none text-right text-sm font-semibold tabular-nums ${credit ? "text-safe" : ""}`}>
        {credit ? "+" : ""}{money(Math.abs(amt(t)))}
      </div>
    </Link>
  );
}
