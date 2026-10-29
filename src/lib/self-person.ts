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
