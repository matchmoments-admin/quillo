// First-run redirect (#765). A brand-new tenant is sent ONCE to set-up (/setup under ft_journey, else
// /onboarding). It used to read "has consented to US inference OR is on Bedrock" as "has done set-up".
// Since Bedrock became the default (#745) every tenant resolves to Bedrock, so nobody was redirected.
// The real signals are: the tenant has already started set-up, or was sent there before.

export interface FirstRunInputs {
  consentXborder: number | null | undefined; // legacy: consenting was an onboarding step
  entityCount: number;
  uiState: string | null | undefined; // profiles.ui_state JSON; `setup_started` marks the one redirect
  setupStatus?: string | null; // ft_journey: GET /api/journey's setup step status, when known
}

export function setupStartedMarker(uiState: string | null | undefined): boolean {
  if (!uiState) return false;
  try {
    return (JSON.parse(uiState) as { setup_started?: unknown }).setup_started === true;
  } catch {
    return false;
  }
}

/** True when the first-run redirect should fire: nothing says this tenant has begun set-up. */
export function needsFirstRun(i: FirstRunInputs): boolean {
  if ((i.consentXborder ?? 0) === 1) return false;
  if (i.entityCount > 0) return false;
  if (setupStartedMarker(i.uiState)) return false;
  if (i.setupStatus && i.setupStatus !== "not_started") return false;
  return true;
}

/** ui_state with the one-redirect marker set, keeping every other key (the cache mirror of PATCH /api/ui-state). */
export function withSetupStarted(uiState: string | null | undefined): string {
  let cur: Record<string, unknown> = {};
  try {
    const parsed = uiState ? (JSON.parse(uiState) as unknown) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) cur = parsed as Record<string, unknown>;
  } catch {
    /* garbage ⇒ start fresh */
  }
  return JSON.stringify({ ...cur, setup_started: true });
}
