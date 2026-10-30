import type { Env } from "../env";
import { featureOn } from "./features";

/**
 * The primary taxpayer ("self"). Every tenant has one persons row, `person_self_<userId>`, and a row whose
 * person_id is NULL also belongs to them (the convention before the persons model). This module is the one place
 * that knows both forms, so a reader can't match one and miss the other: the income-statement supersede matched
 * only NULL while every income row was being stamped with the self id, so re-uploads doubled salary.
 */

export function selfPersonId(userId: string): string {
  return `person_self_${userId}`;
}

/** The person a row belongs to, with NULL read as self. */
export function ownerPersonId(userId: string, personId: string | null | undefined): string {
  return personId ?? selfPersonId(userId);
}

/** True when two rows belong to the same taxpayer: the same person (NULL = self) and the same entity (or none). */
export function sameTaxpayer(
  userId: string,
  a: { person_id?: string | null; entity_id?: string | null },
  b: { person_id?: string | null; entity_id?: string | null },
): boolean {
  return (a.entity_id ?? null) === (b.entity_id ?? null) && ownerPersonId(userId, a.person_id) === ownerPersonId(userId, b.person_id);
}

/**
 * A `person_id` filter for a reader scoped to one person. Asking for the self person also matches a NULL person
 * (legacy rows, before migration 0094 set them); any other person matches exactly.
 */
export function personFilter(userId: string, personId: string): { sql: string; binds: string[] } {
  return personId === selfPersonId(userId) ? { sql: "(person_id = ? OR person_id IS NULL)", binds: [personId] } : { sql: "person_id = ?", binds: [personId] };
}

/**
 * #722: the person a report is scoped to. With `person_scoped_income` ON it is the self person, so another
 * person's income (a spouse's salary) never reaches the user's headline; OFF it is null, the whole tenant.
 */
export function reportPersonId(env: Env, userId: string): string | null {
  return featureOn(env, "person_scoped_income") ? selfPersonId(userId) : null;
}

/** An ` AND …` clause scoping a read to `personId` on `col`; empty (no bind) for null, the whole tenant. */
export function personClause(userId: string, personId: string | null, col = "person_id"): { sql: string; binds: string[] } {
  if (!personId) return { sql: "", binds: [] };
  const pf = personFilter(userId, personId);
  return { sql: ` AND ${pf.sql.replaceAll("person_id", col)}`, binds: pf.binds };
}

/**
 * #722: the person scope for INCOME rows. A property is tenant-level (its expenses and depreciation are not split
 * by person), so income attached to a property stays in whatever the property reports; only income with no
 * property is scoped to the person. Without this, a joint property's rent would follow the person while its
 * expenses did not, overstating the loss.
 */
export function incomePersonClause(userId: string, personId: string | null): { sql: string; binds: string[] } {
  if (!personId) return { sql: "", binds: [] };
  const pf = personFilter(userId, personId);
  return { sql: ` AND (property_id IS NOT NULL OR ${pf.sql})`, binds: pf.binds };
}

/** The same rule as incomePersonClause, for a row already in memory. */
export function incomeInPersonScope(userId: string, personId: string | null | undefined, row: { person_id: string | null; property_id: string | null }): boolean {
  return !personId || row.property_id != null || ownerPersonId(userId, row.person_id) === personId;
}
