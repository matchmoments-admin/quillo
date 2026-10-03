import { useFeatures } from "../lib/features";
import { useAppearance } from "../lib/appearance";
import { APPEARANCES, type Appearance } from "../lib/theme";

const LABEL: Record<Appearance, string> = { system: "System", light: "Light", dark: "Dark" };

/**
 * Account-menu "Appearance: System / Light / Dark" (spec A12). Direction A only exists under
 * `ft_journey`, so the switch renders nothing when the flag is OFF. Sits in the legacy sidebar footer
 * beside the Clerk account button (styled for the forest fill, tone "sidebar") and in the first-timer
 * shell's account menu (#582, tone "plain" on the page roles).
 */
export function AppearanceSwitch({ tone = "sidebar" }: { tone?: "sidebar" | "plain" }) {
  const { has } = useFeatures();
  const { appearance, setAppearance } = useAppearance();
  if (!has("ft_journey")) return null;
  // "plain" = the first-timer shell's light rail / account sheet (#582): the same control on the
  // semantic page roles instead of the legacy sidebar's forest fill.
  const plain = tone === "plain";
  return (
    <div role="radiogroup" aria-label="Appearance" className="mt-1 px-2 py-1">
      <div className={`pb-1.5 text-[10px] font-bold uppercase tracking-[0.2em] ${plain ? "text-muted" : "text-cream/55"}`}>Appearance</div>
      <div className={`grid grid-cols-3 gap-1 rounded-xl p-1 ${plain ? "bg-surface" : "bg-cream/10"}`}>
        {APPEARANCES.map((a) => {
          const on = a === appearance;
          return (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setAppearance(a)}
              className={`min-h-[44px] rounded-lg text-xs font-semibold transition focus:outline-none focus-visible:ring-2 ${
                plain
                  ? `focus-visible:ring-focus ${on ? "bg-card text-ink" : "text-muted hover:text-ink"}`
                  : `focus-visible:ring-cream/60 ${on ? "bg-cream text-forest" : "text-cream/70 hover:bg-cream/10 hover:text-cream"}`
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
