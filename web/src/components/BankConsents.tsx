import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../api";
import { Card, Spinner } from "./ui";
import type { BankConnection } from "../types";

/**
 * Bank connections — the consent dashboard (#576, ADR-0003 §6.4). Rendered only when
 * `bank_feed_cdr` is ON (the caller gates it).
 *
 * The CDR requires the consumer to be able to SEE each consent — which institution, which accounts,
 * which data, since when, until when — and WITHDRAW it. Withdraw here really does all three halves
 * on the server: stops collecting, revokes at the bank-data provider, and deletes the transactions
 * imported from that bank (Privacy Safeguard 12). The copy says so before the click, because the
 * deletion removes lines from the user's records and can't be undone.
 */

// Consented data clusters → plain words. Unknown scopes fall back to a tidied version of the raw
// string rather than being hidden: the consumer must see everything they agreed to.
const CLUSTER_LABEL: Record<string, string> = {
  "account.basic": "Account names and types",
  "account.detail": "Account numbers and features",
  "transaction.basic": "Transaction amounts and dates",
  "transaction.detail": "Transaction details (descriptions, payees)",
  "customer.basic": "Your name and occupation",
  "customer.detail": "Your contact details",
  "payee.detail": "Saved payees",
  "regular_payments.read": "Scheduled payments",
};
function clusterLabel(s: string): string {
  return CLUSTER_LABEL[s] ?? s.replace(/[._:]+/g, " ").replace(/\s+/g, " ").trim();
}

function parseScope(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : null);

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.ceil((t - Date.now()) / 86_400_000);
}

const STATUS_TEXT: Record<string, string> = {
  active: "Active",
  pending: "Pending",
  expired: "Expired",
  revoked: "Withdrawn",
  error: "Needs attention",
};

const EVENT_TEXT: Record<string, string> = {
  consent_granted: "Consent given",
  collected: "Transactions collected",
  consent_expired: "Consent expired",
  expiry_reminder: "Expiry reminder sent",
  consent_withdrawn: "Consent withdrawn",
  upstream_revoked: "Bank-side access ended",
  upstream_revoke_failed: "Bank-side revoke failed (will retry)",
  data_deleted: "Bank data deleted",
  tenant_purged: "Account deleted",
};

