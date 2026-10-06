import { useEffect, type ReactNode } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useFeatures } from "../lib/features";
import { JOURNEY_STEP_KEYS, STEP_LABEL, STEP_ROUTE } from "../lib/journey";
import { STEP_LEGACY_ROUTE, journeyRouteFor, oldStepRouteFor } from "../lib/legacyRoutes";
import { FtLink, StepFooter, StepHeader, useWhyDrawer } from "../components/ft";
import type { JourneyStepKey } from "../types";
import { Dashboard } from "./Dashboard";
import { Home } from "./Home";
import { Onboarding } from "./Onboarding";
import { AboutYou } from "./AboutYou";
import { ConnectPage } from "../components/connect/ConnectPage";
import { ReviewQueue, MATCH_PICKER_ROUTE } from "./ReviewQueue";
import { Review } from "./Review";
import { Reconcile } from "./Reconcile";
import { ShipIt } from "./ShipIt";
import { ShipItPrint } from "./ShipItPrint";

// Flag-aware routing for the first-timer journey (spec A11 "Page-by-page migration", #582).
//
// • <FtRedirect> wraps a legacy route's element. OFF (or while the flag set is still loading) it
//   renders that element untouched — the same markup as today. ON, it redirects to the journey
//   route from the ONE table in lib/legacyRoutes.ts.
// • <StepRoute> is a journey step URL. ON it renders the step: StepHeader + the step body + Back /
//   Why? / Next. Connect (#586) and Review (#587) are their own pages; the other bodies are PLACEHOLDERS that compose
//   today's pages until their step tickets replace them. OFF it redirects to the legacy page the step replaces, so a step
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
  // #591: the footer's Why? is the Why? drawer (the step explainer + Ask Quillo in context when it's on).
  const { openWhy, drawer } = useWhyDrawer(step);
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
      <StepHeader step={step} onWhy={() => openWhy()} />
      <div>{children}</div>
      <StepFooter
        onBack={() => navigate(prev ? STEP_ROUTE[prev] : "/")}
        primary={next ? { label: `Next: ${STEP_LABEL[next]}`, onClick: () => navigate(STEP_ROUTE[next]) } : { label: "Back to Home", onClick: () => navigate("/") }}
      />
      {drawer}
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

/** Connect (#586): its own page. /accounts and /income still redirect here (/income → #income). */
export const ConnectStep = () => (
  <StepRoute step="connect">
    <ConnectPage />
  </StepRoute>
);

/**
 * Review (spec §0 step 3, #587 absorbing #588 Records + #589 Check): ONE self-completing card queue
 * (pages/ReviewQueue.tsx; ?view=labels is its "By label" tab). /review/match?receipt= is the two-pane
 * fallback picker (today's Reconcile). OFF (and while the flag set loads) /review is the legacy "By label"
 * page exactly as today, and /review/match goes to the legacy /reconcile page.
 */
export function ReviewStep() {
  const { has, loaded } = useFeatures();
  const { pathname, search } = useLocation();
  const picker = pathname === MATCH_PICKER_ROUTE;
  if (!loaded || !has("ft_journey")) return picker ? (loaded ? <Navigate to={`/reconcile${search}`} replace /> : null) : <Review />;
  return (
    <StepPage step="review">
      {picker ? (
        <div className="space-y-3">
          <FtLink to={STEP_ROUTE.review} className="text-sm">
            Back to Review
          </FtLink>
          <Reconcile />
        </div>
      ) : (
        <ReviewQueue />
      )}
    </StepPage>
  );
}

/** Lodge in myTax (#590): the Tax-ready gate, the myTax worksheet + mark as lodged; the legacy Filing page folds in here. */
export const LodgeStep = () => (
  <StepRoute step="lodge">
    <ShipIt />
  </StepRoute>
);

/**
 * /lodge/print (#590): the worksheet laid out for paper — no step header/footer. OFF ⇒ the legacy Filing page
 * (as for /lodge); without the worksheet flag there is nothing to print, so it goes back to /lodge.
 */
export function LodgePrintStep() {
  const { has, loaded } = useFeatures();
  if (!loaded) return null;
  if (!has("ft_journey")) return <Navigate to={STEP_LEGACY_ROUTE.lodge} replace />;
  if (!has("mytax_worksheet")) return <Navigate to="/lodge" replace />;
  return <ShipItPrint />;
}
