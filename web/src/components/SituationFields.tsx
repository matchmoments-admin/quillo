import type { EntityDetail } from "../types";
import { isValidAbn, normaliseAbn } from "../lib/abn";
import { OCCUPATIONS, normaliseOccupation, occupationLabel } from "../content/occupations";
import { InfoTip } from "./ui";

// Shared input styling — kept here so the Settings forms and the onboarding wizard render
// identical controls (single source of truth for the situation fields the categoriser reads).
export const fieldInput = "rounded-lg border border-line bg-card px-3 py-2 text-sm";

export const ENTITY_KINDS = ["company", "employment", "novated_lease", "individual", "trust"] as const;

// Hand-mirror of PROPERTY_STATUSES in src/lib/taxonomy.ts — keep in sync. Two relationship groups:
// "own" (landlord/occupier) vs "rent" (tenant). Tenant statuses have no cost base / CGT / ownership %.
export const PROPERTY_STATUSES = ["rented", "vacant", "owner_occupied", "sold", "renting_residence", "renting_business"] as const;
export const OWNED_STATUSES = ["rented", "vacant", "owner_occupied", "sold"] as const;
export const TENANT_STATUSES = ["renting_residence", "renting_business"] as const;
export const isTenantStatus = (s: string): boolean => s.startsWith("renting_");
export function propertyStatusLabel(s: string): string {
  switch (s) {
    case "owner_occupied": return "owner-occupied";
    case "renting_residence": return "renting — home";
    case "renting_business": return "renting — business premises";
    default: return s;
  }
}

// 0031 use_status — how an OWNED property was used this year. This is what GATES deductibility:
// private-use / renovating-not-available / vacant land earn no income, so their costs aren't
// deductible (the CGT cost base still accrues). Distinct from `status` (the own-vs-rent relationship).
export const USE_STATUSES = ["rented", "genuinely_available_for_rent", "private_use_rent_free", "under_renovation_not_available", "vacant_land", "owner_occupied"] as const;
export const DENY_USE_STATUSES = new Set(["private_use_rent_free", "under_renovation_not_available", "vacant_land"]);
export function useStatusLabel(s: string): string {
  switch (s) {
    case "rented": return "Rented out";
    case "genuinely_available_for_rent": return "Genuinely available for rent";
    case "private_use_rent_free": return "Private use — a relative lives there rent-free";
    case "under_renovation_not_available": return "Renovating — not available to rent";
    case "vacant_land": return "Vacant land (no dwelling)";
    case "owner_occupied": return "I live there (owner-occupied)";
    default: return s;
  }
}

export interface EntityValue {
  kind: string;
  name: string;
  detail: EntityDetail;
}

export interface PropertyValue {
  label: string;
  address: string;
  status: string;
  use_status: string; // "" = not set (defaults from status server-side); else a USE_STATUSES value
  ownership_pct: string; // kept as string for a controlled number input; coerced on submit
}

export const emptyEntity = (kind = "company"): EntityValue => ({ kind, name: "", detail: { gst_registered: true } });
export const emptyProperty = (): PropertyValue => ({ label: "", address: "", status: "rented", use_status: "", ownership_pct: "100" });

function namePlaceholder(kind: string): string {
  if (kind === "company") return "Company name e.g. Acme Pty Ltd";
  if (kind === "employment") return "Employer name";
  if (kind === "novated_lease") return "Label e.g. Tesla lease";
  if (kind === "trust") return "Trust name";
  return "Name";
}

/**
 * Controlled editor for one tax entity (kind-aware). Renders only the fields; the caller
 * owns layout, the Add/Save button and submission. Used by Settings (add-new) and the
 * onboarding wizard (edit a draft row). Mirrors the detail{} shape renderSituation() reads.
 */
