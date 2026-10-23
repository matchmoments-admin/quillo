/**
 * The life-situation seam (ADR-0004, docs/adr-0004-life-situation-modules.md).
 *
 * Every life situation (reportable amounts, CGT, ESS, trust, novated lease, Div 7A, …) is ONE
 * `SituationModule` in `src/lib/situations/<key>.ts`, registered once in `situations/index.ts`.
 * buildReport loads the enabled modules over a single `ReportContext` and spreads their fields; the
 * accountant pack iterates the registry for their sections; `composePosition` (position.ts) stays the
 * only place money is combined.
 *
 * Type-only imports here, so the registry never forms a runtime cycle with report.ts / accountant-schedule.ts.
 */
import type { Env } from "../../env";
import type { FeatureKey } from "../features";
import type { JurisdictionDescriptor } from "../jurisdiction";
import type { RulePackThresholds } from "../ledger-totals";
import type { PositionSummands } from "../position";
import type { ReadinessFinding } from "../readiness";
import type { Report } from "../report";
import type { ScheduleSection } from "../accountant-schedule";

/**
 * WHOSE figures a report is for. Today a report is the whole tenant (`personId` null); #722 threads a
 * person through here so a two-earner tenant can be reported per person. Context, not a module.
 */
export interface ReportScope {
  userId: string;
  /** null ⇒ the whole tenant (every caller today). */
  personId: string | null;
}

/** Everything a module may read. Built once per report; modules never resolve any of it themselves. */
export interface ReportContext {
  env: Env;
  scope: ReportScope;
  /** FY start year, e.g. 2025 for FY 2025-26. */
  startYear: number;
  /** The FY label, e.g. "2025-26" (the `fy` column on label-keyed tables). */
  fy: string;
  /** The FY's date bounds under the tenant's jurisdiction (inclusive ISO dates). */
  bounds: { start: string; end: string };
  jurisdiction: JurisdictionDescriptor;
  rulePack: RulePackThresholds;
  /**
   * Entity ids that are SEPARATE taxpayers (company / trust / SMSF / partnership). Their rows never
   * belong to the individual — every module reading a tenant table excludes them, exactly as the headline does.
   */
  separateIds: string[];
  /** The base currency for column headers ('AUD' for every AU tenant). */
  currency: string;
}

/**
 * One life situation. `R` is whatever the module's reader returns; `K` is the Report field it owns.
 *
 * Flag OFF ⇒ the module is not loaded ⇒ its field is absent ⇒ the payload is byte-identical.
 * `load` returning null means "nothing to show" ⇒ the field is absent too.
 */
export interface SituationModule<R, K extends keyof Report = keyof Report> {
  /** The Report field it owns. The registry is that field's ONLY source. */
  key: K;
  flag: FeatureKey;
  /** The reader. null ⇒ nothing to show (the field is omitted). */
  load(ctx: ReportContext): Promise<R | null>;
  /**
   * The Report field's value. A module's reader often loads MORE than the payload carries (e.g. a
   * per-employer breakdown the pack needs, with only the total on the payload), so the projection is
   * explicit. A small extension of the ADR-0004 sketch, which assumed field === R.
   */
  field(r: R): NonNullable<Report[K]>;
  /** Assessable / deductible contribution. Absent ⇒ information only (never in the position). */
  contributes?(r: R): Partial<PositionSummands>;
  /** Readiness findings (not yet consumed — assessReadiness still owns them; ADR-0004 step 2+). */
  findings?(r: R, report: Report): ReadinessFinding[];
  /** The module's accountant-pack sections, uncapped (the pack applies its row cap). */
  schedule?(r: R, ctx: ReportContext): ScheduleSection[];
}

/** The registry's element type: a module with its reader type erased. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySituationModule = SituationModule<any, keyof Report>;

/** Identity helper that keeps `R` and `K` checked at the definition site. */
export function defineSituation<R, K extends keyof Report>(m: SituationModule<R, K>): SituationModule<R, K> {
  return m;
}
