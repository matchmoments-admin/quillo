/**
 * The SituationModule registry (ADR-0004). A static array: adding a life situation is ONE module file
 * plus ONE line here (plus its essential, separate concerns — schema, capture UI, the persona golden).
 *
 * Order matters for byte-identity: it is the order the modules' fields are spread into the Report and
 * the order their sections appear in the accountant pack.
 */
import { featureOn } from "../features";
import type { Report } from "../report";
import type { ScheduleSection } from "../accountant-schedule";
import type { AnySituationModule, ReportContext } from "./types";
import { reportableAmountsModule } from "./reportable-amounts";

export type { SituationModule, ReportContext, ReportScope, AnySituationModule } from "./types";

export const SITUATIONS: readonly AnySituationModule[] = [reportableAmountsModule];

/** A module that is on and had something to show, with its reader's result. */
export interface LoadedSituation {
  module: AnySituationModule;
  result: unknown;
}

/** Load every ENABLED module over the context, concurrently. Flag OFF ⇒ not loaded (no query). */
export async function loadSituations(ctx: ReportContext, registry: readonly AnySituationModule[] = SITUATIONS): Promise<LoadedSituation[]> {
  const enabled = registry.filter((m) => featureOn(ctx.env, m.flag));
  const results = await Promise.all(enabled.map((m) => m.load(ctx)));
  const out: LoadedSituation[] = [];
  enabled.forEach((module, i) => {
    if (results[i] != null) out.push({ module, result: results[i] });
  });
  return out;
}

/** The Report fields the loaded modules own. A disabled or empty module contributes no key at all. */
export function situationFields(loaded: LoadedSituation[]): Partial<Report> {
  const fields: Record<string, unknown> = {};
  for (const { module, result } of loaded) fields[module.key] = module.field(result);
  return fields as Partial<Report>;
}

/** The accountant-pack sections of the loaded modules, in registry order (uncapped). */
export function situationSections(loaded: LoadedSituation[], ctx: ReportContext): ScheduleSection[] {
  return loaded.flatMap(({ module, result }) => (module.schedule ? module.schedule(result, ctx) : []));
}
