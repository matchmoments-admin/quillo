import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { BUCKETS } from "../types";
import { Card, Spinner, BUCKET_LABEL } from "../components/ui";
import { EntityFields, PropertyFields, entityToBody, propertyToBody, emptyEntity, emptyProperty, OWNED_STATUSES, TENANT_STATUSES, propertyStatusLabel, type EntityValue, type PropertyValue } from "../components/SituationFields";

const input = "rounded-lg border border-line bg-card px-3 py-2 text-sm";
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
        <span className="truncate">{property.label} — {propertyStatusLabel(property.status)}</span>
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
        <optgroup label="You own this">
          {OWNED_STATUSES.map((s) => <option key={s} value={s}>{propertyStatusLabel(s)}</option>)}
        </optgroup>
        <optgroup label="You rent this (tenant)">
          {TENANT_STATUSES.map((s) => <option key={s} value={s}>{propertyStatusLabel(s)}</option>)}
        </optgroup>
      </select>
      <button className={btn} disabled={!label || save.isPending} onClick={() => save.mutate()}>Save</button>
      <button className={del} onClick={() => setEditing(false)}>cancel</button>
    </div>
  );
}

function AddProperty({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState<PropertyValue>(emptyProperty());
  const m = useMutation({
    mutationFn: () => api.addProperty(propertyToBody(value)),
    onSuccess: () => {
      setValue(emptyProperty());
      onDone();
    },
  });
  return (
    <div className="flex flex-wrap items-start gap-2 pt-2">
      <div className="flex-1">
        <PropertyFields value={value} onChange={setValue} />
      </div>
      <button className={btn} disabled={!value.label || m.isPending} onClick={() => m.mutate()}>
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
  const [value, setValue] = useState<EntityValue>(emptyEntity());
  const m = useMutation({
    mutationFn: () => api.addEntity(entityToBody(value)),
    onSuccess: () => {
      setValue(emptyEntity(value.kind));
      onDone();
    },
  });
  return (
    <div className="flex flex-wrap items-start gap-2 pt-2">
      <div className="flex-1">
        <EntityFields value={value} onChange={setValue} />
      </div>
      <button className={btn} disabled={!value.name || m.isPending} onClick={() => m.mutate()}>
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
