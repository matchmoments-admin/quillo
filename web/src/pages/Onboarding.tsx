import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { Card, Spinner, Button, BUCKET_LABEL, InfoTip, Term } from "../components/ui";
import {
  EntityFields,
  PropertyFields,
  PersonFields,
  entityToBody,
  propertyToBody,
  personToBody,
  personToValue,
  emptyEntity,
  emptyProperty,
  emptyPerson,
  type EntityValue,
  type PropertyValue,
  type PersonValue,
} from "../components/SituationFields";
import type { DraftRule, SituationDraft } from "../types";

const CONSENT_TEXT =
  "I consent to my receipt and transaction data being processed by Anthropic (USA) for OCR and " +
  "categorisation (Australian Privacy Principle 8 cross-border disclosure). I understand I can switch " +
  "to AU-resident processing (Bedrock Sydney) instead.";

// ── draft → editable form values ─────────────────────────────────────────────
function draftEntityToValue(e: SituationDraft["entities"][number]): EntityValue {
  return { kind: e.kind, name: e.name ?? e.detail?.employer ?? "", detail: e.detail ?? {} };
}
function draftPropertyToValue(p: SituationDraft["properties"][number]): PropertyValue {
  return { label: p.label, address: p.address ?? "", status: p.status, use_status: "", ownership_pct: String(p.ownership_pct ?? 100) };
}

type StepKey = "welcome" | "consent" | "intake" | "people" | "entities" | "properties" | "rules" | "confirm";

