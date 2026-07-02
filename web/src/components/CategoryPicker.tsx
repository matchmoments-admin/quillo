import { BUCKET_LABEL } from "./ui";
import { PICKABLE, isPropertyBucket } from "../lib/buckets";

// Picker-only labels: the compact pill text ("PAYG") reads as jargon inside a <select>, and testing
// showed users don't know that picking a bucket is CONTEXT, not a claim. Pills stay compact via
// BUCKET_LABEL; the picker spells it out. Falls back to BUCKET_LABEL for buckets not overridden.
const PICKER_LABEL: Record<string, string> = {
  payg: "Personal / work (PAYG)",
  company: "Company (business books)",
  asset: "Asset · capital (depreciates)",
};

/**
 * Controlled, presentational bucket (+ property) picker shared by BulkBar and the ReviewView inline
 * editor (#275 / slice 4). It owns the ONE rule both sites repeat: offer only the PICKABLE buckets
 * (income/refund/unknown excluded — those route through an income answer, not a bulk re-bucket), reveal
 * a property sub-select only for a property bucket, and CLEAR the property when the bucket leaves the
 * property set. Theming/copy/aria stay byte-identical per call site via explicit class + label props, so
 * this is a no-flag refactor with no visual change. NOT used by TxnDetail — its picker carries the
 * record-income button + refund-netting selector + no-property-clear semantics and must stay separate.
 */
export function CategoryPicker({
  bucket,
  propertyId,
  onBucket,
  onProperty,
  properties,
  selectClassName,
  mutedClassName,
  bucketPlaceholder,
  bucketAriaLabel,
  disabled,
}: {
  bucket: string;
  propertyId: string;
  onBucket: (v: string) => void;
  onProperty: (v: string) => void;
  properties: { id: string; label: string | null }[];
  selectClassName: string;
  mutedClassName: string;
  bucketPlaceholder: string;
  bucketAriaLabel?: string;
  disabled?: boolean;
}) {
  const needsProperty = isPropertyBucket(bucket);
  return (
    <>
      <select
        value={bucket}
        onChange={(e) => {
          onBucket(e.target.value);
          if (!isPropertyBucket(e.target.value)) onProperty(""); // leaving a property bucket clears the pick
        }}
        disabled={disabled}
        aria-label={bucketAriaLabel}
        className={selectClassName}
      >
        <option value="">{bucketPlaceholder}</option>
        {PICKABLE.map((b) => (
          <option key={b} value={b}>
            {PICKER_LABEL[b] ?? BUCKET_LABEL[b] ?? b}
          </option>
        ))}
      </select>
      {/* Bucket = CONTEXT, not a claim (deny-by-default): saying so here answers the #1 testing
          question — "if I pick PAYG, how does it get claimed?" */}
      {bucket === "payg" && (
        <span className={mutedClassName}>
          Files it as your personal/work spending — nothing is claimed yet. If it's work-related (e.g. software, courses, coaching for your current job), you'll confirm the deduction at year-end Review, or open the Full editor to set the claim label and work-use % now.
        </span>
      )}
      {needsProperty &&
        (properties.length > 0 ? (
          <select value={propertyId} onChange={(e) => onProperty(e.target.value)} disabled={disabled} aria-label="Property" className={selectClassName}>
            <option value="">Which property?</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        ) : (
          <span className={mutedClassName}>Add a property first (Settings)</span>
        ))}
    </>
  );
}