export function EntityFields({ value, onChange }: { value: EntityValue; onChange: (v: EntityValue) => void }) {
  const set = (patch: Partial<EntityValue>) => onChange({ ...value, ...patch });
  const setDetail = (patch: Partial<EntityDetail>) => onChange({ ...value, detail: { ...value.detail, ...patch } });
  const abn = value.detail.abn ?? "";
  const abnTouched = normaliseAbn(abn).length > 0;
  const abnBad = abnTouched && !isValidAbn(abn);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <select className={fieldInput} value={value.kind} onChange={(e) => set({ kind: e.target.value })}>
          {ENTITY_KINDS.map((k) => (
            <option key={k} value={k}>
              {k === "employment" ? "employment (PAYG)" : k}
            </option>
          ))}
        </select>
        <input
          className={`${fieldInput} flex-1`}
          placeholder={namePlaceholder(value.kind)}
          value={value.name}
          onChange={(e) => set({ name: e.target.value })}
        />
      </div>

      {value.kind === "company" && (
        <div className="flex flex-wrap items-center gap-3 pl-1 text-sm">
          <div className="flex flex-col">
            <input
              className={`${fieldInput} w-56 ${abnBad ? "border-danger" : ""}`}
              placeholder="ABN (11 digits)"
              value={abn}
              onChange={(e) => setDetail({ abn: e.target.value })}
            />
            {abnBad && <span className="mt-0.5 text-xs text-danger">Doesn't look like a valid ABN — double-check.</span>}
          </div>
          <label className="flex items-center gap-1.5 text-muted">
            <input
              type="checkbox"
              checked={value.detail.gst_registered ?? false}
              onChange={(e) => setDetail({ gst_registered: e.target.checked })}
            />
            GST registered (lets the agent claim GST credits) <InfoTip k="gst_registered" />
          </label>
        </div>
      )}

      {value.kind === "novated_lease" && (
        <div className="flex flex-wrap items-center gap-2 pl-1">
          <InfoTip k="novated_lease" />
          <input
            className={`${fieldInput} flex-1`}
            placeholder="Vehicle e.g. Tesla Model 3"
            value={value.detail.vehicle ?? ""}
            onChange={(e) => setDetail({ vehicle: e.target.value })}
          />
          <input
            className={`${fieldInput} flex-1`}
            placeholder="Lease provider"
            value={value.detail.provider ?? ""}
            onChange={(e) => setDetail({ provider: e.target.value })}
          />
        </div>
      )}
    </div>
  );
}

/** Seed an EntityValue for the edit form from a stored entity (parses detail_json). */
export function entityToValue(e: { kind: string; name: string | null; detail_json?: string | null }): EntityValue {
  let detail: EntityDetail = {};
  try {
    detail = e.detail_json ? (JSON.parse(e.detail_json) as EntityDetail) : {};
  } catch {
    /* malformed detail → start blank */
  }
  return { kind: e.kind, name: e.name ?? "", detail };
}

/** Build the addEntity request body from an EntityValue (employment stores employer in detail). */
export function entityToBody(v: EntityValue): { kind: string; name: string; detail: EntityDetail } {
  const detail: EntityDetail = {};
  if (v.kind === "company") {
    if (v.detail.abn) detail.abn = normaliseAbn(v.detail.abn);
    detail.gst_registered = v.detail.gst_registered ?? false;
  } else if (v.kind === "employment") {
    detail.employer = v.name || undefined;
  } else if (v.kind === "novated_lease") {
    if (v.detail.vehicle) detail.vehicle = v.detail.vehicle;
    if (v.detail.provider) detail.provider = v.detail.provider;
  }
  return { kind: v.kind, name: v.name, detail };
}

/** Controlled editor for one property. Caller owns layout + submission. */
export function PropertyFields({ value, onChange }: { value: PropertyValue; onChange: (v: PropertyValue) => void }) {
  const set = (patch: Partial<PropertyValue>) => onChange({ ...value, ...patch });
  const tenant = isTenantStatus(value.status);
  // Address matters for attributing expenses on a let property or rented business premises; a private
  // rented home needs nothing claimable yet, so we don't nag for its address.
  const addressMissing = (value.status === "rented" || value.status === "renting_business") && !value.address.trim();
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-2">
        <input className={`${fieldInput} flex-1`} placeholder="Label e.g. Rental 1" value={value.label} onChange={(e) => set({ label: e.target.value })} />
        <input
          className={`${fieldInput} flex-1`}
          placeholder="Address e.g. 14 Rental St, Sydney NSW"
          value={value.address}
          onChange={(e) => set({ address: e.target.value })}
        />
        <select className={fieldInput} value={value.status} onChange={(e) => set({ status: e.target.value })}>
          <optgroup label="You own this">
            {OWNED_STATUSES.map((s) => (
              <option key={s} value={s}>{propertyStatusLabel(s)}</option>
            ))}
          </optgroup>
          <optgroup label="You rent this (tenant)">
            {TENANT_STATUSES.map((s) => (
              <option key={s} value={s}>{propertyStatusLabel(s)}</option>
            ))}
          </optgroup>
        </select>
        {/* Ownership % is meaningless for a tenant — they don't own the premises. */}
        {!tenant && (
          <input
            className={`${fieldInput} w-24`}
            type="number"
            min="1"
            max="100"
            placeholder="Own %"
            value={value.ownership_pct}
            onChange={(e) => set({ ownership_pct: e.target.value })}
            title="Your ownership share %"
          />
        )}
      </div>
      {/* How was it USED this year — gates deductibility. Only relevant for an owned, not-sold property. */}
      {!tenant && value.status !== "sold" && (
        <label className="block pt-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">How was it used this year? <InfoTip tip="This decides whether its costs are deductible. A property earning no income — a relative living there rent-free, or renovating and off the rental market — generally has no deductions, though its CGT cost base still accrues. General info only." /></span>
          <select className={`${fieldInput} mt-1 w-full`} value={value.use_status} onChange={(e) => set({ use_status: e.target.value })}>
            <option value="">— same as above —</option>
            {USE_STATUSES.map((s) => <option key={s} value={s}>{useStatusLabel(s)}</option>)}
          </select>
        </label>
      )}
      {DENY_USE_STATUSES.has(value.use_status) && (
        <span className="pl-1 text-xs text-warn">No deductions while it earns no income (rent-free / off-market / vacant) — but keep the costs: they add to its CGT cost base and reduce a future capital gain. "Slowly renovating" doesn't make holding costs deductible. General info only.</span>
      )}
      {addressMissing && <span className="pl-1 text-xs text-warn">Add the address so rental expenses attribute to the right property.</span>}
      {value.status === "renting_residence" && (
        <span className="pl-1 text-xs text-muted">Rent on your home is generally not deductible — only a sole trader with a genuine place of business can claim a portion. General info only.</span>
      )}
      {value.status === "renting_business" && (
        <span className="pl-1 text-xs text-muted">Business/commercial premises rent is generally deductible, but only the business-use portion if it's partly private — confirm the amount with a registered tax agent. General info only.</span>
      )}
    </div>
  );
}

