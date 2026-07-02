// inline_claim (owner testing feedback): a compact "Claim…" control shared by the inline row editor
// and the BulkBar, so common resolutions (donation · deductible in full · deductible N% · not
// deductible) don't need the full editor. Presentational + two pure mappers; the writes go through
// the callers' existing audited seams (correctBatch for the label, /api/deductibility for the state).
// GENERAL INFORMATION ONLY — choosing a claim is the USER asserting it; nothing is auto-claimed.

export type ClaimChoice = "" | "donation" | "full" | "pct" | "not";

/**
 * Extra correction edits a claim choice implies (they ride the audited/undoable batch). A donation is
 * a PERSONAL claim (D9) — it also forces bucket 'payg', so a donation can never sit in a property/
 * company bucket and inflate that schedule (review finding: label-vs-bucket coherence).
 */
export function claimEdits(claim: ClaimChoice): { field: string; value: string }[] {
  return claim === "donation"
    ? [{ field: "bucket", value: "payg" }, { field: "ato_label", value: "donation" }]
    : [];
}

/** True when the chosen claim is incomplete (pct selected but no valid %) — callers must block save. */
export function claimIncomplete(claim: ClaimChoice, pct: string): boolean {
  return claim === "pct" && claimResolve(claim, pct) === null;
}

/** The deductibility write a claim choice implies (null = leave the claim state untouched). */
export function claimResolve(claim: ClaimChoice, pct: string): { state: string; businessUsePct?: number } | null {
  switch (claim) {
    case "donation":
    case "full":
      return { state: "confirmed_deductible" }; // amount NULL ⇒ the report claims the full amount
    case "pct": {
      const n = Number(pct);
      if (!Number.isFinite(n) || n <= 0) return null; // no/invalid % ⇒ don't write a claim
      return { state: "confirmed_deductible", businessUsePct: Math.min(100, Math.round(n)) };
    }
    case "not":
      return { state: "confirmed_not" };
    default:
      return null;
  }
}

/** Human summary for the shared success note. */
export function claimSummary(claim: ClaimChoice, pct: string, n: number): string {
  switch (claim) {
    case "donation": return `${n} claimed as donation (D9)`;
    case "full": return `${n} claimed in full`;
    case "pct": return `${n} claimed at ${Math.min(100, Math.round(Number(pct) || 0))}% work use`;
    case "not": return `${n} marked not deductible`;
    default: return "";
  }
}

export function ClaimPicker({
  claim,
  pct,
  onClaim,
  onPct,
  selectClassName,
  mutedClassName,
  disabled,
}: {
  claim: ClaimChoice;
  pct: string;
  onClaim: (v: ClaimChoice) => void;
  onPct: (v: string) => void;
  selectClassName: string;
  mutedClassName: string;
  disabled?: boolean;
}) {
  return (
    <>
      <select value={claim} onChange={(e) => onClaim(e.target.value as ClaimChoice)} disabled={disabled} aria-label="Claim" className={selectClassName}>
        <option value="">Claim… (optional)</option>
        <option value="donation">Donation (D9 gift — no benefit received)</option>
        <option value="full">Deductible — full amount</option>
        <option value="pct">Deductible — work-use %</option>
        <option value="not">Not deductible (private)</option>
      </select>
      {claim === "pct" && (
        <input
          type="number"
          min={1}
          max={100}
          value={pct}
          onChange={(e) => onPct(e.target.value)}
          disabled={disabled}
          aria-label="Work-use percent"
          placeholder="%"
          className={`${selectClassName} w-20`}
        />
      )}
      {claim !== "" && (
        <span className={mutedClassName}>
          {claim === "donation"
            ? "Only gifts of $2+ to a DGR with nothing in return (raffle/art-union tickets aren't gifts). You're confirming the claim."
            : claim === "pct"
              ? "Claims that % of each line's amount as the work-use portion. You're confirming the claim."
              : claim === "full"
                ? "You're confirming the whole amount is a work cost you weren't reimbursed for."
                : "Keeps the spend visible but out of your deductions."}{" "}
          General information only.
        </span>
      )}
    </>
  );
}
