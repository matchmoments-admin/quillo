/**
 * D1 caps bound parameters at 100 per statement. Any `IN (…)` built from a caller-sized id list must go
 * through chunkIds so a large import or bulk action can't trip the cap (the failure is a thrown query, not
 * a partial result). 90 leaves room for the statement's other binds.
 */
export const D1_MAX_BINDS = 100;
export const IN_CHUNK = 90;

export function chunkIds<T>(ids: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
