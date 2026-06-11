import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useActiveFy } from "./activeFy";

/**
 * Enabled feature flags, sourced from the dashboard payload. Keyed on the active FY (["dashboard",
 * fy]) so it shares the one cache entry the page + nav badge use — a cache hit, no extra request.
 * `features`/`is_admin` are FY-independent (the server returns them in every response), so reading
 * them off whichever FY is active is always correct. Gate nav/UI with `has(key)`; while loading,
 * `has` returns false so flagged UI stays hidden until confirmed on.
 */
export function useFeatures(): { has: (key: string) => boolean; loaded: boolean } {
  const { fy } = useActiveFy();
  const q = useQuery({ queryKey: ["dashboard", fy], queryFn: () => api.dashboard(fy), staleTime: 60_000 });
  const features = q.data?.features ?? [];
  return { has: (key: string) => features.includes(key), loaded: !q.isLoading && !!q.data };
}

/** Whether the signed-in tenant holds the 'admin' role — gates the Admin page/nav. Same cached query. */
export function useAdminAccess(): { isAdmin: boolean; loaded: boolean } {
  const { fy } = useActiveFy();
  const q = useQuery({ queryKey: ["dashboard", fy], queryFn: () => api.dashboard(fy), staleTime: 60_000 });
  return { isAdmin: q.data?.is_admin ?? false, loaded: !q.isLoading && !!q.data };
}

/** Whether the signed-in tenant holds the 'partner' role — gates the Partner portal page/nav. */
export function usePartnerAccess(): { isPartner: boolean; loaded: boolean } {
  const { fy } = useActiveFy();
  const q = useQuery({ queryKey: ["dashboard", fy], queryFn: () => api.dashboard(fy), staleTime: 60_000 });
  return { isPartner: q.data?.is_partner ?? false, loaded: !q.isLoading && !!q.data };
}
