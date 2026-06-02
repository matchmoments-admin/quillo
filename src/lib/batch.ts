// Pure decision helpers for async (Message Batches) statement categorisation.
// Extracted from TaxAgent.pollBatchJobs so the failure transitions are unit-testable
// offline (no worker runtime / D1 needed) — see scripts/check-units.ts.

export const BATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000; // a submitted job older than this is a zombie

/**
 * The statement's terminal status once a batch job's results are applied. If every chunk
 * errored and nothing was categorised, the IMPORT still succeeded but categorisation failed —
 * so the statement is 'failed' (don't leave its lines stuck looking 'categorising'). Otherwise
 * 'imported'. A partial result (some applied, some errored) counts as imported.
 */
export function batchStatementStatus(applied: number, errored: number): "imported" | "failed" {
  return applied === 0 && errored > 0 ? "failed" : "imported";
}

/**
 * Whether a still-'submitted' batch job has been pending too long and should be force-failed.
 * `createdAtUtc` is the D1 timestamp WITHOUT a zone suffix (stored as UTC); we append 'Z'.
 * Returns false on an unparseable timestamp (don't fail a job we can't age).
 */
export function isStaleBatch(createdAtUtc: string, nowMs: number, maxAgeMs = BATCH_MAX_AGE_MS): boolean {
  const t = Date.parse(createdAtUtc + "Z");
  return Number.isFinite(t) && t > 0 && nowMs - t > maxAgeMs;
}
