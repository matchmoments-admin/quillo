import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError, isDeleteBlocked } from "../api";
import { useFeatures } from "../lib/features";
import { useActiveFy } from "../lib/activeFy";
import { Button, Card, Spinner, money, InfoTip } from "../components/ui";
import type { Account, StatementInfo, StatementParse } from "../types";

const SOURCE_LABEL: Record<string, string> = {
  qbo_feed: "QuickBooks feed",
  statement: "Statement upload",
  manual: "Manual",
};

const STATUS_LABEL: Record<string, string> = {
  parsed: "ready to import",
  categorising: "categorising…",
  imported: "imported",
  failed: "failed",
};

export function Accounts() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["accounts"], queryFn: () => api.accounts() });
  // Statement statuses (for async progress + failures). Poll while anything is categorising.
  const { data: statements } = useQuery({
    queryKey: ["statements"],
    queryFn: () => api.statements(),
    refetchInterval: (q) => ((q.state.data ?? []).some((s) => s.status === "categorising") ? 5000 : false),
  });
  // Toast when a statement finishes background categorisation (categorising → imported), so the
  // user gets closure even if they've navigated away from the upload. Seed the prior-status map
  // on first load so already-imported statements don't fire a stale toast on mount.
  const prevStatus = useRef<Map<string, string>>(new Map());
  const seeded = useRef(false);
  useEffect(() => {
    if (!statements) return;
    if (seeded.current) {
      for (const s of statements) {
        if (prevStatus.current.get(s.id) === "categorising" && s.status === "imported") {
          const n = s.categorised_count ?? s.total_lines ?? s.imported_count;
          toast.success("Categorisation complete", {
            description: `${s.filename ?? "Statement"} — ${n != null ? `${n} ` : ""}transactions categorised.`,
          });
        }
      }
    }
    prevStatus.current = new Map(statements.map((s) => [s.id, s.status]));
    seeded.current = true;
  }, [statements]);
  const sync = useMutation({
    mutationFn: () => api.syncQboAccounts(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["accounts"] }),
  });
  // Bulk-confirm every parsed-but-not-imported statement in one click (flag `bulk_import`).
  const { has } = useFeatures();
  const navigate = useNavigate();
  const parsedCount = (statements ?? []).filter((s) => s.status === "parsed").length;
  const bulkImport = useMutation({
    mutationFn: () => api.confirmImportBulk(),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["statements"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      const errs = r.errors.length ? ` ${r.errors.length} couldn't import (e.g. didn't reconcile).` : "";
      // Steer to the Dashboard hub (WFH card + your likely-claims) rather than dead-ending here —
      // a statements-only PAYG user's biggest claims aren't statement lines (G7).
      toast.success(`Imported ${r.statements} statement(s)`, {
        description: `${r.imported} transaction(s)${r.skipped ? `, ${r.skipped} already on file` : ""}.${errs}`,
        action: { label: "See your claims", onClick: () => navigate("/dashboard") },
      });
    },
    onError: (e) => toast.error("Bulk import failed", { description: (e as Error).message }),
  });

  if (isLoading) return <Spinner />;
  if (error) return <Card className="p-6 text-sm text-muted">Couldn't load accounts: {(error as Error).message}</Card>;
  const accounts = data ?? [];
  const byAccount = (statements ?? []).reduce<Record<string, StatementInfo[]>>((m, s) => {
    (m[s.account_id] ??= []).push(s);
    return m;
  }, {});

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Accounts</h1>
        <p className="hidden text-sm text-muted sm:block">Statement upload for accounts without a working bank feed</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <AddAccount onAdded={() => qc.invalidateQueries({ queryKey: ["accounts"] })} />
      </div>

      <div className="flex items-center gap-3">
        <Button variant="ghost" onClick={() => sync.mutate()} disabled={sync.isPending}>
          {sync.isPending ? "Syncing…" : "↻ Sync accounts from QuickBooks"}
        </Button>
        {sync.isSuccess && <span className="text-sm text-muted">Added {sync.data.synced} feed account(s).</span>}
        {sync.isError && <span className="text-sm text-danger">{(sync.error as Error).message}</span>}
        {has("bulk_import") && parsedCount > 0 && (
          <Button onClick={() => bulkImport.mutate()} disabled={bulkImport.isPending}>
            {bulkImport.isPending ? "Importing…" : `Import all reconciled (${parsedCount})`}
          </Button>
        )}
      </div>

      {accounts.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted">
          No accounts yet. Add each bank/card/investment account above, then upload its statement (CSV/PDF) — or sync your
          QuickBooks feed accounts.
        </Card>
      ) : (
        <ul className="space-y-3">
          {accounts.map((a) => (
            <AccountRow key={a.id} account={a} statements={byAccount[a.id] ?? []} />
          ))}
        </ul>
      )}
    </div>
  );
}

