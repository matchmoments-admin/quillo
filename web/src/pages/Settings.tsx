import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, useLocation } from "react-router-dom";
import { api } from "../api";
import { useFeatures } from "../lib/features";
import { settingsSectionHome } from "../lib/legacyRoutes";
import { useHashScroll } from "../lib/useHashScroll";
import { BUCKETS } from "../types";
import { Card, Spinner, BUCKET_LABEL, InfoTip, money, parseMoneyToCents } from "../components/ui";
import { AiChangesFeed } from "../components/AiChangesFeed";
import { BankConsents } from "../components/BankConsents";
import { CarryIns, PeopleList, runDelete } from "../components/ProfileSections";
import { ENTITY_KINDS, EntityFields, PropertyFields, entityToBody, entityToValue, propertyToBody, propertyError, emptyEntity, emptyProperty, OWNED_STATUSES, TENANT_STATUSES, USE_STATUSES, DENY_USE_STATUSES, isTenantStatus, statusLabel, propertyStatusLabel, type EntityValue, type PropertyValue } from "../components/SituationFields";
import type { Account, Property, LoanProperty, IncomeActivity, Situation } from "../types";
import { isPropertyBucket } from "../lib/buckets";

const input = "rounded-lg border border-line bg-card px-3 py-2 text-sm";
const btn = "rounded-lg bg-ink px-3 py-2 text-sm font-medium text-white hover:bg-ink/90 disabled:opacity-50";
const del = "text-xs text-muted hover:text-danger";

// Settings (#593, spec A11 ticket c, decision #436). With ft_journey OFF this page renders every section
// exactly as it always has. ON it is ACCOUNT-ONLY: consent + Your data (export, delete), bank connections,
// devices (ingest keys) and the recent AI changes. Each tax section moved to ONE new home (the table is
// SETTINGS_SECTION_MOVES in lib/legacyRoutes.ts), composed there from the section components below:
//   People + prior-year carry-ins → Get set up (/setup, only while its profile mode is live — #585)
//   Properties + loan attribution → Grow › Property (/grow/property)
//   Entities, activities, GST, BAS, trust/partnership distributions, SMSF, super → Grow › Business
//   Per-user rules → Review (/review#rules)
// A `/settings#<section>` deep link redirects to `<new home>#<section>`. Every hook sits above the first
// conditional return (hooks lint gate; React #310 history).

export function Settings() {
  const qc = useQueryClient();
  const sit = useQuery({ queryKey: ["situation"], queryFn: () => api.situation() });
  const accts = useQuery({ queryKey: ["accounts"], queryFn: () => api.accounts() });
  const keys = useQuery({ queryKey: ["keys"], queryFn: () => api.keys() });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["situation"] });
  const { has } = useFeatures();
  const { hash } = useLocation();
  const ft = has("ft_journey");
  // #585: with About you live (ft_journey + situation_profile), People and the prior-year carry-ins live in its
  // profile mode instead (spec A2); OFF ⇒ both sections render here exactly as before.
  const aboutYouLive = ft && has("situation_profile");
  useHashScroll(ft);
  const movedTo = ft && hash ? settingsSectionHome(hash, { aboutYou: aboutYouLive }) : null;

  if (movedTo) return <Navigate to={movedTo} replace />;
  if (sit.isLoading) return <Spinner />;
  if (sit.error) return <Card className="p-6 text-sm text-muted">Couldn't load: {(sit.error as Error).message}</Card>;
  const s = sit.data!;

  const devices = (
    <DevicesSection
      anchored={ft}
      loading={keys.isLoading}
      keys={keys.data ?? []}
      onRevoke={(id) => api.revokeKey(id).then(() => qc.invalidateQueries({ queryKey: ["keys"] }))}
      onMinted={() => qc.invalidateQueries({ queryKey: ["keys"] })}
    />
  );
  const privacy = (
    <PrivacyPanel
      anchored={ft}
      profile={s.profile}
      onChange={() => {
        invalidate();
        qc.invalidateQueries({ queryKey: ["progress"] });
      }}
    />
  );

  if (ft) {
    return (
      <div className="space-y-8">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <MovedSections aboutYouLive={aboutYouLive} />
        <AiChangesFeed />
        {privacy}
        {has("bank_feed_cdr") && <BankConsents />}
        {!aboutYouLive && <PeopleSection id="people" persons={s.persons ?? []} onDone={invalidate} />}
        {!aboutYouLive && <CarryInsSection id="carry-ins" />}
        {devices}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      {/* Recent (audited, reversible) changes — self-gates on ai_edit_feed. */}
      <AiChangesFeed />

      {/* Privacy & AI processing (APP-8 consent dashboard) */}
      {privacy}

      {/* Bank connections — the CDR consent dashboard (#576, ADR-0003 §6.4). Flag-gated. */}
      {has("bank_feed_cdr") && <BankConsents />}

      {/* People (taxpayers) — occupation/residency drive deduction hints */}
      <PeopleSection persons={s.persons ?? []} onDone={invalidate} />

      <PropertySections s={s} accounts={accts.data ?? []} onDone={invalidate} />

      {/* Prior-year carry-ins — captured for your agent. CAPTURE-ONLY: never auto-applied to your
          position (a capital loss offsets capital gains only; an opening value is the agent's to apply). */}
      <CarryInsSection />

      <BusinessSections s={s} onDone={invalidate} />

      <RulesSection s={s} onDone={invalidate} />

      {/* Devices / keys */}
      {devices}
    </div>
  );
}