// ── Persons (taxpayers) ──────────────────────────────────────────────────────
// occupation drives the claimability hints the categoriser applies (e.g. nurse, IT professional),
// so surfacing it here improves accuracy. tfn_last4 is deliberately NOT editable in the UI.
export const PERSON_ROLES = ["self", "spouse", "dependent", "other"] as const;

export interface PersonValue {
  display_name: string;
  role: string;
  occupation: string;
  tax_residency: string;
}

export const emptyPerson = (): PersonValue => ({ display_name: "", role: "spouse", occupation: "", tax_residency: "AU" });

export function personToValue(p: { display_name: string; role: string; occupation: string | null; tax_residency: string }): PersonValue {
  // Show the human label for known occupation tokens (e.g. "it_professional" → "IT professional");
  // unknown free-text values are shown exactly as stored.
  return { display_name: p.display_name, role: p.role, occupation: occupationLabel(p.occupation ?? ""), tax_residency: p.tax_residency || "AU" };
}

/** Controlled editor for one taxpayer. Caller owns layout + submission. `lockRole` for the self person. */
export function PersonFields({ value, onChange, lockRole = false }: { value: PersonValue; onChange: (v: PersonValue) => void; lockRole?: boolean }) {
  const set = (patch: Partial<PersonValue>) => onChange({ ...value, ...patch });
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <input className={`${fieldInput} flex-1`} placeholder="Name" value={value.display_name} onChange={(e) => set({ display_name: e.target.value })} />
        <select className={fieldInput} value={value.role} disabled={lockRole} onChange={(e) => set({ role: e.target.value })}>
          {PERSON_ROLES.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <select className={fieldInput} value={value.tax_residency} onChange={(e) => set({ tax_residency: e.target.value })} title="Tax residency">
          <option value="AU">AU resident</option>
          <option value="foreign">Foreign resident</option>
        </select>
      </div>
      <input
        className={`${fieldInput} w-full`}
        list="occupation-options"
        placeholder="Occupation, e.g. Nurse, IT professional, Teacher — helps tailor deduction hints"
        value={value.occupation}
        onChange={(e) => set({ occupation: e.target.value })}
      />
      <datalist id="occupation-options">
        {OCCUPATIONS.map((o) => (
          <option key={o.token} value={o.label} />
        ))}
      </datalist>
    </div>
  );
}

export function personToBody(v: PersonValue): { display_name: string; role: string; occupation: string | null; tax_residency: string } {
  return {
    display_name: v.display_name.trim() || "Taxpayer",
    role: v.role,
    occupation: normaliseOccupation(v.occupation) || null,
    tax_residency: v.tax_residency || "AU",
  };
}

/** Build the addProperty request body from a PropertyValue. */
export function propertyToBody(v: PropertyValue): { label: string; address?: string; status: string; use_status?: string; ownership_pct: number } {
  return {
    label: v.label,
    address: v.address.trim() || undefined,
    status: v.status,
    use_status: v.use_status || undefined,
    ownership_pct: Number(v.ownership_pct) || 100,
  };
}
