import { useEffect, useRef, useState } from "react";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../api";
import { Button, Card, Spinner, money } from "../components/ui";
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
        <span className="text-xs font-medium uppercase tracking-wide text-muted">Type</span>
        <select value={type} onChange={(e) => setType(e.target.value)} className="mt-1 w-full rounded-lg border border-line bg-white px-3 py-2">
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

function AccountRow({ account, statements }: { account: Account; statements: StatementInfo[] }) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [parse, setParse] = useState<StatementParse | null>(null);
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
  const del = useMutation({
    mutationFn: () => api.deleteAccount(account.id),
    onSuccess: invalidate,
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
              {account.line_count ? <span className="text-xs">· {account.line_count} lines</span> : null}
            </div>
            {statements.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
                {statements.map((s) => (
                  <span key={s.id} className={s.status === "failed" ? "text-danger" : s.status === "categorising" ? "text-warn" : ""}>
                    {s.filename ?? s.format ?? "statement"}: {STATUS_LABEL[s.status] ?? s.status}
                    {s.status === "categorising" && s.total_lines ? ` ${s.categorised_count ?? 0} / ${s.total_lines}` : ""}
                    {s.status === "imported" && s.imported_count != null ? ` (${s.imported_count})` : ""}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-none items-center gap-1">
            {!isFeed && (
              <>
                <Button variant="ghost" onClick={() => fileRef.current?.click()} disabled={anyParsing}>
                  {doParse.isPending ? "Reading…" : anyParsing ? "Waiting…" : "Upload statement (CSV/PDF)"}
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,text/csv,.pdf,application/pdf"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) doParse.mutate(f);
                    e.currentTarget.value = "";
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
              if (confirm(`Delete "${account.name}"? Its imported transactions stay, but the account record is removed.`)) del.mutate();
            }}
            deletePending={del.isPending}
          />
        )}

        {note && <p className="mt-2 text-sm text-muted">{note}</p>}

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
                  Found <span className="font-medium">{parse.rowCount}</span> transactions. Preview (first {parse.preview.length}):
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
  const save = useMutation({
    mutationFn: () => api.updateAccount(account.id, { name, institution, last4, type }),
    onSuccess: onSaved,
  });
  return (
    <div className="mt-3 space-y-3 rounded-lg border border-line bg-slate-50 p-3">
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
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Type</span>
          <select value={type} onChange={(e) => setType(e.target.value)} className="mt-1 w-full rounded-lg border border-line bg-white px-3 py-2">
            <option value="transaction">Transaction</option>
            <option value="credit_card">Credit card</option>
            <option value="loan">Loan</option>
            <option value="investment">Investment</option>
          </select>
        </label>
        <Button onClick={() => save.mutate()} disabled={save.isPending || !name}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Money source</span>
          <select
            value={account.source}
            onChange={(e) => onSource(e.target.value)}
            disabled={sourcePending}
            className="rounded-lg border border-line bg-white px-3 py-1.5"
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
