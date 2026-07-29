import type { CostBaseElements } from "../types";

// capital_cost_base_detail (C2) — the read half of `src/lib/capital.ts`, mirrored for the SPA.
//
// The web bundle can't import from the Worker's `src/`, so the convention in this repo is a hand-mirrored
// copy (see `AmmaComponents` in web/src/types.ts). Only the READ side lives here: the canonical cost base is
// COMPUTED SERVER-SIDE from the elements, deliberately, so the figure every engine reads can never disagree
// with what the UI shows. This file must therefore never total anything for display that the server didn't
// already store in `cost_base_cents`.
//
// Keep in sync with `parseCostBaseElements` in src/lib/capital.ts.

/** Read the element breakdown out of a cgt_assets.detail_json blob. Absent/legacy/malformed ⇒ null. */
export function parseCostBaseElements(detailJson: string | null | undefined): CostBaseElements | null {
  if (!detailJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(detailJson);
  } catch {
    return null;
  }
  const blob = (parsed as { cost_base_elements?: unknown } | null)?.cost_base_elements;
  if (!blob || typeof blob !== "object") return null;
  const n = (k: string): number => {
    const v = (blob as Record<string, unknown>)[k];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };
  const note = (blob as Record<string, unknown>).note;
  return {
    purchase_cents: n("purchase_cents"),
    brokerage_cents: n("brokerage_cents"),
    incidental_cents: n("incidental_cents"),
    other_cents: n("other_cents"),
    note: typeof note === "string" && note.trim() ? note.trim() : null,
  };
}
