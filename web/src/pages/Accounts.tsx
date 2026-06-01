import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Button, Card, Spinner, money } from "../components/ui";
import type { Account, StatementParse } from "../types";

const SOURCE_LABEL: Record<string, string> = {
  qbo_feed: "QuickBooks feed",
  statement: "Statement upload",
  manual: "Manual",
};

export function Accounts() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["accounts"], queryFn: () => api.accounts() });

  if (isLoading) return <Spinner />;
  if (error) return <Card className="p-6 text-sm text-muted">Couldn't load accounts: {(error as Error).message}</Card>;
  const accounts = data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Accounts</h1>
        <p className="hidden text-sm text-muted sm:block">Statement upload for accounts without a working bank feed</p>
      </div>

      <AddAccount onAdded={() => qc.invalidateQueries({ queryKey: ["accounts"] })} />

      {accounts.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted">
          No accounts yet. Add each bank/card/investment account above, then upload its statement (CSV).
        </Card>
      ) : (
        <ul className="space-y-3">
          {accounts.map((a) => (
            <AccountRow key={a.id} account={a} />
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

function AccountRow({ account }: { account: Account }) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [parse, setParse] = useState<StatementParse | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const doParse = useMutation({
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
    onError: (e) => setNote(`Couldn't read: ${(e as Error).message}`),
  });

  const doConfirm = useMutation({
    mutationFn: (force?: boolean) => api.confirmImport(parse!.statementId, force),
    onSuccess: (r) => {
      setNote(`Imported ${r.imported} transaction(s)${r.skipped ? ` (${r.skipped} already on file)` : ""}.`);
      setParse(null);
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e) => setNote(`Import failed: ${(e as Error).message}`),
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
            <div className="mt-0.5 flex items-center gap-2 text-sm text-muted">
              <span>{account.institution ?? "—"}</span>
              <span>·</span>
              <span className="capitalize">{account.type.replace("_", " ")}</span>
              <span>·</span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${isFeed ? "bg-accent-soft text-accent" : "bg-slate-100 text-ink"}`}>
                {SOURCE_LABEL[account.source] ?? account.source}
              </span>
              {account.line_count ? <span className="text-xs">· {account.line_count} lines</span> : null}
            </div>
          </div>
          {!isFeed && (
            <div className="flex-none">
              <Button variant="ghost" onClick={() => fileRef.current?.click()} disabled={doParse.isPending}>
                {doParse.isPending ? "Reading…" : "Upload statement (CSV)"}
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) doParse.mutate(f);
                  e.currentTarget.value = "";
                }}
              />
            </div>
          )}
          {isFeed && <span className="text-xs text-muted">Reconciled from QuickBooks — don't upload statements (would double-count).</span>}
        </div>

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