function AddAccount({ onAdded }: { onAdded: () => void }) {
  const [name, setName] = useState("");
  const [institution, setInstitution] = useState("");
  const [type, setType] = useState("transaction");
  const add = useMutation({
    mutationFn: () => api.addAccount({ name, institution, type, source: "statement" }),
    onSuccess: () => {
      setName("");
      setInstitution("");
      onAdded();
    },
  });
  return (
    <Card className="flex flex-wrap items-end gap-3 p-4">
      <label className="flex-1 min-w-[10rem]">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">Account name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Westpac Everyday" className="mt-1 w-full rounded-lg border border-line px-3 py-2" />
      </label>
      <label className="min-w-[8rem]">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">Bank</span>
        <input value={institution} onChange={(e) => setInstitution(e.target.value)} placeholder="Westpac" className="mt-1 w-full rounded-lg border border-line px-3 py-2" />
      </label>
      <label className="min-w-[9rem]">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">Type <InfoTip k="account_type" /></span>
        <select value={type} onChange={(e) => setType(e.target.value)} className="mt-1 w-full rounded-lg border border-line bg-card px-3 py-2">
          <option value="transaction">Transaction</option>
          <option value="credit_card">Credit card</option>
          <option value="loan">Loan</option>
          <option value="investment">Investment</option>
        </select>
      </label>
      <Button onClick={() => name && add.mutate()} disabled={!name || add.isPending}>
        {add.isPending ? "Adding…" : "+ Add account"}
      </Button>
    </Card>
  );
}

// Per-file state for a multi-file (batch) upload. The single per-tenant Durable Object only safely
// parses one statement at a time (a second concurrent parse queues behind it and can 502), so a
// batch is run STRICTLY SEQUENTIALLY client-side — this queue is just the visible progress of that
// loop. Each parsed file persists server-side as a 'parsed' statement; the page-level "Import all
// reconciled" button then commits them in one go.
type QStatus = "pending" | "parsing" | "balanced" | "mismatch" | "noverify" | "dup" | "error" | "skipped";
type QItem = { name: string; status: QStatus; detail?: string };

// Map a parse result to a one-line verdict, mirroring the single-file reconciliation banner.
function verdictFor(p: StatementParse): { status: QStatus; detail: string } {
  if (p.duplicate) return { status: "dup", detail: "already imported" };
  const r = p.reconciliation;
  if (r?.available && r.ok) return { status: "balanced", detail: `balances · ${p.rowCount} txns` };
  if (r?.available && !r.ok) return { status: "mismatch", detail: `off by ${money(Math.abs(r.diff_cents))} · review` };
  return { status: "noverify", detail: `${p.rowCount} txns · eyeball` };
}

const Q_GLYPH: Record<QStatus, string> = {
  pending: "·",
  parsing: "…",
  balanced: "✓",
  mismatch: "⚠",
  noverify: "•",
  dup: "↺",
  error: "✕",
  skipped: "–",
};
const Q_TONE: Record<QStatus, string> = {
  pending: "text-muted",
  parsing: "text-muted",
  balanced: "text-safe",
  mismatch: "text-danger",
  noverify: "text-warn",
  dup: "text-muted",
  error: "text-danger",
  skipped: "text-muted",
};

