import { useEffect, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useFeatures } from "./features";
import { parseAppearance, resolveTheme, type Appearance } from "./theme";

// Appearance (System / Light / Dark) and the `<html data-theme>` it drives (spec A12). The choice is
// persisted server-side in profiles.ui_state.theme (no localStorage, like active_fy / tour_seen). A
// choice made this session lives in a tiny module store so every subscriber — the switch and the
// root sync — updates in the same render (instant switch), while the PATCH persists in the background.

let chosen: Appearance | null = null;
const listeners = new Set<() => void>();
const subscribeChosen = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const getChosen = () => chosen;

const DARK_QUERY = "(prefers-color-scheme: dark)";
const subscribeScheme = (fn: () => void) => {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia(DARK_QUERY);
  mq.addEventListener("change", fn);
  return () => mq.removeEventListener("change", fn);
};
const getPrefersDark = () => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(DARK_QUERY).matches;

/** The current Appearance (session choice → stored ui_state.theme → "light") and a setter that persists it.
 *  Default is LIGHT, not System: Quiet ledger light is the brand look the owner approved; dark is an
 *  explicit opt-in (owner feedback 2026-10-04 — a dark-mode OS silently switched the whole app dark). */
export function useAppearance(): { appearance: Appearance; setAppearance: (next: Appearance) => void } {
  const session = useSyncExternalStore(subscribeChosen, getChosen);
  const sit = useQuery({ queryKey: ["situation"], queryFn: () => api.situation() });
  const appearance = session ?? parseAppearance(sit.data?.profile?.ui_state) ?? "light";
  const setAppearance = (next: Appearance) => {
    chosen = next;
    listeners.forEach((fn) => fn());
    api.setUiState({ theme: next }).catch(() => {}); // best-effort persist; the UI has already switched
  };
  return { appearance, setAppearance };
}

/**
 * Keep `<html data-theme>` in step with the flag, the Appearance choice and the OS scheme. Mounted
 * once in the persistent App layout. `ft_journey` OFF ⇒ `legacy`, which is the bare-:root default,
 * so the attribute changes nothing about how the app renders.
 */
export function useThemeSync(): void {
  const { has } = useFeatures();
  const ftJourney = has("ft_journey");
  const { appearance } = useAppearance();
  const prefersDark = useSyncExternalStore(subscribeScheme, getPrefersDark);
  const theme = resolveTheme(ftJourney, appearance, prefersDark);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
}
