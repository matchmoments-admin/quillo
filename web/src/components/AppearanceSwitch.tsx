import { useFeatures } from "../lib/features";
import { useAppearance } from "../lib/appearance";
import { APPEARANCES, type Appearance } from "../lib/theme";

const LABEL: Record<Appearance, string> = { system: "System", light: "Light", dark: "Dark" };

/**
 * Account-menu "Appearance: System / Light / Dark" (spec A12). Direction A only exists under
 * `ft_journey`, so the switch renders nothing when the flag is OFF. Sits in the sidebar footer beside
 * the Clerk account button (the sidebar is also the mobile "More" drawer, so one placement covers both).
 * Styled for the sidebar's forest fill with the same cream roles as its neighbours.
 */
export function AppearanceSwitch() {
  const { has } = useFeatures();
  const { appearance, setAppearance } = useAppearance();
  if (!has("ft_journey")) return null;
  return (
    <div role="radiogroup" aria-label="Appearance" className="mt-1 px-2 py-1">
      <div className="pb-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-cream/55">Appearance</div>
      <div className="grid grid-cols-3 gap-1 rounded-xl bg-cream/10 p-1">
        {APPEARANCES.map((a) => {
          const on = a === appearance;
          return (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setAppearance(a)}
              className={`min-h-[44px] rounded-lg text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cream/60 ${
                on ? "bg-cream text-forest" : "text-cream/70 hover:bg-cream/10 hover:text-cream"
              }`}
            >
              {LABEL[a]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
