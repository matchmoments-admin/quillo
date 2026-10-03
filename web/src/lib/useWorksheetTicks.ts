import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../api";
import type { Situation } from "../types";
import { parseTicks, tickState, withTick, type TickState, type WorksheetTicks } from "./worksheetTicks";

/**
 * The Ship it worksheet's ticks (#590), persisted in profiles.ui_state.worksheet_ticks via PATCH /api/ui-state
 * (no localStorage). Seeded from the cached ["situation"] query; each toggle updates local state at once and
 * saves in the background. Saves run one at a time, in order, so a fast run of ticks can't land out of order
 * and leave an older set stored. Deliberately NOT a useMutation: the app-wide mutation cache would refetch the
 * journey + readiness after every tick, and a tick changes neither.
 */
export function useWorksheetTicks(fy: number): {
  ready: boolean;
  ticks: WorksheetTicks;
  stateOf: (id: string, amountCents: number | null) => TickState;
  toggle: (id: string, amountCents: number | null) => void;
} {
  const qc = useQueryClient();
  const sit = useQuery({ queryKey: ["situation"], queryFn: () => api.situation() });
  const [ticks, setTicks] = useState<WorksheetTicks | null>(null);
  const latest = useRef<WorksheetTicks>({});
  const saved = useRef<WorksheetTicks>({}); // the last set the server accepted — restored if a save fails
  const chain = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    if (ticks === null && sit.data) {
      const seeded = parseTicks(sit.data.profile?.ui_state);
      latest.current = seeded;
      saved.current = seeded;
      setTicks(seeded);
    }
  }, [sit.data, ticks]);

  const current = ticks ?? {};
  const stateOf = (id: string, amountCents: number | null) => tickState(current, fy, id, amountCents);
  const toggle = (id: string, amountCents: number | null) => {
    const on = tickState(latest.current, fy, id, amountCents) !== "ticked";
    const next = withTick(latest.current, fy, id, on ? { amountCents } : null);
    latest.current = next;
    setTicks(next);
    chain.current = chain.current
      .then(() => api.setUiState({ worksheet_ticks: latest.current }))
      .then((merged) => {
        saved.current = parseTicks(JSON.stringify(merged));
        // Keep the cached profile in step so leaving and coming back shows the saved ticks.
        qc.setQueryData<Situation>(["situation"], (old) => (old?.profile ? { ...old, profile: { ...old.profile, ui_state: JSON.stringify(merged) } } : old));
      })
      .catch((e: unknown) => {
        // Roll back to what's stored, so the screen never shows a tick that a reload would lose.
        latest.current = saved.current;
        setTicks(saved.current);
        toast.error("Couldn't save that tick", { description: e instanceof Error ? e.message : undefined });
      });
  };
  return { ready: ticks !== null, ticks: current, stateOf, toggle };
}
