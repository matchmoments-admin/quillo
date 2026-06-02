import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Card, Spinner } from "../components/ui";

export function Notifications() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["notifications"], queryFn: () => api.notifications() });
  const read = useMutation({
    mutationFn: (id: string) => api.markRead(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  if (isLoading) return <Spinner />;
  if (error) return <Card className="p-6 text-sm text-muted">Couldn't load: {(error as Error).message}</Card>;
  const items = data ?? [];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
      {items.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted">Nothing right now. The weekly scan posts nudges here.</Card>
      ) : (
        <ul className="space-y-3">
          {items.map((n) => (
            <li key={n.id}>
              <Card className={`flex items-start gap-3 p-4 ${n.read_at ? "opacity-60" : ""}`}>
                <span className={`mt-1.5 h-2 w-2 flex-none rounded-full ${n.read_at ? "bg-line" : "bg-yellow"}`} />
                <div className="min-w-0 flex-1">
                  <p className="whitespace-pre-line text-sm">{n.body}</p>
                  <div className="mt-1 flex gap-3 text-xs text-muted">
                    <span>{new Date(n.created_at + "Z").toLocaleString("en-AU")}</span>
                    {n.txn_id && (
                      <Link to={`/txn/${n.txn_id}`} className="text-ink underline underline-offset-2">
                        view receipt
                      </Link>
                    )}
                  </div>
                </div>
                {!n.read_at && (
                  <button onClick={() => read.mutate(n.id)} className="flex-none text-xs text-muted hover:text-ink">
                    mark read
                  </button>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
