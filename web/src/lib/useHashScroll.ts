import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/**
 * Scroll to the URL's #section once the page has rendered it — client navigation doesn't scroll to an
 * anchor by itself, and the section's data may still be loading, so it retries briefly. Shared by the step
 * pages, Grow and Settings (#593). `enabled` false ⇒ a no-op (a flag-OFF page keeps today's behaviour).
 */
export function useHashScroll(enabled = true) {
  const { hash } = useLocation();
  useEffect(() => {
    if (!enabled || !hash) return;
    let id: string;
    try {
      id = decodeURIComponent(hash.slice(1));
    } catch {
      return;
    }
    let tries = 0;
    const t = window.setInterval(() => {
      const el = document.getElementById(id);
      if (el || ++tries > 20) {
        window.clearInterval(t);
        el?.scrollIntoView({ block: "start" });
      }
    }, 100);
    return () => window.clearInterval(t);
  }, [enabled, hash]);
}
