import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { BUCKETS } from "../types";
import { Card, Spinner, BUCKET_LABEL, InfoTip } from "../components/ui";
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

      {/* Privacy & AI processing (APP-8 consent dashboard) */}
      <PrivacyPanel
        profile={s.profile}
        onChange={() => {
          invalidate();
          qc.invalidateQueries({ queryKey: ["progress"] });
        }}
      />

      {/* Properties */}
      <Section title={<>Properties <InfoTip k="property_status" /></>}>
        {s.properties.map((p) => (
          <EditableProperty key={p.id} property={p} onDone={invalidate} />
        ))}
        <AddProperty onDone={invalidate} />
      </Section>

      {/* Entities */}
      <Section title={<>Entities (employment · company · novated lease) <InfoTip k="entities" /></>}>
        {s.entities.map((e) => (
          <Row key={e.id} label={entityLabel(e)} onDelete={() => api.deleteEntity(e.id).then(invalidate)} />
        ))}
        <AddEntity onDone={invalidate} />
      </Section>

      {/* Rules */}
      <Section title={<>Per-user rules <InfoTip k="user_rules" /></>}>
        {s.rules.map((r) => (
          <Row key={r.id} label={`"${r.pattern}" → ${BUCKET_LABEL[r.bucket] ?? r.bucket} · ${r.ato_label}`} onDelete={() => api.deleteRule(r.id).then(invalidate)} />
        ))}
        <AddRule onDone={invalidate} />
      </Section>

      {/* Devices / keys */}
      <Section title={<>Devices (ingest keys) <InfoTip k="devices" /></>}>
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

// APP-8 consent dashboard: shows current cross-border processing state + the recorded consent text
// and date, and lets the user withdraw consent (which re-arms the gate on the US/Anthropic path).
// Bedrock/AU tenants process in Australia, so no cross-border consent is required.
function PrivacyPanel({
  profile,
  onChange,
}: {
  profile?: { consent_xborder: number; consent_xborder_at?: string | null; consent_xborder_text?: string | null; inference_provider: string | null; inference_region?: string | null };
  onChange: () => void;
}) {
  const onBedrock = profile?.inference_provider === "bedrock";
  const consented = (profile?.consent_xborder ?? 0) === 1;
  const withdraw = useMutation({ mutationFn: () => api.withdrawConsent(), onSuccess: onChange });

  const exportData = useMutation({
    mutationFn: () => api.exportData(),
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "quillo-export.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    },
  });
  const purge = useMutation({
    mutationFn: () => api.purgeData(),
    onSuccess: () => {
      // Everything's gone (including the profile) — bounce to a clean re-onboard.
      window.location.href = "/";
    },
  });
  const confirmPurge = () => {
    const typed = window.prompt(
      "This permanently deletes ALL your data — transactions, statements, receipts, income, assets, documents and your QuickBooks connection. This cannot be undone.\n\nType DELETE to confirm.",
    );
    if (typed === "DELETE") purge.mutate();
  };

  return (
    <Card className="p-4">
      <div className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">
        Privacy &amp; AI processing <InfoTip k="app8" />
      </div>

      {onBedrock ? (
        <div className="rounded-lg bg-safe/5 p-3 text-sm">
          <p className="font-medium text-safe">Processed in Australia 🇦🇺</p>
          <p className="mt-1 text-muted">
            Your records are processed by an Australian-resident model (Amazon Bedrock, Sydney), so cross-border
            consent isn't required.
          </p>
        </div>
      ) : consented ? (
        <div className="space-y-3">
          <div className="rounded-lg bg-surface p-3 text-sm">
            <p>
              <span className="font-medium">Cross-border AI processing:</span> consented
              {profile?.consent_xborder_at ? ` on ${profile.consent_xborder_at} (UTC)` : ""}.
            </p>
            <p className="mt-1 text-muted">
              Receipt &amp; transaction content is sent to Anthropic (USA) for OCR and categorisation. Suggestions are
              human-reviewed — you confirm everything.
            </p>
            {profile?.consent_xborder_text && (
              <p className="mt-2 border-l-2 border-line pl-3 text-xs italic text-muted">
                “{profile.consent_xborder_text}”
              </p>
            )}
          </div>
          <button
            onClick={() => {
              if (window.confirm("Withdraw consent? Quillo will stop sending records to the US AI provider, and new items won't be categorised until you re-consent or switch to Australian processing.")) {
                withdraw.mutate();
              }
            }}
            disabled={withdraw.isPending}
            className="rounded-lg border border-danger/40 px-3 py-2 text-sm font-medium text-danger transition hover:bg-danger/5 disabled:opacity-50"
          >
            {withdraw.isPending ? "Withdrawing…" : "Withdraw consent"}
          </button>
        </div>
      ) : (
        <div className="rounded-lg bg-warn/10 p-3 text-sm">
          <p className="font-medium text-warn">Cross-border AI processing not enabled.</p>
          <p className="mt-1 text-muted">
            New items won't be categorised until you consent to US processing (during onboarding) or switch to
            Australian-resident processing.
          </p>
        </div>
      )}

      {/* APP 12 / APP 13 — your data */}
      <div className="mt-4 border-t border-line pt-3">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Your data</div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => exportData.mutate()}
            disabled={exportData.isPending}
            className="rounded-lg border border-ink/25 px-3 py-2 text-sm font-medium text-ink transition hover:bg-ink/5 disabled:opacity-50"
          >
            {exportData.isPending ? "Preparing…" : "Export my data (JSON)"}
          </button>
          <button
            onClick={confirmPurge}
            disabled={purge.isPending}
            className="rounded-lg border border-danger/40 px-3 py-2 text-sm font-medium text-danger transition hover:bg-danger/5 disabled:opacity-50"
          >
            {purge.isPending ? "Deleting…" : "Delete my account & data"}
          </button>
        </div>
        {exportData.isError && <p className="mt-2 text-xs text-danger">Export failed: {(exportData.error as Error).message}</p>}
        {purge.isError && <p className="mt-2 text-xs text-danger">Delete failed: {(purge.error as Error).message}</p>}
      </div>

      <p className="mt-3 text-xs text-muted">
        Read our{" "}
        <a href="https://quillo.au/privacy" target="_blank" rel="noreferrer" className="underline underline-offset-2">
          Privacy Policy
        </a>
        . Under the Australian Privacy Principles you can request access to, correction of, or deletion of your data —
        email{" "}
        <a href="mailto:hello@quillo.au" className="underline underline-offset-2">
          hello@quillo.au
        </a>
        .
      </p>
    </Card>
  );
}

function Section({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
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
