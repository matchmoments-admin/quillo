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
          <EditableProperty key={p.id} property={p} onDone={invalidate} />
        ))}
        <AddProperty onDone={invalidate} />
      </Section>

      {/* Entities */}
      <Section title="Entities (employment · company · novated lease)">
        {s.entities.map((e) => (
          <Row key={e.id} label={entityLabel(e)} onDelete={() => api.deleteEntity(e.id).then(invalidate)} />
        ))}
        <AddEntity onDone={invalidate} />
      </Section>

      {/* Rules */}
      <Section title="Per-user rules">
        {s.rules.map((r) => (
          <Row key={r.id} label={`"${r.pattern}" → ${BUCKET_LABEL[r.bucket] ?? r.bucket} · ${r.ato_label}`} onDelete={() => api.deleteRule(r.id).then(invalidate)} />
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

function EditableProperty({ property, onDone }: { property: { id: string; label: string; status: string }; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(property.label);
  const [status, setStatus] = useState(property.status);
  const save = useMutation({ mutationFn: () => api.updateProperty(property.id, { label, status }), onSuccess: () => { setEditing(false); onDone(); } });
  if (!editing) {
    return (
      <div className="flex items-center justify-between rounded-lg bg-surface px-3 py-2 text-sm">
        <span className="truncate">{property.label} — {property.status}</span>
        <div className="flex flex-none gap-3">
          <button onClick={() => setEditing(true)} className={del}>edit</button>
          <button onClick={() => api.deleteProperty(property.id).then(onDone)} className={del}>delete</button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-2 rounded-lg bg-surface px-3 py-2">
      <input className={`${input} flex-1`} value={label} onChange={(e) => setLabel(e.target.value)} />
      <select className={input} value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="rented">rented</option>
        <option value="vacant">vacant</option>
        <option value="owner_occupied">owner-occupied</option>
        <option value="sold">sold</option>
      </select>
      <button className={btn} disabled={!label || save.isPending} onClick={() => save.mutate()}>Save</button>
      <button className={del} onClick={() => setEditing(false)}>cancel</button>
    </div>
  );
}

function AddProperty({ onDone }: { onDone: () => void }) {
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [status, setStatus] = useState("rented");
  const [ownership, setOwnership] = useState("100");
  const m = useMutation({
    mutationFn: () =>
      api.addProperty({ label, address: address || undefined, status, ownership_pct: Number(ownership) || 100 }),
    onSuccess: () => {
      setLabel("");
      setAddress("");
      onDone();
    },
  });
  return (
    <div className="flex flex-wrap gap-2 pt-2">
      <input className={`${input} flex-1`} placeholder="Label e.g. Rental 1" value={label} onChange={(e) => setLabel(e.target.value)} />
      <input className={`${input} flex-1`} placeholder="Address e.g. 14 Rental St, Sydney NSW" value={address} onChange={(e) => setAddress(e.target.value)} />
      <select className={input} value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="rented">rented</option>
        <option value="vacant">vacant</option>
        <option value="owner_occupied">owner-occupied</option>
        <option value="sold">sold</option>
      </select>
      <input className={`${input} w-24`} type="number" min="1" max="100" placeholder="Own %" value={ownership} onChange={(e) => setOwnership(e.target.value)} title="Your ownership share %" />
      <button className={btn} disabled={!label || m.isPending} onClick={() => m.mutate()}>
        Add
      </button>
    </div>
  );
}

// Render an entity's stored detail (ABN/GST/employer/vehicle) so you can confirm what the
// categoriser actually knows about you. Mirrors the fields renderSituation() reads in db.ts.
function entityLabel(e: { kind: string; name: string | null; detail_json?: string | null }): string {
  let d: Record<string, unknown> = {};
  try {
    d = e.detail_json ? (JSON.parse(e.detail_json) as Record<string, unknown>) : {};
  } catch {
    /* ignore */
  }
  const bits = [e.kind, e.name].filter(Boolean);
  if (e.kind === "company") {
    if (d.abn) bits.push(`ABN ${d.abn}`);
    bits.push(d.gst_registered ? "GST registered" : "not GST registered");
  } else if (e.kind === "employment" && (d.employer || e.name)) {
    // name already shown
  } else if (e.kind === "novated_lease") {
    if (d.vehicle) bits.push(String(d.vehicle));
    if (d.provider) bits.push(`via ${d.provider}`);
  }
  return bits.join(" — ");
}

function AddEntity({ onDone }: { onDone: () => void }) {
  const [kind, setKind] = useState("company");
  const [name, setName] = useState("");
  const [abn, setAbn] = useState("");
  const [gst, setGst] = useState(true);
  const [vehicle, setVehicle] = useState("");
  const [provider, setProvider] = useState("");
  const buildDetail = () => {
    if (kind === "company") return { abn: abn || undefined, gst_registered: gst };
    if (kind === "employment") return { employer: name || undefined };
    if (kind === "novated_lease") return { vehicle: vehicle || undefined, provider: provider || undefined };
    return {};
  };
  const m = useMutation({
    mutationFn: () => api.addEntity({ kind, name, detail: buildDetail() }),
    onSuccess: () => {
      setName("");
      setAbn("");
      setVehicle("");
      setProvider("");
      onDone();
    },
  });
  const namePlaceholder =
    kind === "company" ? "Company name e.g. Acme Pty Ltd" : kind === "employment" ? "Employer name" : kind === "novated_lease" ? "Label e.g. Tesla lease" : "Name";
  return (
    <div className="space-y-2 pt-2">
      <div className="flex flex-wrap gap-2">
        <select className={input} value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="company">company</option>
          <option value="employment">employment (PAYG)</option>
          <option value="novated_lease">novated_lease</option>
          <option value="individual">individual</option>
          <option value="trust">trust</option>
        </select>
        <input className={`${input} flex-1`} placeholder={namePlaceholder} value={name} onChange={(e) => setName(e.target.value)} />
        <button className={btn} disabled={!name || m.isPending} onClick={() => m.mutate()}>
          Add
        </button>
      </div>
      {kind === "company" && (
        <div className="flex flex-wrap items-center gap-3 pl-1 text-sm">
          <input className={`${input} w-56`} placeholder="ABN (11 digits)" value={abn} onChange={(e) => setAbn(e.target.value)} />
          <label className="flex items-center gap-1.5 text-muted">
            <input type="checkbox" checked={gst} onChange={(e) => setGst(e.target.checked)} />
            GST registered (lets the agent claim GST credits)
          </label>
        </div>
      )}
      {kind === "novated_lease" && (
        <div className="flex flex-wrap gap-2 pl-1">
          <input className={`${input} flex-1`} placeholder="Vehicle e.g. Tesla Model 3" value={vehicle} onChange={(e) => setVehicle(e.target.value)} />
          <input className={`${input} flex-1`} placeholder="Lease provider" value={provider} onChange={(e) => setProvider(e.target.value)} />
        </div>
      )}
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
