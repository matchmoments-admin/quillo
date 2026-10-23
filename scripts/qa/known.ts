// Known, ticketed defects (#699). A failing check that matches an entry here is reported as KNOWN with
// its issue and does not fail the run; a NEW failure still does. Delete an entry when its issue is fixed,
// so the check guards the fix from then on.
export interface Known {
  /** Matched against "suite|check" (suite may carry a ":label", e.g. "routes:empty"). */
  match: RegExp;
  issue: string;
  why: string;
}

export const KNOWN: Known[] = [
  { match: /^persona:james\|a duplicate entity role is refused/, issue: "PR #753", why: "a duplicate entity role is a UNIQUE-constraint 500" },
];

export function knownFor(suite: string, check: string): Known | undefined {
  return KNOWN.find((k) => k.match.test(`${suite}|${check}`));
}
