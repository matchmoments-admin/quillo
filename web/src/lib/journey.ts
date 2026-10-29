import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useActiveFy } from "./activeFy";
import { useFeatures } from "./features";
import { STEP_GUIDES, type StepKey } from "../content/stepGuides";
import { JOURNEY_STEPS } from "../components/ft/model";
import type { Journey, JourneyStepKey, JourneyStepStatus } from "../types";
import { findingFixLinkForKind, type FixLink } from "./findingLinks";

// The first-timer journey (spec A11, #582; flag ft_journey): routes for the four steps (spec §0, #585) and the one shared
// /api/journey query the shell (status dots) and Home read. The key is ["journey", fy]; main.tsx's
// mutation cache invalidates it after every write, like ["progress"].

/** The four steps in order — the one list in content/stepGuides.ts (via components/ft/model.ts). */
export const JOURNEY_STEP_KEYS: readonly JourneyStepKey[] = JOURNEY_STEPS;

export const STEP_ROUTE: Record<JourneyStepKey, string> = {
  setup: "/setup",
  connect: "/connect",
  review: "/review",
  lodge: "/lodge",
};

/** Rail/sheet labels = the step guides' titles, so the rail, header and Why? sheet never disagree. */
export const STEP_LABEL = Object.fromEntries(JOURNEY_STEPS.map((k) => [k, STEP_GUIDES[k].title])) as Record<JourneyStepKey, string>;

export const STATUS_LABEL: Record<JourneyStepStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  needs_attention: "Needs attention",
  done: "Done",
};

/** Which step guide applies on a pathname (Home for "/" and every non-step page). */
export function stepForPath(pathname: string): StepKey {
  for (const k of JOURNEY_STEP_KEYS) {
    const r = STEP_ROUTE[k];
    if (pathname === r || pathname.startsWith(`${r}/`)) return k;
  }
  return "home";
}

/** The journey for the active FY. Disabled (no request) unless ft_journey is ON. */
export function useJourney() {
  const { fy } = useActiveFy();
  const { has } = useFeatures();
  return useQuery({ queryKey: ["journey", fy], queryFn: () => api.journey(fy), enabled: has("ft_journey"), staleTime: 30_000 });
}

/**
 * A What's-left item's fix link, the same on Home and on a step page (`here`, null on Home): its evidence kind's
 * page when that is specific, else the step it points into. With `cleanup` (review_cleanup), a finding about bank
 * lines goes to the transaction list, whichever step it counts against. A transaction finding that points into
 * the page you're on goes to the transaction list, never back to the same page.
 */
export function whatsLeftFixLink(w: Journey["whats_left"][number], here: JourneyStepKey | null, cleanup = false): FixLink {
  if (w.evidence_kind && w.evidence_kind !== "transaction") return findingFixLinkForKind(w.evidence_kind, { journey: true });
  // Income the bank shows but nothing records: its evidence is the deposits, but the fix is the income statement.
  if (cleanup && w.id === "income_not_recorded") return { to: "/connect#income", label: "Add your income" };
  if (cleanup && w.evidence_kind === "transaction") return { to: "/transactions?view=all", label: "Sort it out" };
  if (w.step !== here) return { to: STEP_ROUTE[w.step], label: `Go to ${STEP_LABEL[w.step]}` };
  return { to: "/transactions", label: "Sort it out" };
}
