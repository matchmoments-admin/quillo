import { useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useFeatures } from "../lib/features";
import { JOURNEY_STEP_KEYS, STEP_LABEL, STEP_ROUTE } from "../lib/journey";
import { STEP_LEGACY_ROUTE, journeyRouteFor } from "../lib/legacyRoutes";
import { StepFooter, StepHeader, WhySheet } from "../components/ft";
import type { JourneyStepKey } from "../types";
import { Dashboard } from "./Dashboard";
import { Home } from "./Home";
import { Onboarding } from "./Onboarding";
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
//   (#585–#590) replace them. OFF it redirects to the legacy page the step replaces, so a step URL
//   never 404s after a rollback.
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
function carryOver(to: string, search: string, hash: string): string {
  const m = /^([^?#]*)(?:\?([^#]*))?(#.*)?$/.exec(to);
  const path = m?.[1] ?? to;
  const params = new URLSearchParams(m?.[2] ?? "");
  const legacy = new URLSearchParams(search);
  legacy.delete("view");
  legacy.forEach((v, k) => {
    if (!params.has(k)) params.set(k, v);
  });
  const qs = params.toString();
  return `${path}${qs ? `?${qs}` : ""}${m?.[3] ?? hash}`;
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

// ── Placeholder step bodies (replaced by #585–#590) ──────────────────────────────────────────────

export const AboutStep = () => (
  <StepRoute step="about">
    <Onboarding />
  </StepRoute>
);

export const BringInStep = () => (
  <StepRoute step="bring_in">
    <Accounts />
    <section id="income" className="mt-10 scroll-mt-20">
      <Income />
    </section>
  </StepRoute>
);

/** /claims is the review queue; /claims?view=labels is the "By label" tab (legacy /review). */
function ClaimsBody() {
  const [params] = useSearchParams();
  return params.get("view") === "labels" ? <Review /> : <Transactions />;
}
export const ClaimsStep = () => (
  <StepRoute step="claims">
    <ClaimsBody />
  </StepRoute>
);

export const RecordsStep = () => (
  <StepRoute step="records">
    <section id="documents" className="scroll-mt-20">
      <Documents />
    </section>
  </StepRoute>
);

/** /check and the fallback picker /check/match both show today's reconcile page until A8's UI lands. */
export const CheckStep = () => (
  <StepRoute step="check">
    <Reconcile />
  </StepRoute>
);

export const ShipStep = () => (
  <StepRoute step="ship">
    <Filing />
  </StepRoute>
);
