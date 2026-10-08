import { Navigate, useParams } from "react-router-dom";
import { useFeatures } from "../lib/features";
import { useActiveFy } from "../lib/activeFy";
import { useJourney } from "../lib/journey";
import { useHashScroll } from "../lib/useHashScroll";
import { GROW_BLURB, GROW_LABEL, GROW_LEGACY_ROUTE, isGrowKey, useSetGrowLayer } from "../lib/grow";
import { FtButton, FtCard, FtLink, GeneralInfoNote } from "../components/ft";
import { LoanInterestCard } from "../components/LoanInterestCard";
import { CapitalEquity } from "../components/income/CapitalEquity";
import { EssGrants } from "../components/income/EssGrants";
import type { GrowLayerKey } from "../types";
import { Assets } from "./Assets";
import { Extras } from "./Extras";
import { Savings } from "./Savings";
import { QuickBooks } from "./QuickBooks";
import { BusinessSettings, PropertySettings } from "./Settings";

// Grow pages at /grow/:layer (spec A11 ticket b, #592; flag ft_journey). Each is COMPOSED from the existing
// pages/components — no rewrites. Property and Business compose the editors that used to live on Settings
// (#593: Settings is account-only with the flag ON); `/settings#properties` etc. land on their anchors here.
//
// A Grow page is always reachable by URL (every legacy deep link keeps working), even when the layer is
// hidden from the rail; a hidden, switchable layer shows a one-tap "Show in my menu". OFF, a /grow URL
// redirects to the legacy page it composes. Every hook sits above the first conditional return.

function PropertyBody({ fyStart }: { fyStart: number }) {
  return (
    <div className="space-y-4">
      <PropertySettings />
      <LoanInterestCard fy={fyStart} />
      <FtCard className="p-4">
        <p className="text-sm text-ink">Rent you received is recorded with your income, and each property's position is on Reports.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <FtLink to="/connect#income" variant="secondary">
            Your income
          </FtLink>
          <FtLink to="/reports" variant="secondary">
            Reports
          </FtLink>
        </div>
      </FtCard>
    </div>
  );
}

function InvestmentsBody() {
  const { has } = useFeatures();
  return (
    <div className="space-y-4">
      {has("cgt_engine") && <CapitalEquity />}
      {has("ess_engine") && <EssGrants />}
      <FtCard className="p-4">
        <p className="text-sm text-ink">Dividends and fund distributions are recorded with your income.</p>
        <div className="mt-2">
          <FtLink to="/connect#income" variant="secondary">
            Your income
          </FtLink>
        </div>
      </FtCard>
    </div>
  );
}

function BusinessBody() {
  return <BusinessSettings />;
}

function LayerBody({ layer, fyStart }: { layer: GrowLayerKey; fyStart: number }) {
  switch (layer) {
    case "property":
      return <PropertyBody fyStart={fyStart} />;
    case "investments":
      return <InvestmentsBody />;
    case "business":
      return <BusinessBody />;
    case "assets":
      return <Assets />;
    case "integrations":
      return <QuickBooks />;
    case "extras":
      return <Extras />;
    case "savings":
      return <Savings />;
    case "advisers":
      return <Navigate to="/partner" replace />;
  }
}

/** Layers whose body is a whole existing page that renders its own <h1>. */
const OWN_HEADING: ReadonlySet<GrowLayerKey> = new Set<GrowLayerKey>(["assets", "integrations", "extras", "savings"]);

export function GrowRoute() {
  const { layer } = useParams();
  const { has, loaded } = useFeatures();
  const { fy: fyStart } = useActiveFy();
  const journey = useJourney();
  const set = useSetGrowLayer();
  useHashScroll(loaded && has("ft_journey"));
  if (!loaded) return null;
  if (!isGrowKey(layer)) return <Navigate to="/" replace />;
  if (!has("ft_journey")) return <Navigate to={GROW_LEGACY_ROUTE[layer]} replace />;
  const view = journey.data?.grow.layers.find((l) => l.key === layer);
  const hidden = view?.state === "off" && view.switchable;
  return (
    <div className="space-y-6">
      {/* Composed legacy pages (Assets, QuickBooks, Extras, Savings) bring their own heading; only the
          Grow-native bodies get one here, in the existing pages' type style (owner 2026-10-04: legacy look). */}
      {OWN_HEADING.has(layer) ? (
        <p className="text-xs font-semibold uppercase tracking-wider text-muted">Grow</p>
      ) : (
        <header>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">Grow</p>
          <h1 className="mt-1 font-display text-4xl text-forest">{GROW_LABEL[layer]}</h1>
          <p className="mt-1 max-w-[65ch] text-sm text-muted">{GROW_BLURB[layer]}</p>
        </header>
      )}
      {hidden && (
        <FtCard className="flex flex-wrap items-center gap-3 p-4">
          <p className="min-w-0 flex-1 text-sm text-muted">This isn't in your menu yet.</p>
          <FtButton variant="secondary" busy={set.isPending} onClick={() => set.mutate({ layer, state: "on", source: "switched" })}>
            Show in my menu
          </FtButton>
        </FtCard>
      )}
      <LayerBody layer={layer} fyStart={fyStart} />
      <GeneralInfoNote />
    </div>
  );
}
