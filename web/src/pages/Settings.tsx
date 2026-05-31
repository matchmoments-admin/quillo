import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { BUCKETS } from "../types";
import { Card, Spinner, BUCKET_LABEL } from "../components/ui";

const input = "rounded-lg border border-line bg-white px-3 py-2 text-sm";
const btn = "rounded-lg bg-ink px-3 py-2 text-sm font-medium text-white hover:bg-ink/90 disabled:opacity-50";
const del = "text-xs text-muted hover:text-danger";

export function Settings() {
  const qc = useQueryClient();
  const sit = useQuery({ queryKey: ["situation"], queryFn: () => api.situation() });
  const keys = useQuery({ queryKey: ["keys"], queryFn: () => api.keys() });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["situation"] });

  if (sit.isLoading) return <Spinner />;
  if (sit.error) return <Card className="p-6 text-sm text-muted">Couldn't load: {(sit.error as Error).message}</Card>;
  const s = sit.data!;

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      {/* Properties */}
      <Section title="Properties">
        {s.properties.map((p) => (
          <Row key={p.id} label={`${p.label} — ${p.status}`} onDelete={() => api.deleteProperty(p.id).then(invalidate)} />
        ))}
        <AddProperty onDone={invalidate} />
      </Section>

      {/* Entities */}
      <Section title="Entities (employment · company · novated lease)">
        {s.entities.map((e, i) => (
          <Row key={i} label={`${e.kind}${e.name ? ` — ${e.name}` : ""}`} />
        ))}
        <AddEntity onDone={invalidate} />
      </Section>

      {/* Rules */}
      <Section title="Per-user rules">
        {s.rules.map((r, i) => (
          <Row key={i} label={`"${r.pattern}" → ${BUCKET_LABEL[r.bucket] ?? r.bucket} · ${r.ato_label}`} />
        ))}
        <AddRule onDone={invalidate} />
      </Section>

      {/* Devices / keys */}
      <Section title="Devices (ingest keys)">
        {keys.isLoading ? (
          <Spinner />
        ) : (
          (keys.data ?? []).map((k) => (
            <Row
              key={k.key_id}
              label={`${k.label ?? "key"} · ${k.key_id}${k.revoked_at ? " (revoked)" : ""}`}
              onDelete={k.revoked_at ? undefined : () => api.revokeKey(k.key_id).then(() => qc.invalidateQueries({ queryKey: ["keys"] }))}
              deleteLabel="revoke"
            />
          ))
        )}
        <MintKey onDone={() => qc.invalidateQueries({ queryKey: ["keys"] })} />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="p-4">
      <div className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">{title}</div>
      <div className="space-y-2">{children}</div>
    </Card>
  );
}

function Row({ label, onDelete, deleteLabel = "delete" }: { label: string; onDelete?: () => void; deleteLabel?: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-surface px-3 py-2 text-sm">
      <span className="truncate">{label}</span>
      {onDelete && (
        <button onClick={onDelete} className={del}>
          {deleteLabel}
        </button>
      )}
    </div>
  );
}

function AddProperty({ onDone }: { onDone: () => void }) {
  const [label, setLabel] = useState("");
  const [status, setStatus] = useState("rented");
  const m = useMutation({ mutationFn: () => api.addProperty({ label, status }), onSuccess: () => { setLabel(""); onDone(); } });
  return (
    <div className="flex flex-wrap gap-2 pt-2">
      <input className={`${input} flex-1`} placeholder="Label e.g. 14 Rental St" value={label} onChange={(e) => setLabel(e.target.value)} />
      <select className={input} value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="rented">rented</option>
        <option value="vacant">vacant</option>
        <option value="owner_occupied">owner-occupied</option>
        <option value="sold">sold</option>
      </select>
      <button className={btn} disabled={!label || m.isPending} onClick={() => m.mutate()}>
        Add
      </button>
    </div>
  );
}

function AddEntity({ onDone }: { onDone: () => void }) {
  const [kind, setKind] = useState("company");
  const [name, setName] = useState("");
  const m = useMutation({ mutationFn: () => api.addEntity({ kind, name }), onSuccess: () => { setName(""); onDone(); } });
  return (
    <div className="flex flex-wrap gap-2 pt-2">
      <select className={input} value={kind} onChange={(e) => setKind(e.target.value)}>
        <option value="company">company</option>
        <option value="employment">employment</option>
        <option value="novated_lease">novated_lease</option>
        <option value="individual">individual</option>
        <option value="trust">trust</option>
      </select>
      <input className={`${input} flex-1`} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <button className={btn} disabled={m.isPending} onClick={() => m.mutate()}>
        Add
      </button>
    </div>
  );
}

function AddRule({ onDone }: { onDone: () => void }) {
  const [pattern, setPattern] = useState("");
  const [bucket, setBucket] = useState("company");
  const [label, setLabel] = useState("");
  const m = useMutation({
    mutationFn: () => api.addRule({ pattern, bucket, ato_label: label }),
    onSuccess: () => { setPattern(""); setLabel(""); onDone(); },
  });
  return (
    <div className="flex flex-wrap gap-2 pt-2">
      <input className={`${input} flex-1`} placeholder="Merchant contains…" value={pattern} onChange={(e) => setPattern(e.target.value)} />
      <select className={input} value={bucket} onChange={(e) => setBucket(e.target.value)}>
        {BUCKETS.map((b) => (
          <option key={b} value={b}>
            {BUCKET_LABEL[b]}
          </option>
        ))}
      </select>
      <input className={`${input} flex-1`} placeholder="ATO label" value={label} onChange={(e) => setLabel(e.target.value)} />
      <button className={btn} disabled={!pattern || !label || m.isPending} onClick={() => m.mutate()}>
        Add
      </button>
    </div>
  );
}

function MintKey({ onDone }: { onDone: () => void }) {
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState<{ keyId: string; secret: string } | null>(null);
  const m = useMutation({ mutationFn: () => api.mintKey(label || "web"), onSuccess: (r) => { setSecret(r); setLabel(""); onDone(); } });
  return (
    <div className="space-y-2 pt-2">
      <div className="flex gap-2">
        <input className={`${input} flex-1`} placeholder="Device label e.g. android" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button className={btn} disabled={m.isPending} onClick={() => m.mutate()}>
          Mint key
        </button>
      </div>
      {secret && (
        <div className="rounded-lg bg-warn/10 p-3 text-xs">
          <p className="mb-1 font-medium text-warn">Save these now — the secret is shown once:</p>
          <code className="block">KEY_ID={secret.keyId}</code>
          <code className="block break-all">SECRET={secret.secret}</code>
        </div>
      )}
    </div>
  );
}