export function BankConsents() {
  const qc = useQueryClient();
  const { data: connections, isLoading } = useQuery({
    queryKey: ["bank-connections"],
    queryFn: () => api.bankConnections(),
  });
  const { data: history } = useQuery({ queryKey: ["bank-history"], queryFn: () => api.bankHistory() });

  // Which connection is mid-confirmation — an inline second step instead of a browser dialog, so the
  // consequences are on screen next to the button.
  const [confirming, setConfirming] = useState<string | null>(null);

  const disconnect = useMutation({
    mutationFn: (connectionId: string) => api.bankDisconnect(connectionId),
    onSuccess: (r) => {
      setConfirming(null);
      if (r.upstreamRevoked) {
        toast.success(`Consent withdrawn. ${r.linesDeleted} imported transaction(s) deleted.`);
      } else {
        toast.warning(
          `Quillo has stopped collecting and deleted ${r.linesDeleted} imported transaction(s), but the bank-side revoke didn't go through yet. Use Retry, or we'll retry automatically.`,
        );
      }
      qc.invalidateQueries({ queryKey: ["bank-connections"] });
      qc.invalidateQueries({ queryKey: ["bank-history"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["progress"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const conns = connections ?? [];

  return (
    <div id="bank-connections">
    <Card className="space-y-4 p-4">
      <div>
        <div className="text-xs font-medium uppercase tracking-wide text-muted">Bank connections</div>
        <p className="mt-1 text-sm text-muted">
          Each bank you've connected, what you agreed to share and until when. Withdrawing stops Quillo collecting
          straight away, ends the bank-data provider's access, and deletes the transactions imported from that bank.
        </p>
      </div>

      {isLoading ? (
        <Spinner />
      ) : conns.length === 0 ? (
        <p className="text-sm text-muted">No banks connected. You can connect one from Accounts.</p>
      ) : (
        <ul className="space-y-3">
          {conns.map((c) => (
            <ConsentRow
              key={c.id}
              conn={c}
              confirming={confirming === c.id}
              busy={disconnect.isPending && disconnect.variables === c.id}
              onAsk={() => setConfirming(c.id)}
              onCancel={() => setConfirming(null)}
              onWithdraw={() => disconnect.mutate(c.id)}
            />
          ))}
        </ul>
      )}

      {(history?.length ?? 0) > 0 && (
        <details className="border-t border-line pt-3 text-sm">
          <summary className="cursor-pointer text-xs font-medium uppercase tracking-wide text-muted">
            Consent history
          </summary>
          <ul className="mt-2 space-y-1">
            {history!.map((h, i) => (
              <li key={i} className="flex flex-wrap gap-x-3 text-xs">
                <span className="tnum text-muted">{day(h.created_at)}</span>
                <span>{EVENT_TEXT[h.event] ?? h.event}</span>
                {h.event === "collected" && h.row_count != null && (
                  <span className="text-muted">
                    {h.row_count} new line(s){h.from_date && h.to_date ? ` · ${h.from_date} to ${h.to_date}` : ""}
                  </span>
                )}
                {h.event === "data_deleted" && h.row_count != null && (
                  <span className="text-muted">{h.row_count} line(s) deleted</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
    </div>
  );
}

function ConsentRow({
  conn,
  confirming,
  busy,
  onAsk,
  onCancel,
  onWithdraw,
}: {
  conn: BankConnection;
  confirming: boolean;
  busy: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onWithdraw: () => void;
}) {
  const scope = parseScope(conn.consent_scope);
  const left = daysUntil(conn.consent_expires_at);
  const withdrawn = conn.status === "revoked";
  const upstreamPending = withdrawn && !conn.upstream_revoked_at;
  const name = conn.institution ?? conn.institution_id ?? "Bank";

  return (
    <li className="rounded-lg border border-line p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <span className="font-medium">{name}</span>
          <span className="ml-2 text-xs text-muted">
            {conn.access_type === "cdr" ? "Open Banking (Consumer Data Right)" : "Web connector"}
          </span>
        </div>
        <span className={`text-xs font-medium ${withdrawn || conn.status === "expired" ? "text-muted" : conn.status === "active" ? "text-safe" : "text-warn"}`}>
          {STATUS_TEXT[conn.status] ?? conn.status}
        </span>
      </div>

      <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
        {conn.consent_granted_at && (
          <div><dt className="inline text-muted">Consent given: </dt><dd className="inline tnum">{day(conn.consent_granted_at)}</dd></div>
        )}
        {conn.consent_expires_at && !withdrawn && (
          <div>
            <dt className="inline text-muted">Expires: </dt>
            <dd className={`inline tnum ${left != null && left <= 30 ? "text-warn" : ""}`}>
              {day(conn.consent_expires_at)}
              {left != null && left > 0 ? ` (${left} day${left === 1 ? "" : "s"})` : ""}
            </dd>
          </div>
        )}
        {conn.last_sync_at && (
          <div><dt className="inline text-muted">Last collected: </dt><dd className="inline tnum">{day(conn.last_sync_at)}</dd></div>
        )}
        {withdrawn && conn.revoked_at && (
          <div><dt className="inline text-muted">Withdrawn: </dt><dd className="inline tnum">{day(conn.revoked_at)}</dd></div>
        )}
        {withdrawn && (
          <div>
            <dt className="inline text-muted">Bank-side access: </dt>
            <dd className={`inline ${upstreamPending ? "text-warn" : ""}`}>
              {upstreamPending ? "revoke pending" : `ended ${day(conn.upstream_revoked_at) ?? ""}`}
            </dd>
          </div>
        )}
        {withdrawn && conn.data_deleted_at && (
          <div><dt className="inline text-muted">Imported data deleted: </dt><dd className="inline tnum">{day(conn.data_deleted_at)}</dd></div>
        )}
      </dl>

      {scope.length > 0 && (
        <div className="mt-2 text-xs">
          <span className="text-muted">Data you agreed to share: </span>
          {scope.map(clusterLabel).join(" · ")}
        </div>
      )}

      {!withdrawn && conn.accounts.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs">
          {conn.accounts.map((a) => (
            <li key={a.id}>
              {a.name ?? "Account"}
              {a.masked_number && <span className="text-muted"> ••••{a.masked_number}</span>}
              <span className="text-muted">
                {" — "}
                {a.selected === 1 && a.account_id
                  ? `collected into ${a.mapped_account_name ?? "a Quillo account"}`
                  : "not collected"}
              </span>
            </li>
          ))}
        </ul>
      )}

      {conn.last_error && <p className="mt-2 text-xs text-warn">{conn.last_error}</p>}

      <div className="mt-3">
        {!withdrawn && !confirming && (
          <button
            onClick={onAsk}
            className="rounded-lg border border-danger/40 px-3 py-1.5 text-xs font-medium text-danger transition hover:bg-danger/5"
          >
            Withdraw consent
          </button>
        )}
        {!withdrawn && confirming && (
          <div className="space-y-2 rounded-lg bg-danger/5 p-3 text-xs">
            <p>
              Withdraw your consent for <span className="font-medium">{name}</span>? Quillo stops collecting
              immediately, asks the bank-data provider to end its access, and <span className="font-medium">deletes
              every transaction imported from this bank</span> — including how you categorised them. Receipts you
              matched to those lines are kept. If you still need these accounts for your return, upload their
              statements afterwards. This can't be undone.
            </p>
            <div className="flex gap-2">
              <button
                onClick={onWithdraw}
                disabled={busy}
                className="rounded-lg border border-danger/40 px-3 py-1.5 font-medium text-danger transition hover:bg-danger/10 disabled:opacity-50"
              >
                {busy ? "Withdrawing…" : "Withdraw and delete"}
              </button>
              <button onClick={onCancel} disabled={busy} className="rounded-lg px-3 py-1.5 text-muted hover:text-ink">
                Cancel
              </button>
            </div>
          </div>
        )}
        {upstreamPending && (
          <button
            onClick={onWithdraw}
            disabled={busy}
            className="rounded-lg border border-ink/25 px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-ink/5 disabled:opacity-50"
          >
            {busy ? "Retrying…" : "Retry bank-side revoke"}
          </button>
        )}
      </div>
    </li>
  );
}
