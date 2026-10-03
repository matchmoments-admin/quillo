import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../api";
import { useActiveFy } from "./activeFy";
import type { GrowLayerKey } from "../types";

// The Grow layer in the SPA (spec A11 ticket b, #592; flag ft_journey). Visibility + suggestions come from
// the server (src/lib/grow.ts) inside the shared /api/journey read; this file only names and routes them.

export { GROW_LABEL, GROW_BLURB, GROW_ROUTE, GROW_LEGACY_ROUTE, GROW_KEYS, isGrowKey } from "./growRoutes";

/**
 * Write a Grow choice (the switcher, or Yes / No on a suggestion). The global mutation cache invalidates
 * ["journey"] after every write, so the rail, Home and the switcher refresh from the server.
 */
export function useSetGrowLayer() {
  const { fy } = useActiveFy();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { layer: GrowLayerKey; state: "on" | "off"; source: "switched" | "detected" }) =>
      api.setGrowLayer({ ...v, ...(v.source === "detected" && v.state === "off" ? { fy } : {}) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["journey"] }),
    onError: (e) => toast.error((e as Error).message),
  });
}
