import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useFeatures } from "./features";

/**
 * GET /api/education (#591): the ATO occupation-guide links for this tenant's people and the state
 * revenue office links. Only fetched when ft_journey is ON (the endpoint 404s otherwise), so flag OFF
 * issues no request. Static pack content per tenant ⇒ a long staleTime.
 */
export function useEducation() {
  const { has } = useFeatures();
  const enabled = has("ft_journey");
  return useQuery({ queryKey: ["education"], queryFn: api.education, enabled, staleTime: 10 * 60_000 });
}

/**
 * One occupation guide to link beside the golden rules, or null. Only when exactly one occupation is
 * on the return: with several, a single link could name the wrong job, so callers use useEducation()
 * and pick by the card's person instead.
 */
export function useOccupationGuide(): { label: string; ato_url: string | null } | null {
  const q = useEducation();
  const guides = q.data?.occupation_guides ?? [];
  return guides.length === 1 ? guides[0]! : null;
}