export function Onboarding() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const sit = useQuery({ queryKey: ["situation"], queryFn: () => api.situation() });

  // Rows the user will ADD. Existing saved entities/properties are shown read-only so we
  // never re-create them on save (no duplication for returning users).
  const [entities, setEntities] = useState<EntityValue[]>([]);
  const [properties, setProperties] = useState<PropertyValue[]>([]);
  const [rules, setRules] = useState<(DraftRule & { accept: boolean })[]>([]);
  const [intake, setIntake] = useState("");
  const [wfhDays, setWfhDays] = useState(""); // WFH days/week — the #1 PAYG claim, captured at set-up (D.1)

  // The taxpayer (self) + any spouse/dependants. Occupation + residency are the single biggest
  // inputs to the claimability engine, yet onboarding never used to ask for them (review High #5) —
  // users reached the categoriser with occupation NULL and residency silently defaulted to AU.
  const [self, setSelf] = useState<PersonValue>(emptyPerson());
  const [selfId, setSelfId] = useState<string | null>(null);
  const [extraPersons, setExtraPersons] = useState<PersonValue[]>([]);
  const [seeded, setSeeded] = useState(false);
  // Seed the self person from the row ensureTenant created, once the situation loads.
  useEffect(() => {
    if (seeded || !sit.data) return;
    const me = (sit.data.persons ?? []).find((p) => p.role === "self");
    if (me) {
      setSelfId(me.id);
      setSelf({ ...personToValue(me), role: "self" });
    } else {
      setSelf({ ...emptyPerson(), role: "self" });
    }
    setSeeded(true);
  }, [sit.data, seeded]);

  const consent = useMutation({
    mutationFn: () => api.consent(CONSENT_TEXT),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["situation"] }),
  });

  const draft = useMutation({
    mutationFn: (msg: string) => api.draftSituation(msg),
    onSuccess: (d) => {
      setEntities(d.entities.map(draftEntityToValue));
      setProperties(d.properties.map(draftPropertyToValue));
      setRules(d.rules.map((r) => ({ ...r, accept: true })));
      setStep("people");
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      // Persist the taxpayer's occupation/residency first — it drives categorisation. Update the
      // existing self row if there is one; otherwise create it.
      if (selfId) await api.updatePerson(selfId, personToBody(self));
      else await api.addPerson(personToBody({ ...self, role: "self" }));
      for (const p of extraPersons) if (p.display_name.trim()) await api.addPerson(personToBody(p));
      for (const e of entities) if (e.name.trim()) await api.addEntity(entityToBody(e));
      for (const p of properties) if (p.label.trim()) await api.addProperty(propertyToBody(p));
      for (const r of rules) if (r.accept) await api.addRule({ pattern: r.pattern, bucket: r.bucket, ato_label: r.ato_label });
      // WFH days/week → derive hours for the current FY (server derives; she refines on the Dashboard).
      if (wfhDays.trim() !== "") {
        const now = new Date();
        const fyStart = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
        await api.setWorkUse(fyStart, { wfh_hours: null, car_work_km: null, wfh_days_per_week: Math.max(0, Number(wfhDays)), wfh_weeks: null });
      }
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["situation"] });
      // Land on the PRIMED first action (import → review → … → File) rather than a bare dashboard.
      try {
        const p = await api.progress();
        navigate(p.next_action.href);
      } catch {
        navigate("/");
      }
    },
  });

  const [step, setStep] = useState<StepKey>("welcome");
  const [showFullConsent, setShowFullConsent] = useState(false);

  const stepKeys = useMemo<StepKey[]>(
    () => ["welcome", "consent", "intake", "people", "entities", "properties", ...(rules.length ? (["rules"] as StepKey[]) : []), "confirm"],
    [rules.length],
  );

  if (sit.isLoading) return <Spinner />;
  const s = sit.data;
  const usingBedrock = s?.profile?.inference_provider === "bedrock";
  const hasConsent = (s?.profile?.consent_xborder ?? 0) === 1 || usingBedrock;

  const idx = Math.max(0, stepKeys.indexOf(step));
  const goNext = () => setStep(stepKeys[Math.min(idx + 1, stepKeys.length - 1)]);
  const goBack = () => setStep(stepKeys[Math.max(idx - 1, 0)]);

  const updateEntity = (i: number, v: EntityValue) => setEntities((xs) => xs.map((x, j) => (j === i ? v : x)));
  const updateProperty = (i: number, v: PropertyValue) => setProperties((xs) => xs.map((x, j) => (j === i ? v : x)));

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Get set up</h1>
        <p className="mt-1 text-sm text-muted">
          A few one-time steps so the agent categorises accurately for your situation. Nothing is saved until you confirm.
        </p>
      </div>

      {/* progress */}
      <div className="flex items-center gap-1.5">
        {stepKeys.map((k, i) => (
          <div key={k} className={`h-1.5 flex-1 rounded-full ${i <= idx ? "bg-ink" : "bg-line"}`} />
        ))}
      </div>

      {step === "welcome" && (
        <Card className="p-5">
          <StepHead n={idx + 1} total={stepKeys.length} title="Welcome to Quillo" />
          <p className="text-sm text-ink-2">
            Quillo turns your receipts, statements and accounts into tidy, ATO-ready categories — so a financial year is
            ready to hand to your tax agent. You stay in control and confirm everything; Quillo never lodges your return
            and never moves your money.
          </p>
          <div className="mt-3 rounded-lg bg-surface p-3 text-xs text-muted">
            <span className="font-medium text-ink">Your privacy:</span> to read and categorise your records we use AI. Today
            that runs on secure servers in the USA (Anthropic) — we'll ask your explicit consent next — or you can switch to
            Australian-resident processing. We never sell your data or use it to train anyone's model.
          </div>
          <NavRow onNext={goNext} />
        </Card>
      )}

      {step === "consent" && (
        <Card className="p-5">
          <StepHead n={idx + 1} total={stepKeys.length} title={<>Cross-border processing consent (APP 8) <InfoTip k="app8" /></>} />
          {usingBedrock ? (
            <p className="text-sm text-muted">You're on AU-resident inference (Bedrock) — no US consent needed.</p>
          ) : hasConsent ? (
            <p className="text-sm text-safe">Consent recorded — you're good to go.</p>
          ) : (
            <>
              {/* Layered consent: a plain-language summary, with the full APP-8 wording behind "Read more". */}
              <p className="mb-2 text-sm text-ink-2">
                We send your receipt &amp; transaction content to Anthropic (USA) to read and categorise it. This is a
                cross-border disclosure under APP 8 — consenting means APP 8.1 protections won't apply to that US transfer.
                You can withdraw any time in Settings, or switch to Australian processing.
              </p>
              <button
                type="button"
                onClick={() => setShowFullConsent((v) => !v)}
                className="mb-2 text-xs font-semibold text-ink-3 underline underline-offset-2 hover:text-ink"
              >
                {showFullConsent ? "Hide" : "Read more"}
              </button>
              {showFullConsent && <p className="mb-3 rounded-lg bg-surface p-3 text-xs text-muted">{CONSENT_TEXT}</p>}
              <div>
                <Button onClick={() => consent.mutate()} disabled={consent.isPending}>
                  {consent.isPending ? "Recording…" : "I consent"}
                </Button>
              </div>
            </>
          )}
          <NavRow onNext={goNext} nextDisabled={!hasConsent} />
        </Card>
      )}

      {step === "intake" && (
        <Card className="p-5">
          <StepHead n={idx + 1} total={stepKeys.length} title="Tell me about your situation" />
          <p className="mb-3 text-sm text-muted">
            In your own words — your work, any company (with <Term k="abn">ABN</Term>), investment properties,{" "}
            <Term k="novated_lease">novated lease</Term>. I'll pre-fill the next steps; you confirm everything. Or skip and
            fill it in manually.
          </p>
          <textarea
            className="h-32 w-full rounded-lg border border-line bg-card px-3 py-2 text-sm"
            placeholder="e.g. I run Acme Pty Ltd (ABN 51 824 753 556), GST registered. I'm also PAYG-employed at BigCo. I have one rental at 14 Rental St, Sydney — I own 50%."
            value={intake}
            onChange={(e) => setIntake(e.target.value)}
          />
          {draft.isError && (
            <p className="mt-2 text-sm text-danger">
              Couldn't read that ({(draft.error as Error).message}). You can fill it in manually instead.
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button className="whitespace-nowrap" onClick={() => draft.mutate(intake)} disabled={!intake.trim() || draft.isPending}>
              {draft.isPending ? "Reading…" : "Extract & continue"}
            </Button>
            <Button className="whitespace-nowrap" variant="ghost" onClick={goNext}>
              Skip — I'll fill it in
            </Button>
          </div>
          <NavRow onBack={goBack} />
        </Card>
      )}

      {step === "people" && (
        <Card className="p-5">
          <StepHead n={idx + 1} total={stepKeys.length} title="You & your household" />
          <p className="mb-3 text-sm text-muted">
            Your occupation and tax residency shape which deductions the agent suggests, so it's worth getting right.
            Add a spouse/dependant only if their tax affairs sit alongside yours.
          </p>
          <div className="rounded-lg bg-surface p-3">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">You (the taxpayer)</div>
            <PersonFields value={self} onChange={setSelf} lockRole />
          </div>
          {/* WFH days/week — the single most-valuable PAYG deduction, captured up front so it appears
              automatically on the Dashboard. We derive the hours; she can refine them later. (D.1/R2) */}
          <label className="mt-3 block rounded-lg bg-surface p-3">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">Do you work from home? Roughly how many days a week?</span>
            <input
              type="number" min="0" max="7" step="0.5" value={wfhDays}
              onChange={(e) => setWfhDays(e.target.value)}
              placeholder="e.g. 2 — leave blank if you don't"
              className="mt-1 w-full rounded-lg border border-line bg-card px-3 py-2 text-sm"
            />
            <span className="mt-1 block text-xs text-muted">We'll estimate your home-office hours from this (you can refine them on the Dashboard). General info only.</span>
          </label>
          {extraPersons.length > 0 && (
            <div className="mt-3 space-y-3">
              {extraPersons.map((p, i) => (
                <div key={i} className="rounded-lg bg-surface p-3">
                  <PersonFields value={p} onChange={(v) => setExtraPersons((xs) => xs.map((x, j) => (j === i ? v : x)))} />
                  <button className="mt-2 text-xs text-muted hover:text-danger" onClick={() => setExtraPersons((xs) => xs.filter((_, j) => j !== i))}>
                    remove
                  </button>
                </div>
              ))}
            </div>
          )}
          <button className="mt-3 text-sm text-ink underline underline-offset-2" onClick={() => setExtraPersons((xs) => [...xs, emptyPerson()])}>
            + Add a spouse or dependant
          </button>
          <NavRow onBack={goBack} onNext={goNext} />
        </Card>
      )}

      {step === "entities" && (
        <Card className="p-5">
          <StepHead n={idx + 1} total={stepKeys.length} title={<>Your entities <InfoTip k="entities" /></>} />
          <p className="mb-3 text-sm text-muted">Company, PAYG employment, novated lease. Confirm or edit what I drafted; add any I missed.</p>
          <ExistingList items={(s?.entities ?? []).map((e) => `${e.kind}${e.name ? ` — ${e.name}` : ""}`)} />
          <div className="space-y-3">
            {entities.map((e, i) => (
              <div key={i} className="rounded-lg bg-surface p-3">
                <EntityFields value={e} onChange={(v) => updateEntity(i, v)} />
                <button className="mt-2 text-xs text-muted hover:text-danger" onClick={() => setEntities((xs) => xs.filter((_, j) => j !== i))}>
                  remove
                </button>
              </div>
            ))}
          </div>
          <button className="mt-3 text-sm text-ink underline underline-offset-2" onClick={() => setEntities((xs) => [...xs, emptyEntity()])}>
            + Add an entity
          </button>
          <NavRow onBack={goBack} onNext={goNext} />
        </Card>
      )}

      {step === "properties" && (
        <Card className="p-5">
          <StepHead n={idx + 1} total={stepKeys.length} title={<>Your properties <InfoTip k="property_status" /></>} />
          <p className="mb-3 text-sm text-muted">Each investment property so expenses attribute correctly. Address matters for rentals.</p>
          <ExistingList items={(s?.properties ?? []).map((p) => `${p.label} — ${p.status}`)} />
          <div className="space-y-3">
            {properties.map((p, i) => (
              <div key={i} className="rounded-lg bg-surface p-3">
                <PropertyFields value={p} onChange={(v) => updateProperty(i, v)} />
                <button className="mt-2 text-xs text-muted hover:text-danger" onClick={() => setProperties((xs) => xs.filter((_, j) => j !== i))}>
                  remove
                </button>
              </div>
            ))}
          </div>
          <button className="mt-3 text-sm text-ink underline underline-offset-2" onClick={() => setProperties((xs) => [...xs, emptyProperty()])}>
            + Add a property
          </button>
          <NavRow onBack={goBack} onNext={goNext} />
        </Card>
      )}

      {step === "rules" && (
        <Card className="p-5">
          <StepHead n={idx + 1} total={stepKeys.length} title={<>Suggested rules <InfoTip k="user_rules" /></>} />
          <p className="mb-3 text-sm text-muted">I spotted a few merchant rules. Keep the ones that look right.</p>
          <div className="space-y-2">
            {rules.map((r, i) => (
              <label key={i} className="flex items-center gap-2 rounded-lg bg-surface px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  checked={r.accept}
                  onChange={(e) => setRules((xs) => xs.map((x, j) => (j === i ? { ...x, accept: e.target.checked } : x)))}
                />
                <span>
                  "{r.pattern}" → {BUCKET_LABEL[r.bucket] ?? r.bucket} · {r.ato_label}
                </span>
              </label>
            ))}
          </div>
          <NavRow onBack={goBack} onNext={goNext} />
        </Card>
      )}

      {step === "confirm" && (
        <Card className="p-5">
          <StepHead n={idx + 1} total={stepKeys.length} title="What the agent will know" />
          <p className="mb-3 text-sm text-muted">Review before saving. This is exactly the context the categoriser uses.</p>
          <Summary
            persons={[self, ...extraPersons.filter((p) => p.display_name.trim())]}
            entities={entities.filter((e) => e.name.trim())}
            properties={properties.filter((p) => p.label.trim())}
            rules={rules.filter((r) => r.accept)}
            hasConsent={hasConsent}
          />
          {save.isError && <p className="mt-2 text-sm text-danger">Save failed: {(save.error as Error).message}</p>}
          <div className="mt-4 flex items-center gap-2">
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save & finish"}
            </Button>
            <Button variant="ghost" onClick={goBack}>
              Back
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

function StepHead({ n, total, title }: { n: number; total: number; title: ReactNode }) {
  return (
    <div className="mb-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">
        Step {n} of {total}
      </div>
      <h2 className="text-lg font-medium">{title}</h2>
    </div>
  );
}

function NavRow({ onBack, onNext, nextDisabled }: { onBack?: () => void; onNext?: () => void; nextDisabled?: boolean }) {
  if (!onBack && !onNext) return null;
  return (
    <div className="mt-5 flex items-center justify-between border-t border-line pt-4">
      {onBack ? (
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
      ) : (
        <span />
      )}
      {onNext && (
        <Button onClick={onNext} disabled={nextDisabled}>
          Next
        </Button>
      )}
    </div>
  );
}

function ExistingList({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="mb-3 rounded-lg bg-safe/5 p-3 text-sm text-muted">
      <div className="mb-1 text-xs font-medium uppercase tracking-wide">Already saved</div>
      {items.map((it, i) => (
        <div key={i}>• {it}</div>
      ))}
    </div>
  );
}

function Summary({
  persons,
  entities,
  properties,
  rules,
  hasConsent,
}: {
  persons: PersonValue[];
  entities: EntityValue[];
  properties: PropertyValue[];
  rules: (DraftRule & { accept: boolean })[];
  hasConsent: boolean;
}) {
  return (
    <div className="space-y-3 text-sm">
      <Line label="Consent" value={hasConsent ? "Recorded" : "Not yet — required for categorisation"} ok={hasConsent} />
      <div>
        <div className="text-xs font-medium uppercase tracking-wide text-muted">People ({persons.length})</div>
        {persons.map((p, i) => (
          <div key={i}>
            • {p.display_name || (p.role === "self" ? "You" : "Taxpayer")} — {p.role}
            {p.occupation ? ` · ${p.occupation}` : " · occupation not set"} · {p.tax_residency === "foreign" ? "foreign resident" : "AU resident"}
          </div>
        ))}
      </div>
      <div>
        <div className="text-xs font-medium uppercase tracking-wide text-muted">Entities ({entities.length})</div>
        {entities.length ? (
          entities.map((e, i) => (
            <div key={i}>
              • {e.kind}
              {e.name ? ` — ${e.name}` : ""}
              {e.kind === "company" && (e.detail.abn ? ` · ABN ${e.detail.abn}` : "") + (e.detail.gst_registered ? " · GST registered" : " · not GST registered")}
              {e.kind === "novated_lease" && e.detail.vehicle ? ` · ${e.detail.vehicle}${e.detail.provider ? ` via ${e.detail.provider}` : ""}` : ""}
            </div>
          ))
        ) : (
          <div className="text-muted">None</div>
        )}
      </div>
      <div>
        <div className="text-xs font-medium uppercase tracking-wide text-muted">Properties ({properties.length})</div>
        {properties.length ? (
          properties.map((p, i) => (
            <div key={i}>
              • {p.label} — {p.status}
              {p.address ? ` · ${p.address}` : ""} · {p.ownership_pct || 100}% owned
            </div>
          ))
        ) : (
          <div className="text-muted">None</div>
        )}
      </div>
      {rules.length > 0 && (
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-muted">Rules ({rules.length})</div>
          {rules.map((r, i) => (
            <div key={i}>
              • "{r.pattern}" → {BUCKET_LABEL[r.bucket] ?? r.bucket}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Line({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`grid h-5 w-5 place-items-center rounded-full text-[10px] font-bold ${ok ? "bg-safe text-white" : "bg-line text-muted"}`}>
        {ok ? "✓" : "!"}
      </span>
      <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}:</span>
      <span>{value}</span>
    </div>
  );
}
