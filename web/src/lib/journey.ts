import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useActiveFy } from "./activeFy";
import { useFeatures } from "./features";
import { STEP_GUIDES, type StepKey } from "../content/stepGuides";
import { JOURNEY_STEPS } from "../components/ft/model";
import type { JourneyStepKey, JourneyStepStatus } from "../types";

// The first-timer journey (spec A11, #582; flag ft_journey): routes for the six steps and the one shared
// /api/journey query the shell (status dots) and Home read. The key is ["journey", fy]; main.tsx's
// mutation cache invalidates it after every write, like ["progress"].

/** The six steps in order — the one list in content/stepGuides.ts (via components/ft/model.ts). */
export const JOURNEY_STEP_KEYS: readonly JourneyStepKey[] = JOURNEY_STEPS;

export const STEP_ROUTE: Record<JourneyStepKey, string> = {
  about: "/about",
  bring_in: "/bring-in",
  claims: "/claims",
  records: "/records",
  check: "/check",
  ship: "/ship",
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
