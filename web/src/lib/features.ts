import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

/**
 * Enabled feature flags, sourced from the dashboard payload. Reuses the ["dashboard"] query key
 * (App already loads it on mount), so this is a cache hit — no extra request. Gate nav/UI with
 * `has(key)`; while loading, `has` returns false so flagged UI stays hidden until confirmed on.
 */
export function useFeatures(): { has: (key: string) => boolean; loaded: boolean } {
  const q = useQuery({ queryKey: ["dashboard"], queryFn: () => api.dashboard(), staleTime: 60_000 });
  const features = q.data?.features ?? [];
  return { has: (key: string) => features.includes(key), loaded: !q.isLoading && !!q.data };
}
