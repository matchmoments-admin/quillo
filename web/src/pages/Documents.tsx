import { useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Card, Spinner, Button } from "../components/ui";
import type { DocRow } from "../types";

const DOC_LABEL: Record<string, string> = {
  receipt: "Receipt",
  invoice: "Invoice",
  payslip: "Payslip",
  agent_rental_summary: "Agent rental summary",
  dividend_statement: "Dividend statement",
  managed_fund_amma: "Managed fund (AMMA)",
  depreciation_schedule: "Depreciation schedule",
  super_statement: "Super statement",
  bank_statement: "Bank statement",
  loan_statement: "Loan statement",
  other: "Other",
  unknown: "Unclassified",
};

export function Documents() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({ queryKey: ["documents"], queryFn: () => api.documents() });

  // The download route is Bearer-authed, so a raw <a href> opens a tab with no Clerk token →
  // "unauthorized". Open a blank tab synchronously (keeps it inside the user gesture so popup
  // blockers allow it), fetch the file with auth, then point the tab at the blob: URL.
  const [opening, setOpening] = useState<string | null>(null);
  async function openDoc(id: string) {
    const tab = window.open("about:blank", "_blank");
    if (!tab) { setNote("Couldn't open the document — allow pop-ups for this site and try again."); return; }
    setOpening(id);
    try {
      const url = await api.documentBlobUrl(id);
      tab.location.href = url;
      // Revoke once the tab has had time to load. (No reliable cross-tab load signal for a blob:
      // URL, so use a generous timer — long enough for a large PDF on a slow link.)
      setTimeout(() => URL.revokeObjectURL(url), 120_000);
    } catch (e) {
      tab.close();
      setNote((e as Error).message);
    } finally {
      setOpening(null);
    }
  }

  const del = useMutation({
    mutationFn: (id: string) => api.deleteDocument(id),
    onSuccess: (r) => {
      const extra = [r.income_removed ? `${r.income_removed} income row${r.income_removed === 1 ? "" : "s"}` : "", r.txns_removed ? `${r.txns_removed} transaction${r.txns_removed === 1 ? "" : "s"}` : ""].filter(Boolean).join(" + ");
      setNote(`Deleted the document${extra ? ` and the ${extra} it created` : ""}.`);
      qc.invalidateQueries({ queryKey: ["documents"] });
      qc.invalidateQueries({ queryKey: ["income"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e) => setNote(`Couldn't delete: ${(e as Error).message}`),
  });

  const upload = useMutation({
    mutationFn: (file: File) => api.uploadDocument(file),
    onSuccess: (r) => {
      setNote(`Filed as ${DOC_LABEL[r.doc_type] ?? r.doc_type}${r.routed ? " and routed." : " — held for review."}`);
      qc.invalidateQueries({ queryKey: ["documents"] });
      qc.invalidateQueries({ queryKey: ["income"] });
    },
    onError: (e) => setNote((e as Error).message),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Documents</h1>
        <div>
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept="image/*,application/pdf"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ""; }}
          />
          <Button onClick={() => fileRef.current?.click()} disabled={upload.isPending}>
            {upload.isPending ? "Classifying…" : "Upload a document"}
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted">
        The Smart Inbox classifies anything you drop here — payslips, agent statements, dividend
        statements — and routes it to the right place. Anything it's unsure about is held for review.
      </p>
      {note && <Card className="p-3 text-sm">{note}</Card>}

      {isLoading ? (
        <Spinner />
      ) : error ? (
        <Card className="p-6 text-sm text-muted">Couldn't load: {(error as Error).message}</Card>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-2.5">Type</th>
                <th className="px-4 py-2.5">Issuer</th>
                <th className="px-4 py-2.5">Date</th>
                <th className="px-4 py-2.5">Confidence</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {(data ?? []).map((d: DocRow) => (
                <tr key={d.id} className="border-t border-line">
                  <td className="px-4 py-2">
                    {DOC_LABEL[d.doc_type] ?? d.doc_type}
                    {d.needs_review ? <span className="ml-2 rounded-full bg-warn/10 px-2 py-0.5 text-xs text-warn">review</span> : null}
                  </td>
                  <td className="px-4 py-2 text-muted">{d.issuer ?? "—"}</td>
                  <td className="px-4 py-2 text-muted tabular-nums">{d.doc_date ?? "—"}</td>
                  <td className="px-4 py-2 text-muted tabular-nums">{d.classification_confidence == null ? "—" : `${Math.round(d.classification_confidence * 100)}%`}</td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex items-center justify-end gap-3">
                      <button type="button" className="text-xs text-ink underline disabled:opacity-50" onClick={() => openDoc(d.id)} disabled={opening === d.id}>{opening === d.id ? "opening…" : "open"}</button>
                      <button
                        type="button"
                        className="text-xs text-danger hover:underline disabled:opacity-50"
                        disabled={del.isPending}
                        onClick={() => {
                          if (confirm("Delete this document? It also removes the income / transactions it created here. This can't be undone.")) del.mutate(d.id);
                        }}
                      >
                        {del.isPending && del.variables === d.id ? "deleting…" : "delete"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {!(data ?? []).length && (
                <tr className="border-t border-line"><td colSpan={5} className="px-4 py-6 text-muted">No documents yet.</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      )}
      <p className="text-xs text-muted">Stored under 5-year ATO retention. General information only — not tax advice.</p>
    </div>
  );
}