/** ft_journey ON: where the tax sections went, one link per new home (targets from SETTINGS_SECTION_MOVES). */
function MovedSections({ aboutYouLive }: { aboutYouLive: boolean }) {
  const homes: { anchor: string; what: string }[] = [
    ...(aboutYouLive ? [{ anchor: "people", what: "People and last year's carry-ins" }, { anchor: "employers", what: "Your employers" }] : []),
    { anchor: "properties", what: "Properties and their loans" },
    { anchor: "entities", what: "Business, companies, trusts, GST and BAS, SMSF and super" },
    { anchor: "rules", what: "Your sorting rules" },
  ];
  return (
    <Card className="p-4">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Looking for your tax details?</div>
      <p className="text-sm text-muted">Settings now holds your account only. Your tax details live where you use them:</p>
      <ul className="mt-2 space-y-1 text-sm">
        {homes.map((h) => {
          const to = settingsSectionHome(`#${h.anchor}`, { aboutYou: aboutYouLive });
          if (!to) return null;
          return (
            <li key={h.anchor}>
              {h.what}:{" "}
              <Link to={to} className="font-medium text-ink underline underline-offset-2">
                {movedLabel(to)}
              </Link>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function movedLabel(to: string): string {
  if (to.startsWith("/setup")) return "Get set up";
  if (to.startsWith("/grow/property")) return "Grow › Property";
  if (to.startsWith("/grow/business")) return "Grow › Business & companies";
  return "Review";
}

// ── Section groups, composed by Settings (flag OFF) and by their new homes (flag ON, #593) ───────────────
// `anchored` / `id` add the section's anchor id (a wrapper div) — only in the ON homes, so OFF markup is
// byte-identical to before the split.

function PeopleSection({ id, persons, onDone }: { id?: string; persons: NonNullable<Situation["persons"]>; onDone: () => void }) {
  return (
    <Section id={id} title={<>People (taxpayers) <InfoTip k="persons" /></>}>
      <PeopleList persons={persons} onDone={onDone} />
    </Section>
  );
}

function CarryInsSection({ id }: { id?: string }) {
  return (
    <Section
      id={id}
      title={
        <>
          Prior-year carry-ins{" "}
          <InfoTip tip="Carried-forward capital losses and opening depreciation values from last year. These are stored for your registered tax agent — Quillo never auto-applies them to your position (a capital loss offsets capital gains only, not income)." />
        </>
      }
    >
      <CarryIns />
    </Section>
  );
}

function PropertySections({ s, accounts, onDone, anchored = false }: { s: Situation; accounts: Account[]; onDone: () => void; anchored?: boolean }) {
  return (
    <>
      {/* Properties */}
      <Section id={anchored ? "properties" : undefined} title={<>Properties <InfoTip k="property_status" /></>}>
        {s.properties.map((p) => (
          <EditableProperty key={p.id} property={p} onDone={onDone} />
        ))}
        {!s.properties.length && <Empty>No properties yet. Add an investment or rented property so its expenses attribute correctly.</Empty>}
        <AddProperty onDone={onDone} />
      </Section>

      {/* Loan → property links — set the deductible-interest % each loan funds. Set-up data only:
          it pre-fills the guided interest/principal split later; nothing is claimed here. */}
      <Section
        id={anchored ? "loans" : undefined}
        title={
          <>
            Loan interest attribution{" "}
            <InfoTip tip="Link a loan/mortgage account to the property it funds and set the share of interest that's deductible. It pre-fills the guided interest-vs-principal split later — nothing is claimed automatically." />
          </>
        }
      >
        {(s.loans_properties ?? []).map((lp) => (
          <EditableLoanProperty key={lp.id} link={lp} accounts={accounts} properties={s.properties} onDone={onDone} />
        ))}
        {!(s.loans_properties ?? []).length && (
          <Empty>No loan links yet. Link a loan to the property it funds so its interest can be split out at tax time.</Empty>
        )}
        <AddLoanProperty accounts={accounts} properties={s.properties} onDone={onDone} />
      </Section>
    </>
  );
}

function BusinessSections({ s, onDone, anchored = false, employersElsewhere = false }: { s: Situation; onDone: () => void; anchored?: boolean; employersElsewhere?: boolean }) {
  const { has } = useFeatures();
  const a = (id: string) => (anchored ? id : undefined);
  return (
    <>
      {/* Entities. #593: with Get set up's profile mode live, employers are edited there (next to the
          employment periods), so Grow › Business keeps companies, trusts, partnerships, SMSF and leases. */}
      {employersElsewhere ? (
        <Section id={a("entities")} title={<>Entities (company · trust · partnership · novated lease) <InfoTip k="entities" /></>}>
          {s.entities.filter((e) => e.kind !== "employment").map((e) => (
            <EditableEntity key={e.id} entity={e} onDone={onDone} kinds={NON_EMPLOYER_KINDS} />
          ))}
          {!s.entities.some((e) => e.kind !== "employment") && <Empty>No entities yet. Add your company (with ABN), trust, partnership or a novated lease so spend routes to the right tax "hat".</Empty>}
          <AddEntity onDone={onDone} kinds={NON_EMPLOYER_KINDS} />
          <p className="px-1 pt-1 text-xs text-muted">
            Your employers are in{" "}
            <Link to="/setup#employers" className="text-ink underline underline-offset-2">
              Get set up
            </Link>
            .
          </p>
        </Section>
      ) : (
        <Section id={a("entities")} title={<>Entities (employment · company · novated lease) <InfoTip k="entities" /></>}>
          {s.entities.map((e) => (
            <EditableEntity key={e.id} entity={e} onDone={onDone} />
          ))}
          {!s.entities.length && <Empty>No entities yet. Add your employer, company (with ABN), or a novated lease so spend routes to the right tax "hat".</Empty>}
          <AddEntity onDone={onDone} />
        </Section>
      )}

      {/* Business activities (#155) — a sole trader names their activity (e.g. "Rideshare", "Freelance
          design") so spend can attribute to it. Auto-seeded for employers/companies; manual for ABN
          sole traders. attribution_engine is what makes attribution useful, so gate the section on it. */}
      {has("attribution_engine") && (
        <Section id={a("activities")} title={<>Business activities <InfoTip tip="Name a business/sole-trader activity (e.g. 'Rideshare', 'Freelance design') so its income and expenses attribute to it. Salary and rental activities are created automatically. Optionally tag an occupation (e.g. it_professional) for future occupation-specific hints. General information." /></>}>
          <BusinessActivities entities={s.entities} />
        </Section>
      )}

      {/* GST registration (the tenant default — the fallback for a sole trader with no company entity).
          Drives the indicative BAS on Reports. A company's own GST flag is set on its entity above. */}
      {has("gst_bas") && (
        <Section id={a("gst")} title={<>GST registration <InfoTip tip="Tick this if you're registered for GST (e.g. an ABN sole trader). Quillo then shows an indicative BAS position on Reports — GST collected on business income minus GST credits on business spend. A company's GST flag is set on its entity. General information — confirm with a registered tax/BAS agent." /></>}>
          <GstRegistration registered={(s.profile?.gst_registered ?? 0) === 1} onDone={onDone} />
        </Section>
      )}

      {/* BAS periods + PAYG instalments (#174) — actual lodged/draft figures. Recorded BAS periods
          OVERRIDE the ledger-derived indicative BAS for the FY; PAYG instalments are informational. */}
      {has("gst_bas") && (
        <Section id={a("bas")} title={<>BAS periods &amp; PAYG instalments <InfoTip tip="Enter your actual quarterly BAS figures (GST collected / credits) — these override Quillo's ledger estimate for that year on Reports. PAYG instalments are pre-payments toward your income tax (informational, never in your position). Quillo never lodges. General information — confirm with a registered tax/BAS agent." /></>}>
          <BasPeriods />
        </Section>
      )}

      {/* Trust distributions (#139) — what a trust distributed to you, character retained */}
      {has("trust_distributions") && (
        <Section id={a("trust")} title={<>Trust distributions <InfoTip tip="Your share of a trust's net income, with its character retained (a franked dividend stays franked). It's assessable to you. Add a trust entity above first. General information — confirm with a registered tax agent." /></>}>
          <TrustDistributions trusts={s.entities.filter((e) => e.kind === "trust")} />
        </Section>
      )}

      {/* Partnership distributions (Slice E) — your share of partnership net income, character retained */}
      {has("partnership_distributions") && (
        <Section id={a("partnership")} title={<>Partnership distributions <InfoTip tip="Your share of a partnership's net income, with its character retained (a franked dividend stays franked, a discounted capital gain stays discounted). It's assessable to you; the partnership lodges its own return. Add a partnership entity above first. General information — confirm with a registered tax agent." /></>}>
          <PartnershipDistributions partnerships={s.entities.filter((e) => e.kind === "partnership")} />
        </Section>
      )}

      {/* SMSF members + balances (#140) — drives the ECPI exempt fraction. Fund earnings are recorded
          as income against the SMSF entity (Income page). SMSF is a separate taxpayer. */}
      {has("smsf_engine") && (
        <Section id={a("smsf")} title={<>SMSF members &amp; balances <InfoTip tip="A self-managed super fund is a separate taxpayer. Add each member's pension- and accumulation-phase balances so Quillo can compute the ECPI exempt fraction (the share of fund income that's tax-exempt in pension phase). Record the fund's earnings as income against the SMSF entity. General information — confirm with a registered tax/SMSF agent." /></>}>
          <SmsfMembers funds={s.entities.filter((e) => e.kind === "smsf")} />
        </Section>
      )}

      {/* Super contributions (#140) — concessional / non-concessional, for cap context. Capture-only. */}
      {has("smsf_engine") && (
        <Section id={a("super")} title={<>Super contributions <InfoTip tip="Concessional (pre-tax, e.g. salary sacrifice + employer SG) and non-concessional (after-tax) contributions, recorded for the contributions-cap context your agent checks. Capture-only — Quillo doesn't apply the cap. General information." /></>}>
          <SuperContributions persons={s.persons ?? []} />
        </Section>
      )}
    </>
  );
}

function RulesSection({ s, onDone, anchored = false }: { s: Situation; onDone: () => void; anchored?: boolean }) {
  return (
    <Section id={anchored ? "rules" : undefined} title={<>Per-user rules <InfoTip k="user_rules" /></>}>
        {s.rules.map((r) => (
          <EditableRule key={r.id} rule={r} properties={s.properties} onDone={onDone} />
        ))}
        {!s.rules.length && <Empty>No rules yet. Add a shortcut like "Ray White → rental agent" — or just correct the same merchant twice and Quillo will offer to learn it for you.</Empty>}
        <AddRule properties={s.properties} onDone={onDone} />
        <p className="px-1 pt-1 text-xs text-muted">
          Matching is case-insensitive and matches any merchant <em>containing</em> the text; the highest-priority rule wins.
          Quillo also auto-learns a rule when you correct the same merchant twice — you'll get an alert when it does.
        </p>
    </Section>
  );
}

function DevicesSection({
  anchored,
  loading,
  keys,
  onRevoke,
  onMinted,
}: {
  anchored: boolean;
  loading: boolean;
  keys: { key_id: string; label?: string | null; revoked_at?: string | null }[];
  onRevoke: (keyId: string) => Promise<unknown>;
  onMinted: () => void;
}) {
  return (
    <Section id={anchored ? "devices" : undefined} title={<>Devices (ingest keys) <InfoTip k="devices" /></>}>
      {loading ? (
        <Spinner />
      ) : (
        keys.map((k) => (
          <Row
            key={k.key_id}
            label={`${k.label ?? "key"} · ${k.key_id}${k.revoked_at ? " (revoked)" : ""}`}
            onDelete={k.revoked_at ? undefined : () => onRevoke(k.key_id)}
            deleteLabel="revoke"
          />
        ))
      )}
      <MintKey onDone={onMinted} />
    </Section>
  );
}

// ── The sections' new homes (flag ft_journey ON, #593): each fetches the situation and renders its group
// with anchors, so Grow › Property / Grow › Business / Review compose the SAME editors Settings had. ────────

function useSituation() {
  const qc = useQueryClient();
  const sit = useQuery({ queryKey: ["situation"], queryFn: () => api.situation() });
  return { sit, invalidate: () => qc.invalidateQueries({ queryKey: ["situation"] }) };
}

function SituationGate({ sit, children }: { sit: ReturnType<typeof useSituation>["sit"]; children: (s: Situation) => React.ReactNode }) {
  if (sit.isLoading) return <Spinner />;
  if (sit.error || !sit.data) return <Card className="p-6 text-sm text-muted">Couldn't load: {(sit.error as Error | null)?.message ?? "no data"}</Card>;
  return <>{children(sit.data)}</>;
}

/** Grow › Property: Properties + loan interest attribution (anchors #properties, #loans). */
export function PropertySettings() {
  const { sit, invalidate } = useSituation();
  const accts = useQuery({ queryKey: ["accounts"], queryFn: () => api.accounts() });
  return <SituationGate sit={sit}>{(s) => <PropertySections anchored s={s} accounts={accts.data ?? []} onDone={invalidate} />}</SituationGate>;
}

/**
 * Grow › Business & companies: entities through super contributions (anchors #entities … #super). Employers
 * move to Get set up (#employers) only while its profile mode is live (ft_journey + situation_profile, the
 * same rule as People); otherwise they stay here with the other entities.
 */
export function BusinessSettings() {
  const { sit, invalidate } = useSituation();
  const { has } = useFeatures();
  const employersElsewhere = has("ft_journey") && has("situation_profile");
  return <SituationGate sit={sit}>{(s) => <BusinessSections anchored employersElsewhere={employersElsewhere} s={s} onDone={invalidate} />}</SituationGate>;
}

/**
 * Get set up (profile mode, ft_journey + situation_profile): your employers — `employment` entities only,
 * moved out of Grow › Business (#593). The caller renders the #employers section around it. Employers marked
 * from bank pay ("My wages", #577) are employment entities too, so they show here.
 */
export function EmployerList({ entities, onDone }: { entities: Situation["entities"]; onDone: () => void }) {
  const employers = entities.filter((e) => e.kind === "employment");
  return (
    <>
      {employers.map((e) => (
        <EditableEntity key={e.id} entity={e} onDone={onDone} kinds={EMPLOYER_KINDS} />
      ))}
      {!employers.length && <Empty>No employers yet. Add each employer who pays you wages so your work spending and their income statement line up.</Empty>}
      <AddEntity onDone={onDone} kinds={EMPLOYER_KINDS} />
    </>
  );
}

const EMPLOYER_KINDS: readonly string[] = ["employment"];
const NON_EMPLOYER_KINDS: readonly string[] = ENTITY_KINDS.filter((k) => k !== "employment");

/** Review: the per-user sorting rules (anchor #rules). */
export function RulesSettings() {
  const { sit, invalidate } = useSituation();
  return <SituationGate sit={sit}>{(s) => <RulesSection anchored s={s} onDone={invalidate} />}</SituationGate>;
}


// APP-8 consent dashboard: shows current cross-border processing state + the recorded consent text
// and date, and lets the user withdraw consent (which re-arms the gate on the US/Anthropic path).
// Bedrock/AU tenants process in Australia, so no cross-border consent is required.
function PrivacyPanel({
  anchored = false,
  profile,
  onChange,
}: {
  anchored?: boolean;
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

  const panel = (
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
      <div id={anchored ? "your-data" : undefined} className="mt-4 border-t border-line pt-3">
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
  // ft_journey ON (#593): anchors #privacy and #your-data; OFF the markup is unchanged.
  return anchored ? (
    <div id="privacy" className="scroll-mt-20">
      {panel}
    </div>
  ) : (
    panel
  );
}

function GstRegistration({ registered, onDone }: { registered: boolean; onDone: () => void }) {
  const qc = useQueryClient();
  const set = useMutation({
    mutationFn: (v: boolean) => api.setGstRegistered(v),
    onSuccess: () => {
      onDone();
      for (const k of ["report", "dashboard", "filing-readiness"]) qc.invalidateQueries({ queryKey: [k] });
    },
  });
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" className="h-4 w-4" checked={registered} disabled={set.isPending} onChange={(e) => set.mutate(e.target.checked)} />
      <span>I'm registered for GST</span>
      {set.isPending && <span className="text-xs text-muted">saving…</span>}
    </label>
  );
}

function Section({ id, title, children }: { id?: string; title: React.ReactNode; children: React.ReactNode }) {
  const card = (
    <Card className="p-4">
      <div className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">{title}</div>
      <div className="space-y-2">{children}</div>
    </Card>
  );
  // An anchored section (its new home, flag ON — #593) gets an id wrapper; without one the markup is unchanged.
  return id ? (
    <div id={id} className="scroll-mt-20">
      {card}
    </div>
  ) : (
    card
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

function EditableProperty({ property, onDone }: { property: { id: string; label: string; status: string; use_status?: string | null; acquired_date?: string | null; cost_base_cents?: number | null; main_residence_flag?: number | null }; onDone: () => void }) {
  const { has } = useFeatures();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(property.label);
  const [status, setStatus] = useState(property.status);
  const [useStatus, setUseStatus] = useState(property.use_status ?? "");
  // #486 (property_capital_detail): these columns have existed since migration 0006 and the API has
  // always accepted them, but no surface ever set them — so a taxpayer could not record what their
  // property cost, when they bought it, or that it is their main residence. Money-relevant: the
  // acquired date gates the 12-month CGT discount, and the cost base is what a disposal is measured
  // against. Held as strings so an untouched field stays "" and is sent as null ⇒ COALESCE leaves the
  // stored value alone.
  const [acquiredDate, setAcquiredDate] = useState(property.acquired_date ?? "");
  const [costBase, setCostBase] = useState(property.cost_base_cents != null ? String(property.cost_base_cents / 100) : "");
  const [mainResidence, setMainResidence] = useState((property.main_residence_flag ?? 0) === 1);
  const capitalOn = has("property_capital_detail") && !isTenantStatus(status);
  const save = useMutation({
    mutationFn: () => api.updateProperty(property.id, {
      label, status, use_status: useStatus || null,
      // Flag OFF (or a tenant record) ⇒ these keys are never sent ⇒ the request body is byte-identical
      // to today's. A blank field sends null so COALESCE preserves whatever is stored.
      ...(capitalOn ? {
        acquired_date: acquiredDate || null,
        cost_base_cents: costBase.trim() === "" ? null : Math.round(Number(costBase) * 100),
        main_residence_flag: mainResidence ? 1 : 0,
      } : {}),
    }),
    onSuccess: () => { setEditing(false); onDone(); },
  });
  if (!editing) {
    return (
      <div className="flex items-center justify-between rounded-lg bg-surface px-3 py-2 text-sm">
        <span className="truncate">{property.label} — {propertyStatusLabel(property.status)}</span>
        <div className="flex flex-none gap-3">
          <button onClick={() => setEditing(true)} className={del}>edit</button>
          <button onClick={() => runDelete(() => api.deleteProperty(property.id), { onDone, label: "property" })} className={del}>delete</button>
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
      {!isTenantStatus(status) && status !== "sold" && (
        <select className={input} value={useStatus} onChange={(e) => setUseStatus(e.target.value)} title="How it was used this year (gates deductibility)">
          <option value="">used: — same —</option>
          {USE_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
        </select>
      )}
      {capitalOn && (
        <details className="w-full pt-1">
          <summary className="cursor-pointer text-xs font-medium uppercase tracking-wide text-muted">Capital details (for when you sell)</summary>
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <label className="flex items-center gap-1 text-xs text-muted">
              Bought
              <input className={input} type="date" value={acquiredDate} onChange={(e) => setAcquiredDate(e.target.value)} title="Contract date you acquired it — sets the 12-month CGT discount clock" />
            </label>
            <label className="flex items-center gap-1 text-xs text-muted">
              Cost base $
              <input className={`${input} w-36`} type="number" min="0" step="0.01" placeholder="incl. stamp duty, legals" value={costBase} onChange={(e) => setCostBase(e.target.value)} title="Purchase price plus incidental capital costs (stamp duty, legal fees) — not repairs or interest" />
            </label>
            <label className="flex items-center gap-1 text-xs text-muted">
              <input type="checkbox" checked={mainResidence} onChange={(e) => setMainResidence(e.target.checked)} />
              This is / was my main residence
            </label>
          </div>
          <p className="pt-2 text-xs text-muted">
            Only used when you sell. Quillo never applies the main-residence exemption for you — ticking this makes it
            <strong> set the disposal aside for your registered tax agent</strong> rather than putting a number on it. General information only.
          </p>
        </details>
      )}
      <button className={btn} disabled={!label || save.isPending} onClick={() => save.mutate()}>Save</button>
      <button className={del} onClick={() => setEditing(false)}>cancel</button>
      {DENY_USE_STATUSES.has(useStatus) && <span className="w-full pl-1 text-xs text-warn">No deductions while it earns no income — costs still add to its CGT cost base. General info only.</span>}
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
      <button className={btn} disabled={!!propertyError(value) || m.isPending} onClick={() => m.mutate()} title={propertyError(value) ?? undefined}>
        Add
      </button>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-1 text-xs text-muted">{children}</p>;
}

function EditableLoanProperty({
  link,
  accounts,
  properties,
  onDone,
}: {
  link: LoanProperty;
  accounts: Account[];
  properties: Property[];
  onDone: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [pct, setPct] = useState(String(link.deductible_interest_pct));
  const save = useMutation({
    mutationFn: () => api.updateLoanProperty(link.id, { deductible_interest_pct: Number(pct) }),
    onSuccess: () => {
      setEditing(false);
      onDone();
    },
  });
  const remove = useMutation({ mutationFn: () => api.deleteLoanProperty(link.id), onSuccess: onDone });
  const acc = accounts.find((a) => a.id === link.loan_account_id);
  const prop = properties.find((p) => p.id === link.property_id);
  const label = `${acc?.name ?? "loan"} → ${prop?.label ?? "property"}`;

  if (!editing) {
    return (
      <div className="flex items-center justify-between rounded-lg bg-surface px-3 py-2 text-sm">
        <span className="truncate">
          {label} · <span className="tabular-nums">{link.deductible_interest_pct}%</span> interest deductible
        </span>
        <div className="flex flex-none gap-3">
          <button onClick={() => { setPct(String(link.deductible_interest_pct)); setEditing(true); }} className={del}>
            edit
          </button>
          <button onClick={() => remove.mutate()} disabled={remove.isPending} className={del}>
            delete
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface px-3 py-2 text-sm">
      <span className="truncate">{label}</span>
      <input className={`${input} w-20`} type="number" min={0} max={100} value={pct} onChange={(e) => setPct(e.target.value)} aria-label="Deductible interest %" />
      <span>% deductible</span>
      <button className={btn} disabled={save.isPending || pct === ""} onClick={() => save.mutate()}>
        Save
      </button>
      <button className={del} onClick={() => setEditing(false)}>
        cancel
      </button>
    </div>
  );
}

function AddLoanProperty({ accounts, properties, onDone }: { accounts: Account[]; properties: Property[]; onDone: () => void }) {
  const loans = accounts.filter((a) => a.type === "loan");
  const [loanId, setLoanId] = useState("");
  const [propId, setPropId] = useState("");
  const [pct, setPct] = useState("");
  const add = useMutation({
    mutationFn: () => api.addLoanProperty({ loan_account_id: loanId, property_id: propId, deductible_interest_pct: pct === "" ? 0 : Number(pct) }),
    onSuccess: () => {
      setLoanId("");
      setPropId("");
      setPct("");
      onDone();
    },
  });
  if (loans.length === 0) return <Empty>No loan accounts yet. Add one on the Accounts page (type “loan”) to link it to a property.</Empty>;
  if (properties.length === 0) return <Empty>Add a property above first, then link your loan to it.</Empty>;
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <select className={input} value={loanId} onChange={(e) => setLoanId(e.target.value)} aria-label="Loan account">
        <option value="">Loan account…</option>
        {loans.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      <select className={input} value={propId} onChange={(e) => setPropId(e.target.value)} aria-label="Property">
        <option value="">Property…</option>
        {properties.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <input className={`${input} w-20`} type="number" min={0} max={100} placeholder="%" value={pct} onChange={(e) => setPct(e.target.value)} aria-label="Deductible interest %" />
      <button className={btn} disabled={!loanId || !propId || add.isPending} onClick={() => add.mutate()}>
        Add link
      </button>
      {add.isError && <span className="text-xs text-danger">{(add.error as Error).message}</span>}
    </div>
  );
}


function EditableEntity({ entity, onDone, kinds }: { entity: { id: string; kind: string; name: string | null; detail_json?: string | null }; onDone: () => void; kinds?: readonly string[] }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<EntityValue>(() => entityToValue(entity));
  const save = useMutation({ mutationFn: () => api.updateEntity(entity.id, entityToBody(value)), onSuccess: () => { setEditing(false); onDone(); } });
  if (!editing) {
    return (
      <div className="flex items-center justify-between rounded-lg bg-surface px-3 py-2 text-sm">
        <span className="truncate">{entityLabel(entity)}</span>
        <div className="flex flex-none gap-3">
          <button onClick={() => { setValue(entityToValue(entity)); setEditing(true); }} className={del}>edit</button>
          <button onClick={() => runDelete(() => api.deleteEntity(entity.id), { onDone, label: "entity", archive: () => api.archiveEntity(entity.id) })} className={del}>delete</button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-start gap-2 rounded-lg bg-surface px-3 py-2">
      <div className="flex-1"><EntityFields value={value} onChange={setValue} kinds={kinds} /></div>
      <button className={btn} disabled={!value.name || save.isPending} onClick={() => save.mutate()}>Save</button>
      <button className={del} onClick={() => setEditing(false)}>cancel</button>
    </div>
  );
}

function EditableRule({ rule, properties, onDone }: { rule: { id: string; pattern: string; bucket: string; ato_label: string; property_id?: string | null }; properties: Property[]; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [pattern, setPattern] = useState(rule.pattern);
  const [bucket, setBucket] = useState(rule.bucket);
  const [label, setLabel] = useState(rule.ato_label);
  const [propertyId, setPropertyId] = useState(rule.property_id ?? "");
  // A property only belongs on a property bucket — clear it (→ NULL) when the rule isn't one, so a
  // learned rule can't route, e.g., a payg expense to a property.
  const effPropId = isPropertyBucket(bucket) ? propertyId : "";
  const save = useMutation({ mutationFn: () => api.updateRule(rule.id, { pattern, bucket, ato_label: label, property_id: effPropId || null }), onSuccess: () => { setEditing(false); onDone(); } });
  if (!editing) {
    const propLabel = rule.property_id ? properties.find((p) => p.id === rule.property_id)?.label : null;
    return (
      <div className="flex items-center justify-between rounded-lg bg-surface px-3 py-2 text-sm">
        <span className="truncate">"{rule.pattern}" → {BUCKET_LABEL[rule.bucket] ?? rule.bucket} · {rule.ato_label}{propLabel ? ` · ${propLabel}` : ""}</span>
        <div className="flex flex-none gap-3">
          <button onClick={() => { setPattern(rule.pattern); setBucket(rule.bucket); setLabel(rule.ato_label); setPropertyId(rule.property_id ?? ""); setEditing(true); }} className={del}>edit</button>
          <button onClick={() => api.deleteRule(rule.id).then(onDone)} className={del}>delete</button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-2 rounded-lg bg-surface px-3 py-2">
      <input className={`${input} flex-1`} value={pattern} onChange={(e) => setPattern(e.target.value)} />
      <select className={input} value={bucket} onChange={(e) => setBucket(e.target.value)}>
        {BUCKETS.map((b) => (
          <option key={b} value={b}>{BUCKET_LABEL[b]}</option>
        ))}
      </select>
      <input className={`${input} flex-1`} value={label} onChange={(e) => setLabel(e.target.value)} />
      {isPropertyBucket(bucket) && (
        <select className={input} value={propertyId} onChange={(e) => setPropertyId(e.target.value)} aria-label="Property">
          <option value="">— property (optional) —</option>
          {properties.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      )}
      <button className={btn} disabled={!pattern || !label || save.isPending} onClick={() => save.mutate()}>Save</button>
      <button className={del} onClick={() => setEditing(false)}>cancel</button>
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

function AddEntity({ onDone, kinds }: { onDone: () => void; kinds?: readonly string[] }) {
  const [value, setValue] = useState<EntityValue>(() => emptyEntity(kinds?.[0]));
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
        <EntityFields value={value} onChange={setValue} kinds={kinds} />
      </div>
      <button className={btn} disabled={!value.name || m.isPending} onClick={() => m.mutate()}>
        Add
      </button>
    </div>
  );
}

function AddRule({ properties, onDone }: { properties: Property[]; onDone: () => void }) {
  const [pattern, setPattern] = useState("");
  const [bucket, setBucket] = useState("company");
  const [label, setLabel] = useState("");
  const [propertyId, setPropertyId] = useState("");
  const effPropId = isPropertyBucket(bucket) ? propertyId : "";
  const m = useMutation({
    mutationFn: () => api.addRule({ pattern, bucket, ato_label: label, property_id: effPropId || undefined }),
    onSuccess: () => { setPattern(""); setLabel(""); setPropertyId(""); onDone(); },
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
      {isPropertyBucket(bucket) && (
        <select className={input} value={propertyId} onChange={(e) => setPropertyId(e.target.value)} aria-label="Property">
          <option value="">— property (optional) —</option>
          {properties.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      )}
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

// Trust distributions (#139): record what a trust distributed to a beneficiary, character retained.
const TRUST_CHARACTERS = ["ordinary", "franked_dividend", "discount_capital_gain", "foreign_income"] as const;
const CHAR_LABEL: Record<string, string> = { ordinary: "Ordinary income", franked_dividend: "Franked dividend", discount_capital_gain: "Discount capital gain", foreign_income: "Foreign income" };

function TrustDistributions({ trusts }: { trusts: { id: string; name: string | null }[] }) {
  const qc = useQueryClient();
  const dists = useQuery({ queryKey: ["trust-distributions"], queryFn: () => api.trustDistributions() });
  const [adding, setAdding] = useState(false);
  const invalidate = () => { qc.invalidateQueries({ queryKey: ["trust-distributions"] }); qc.invalidateQueries({ queryKey: ["report"] }); };
  if (!trusts.length) return <Empty>Add a trust entity above first, then record what it distributed to you.</Empty>;
  return (
    <div className="space-y-2">
      {(dists.data ?? []).map((d) => (
        <Row key={d.id} label={`${CHAR_LABEL[d.character] ?? d.character} · ${money(d.amount_cents)}${d.franking_credit_cents ? ` (franking ${money(d.franking_credit_cents)})` : ""} · ${d.fy}`} onDelete={() => api.deleteTrustDistribution(d.id).then(invalidate)} />
      ))}
      {adding ? (
        <AddTrustDistribution trusts={trusts} onDone={() => { setAdding(false); invalidate(); }} />
      ) : (
        <button className={btn} onClick={() => setAdding(true)}>+ Add distribution</button>
      )}
    </div>
  );
}

function AddTrustDistribution({ trusts, onDone }: { trusts: { id: string; name: string | null }[]; onDone: () => void }) {
  const [trustId, setTrustId] = useState(trusts[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [character, setCharacter] = useState("ordinary");
  const [franking, setFranking] = useState("");
  const add = useMutation({
    mutationFn: () => api.addTrustDistribution({ trust_entity_id: trustId, amount_cents: parseMoneyToCents(amount) ?? 0, character, franking_credit_cents: parseMoneyToCents(franking) ?? 0 }),
    onSuccess: onDone,
  });
  return (
    <div className="space-y-2 rounded-lg border border-line p-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <select className={input} value={trustId} onChange={(e) => setTrustId(e.target.value)}>{trusts.map((t) => <option key={t.id} value={t.id}>{t.name ?? "Trust"}</option>)}</select>
        <select className={input} value={character} onChange={(e) => setCharacter(e.target.value)}>{TRUST_CHARACTERS.map((c) => <option key={c} value={c}>{CHAR_LABEL[c]}</option>)}</select>
        <input className={input} inputMode="decimal" placeholder="Amount $" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <input className={input} inputMode="decimal" placeholder="Franking $ (optional)" value={franking} onChange={(e) => setFranking(e.target.value)} />
      </div>
      <button className={btn} onClick={() => add.mutate()} disabled={add.isPending || !amount || !trustId}>{add.isPending ? "Saving…" : "Save distribution"}</button>
      {add.error && <p className="text-sm text-danger">{(add.error as Error).message}</p>}
    </div>
  );
}

// Slice E: partnership distributions — your share of partnership net income, character retained.
function PartnershipDistributions({ partnerships }: { partnerships: { id: string; name: string | null }[] }) {
  const qc = useQueryClient();
  const dists = useQuery({ queryKey: ["partnership-distributions"], queryFn: () => api.partnershipDistributions() });
  const [adding, setAdding] = useState(false);
  const invalidate = () => { qc.invalidateQueries({ queryKey: ["partnership-distributions"] }); qc.invalidateQueries({ queryKey: ["report"] }); };
  if (!partnerships.length) return <Empty>Add a partnership entity above first, then record your share of its net income.</Empty>;
  return (
    <div className="space-y-2">
      {(dists.data ?? []).map((d) => (
        <Row key={d.id} label={`${CHAR_LABEL[d.character] ?? d.character} · ${money(d.amount_cents)}${d.franking_credit_cents ? ` (franking ${money(d.franking_credit_cents)})` : ""} · ${d.fy}`} onDelete={() => api.deletePartnershipDistribution(d.id).then(invalidate)} />
      ))}
      {adding ? (
        <AddPartnershipDistribution partnerships={partnerships} onDone={() => { setAdding(false); invalidate(); }} />
      ) : (
        <button className={btn} onClick={() => setAdding(true)}>+ Add distribution</button>
      )}
    </div>
  );
}

function AddPartnershipDistribution({ partnerships, onDone }: { partnerships: { id: string; name: string | null }[]; onDone: () => void }) {
  const [partnershipId, setPartnershipId] = useState(partnerships[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [character, setCharacter] = useState("ordinary");
  const [franking, setFranking] = useState("");
  const add = useMutation({
    mutationFn: () => api.addPartnershipDistribution({ partnership_entity_id: partnershipId, amount_cents: parseMoneyToCents(amount) ?? 0, character, franking_credit_cents: parseMoneyToCents(franking) ?? 0 }),
    onSuccess: onDone,
  });
  return (
    <div className="space-y-2 rounded-lg border border-line p-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <select className={input} value={partnershipId} onChange={(e) => setPartnershipId(e.target.value)}>{partnerships.map((t) => <option key={t.id} value={t.id}>{t.name ?? "Partnership"}</option>)}</select>
        <select className={input} value={character} onChange={(e) => setCharacter(e.target.value)}>{TRUST_CHARACTERS.map((c) => <option key={c} value={c}>{CHAR_LABEL[c]}</option>)}</select>
        <input className={input} inputMode="decimal" placeholder="Your share $" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <input className={input} inputMode="decimal" placeholder="Franking $ (optional)" value={franking} onChange={(e) => setFranking(e.target.value)} />
      </div>
      <button className={btn} onClick={() => add.mutate()} disabled={add.isPending || !amount || !partnershipId}>{add.isPending ? "Saving…" : "Save distribution"}</button>
      {add.error && <p className="text-sm text-danger">{(add.error as Error).message}</p>}
    </div>
  );
}

const SMSF_PHASES = ["accumulation", "pension", "transition"] as const;

function SmsfMembers({ funds }: { funds: { id: string; name: string | null }[] }) {
  const qc = useQueryClient();
  const members = useQuery({ queryKey: ["smsf-members"], queryFn: () => api.smsfMembers() });
  const [adding, setAdding] = useState(false);
  const invalidate = () => { qc.invalidateQueries({ queryKey: ["smsf-members"] }); qc.invalidateQueries({ queryKey: ["report"] }); };
  if (!funds.length) return <Empty>Add an SMSF entity above first (Entities → kind "smsf"), then record each member's balances.</Empty>;
  const fundName = (id: string) => funds.find((f) => f.id === id)?.name ?? "SMSF";
  return (
    <div className="space-y-2">
      {(members.data ?? []).map((mb) => (
        <Row
          key={mb.id}
          label={`${fundName(mb.smsf_entity_id)} · ${mb.phase} · pension ${money(mb.pension_balance_cents)} / accum ${money(mb.accumulation_balance_cents)}`}
          onDelete={() => api.deleteSmsfMember(mb.id).then(invalidate)}
        />
      ))}
      {adding ? (
        <AddSmsfMember funds={funds} onDone={() => { setAdding(false); invalidate(); }} />
      ) : (
        <button className={btn} onClick={() => setAdding(true)}>+ Add member</button>
      )}
    </div>
  );
}

function AddSmsfMember({ funds, onDone }: { funds: { id: string; name: string | null }[]; onDone: () => void }) {
  const [fundId, setFundId] = useState(funds[0]?.id ?? "");
  const [phase, setPhase] = useState<string>("accumulation");
  const [pension, setPension] = useState("");
  const [accum, setAccum] = useState("");
  const add = useMutation({
    mutationFn: () => api.addSmsfMember({
      smsf_entity_id: fundId,
      phase,
      pension_balance_cents: parseMoneyToCents(pension) ?? 0,
      accumulation_balance_cents: parseMoneyToCents(accum) ?? 0,
    }),
    onSuccess: onDone,
  });
  return (
    <div className="space-y-2 rounded-lg border border-line p-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <select className={input} value={fundId} onChange={(e) => setFundId(e.target.value)}>{funds.map((f) => <option key={f.id} value={f.id}>{f.name ?? "SMSF"}</option>)}</select>
        <select className={input} value={phase} onChange={(e) => setPhase(e.target.value)}>{SMSF_PHASES.map((p) => <option key={p} value={p}>{p}</option>)}</select>
        <input className={input} inputMode="decimal" placeholder="Pension balance $" value={pension} onChange={(e) => setPension(e.target.value)} />
        <input className={input} inputMode="decimal" placeholder="Accumulation balance $" value={accum} onChange={(e) => setAccum(e.target.value)} />
      </div>
      <button className={btn} onClick={() => add.mutate()} disabled={add.isPending || !fundId}>{add.isPending ? "Saving…" : "Save member"}</button>
      {add.error && <p className="text-sm text-danger">{(add.error as Error).message}</p>}
    </div>
  );
}

function BasPeriods() {
  const qc = useQueryClient();
  const periods = useQuery({ queryKey: ["bas-periods"], queryFn: () => api.basPeriods() });
  const instals = useQuery({ queryKey: ["payg-instalments"], queryFn: () => api.paygInstalments() });
  const [addingBas, setAddingBas] = useState(false);
  const [addingPayg, setAddingPayg] = useState(false);
  const invalidate = () => { for (const k of ["bas-periods", "payg-instalments", "report", "dashboard"]) qc.invalidateQueries({ queryKey: [k] }); };
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <div className="text-xs font-medium uppercase tracking-wide text-muted">BAS periods</div>
        {(periods.data ?? []).map((p) => (
          <Row key={p.id} label={`${p.period_start} → ${p.period_end} · GST out ${money(p.output_gst_cents)} / in ${money(p.input_gst_cents)} · ${p.status}`} onDelete={() => api.deleteBasPeriod(p.id).then(invalidate)} />
        ))}
        {addingBas ? <AddBasPeriod onDone={() => { setAddingBas(false); invalidate(); }} /> : <button className={btn} onClick={() => setAddingBas(true)}>+ Add BAS period</button>}
      </div>
      <div className="space-y-2">
        <div className="text-xs font-medium uppercase tracking-wide text-muted">PAYG instalments</div>
        {(instals.data ?? []).map((p) => (
          <Row key={p.id} label={`FY ${p.fy}${p.quarter ? ` · Q${p.quarter}` : ""} · ${money(p.instalment_cents)}`} onDelete={() => api.deletePaygInstalment(p.id).then(invalidate)} />
        ))}
        {addingPayg ? <AddPaygInstalment onDone={() => { setAddingPayg(false); invalidate(); }} /> : <button className={btn} onClick={() => setAddingPayg(true)}>+ Add PAYG instalment</button>}
      </div>
    </div>
  );
}

function AddBasPeriod({ onDone }: { onDone: () => void }) {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [out, setOut] = useState("");
  const [inp, setInp] = useState("");
  const add = useMutation({
    mutationFn: () => api.addBasPeriod({ period_start: start, period_end: end, output_gst_cents: parseMoneyToCents(out) ?? 0, input_gst_cents: parseMoneyToCents(inp) ?? 0, status: "finalised" }),
    onSuccess: onDone,
  });
  return (
    <div className="space-y-2 rounded-lg border border-line p-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <input className={input} type="date" aria-label="Period start" value={start} onChange={(e) => setStart(e.target.value)} />
        <input className={input} type="date" aria-label="Period end" value={end} onChange={(e) => setEnd(e.target.value)} />
        <input className={input} inputMode="decimal" placeholder="GST collected $" value={out} onChange={(e) => setOut(e.target.value)} />
        <input className={input} inputMode="decimal" placeholder="GST credits $" value={inp} onChange={(e) => setInp(e.target.value)} />
      </div>
      <button className={btn} onClick={() => add.mutate()} disabled={add.isPending || !start || !end}>{add.isPending ? "Saving…" : "Save BAS period"}</button>
      {add.error && <p className="text-sm text-danger">{(add.error as Error).message}</p>}
    </div>
  );
}

const PAYG_QUARTERS = [1, 2, 3, 4] as const;

function AddPaygInstalment({ onDone }: { onDone: () => void }) {
  const [fy, setFy] = useState("");
  const [quarter, setQuarter] = useState("");
  const [amount, setAmount] = useState("");
  const add = useMutation({
    mutationFn: () => api.addPaygInstalment({ fy: fy.trim() || undefined, quarter: quarter ? Number(quarter) : null, instalment_cents: parseMoneyToCents(amount) ?? 0 }),
    onSuccess: onDone,
  });
  return (
    <div className="space-y-2 rounded-lg border border-line p-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <input className={input} placeholder="FY e.g. 2024-25" value={fy} onChange={(e) => setFy(e.target.value)} />
        <select className={input} value={quarter} onChange={(e) => setQuarter(e.target.value)}><option value="">Quarter…</option>{PAYG_QUARTERS.map((q) => <option key={q} value={q}>Q{q}</option>)}</select>
        <input className={input} inputMode="decimal" placeholder="Amount $" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </div>
      <button className={btn} onClick={() => add.mutate()} disabled={add.isPending || !amount}>{add.isPending ? "Saving…" : "Save instalment"}</button>
      {add.error && <p className="text-sm text-danger">{(add.error as Error).message}</p>}
    </div>
  );
}

const ACTIVITY_TYPES = ["business", "investment", "private"] as const;
const ACTIVITY_TYPE_LABEL: Record<string, string> = { business: "Business / sole trader", investment: "Investment", private: "Private", salary_wages: "Salary", rental_property: "Rental property" };

function BusinessActivities({ entities }: { entities: { id: string; kind: string; name: string | null }[] }) {
  const qc = useQueryClient();
  const acts = useQuery({ queryKey: ["income-activities"], queryFn: () => api.incomeActivities() });
  const [adding, setAdding] = useState(false);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["income-activities"] });
  const entName = (id: string | null) => entities.find((e) => e.id === id)?.name ?? "—";
  // Auto-seeded salary/rental activities are managed elsewhere; show the user-relevant ones.
  const rows = (acts.data ?? []).filter((a) => a.activity_type === "business" || a.activity_type === "investment" || a.activity_type === "private");
  return (
    <div className="space-y-2">
      {rows.map((a) => (
        <div key={a.id} className="space-y-1">
          <Row label={`${a.label || ACTIVITY_TYPE_LABEL[a.activity_type] || a.activity_type}${a.entity_id ? ` · ${entName(a.entity_id)}` : ""}${a.occupation_scope ? ` · ${a.occupation_scope}` : ""}`} onDelete={() => api.deleteIncomeActivity(a.id).then(invalidate)} />
          {a.activity_type === "business" && <PsiStatusSelect a={a} onSaved={invalidate} />}
        </div>
      ))}
      {!rows.length && <Empty>No business activities yet. Add one to name your sole-trader work (rideshare, freelance, consulting) so spend attributes to it.</Empty>}
      {adding ? (
        <AddIncomeActivity entities={entities} onDone={() => { setAdding(false); invalidate(); }} />
      ) : (
        <button className={btn} onClick={() => setAdding(true)}>+ Add activity</button>
      )}
    </div>
  );
}

// S2: self-declared PSI/Div 86 status on a business activity. Capture-only — it sharpens the PSI guidance
// on the File page and never changes the position. Saves on change (null clears = not assessed).
const PSI_OPTIONS = [["", "Not assessed"], ["not_psi", "PSI doesn't apply"], ["psi_applies", "PSI applies"]] as const;

function PsiStatusSelect({ a, onSaved }: { a: IncomeActivity; onSaved: () => void }) {
  const save = useMutation({
    mutationFn: (v: string) => api.setIncomeActivityPsiStatus(a.id, v || null),
    onSuccess: onSaved,
  });
  // The server is the source of truth (no stale local copy); show the in-flight value optimistically.
  const value = save.isPending && typeof save.variables === "string" ? save.variables : (a.psi_status ?? "");
  return (
    <div className="flex items-center gap-2 pl-3 text-xs">
      <span className="inline-flex items-center gap-1 text-muted">PSI status <InfoTip k="psi_status" /></span>
      <select className={input} value={value} disabled={save.isPending} onChange={(e) => save.mutate(e.target.value)}>
        {PSI_OPTIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
      </select>
      {save.isError && <span className="text-danger">Couldn't save</span>}
    </div>
  );
}

function AddIncomeActivity({ entities, onDone }: { entities: { id: string; kind: string; name: string | null }[]; onDone: () => void }) {
  const [entityId, setEntityId] = useState("");
  const [activityType, setActivityType] = useState<string>("business");
  const [label, setLabel] = useState("");
  const [scope, setScope] = useState("");
  const [psiStatus, setPsiStatus] = useState("");
  // Sole traders attribute to their individual entity; companies to the company. Offer both.
  const pickable = entities.filter((e) => e.kind === "individual" || e.kind === "company");
  const add = useMutation({
    mutationFn: () => api.addIncomeActivity({ entity_id: entityId || null, activity_type: activityType, label: label.trim() || null, occupation_scope: scope.trim() || null, psi_status: activityType === "business" ? (psiStatus || null) : null }),
    onSuccess: onDone,
  });
  return (
    <div className="space-y-2 rounded-lg border border-line p-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <select className={input} value={activityType} onChange={(e) => setActivityType(e.target.value)}>{ACTIVITY_TYPES.map((t) => <option key={t} value={t}>{ACTIVITY_TYPE_LABEL[t]}</option>)}</select>
        <input className={input} placeholder="Label e.g. Rideshare" value={label} onChange={(e) => setLabel(e.target.value)} />
        <select className={input} value={entityId} onChange={(e) => setEntityId(e.target.value)}>
          <option value="">Me (individual)</option>
          {pickable.map((e) => <option key={e.id} value={e.id}>{e.name ?? e.kind}</option>)}
        </select>
        <input className={input} placeholder="Occupation e.g. it_professional" value={scope} onChange={(e) => setScope(e.target.value)} />
      </div>
      {activityType === "business" && (
        <label className="flex items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1 text-muted">PSI status <InfoTip k="psi_status" /></span>
          <select className={input} value={psiStatus} onChange={(e) => setPsiStatus(e.target.value)}>
            {PSI_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      )}
      <button className={btn} onClick={() => add.mutate()} disabled={add.isPending}>{add.isPending ? "Saving…" : "Save activity"}</button>
      {add.error && <p className="text-sm text-danger">{(add.error as Error).message}</p>}
    </div>
  );
}

const SUPER_TYPES = ["concessional", "personal_deductible", "non_concessional"] as const;
const SUPER_TYPE_LABEL: Record<string, string> = {
  concessional: "Concessional — employer/salary-sacrifice (pre-tax)",
  // Only PERSONAL deductible contributions reduce assessable income (s290-150) — you lodge a notice of
  // intent and claim them. Employer SG / salary-sacrifice are already pre-tax and are NOT deductible again.
  personal_deductible: "Personal deductible (you'll claim a deduction)",
  non_concessional: "Non-concessional (after-tax)",
};

function SuperContributions({ persons }: { persons: { id: string; display_name: string }[] }) {
  const qc = useQueryClient();
  const rows = useQuery({ queryKey: ["super-contributions"], queryFn: () => api.superContributions() });
  const [adding, setAdding] = useState(false);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["super-contributions"] });
  const personName = (id: string | null) => persons.find((p) => p.id === id)?.display_name ?? "You";
  return (
    <div className="space-y-2">
      {(rows.data ?? []).map((c) => (
        <Row key={c.id} label={`${personName(c.person_id)} · ${SUPER_TYPE_LABEL[c.type] ?? c.type} · ${money(c.amount_cents)} · ${c.fy}`} onDelete={() => api.deleteSuperContribution(c.id).then(invalidate)} />
      ))}
      {adding ? (
        <AddSuperContribution persons={persons} onDone={() => { setAdding(false); invalidate(); }} />
      ) : (
        <button className={btn} onClick={() => setAdding(true)}>+ Add contribution</button>
      )}
    </div>
  );
}

function AddSuperContribution({ persons, onDone }: { persons: { id: string; display_name: string }[]; onDone: () => void }) {
  const [personId, setPersonId] = useState(persons[0]?.id ?? "");
  const [type, setType] = useState<string>("concessional");
  const [amount, setAmount] = useState("");
  const add = useMutation({
    mutationFn: () => api.addSuperContribution({ person_id: personId || null, type, amount_cents: parseMoneyToCents(amount) ?? 0 }),
    onSuccess: onDone,
  });
  return (
    <div className="space-y-2 rounded-lg border border-line p-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <select className={input} value={personId} onChange={(e) => setPersonId(e.target.value)}>{persons.map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}</select>
        <select className={input} value={type} onChange={(e) => setType(e.target.value)}>{SUPER_TYPES.map((t) => <option key={t} value={t}>{SUPER_TYPE_LABEL[t]}</option>)}</select>
        <input className={input} inputMode="decimal" placeholder="Amount $" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </div>
      <button className={btn} onClick={() => add.mutate()} disabled={add.isPending || !amount}>{add.isPending ? "Saving…" : "Save contribution"}</button>
      {add.error && <p className="text-sm text-danger">{(add.error as Error).message}</p>}
    </div>
  );
}