function AccountRow({ account, statements }: { account: Account; statements: StatementInfo[] }) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [parse, setParse] = useState<StatementParse | null>(null);
  const [queue, setQueue] = useState<QItem[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // A parse holds the single per-tenant Durable Object; let only one run at a time so a second
  // upload doesn't queue behind it and time out (the 502). True while ANY row is parsing.
  const anyParsing = useIsMutating({ mutationKey: ["parseStatement"] }) > 0;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["accounts"] });
    qc.invalidateQueries({ queryKey: ["statements"] });
  };

  const doParse = useMutation({
    mutationKey: ["parseStatement"], // shared key so all rows can see when ANY parse is in flight
    mutationFn: (file: File) => api.parseStatement(file, account.id),
    onMutate: () => setNote("Reading your statement…"),
    onSuccess: (p) => {
      if (p.duplicate) {
        setNote("This exact file was already imported.");
        setParse(null);
      } else {
        setNote(null);
        setParse(p);
      }
    },
    onError: (e) => {
      setNote(`Couldn't read: ${(e as Error).message}`);
      toast.error(`Couldn't read ${account.name}'s statement`, { description: (e as Error).message });
    },
  });

  // Sequential batch parse. Shares the ["parseStatement"] key so `anyParsing` disables every other
  // row's upload while a batch runs (the single-DO 502 guard). A 429 (AI budget) / 403 (consent)
  // halts the run and marks the remaining files skipped — those are whole-session conditions that
  // won't clear mid-batch, so there's no point hammering them; everything parsed so far is kept.
  const doBatch = useMutation({
    mutationKey: ["parseStatement"],
    mutationFn: async (files: File[]) => {
      const set = (i: number, patch: Partial<QItem>) => setQueue((q) => (q ? q.map((it, idx) => (idx === i ? { ...it, ...patch } : it)) : q));
      let parsed = 0;
      for (let i = 0; i < files.length; i++) {
        set(i, { status: "parsing" });
        try {
          const p = await api.parseStatement(files[i], account.id);
          set(i, verdictFor(p));
          if (!p.duplicate) parsed++;
        } catch (e) {
          const status = e instanceof ApiError ? e.status : 0;
          set(i, { status: "error", detail: (e as Error).message });
          if (status === 429 || status === 403) {
            setQueue((q) => (q ? q.map((it, idx) => (idx > i ? { ...it, status: "skipped" as QStatus, detail: status === 403 ? "consent needed" : "AI paused for today" } : it)) : q));
            return { parsed, halted: true as const };
          }
        }
      }
      return { parsed, halted: false as const };
    },
    onSettled: () => invalidate(), // surface the freshly-'parsed' statements as chips + light up "Import all reconciled"
    onSuccess: ({ parsed, halted }) => {
      if (parsed > 0) {
        toast.success(`Parsed ${parsed} statement(s)`, {
          description: `Use “Import all reconciled” at the top of the page to import ${parsed === 1 ? "it" : "them"}.`,
        });
      } else if (halted) {
        toast.error("Couldn't parse the batch", { description: "AI is paused or consent is needed — nothing was imported." });
      }
    },
    onError: (e) => toast.error("Batch upload failed", { description: (e as Error).message }),
  });

  const doConfirm = useMutation({
    mutationFn: (force?: boolean) => api.confirmImport(parse!.statementId, force),
    onSuccess: (r) => {
      setNote(`Imported ${r.imported} transaction(s)${r.skipped ? ` (${r.skipped} already on file)` : ""}.`);
      setParse(null);
      invalidate();
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success(`Imported ${r.imported} transaction(s)`, {
        description: "Categorising in the background — you can keep working or upload another statement.",
      });
    },
    onError: (e) => {
      setNote(`Import failed: ${(e as Error).message}`);
      toast.error("Import failed", { description: (e as Error).message });
    },
  });

  const setSource = useMutation({
    mutationFn: (source: string) => api.setAccountSource(account.id, source),
    onSuccess: invalidate,
  });
  const archive = useMutation({
    mutationFn: () => api.archiveAccount(account.id),
    onSuccess: () => {
      toast.success(`Archived "${account.name}"`, { description: "Hidden from lists; its transactions stay counted." });
      invalidate();
    },
    onError: (e) => toast.error("Couldn't archive", { description: (e as Error).message }),
  });
  const del = useMutation({
    mutationFn: () => api.deleteAccount(account.id),
    onSuccess: invalidate,
    onError: (e) => {
      // Blocked because transactions/statements still reference it — offer the non-destructive archive.
      if (isDeleteBlocked(e) && e.archivable) {
        toast.error(e.message, {
          description: "Archive it instead to hide it without losing the data.",
          action: { label: "Archive", onClick: () => archive.mutate() },
        });
      } else {
        toast.error("Couldn't delete account", { description: (e as Error).message });
      }
    },
  });

  const isFeed = account.source === "qbo_feed";

  return (
    <li>
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-medium">
              {account.name} {account.last4 && <span className="text-muted">····{account.last4}</span>}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-muted">
              <span>{account.institution ?? "—"}</span>
              <span>·</span>
              <span className="capitalize">{account.type.replace("_", " ")}</span>
              <span>·</span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${isFeed ? "bg-ink/5 text-ink" : "bg-surface text-ink"}`}>
                {SOURCE_LABEL[account.source] ?? account.source}
              </span>
              <InfoTip k="account_source" />
              {account.line_count ? <span className="text-xs">· {account.line_count} lines</span> : null}
            </div>
            {statements.length > 0 && (
              <div className="mt-1 flex flex-col gap-1 text-xs text-muted">
                {statements.map((s) => (
                  <StatementChip key={s.id} statement={s} onChange={invalidate} />
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-none items-center gap-1">
            {!isFeed && (
              <>
                <Button variant="ghost" onClick={() => fileRef.current?.click()} disabled={anyParsing}>
                  {doParse.isPending || doBatch.isPending ? "Reading…" : anyParsing ? "Waiting…" : "Upload statements (CSV/PDF)"}
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  accept=".csv,text/csv,.pdf,application/pdf"
                  className="hidden"
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.currentTarget.value = "";
                    if (files.length === 0) return;
                    // One file keeps the rich inline preview; many files run the sequential queue.
                    if (files.length === 1) {
                      doParse.mutate(files[0]);
                      return;
                    }
                    setParse(null);
                    setNote(null);
                    setQueue(files.map((f) => ({ name: f.name, status: "pending" })));
                    doBatch.mutate(files);
                  }}
                />
              </>
            )}
            <button onClick={() => setEditing((v) => !v)} className="rounded-lg px-2 py-1.5 text-sm text-muted hover:text-ink" title="Manage">
              {editing ? "Done" : "Manage"}
            </button>
          </div>
        </div>

        {isFeed && <p className="mt-2 text-xs text-muted">Reconciled from QuickBooks — don't upload statements (would double-count).</p>}

        {editing && (
          <EditAccount
            account={account}
            sourcePending={setSource.isPending}
            onSource={(s) => setSource.mutate(s)}
            onSaved={() => {
              setEditing(false);
              invalidate();
            }}
            onDelete={() => {
              if (confirm(`Delete "${account.name}"? If it still has transactions or statements, the delete is blocked — you'll be offered Archive instead (keeps the data, hides the account).`)) del.mutate();
            }}
            deletePending={del.isPending || archive.isPending}
          />
        )}

        {note && <p className="mt-2 text-sm text-muted">{note}</p>}

        {queue &&
          (() => {
            const done = queue.filter((q) => q.status !== "pending" && q.status !== "parsing").length;
            const ready = queue.filter((q) => q.status === "balanced" || q.status === "noverify" || q.status === "mismatch").length;
            return (
              <div className="mt-3 space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">
                    {doBatch.isPending ? `Uploading ${queue.length} statements…` : `Parsed ${done} of ${queue.length}`}
                  </span>
                  <span className="tabular-nums text-muted">
                    {done}/{queue.length}
                  </span>
                </div>
                <ul className="max-h-64 overflow-auto rounded-lg border border-line text-sm">
                  {queue.map((q, i) => (
                    <li key={i} className="flex items-center gap-2 border-t border-line px-3 py-1.5 first:border-0">
                      {q.status === "parsing" ? (
                        <span className="h-3.5 w-3.5 flex-none animate-spin rounded-full border-2 border-line border-t-ink" />
                      ) : (
                        <span className={`w-4 flex-none text-center ${Q_TONE[q.status]}`}>{Q_GLYPH[q.status]}</span>
                      )}
                      <span className="min-w-0 flex-1 truncate">{q.name}</span>
                      {q.detail && <span className={`flex-none text-xs ${Q_TONE[q.status]}`}>{q.detail}</span>}
                    </li>
                  ))}
                </ul>
                {!doBatch.isPending && (
                  <div className="flex items-center gap-3">
                    {ready > 0 && <span className="text-sm text-muted">{ready} ready — use “Import all reconciled” at the top of the page.</span>}
                    <Button variant="ghost" onClick={() => setQueue(null)}>
                      Done
                    </Button>
                  </div>
                )}
              </div>
            );
          })()}

        {parse &&
          (() => {
            const recon = parse.reconciliation;
            const balanced = recon?.available && recon.ok;
            const mismatch = recon?.available && !recon.ok;
            return (
              <div className="mt-3 space-y-2">
                {/* Reconciliation verdict — the proof the import is complete + accurate. */}
                {recon?.available ? (
                  balanced ? (
                    <div className="rounded-lg bg-safe/10 px-3 py-2 text-sm text-safe">✓ Balances — {parse.rowCount} transactions reconcile to the statement total.</div>
                  ) : (
                    <div className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
                      ⚠ Doesn't reconcile — off by {money(Math.abs(recon.diff_cents))}
                      {recon.first_bad_line != null ? `, first wrong around line ${recon.first_bad_line + 1}` : ""}. Review below before importing.
                    </div>
                  )
                ) : (
                  <div className="rounded-lg bg-warn/10 px-3 py-2 text-sm text-warn">No running balance on this statement — couldn't self-verify. Please eyeball the rows.</div>
                )}
                <div className="text-sm">
                  Found <span className="font-medium">{parse.rowCount}</span> transactions <InfoTip k="reconcile" />. Preview (first {parse.preview.length}):
                </div>
                <div className="max-h-64 overflow-auto rounded-lg border border-line">
                  <table className="w-full text-sm">
                    <tbody>
                      {parse.preview.map((l, i) => (
                        <tr key={i} className={`border-t border-line first:border-0 ${recon?.first_bad_line === i ? "bg-danger/5" : ""}`}>
                          <td className="px-3 py-1.5 text-muted">{l.date ?? "—"}</td>
                          <td className="px-3 py-1.5">{l.description}</td>
                          <td className={`px-3 py-1.5 text-right tabular-nums ${l.direction === "credit" ? "text-safe" : ""}`}>
                            {l.direction === "credit" ? "+" : ""}
                            {money(l.amount_cents)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex gap-2">
                  {!mismatch ? (
                    <Button onClick={() => doConfirm.mutate(false)} disabled={doConfirm.isPending}>
                      {doConfirm.isPending ? "Importing…" : `Import ${parse.rowCount} transactions`}
                    </Button>
                  ) : (
                    <Button variant="ghost" onClick={() => doConfirm.mutate(true)} disabled={doConfirm.isPending} className="border-danger/40 text-danger">
                      {doConfirm.isPending ? "Importing…" : "Import anyway (override)"}
                    </Button>
                  )}
                  <Button variant="ghost" onClick={() => setParse(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            );
          })()}
      </Card>
    </li>
  );
}

// One row in an account's statement list. A persisted 'parsed' ("ready to import") statement gets
// Import + Remove actions (the in-session confirm only existed right after upload, so a parsed
// statement was previously stuck); a reconcile-gate failure offers "Import anyway" (force). A
// 'failed' parse can be removed. Imported transactions are never touched by Remove.
function StatementChip({ statement: s, onChange }: { statement: StatementInfo; onChange: () => void }) {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const imp = useMutation({
    mutationFn: (force?: boolean) => api.confirmImport(s.id, force),
    onSuccess: (r) => {
      setErr(null);
      toast.success(`Imported ${r.imported} transaction(s)`, { description: r.skipped ? `${r.skipped} already on file.` : "Categorising in the background." });
      onChange();
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e) => setErr((e as Error).message),
  });
  const del = useMutation({
    mutationFn: (purge?: boolean) => api.deleteStatement(s.id, purge),
    onSuccess: (r) => {
      toast.success(r.linesRemoved ? `Removed (${r.linesRemoved} transactions deleted) — re-upload to re-import` : "Statement removed");
      onChange();
      if (r.linesRemoved) {
        qc.invalidateQueries({ queryKey: ["transactions"] });
        qc.invalidateQueries({ queryKey: ["dashboard"] });
      }
    },
    onError: (e) => toast.error("Couldn't remove statement", { description: (e as Error).message }),
  });
  const imported = s.status === "imported" || s.status === "categorising";
  const progress = s.status === "categorising" && s.total_lines ? ` ${s.categorised_count ?? 0} / ${s.total_lines}` : "";
  const count = s.status === "imported" && s.imported_count != null ? ` (${s.imported_count})` : "";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className={s.status === "failed" ? "text-danger" : s.status === "categorising" ? "text-warn" : ""}>
        {s.filename ?? s.format ?? "statement"}: {STATUS_LABEL[s.status] ?? s.status}{progress}{count}
      </span>
      {s.status === "parsed" && (
        <button onClick={() => imp.mutate(false)} disabled={imp.isPending} className="font-medium text-ink underline underline-offset-2 hover:text-green">
          {imp.isPending ? "Importing…" : "Import"}
        </button>
      )}
      {(s.status === "parsed" || s.status === "failed") && (
        <button
          onClick={() => { if (confirm("Remove this statement upload? Any already-imported transactions stay.")) del.mutate(false); }}
          disabled={del.isPending}
          className="underline underline-offset-2 hover:text-danger"
        >
          {del.isPending ? "Removing…" : "Remove"}
        </button>
      )}
      {imported && (
        <button
          onClick={() => {
            if (confirm(`Remove + re-import "${s.filename ?? "this statement"}"?\n\nThis DELETES its ${s.imported_count ?? ""} imported transactions (and any manual categorisation on them) so you can re-upload the PDF and re-import cleanly with the de-dup fix. Receipts stay, just un-matched.`))
              del.mutate(true);
          }}
          disabled={del.isPending}
          className="underline underline-offset-2 hover:text-danger"
          title="Delete this statement's transactions so you can re-upload it"
        >
          {del.isPending ? "Removing…" : "Remove + re-import"}
        </button>
      )}
      {err && (
        <span className="text-danger">
          {err}{" "}
          <button onClick={() => imp.mutate(true)} disabled={imp.isPending} className="font-medium underline underline-offset-2">Import anyway</button>
        </span>
      )}
    </div>
  );
}

function EditAccount({
  account,
  onSaved,
  onDelete,
  onSource,
  sourcePending,
  deletePending,
}: {
  account: Account;
  onSaved: () => void;
  onDelete: () => void;
  onSource: (source: string) => void;
  sourcePending: boolean;
  deletePending: boolean;
}) {
  const [name, setName] = useState(account.name);
  const [institution, setInstitution] = useState(account.institution ?? "");
  const [last4, setLast4] = useState(account.last4 ?? "");
  const [type, setType] = useState(account.type);
  // Loan facts (0044): the interest-rate section tied to the account. FALLBACK estimate inputs only —
  // actual deductible interest is sourced from the statement/lender summary (S4). Stored in cents;
  // shown in dollars. Empty string ⇒ clear (null); only sent for loan accounts.
  const [rate, setRate] = useState(account.interest_rate_pct != null ? String(account.interest_rate_pct) : "");
  const [balance, setBalance] = useState(account.balance_cents != null ? String(account.balance_cents / 100) : "");
  const save = useMutation({
    mutationFn: () =>
      api.updateAccount(account.id, {
        name,
        institution,
        last4,
        type,
        ...(type === "loan"
          ? {
              interest_rate_pct: rate.trim() === "" ? null : Number(rate),
              balance_cents: balance.trim() === "" ? null : Math.round(Number(balance) * 100),
            }
          : {}),
      }),
    onSuccess: onSaved,
  });

  // Evidence-first loan interest (S5, flag loan_interest_v2): record the lender's ACTUAL interest for
  // the active FY against this loan — the figure that flows to the property's deductible interest
  // (retiring the per-line split). Scoped to the active FY; prefills from any recorded summary.
  const { has } = useFeatures();
  const { fy } = useActiveFy();
  const v2 = type === "loan" && has("loan_interest_v2");
  const qc = useQueryClient();
  const liQ = useQuery({ queryKey: ["loan-interest", fy], queryFn: () => api.loanInterest(fy), enabled: v2 });
  const existing = liQ.data?.find((s) => s.loan_account_id === account.id);
  const [fyInterest, setFyInterest] = useState("");
  useEffect(() => {
    setFyInterest(existing ? String(existing.interest_cents / 100) : "");
  }, [existing?.id, existing?.interest_cents]);
  const setLi = useMutation({
    mutationFn: () => api.setLoanInterest(account.id, { fy, interest_cents: Math.round(Number(fyInterest) * 100), source: "lender_summary" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["loan-interest", fy] });
      qc.invalidateQueries({ queryKey: ["report"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success("Loan interest saved");
    },
  });
  return (
    <div className="mt-3 space-y-3 rounded-lg border border-line bg-surface p-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex-1 min-w-[9rem]">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full rounded-lg border border-line px-3 py-2" />
        </label>
        <label className="min-w-[7rem]">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Bank</span>
          <input value={institution} onChange={(e) => setInstitution(e.target.value)} className="mt-1 w-full rounded-lg border border-line px-3 py-2" />
        </label>
        <label className="w-20">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Last 4</span>
          <input value={last4} onChange={(e) => setLast4(e.target.value)} maxLength={4} className="mt-1 w-full rounded-lg border border-line px-3 py-2" />
        </label>
        <label className="min-w-[8rem]">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Type <InfoTip k="account_type" /></span>
          <select value={type} onChange={(e) => setType(e.target.value)} className="mt-1 w-full rounded-lg border border-line bg-card px-3 py-2">
            <option value="transaction">Transaction</option>
            <option value="credit_card">Credit card</option>
            <option value="loan">Loan</option>
            <option value="investment">Investment</option>
          </select>
        </label>
        {type === "loan" && (
          <>
            <label className="w-24">
              <span className="text-xs font-medium uppercase tracking-wide text-muted">Rate %</span>
              <input value={rate} onChange={(e) => setRate(e.target.value)} inputMode="decimal" placeholder="6.25" className="mt-1 w-full rounded-lg border border-line px-3 py-2" />
            </label>
            <label className="w-32">
              <span className="text-xs font-medium uppercase tracking-wide text-muted">Balance $</span>
              <input value={balance} onChange={(e) => setBalance(e.target.value)} inputMode="decimal" placeholder="450000" className="mt-1 w-full rounded-lg border border-line px-3 py-2" />
            </label>
          </>
        )}
        <Button onClick={() => save.mutate()} disabled={save.isPending || !name}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
      {type === "loan" && (
        <p className="text-xs text-muted">
          Used only as an indicative estimate when no statement figure is available — your actual deductible interest comes from your loan statements. General information only — not tax advice.
        </p>
      )}
      {v2 && (
        <div className="flex flex-wrap items-end gap-3 border-t border-line pt-3">
          <label className="min-w-[12rem] flex-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">
              Interest charged · FY {fy}–{String((fy + 1) % 100).padStart(2, "0")} $
            </span>
            <input value={fyInterest} onChange={(e) => setFyInterest(e.target.value)} inputMode="decimal" placeholder="12000" className="mt-1 w-full rounded-lg border border-line px-3 py-2" />
          </label>
          <Button onClick={() => setLi.mutate()} disabled={setLi.isPending || fyInterest.trim() === ""}>
            {setLi.isPending ? "Saving…" : "Save interest"}
          </Button>
          <p className="w-full text-xs text-muted">
            The actual interest from your lender's annual summary or statements — this is what flows to the property's deductible interest, replacing the per-line split
            {existing ? ` (recorded: ${money(existing.interest_cents)}${existing.source === "estimate" ? " · estimate" : ""})` : ""}. General information only — not tax advice.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Money source <InfoTip k="account_source" /></span>
          <select
            value={account.source}
            onChange={(e) => onSource(e.target.value)}
            disabled={sourcePending}
            className="rounded-lg border border-line bg-card px-3 py-1.5"
          >
            <option value="statement">Statement upload</option>
            <option value="qbo_feed">QuickBooks feed</option>
            <option value="manual">Manual</option>
          </select>
          <span className="text-xs text-muted">A QuickBooks-feed account won't accept statement uploads (avoids double-counting).</span>
        </label>
        <button onClick={onDelete} disabled={deletePending} className="text-sm text-danger hover:underline">
          {deletePending ? "Deleting…" : "Delete account"}
        </button>
      </div>
    </div>
  );
}
