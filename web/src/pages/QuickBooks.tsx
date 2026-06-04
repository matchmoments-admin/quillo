import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../api";
import { Card, Spinner, Button, money } from "../components/ui";

export function QuickBooks() {
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const justConnected = params.get("connected");
  const status = useQuery({ queryKey: ["qbo-status"], queryFn: () => api.qboStatus() });
  const recon = useQuery({ queryKey: ["qbo-reconcile"], queryFn: () => api.reconcile(), enabled: status.data?.connected === true });
  // Fetch the Intuit authorize URL (Bearer-authed), then hand the browser to Intuit.
  const connect = useMutation({
    mutationFn: () => api.qboConnect(),
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
  });
  // Disconnect revokes the token at Intuit and deletes the stored (encrypted) connection.
  const disconnect = useMutation({
    mutationFn: () => api.qboDisconnect(),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["qbo-status"] });
      qc.invalidateQueries({ queryKey: ["qbo-reconcile"] });
      toast.success(r.revoked ? "Disconnected from QuickBooks." : "Disconnected. (Intuit revoke could not be confirmed.)");
    },
    onError: (e) => toast.error(`Couldn't disconnect: ${(e as Error).message}`),
  });
  const doDisconnect = () => {
    if (window.confirm("Disconnect QuickBooks? This revokes Quillo's access and removes the stored tokens. You can reconnect any time.")) {
      disconnect.mutate();
    }
  };

  if (status.isLoading) return <Spinner />;
  const needsReconnect = status.data?.needs_reconnect || recon.data?.needsReconnect;
  const connected = status.data?.connected && !needsReconnect;
  // A dead-but-stored connection (refresh token expired) can still be cleared/revoked.
  const hasStoredConnection = status.data?.connected || status.data?.needs_reconnect;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">QuickBooks</h1>

      {justConnected === "1" && <Card className="bg-safe/5 p-3 text-sm text-safe">Connected to QuickBooks.</Card>}
      {justConnected === "0" && (
        <Card className="bg-danger/5 p-3 text-sm text-danger">
          Connection failed{params.get("reason") ? `: ${params.get("reason")}` : " — try again."}
        </Card>
      )}

      <Card className="p-4">
        <p className="text-sm">
          Status:{" "}
          {connected ? (
            <span className="font-medium text-safe">connected</span>
          ) : (
            <span className="font-medium text-muted">not connected</span>
          )}
          {status.data?.realm_id && <span className="text-muted"> · realm {status.data.realm_id}</span>}
        </p>
        <p className="mt-2 text-xs text-muted">
          The agent is a <strong>reader / reconciler</strong>: bank feeds are the source of truth in QuickBooks; the agent reads
          matched lines and attaches your receipt — it never posts duplicate purchases.
        </p>
        {!connected && (
          <div className="mt-3 space-y-2">
            {needsReconnect && (
              <p className="text-sm text-warn">Your QuickBooks authorisation expired — reconnect to resume reconciliation.</p>
            )}
            <Button onClick={() => connect.mutate()} disabled={connect.isPending}>
              {connect.isPending ? "Redirecting…" : needsReconnect ? "Reconnect QuickBooks" : "Connect QuickBooks"}
            </Button>
            {connect.isError && (
              <p className="text-sm text-danger">Couldn't start QuickBooks connect: {(connect.error as Error).message}</p>
            )}
          </div>
        )}
        {hasStoredConnection && (
          <div className="mt-3 border-t border-line pt-3">
            <Button variant="ghost" onClick={doDisconnect} disabled={disconnect.isPending}>
              {disconnect.isPending ? "Disconnecting…" : "Disconnect QuickBooks"}
            </Button>
            <p className="mt-2 text-xs text-muted">Revokes Quillo's access at Intuit and deletes the stored tokens.</p>
          </div>
        )}
      </Card>

      {connected && (
        <div className="grid gap-6 sm:grid-cols-2">
          <Card className="p-4">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Company expenses (this agent)</div>
            {recon.isLoading ? (
              <Spinner />
            ) : (
              <ul className="space-y-1 text-sm">
                {(recon.data?.company ?? []).map((t) => (
                  <li key={t.id} className="flex justify-between">
                    <span className="truncate">{t.merchant ?? "—"}</span>
                    <span className="tabular-nums">
                      {money(t.amount_cents)} {t.ledger_ref ? "✓" : "·"}
                    </span>
                  </li>
                ))}
                {!recon.data?.company.length && <li className="text-muted">none</li>}
              </ul>
            )}
          </Card>
          <Card className="p-4">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Recent QuickBooks purchases</div>
            {recon.isLoading ? (
              <Spinner />
            ) : recon.data?.error ? (
              <p className="text-sm text-danger">{recon.data.error}</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {(recon.data?.purchases ?? []).map((p) => (
                  <li key={p.Id} className="flex justify-between">
                    <span className="truncate">{p.PrivateNote ?? p.TxnDate}</span>
                    <span className="tabular-nums">${p.TotalAmt?.toFixed(2)}</span>
                  </li>
                ))}
                {!recon.data?.purchases.length && <li className="text-muted">none</li>}
              </ul>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
