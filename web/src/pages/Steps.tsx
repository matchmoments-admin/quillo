import { useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useFeatures } from "../lib/features";
import { JOURNEY_STEP_KEYS, STEP_LABEL, STEP_ROUTE } from "../lib/journey";
import { STEP_LEGACY_ROUTE, journeyRouteFor, oldStepRouteFor } from "../lib/legacyRoutes";
import { StepFooter, StepHeader, WhySheet } from "../components/ft";
import type { JourneyStepKey } from "../types";
import { Dashboard } from "./Dashboard";
import { Home } from "./Home";
import { Onboarding } from "./Onboarding";
import { AboutYou } from "./AboutYou";
import { Accounts } from "./Accounts";
import { Income } from "./Income";
import { Transactions } from "./Transactions";
import { Review } from "./Review";
import { Documents } from "./Documents";
import { Reconcile } from "./Reconcile";
import { Filing } from "./Filing";

// Flag-aware routing for the first-timer journey (spec A11 "Page-by-page migration", #582).
//
// • <FtRedirect> wraps a legacy route's element. OFF (or while the flag set is still loading) it
//   renders that element untouched — the same markup as today. ON, it redirects to the journey
//   route from the ONE table in lib/legacyRoutes.ts.
// • <StepRoute> is a journey step URL. ON it renders the step: StepHeader + the step body + Back /
//   Why? / Next. The bodies are PLACEHOLDERS that compose today's pages until the step tickets
//   (#586, #587, #590) replace them. OFF it redirects to the legacy page the step replaces, so a step
//   URL never 404s after a rollback.
// • FOUR steps since the design review (spec §0, #585): /setup, /connect, /review, /lodge. The six old
//   step URLs go through <OldStepRedirect> (lib/legacyRoutes.ts OLD_STEP_ROUTES). /review is special:
//   its path is also the legacy "By label" page, so OFF it renders that page in place (byte-identical).
// • <HomeIndex> is "/": Home when ON, Dashboard otherwise.
// Every hook sits above the first conditional return (hooks lint gate; React #310 history).

export function FtRedirect({ children }: { children: ReactNode }) {
  const { has, loaded } = useFeatures();
  const { pathname, search, hash } = useLocation();
  const to = loaded && has("ft_journey") ? journeyRouteFor(pathname, search) : null;
  if (!to) return <>{children}</>;
  return <Navigate to={carryOver(to, search, hash)} replace />;
}

/**
 * Keep what a legacy deep link pointed at: the legacy URL's query params ride along (the target's own
 * params win, and the `view` switch that chose the redirect is dropped), and its #hash unless the target
 * names its own section.
 */
function carryOver(to: string, search: string, hash: string, keepView = false): string {
  const m = /^([^?#]*)(?:\?([^#]*))?(#.*)?$/.exec(to);
  const path = m?.[1] ?? to;
  const params = new URLSearchParams(m?.[2] ?? "");
  const legacy = new URLSearchParams(search);
  if (!keepView) legacy.delete("view");
  legacy.forEach((v, k) => {
    if (!params.has(k)) params.set(k, v);
  });
  const qs = params.toString();
  return `${path}${qs ? `?${qs}` : ""}${m?.[3] ?? hash}`;
}

/** An old 6-step URL (#582) → its 4-step route, flag-independent; query (incl. ?view=labels) and #hash ride along. */
export function OldStepRedirect() {
  const { pathname, search, hash } = useLocation();
  return <Navigate to={carryOver(oldStepRouteFor(pathname) ?? "/", search, hash, true)} replace />;
}

export function HomeIndex() {
  const { has } = useFeatures();
  return has("ft_journey") ? <Home /> : <Dashboard />;
}

function StepPage({ step, children }: { step: JourneyStepKey; children: ReactNode }) {
  const navigate = useNavigate();
  const [why, setWhy] = useState(false);
  const i = JOURNEY_STEP_KEYS.indexOf(step);
  const prev = i > 0 ? JOURNEY_STEP_KEYS[i - 1] : undefined;
  const next = JOURNEY_STEP_KEYS[i + 1];
  // A #section deep link (/bring-in#income, /records#documents) scrolls once the composed page has
  // rendered — client navigation doesn't scroll to an anchor by itself. Retries briefly while the
  // section's page is still loading its data.
  const { hash } = useLocation();
  useEffect(() => {
    if (!hash) return;
    let tries = 0;
    const t = window.setInterval(() => {
      const el = document.getElementById(decodeURIComponent(hash.slice(1)));
      if (el || ++tries > 20) {
        window.clearInterval(t);
        el?.scrollIntoView({ block: "start" });
      }
    }, 100);
    return () => window.clearInterval(t);
  }, [hash]);
  return (
    <div className="space-y-6">
      <StepHeader step={step} />
      <div>{children}</div>
      <StepFooter
        onBack={() => navigate(prev ? STEP_ROUTE[prev] : "/")}
        onWhy={() => setWhy(true)}
        primary={next ? { label: `Next: ${STEP_LABEL[next]}`, onClick: () => navigate(STEP_ROUTE[next]) } : { label: "Back to Home", onClick: () => navigate("/") }}
      />
      <WhySheet open={why} onClose={() => setWhy(false)} step={step} />
    </div>
  );
}

export function StepRoute({ step, children }: { step: JourneyStepKey; children: ReactNode }) {
  const { has, loaded } = useFeatures();
  if (!loaded) return null;
  if (!has("ft_journey")) return <Navigate to={STEP_LEGACY_ROUTE[step]} replace />;
  return <StepPage step={step}>{children}</StepPage>;
}

// ── Step bodies ──────────────────────────────────────────────────────────────────────────────────

/**
 * Get set up (#585, spec §0 + A2): Before you start + the "Can you get into myTax?" check + About you's
 * questions. The real page when situation_profile is ON too (its answers write the situation profile);
 * with ft_journey ON and situation_profile OFF the legacy Onboarding wizard stays as the step body.
 * ft_journey OFF ⇒ /setup redirects to /onboarding.
 */
export function SetupStep() {
  const { has, loaded } = useFeatures();
  if (!loaded) return null;
  if (!has("ft_journey")) return <Navigate to={STEP_LEGACY_ROUTE.setup} replace />;
  if (has("situation_profile")) return <AboutYou />;
  return (
    <StepPage step="setup">
      <Onboarding />
    </StepPage>
  );
}

/** Connect (placeholder until #586): today's accounts page + income. */
export const ConnectStep = () => (
  <StepRoute step="connect">
    <Accounts />
    <section id="income" className="mt-10 scroll-mt-20">
      <Income />
    </section>
  </StepRoute>
);

/**
 * Review (placeholder until #587): the review queue (or the "By label" roll-up with ?view=labels), then
 * records (#documents) and the reconcile check (#check). OFF — and while the flag set loads — /review is the
 * legacy "By label" page exactly as today (it was <FtRedirect><Review /></FtRedirect>).
 */
export function ReviewStep() {
  const { has, loaded } = useFeatures();
  const [params] = useSearchParams();
  if (!loaded || !has("ft_journey")) return <Review />;
  return (
    <StepPage step="review">
      {params.get("view") === "labels" ? <Review /> : <Transactions />}
      <section id="documents" className="mt-10 scroll-mt-20">
        <Documents />
      </section>
      <section id="check" className="mt-10 scroll-mt-20">
        <Reconcile />
      </section>
    </StepPage>
  );
}

/** Lodge in myTax (placeholder until #590): today's filing page. */
export const LodgeStep = () => (
  <StepRoute step="lodge">
    <Filing />
  </StepRoute>
);
