import { useActiveFy } from "../lib/activeFy";
import { JOURNEY_STEP_KEYS, STATUS_LABEL, STEP_LABEL, STEP_ROUTE, useJourney } from "../lib/journey";
import { money } from "../components/ui";
import { Badge, EmptyState, FtCard, FtLink, GeneralInfoNote, GrowSuggestionCard, Skeleton, StatusGate } from "../components/ft";
import { useSetGrowLayer } from "../lib/grow";
import type { Journey, JourneyStepStatus } from "../types";

// Home (spec A11 "Home", #582; flag ft_journey — only routed when ON). Three blocks, same order in
// every state: (1) the readiness hero, (2) What's left, (3) a quiet step row. No calculators, no
// breakdown tables, no run-rate strip. Everything comes from the one /api/journey read the shell
// shares; the estimate is the readiness engine's indicative taxable position, present only when there
// are no blockers, and is never a refund or tax-payable figure.

const TONE: Record<JourneyStepStatus, "ok" | "accent" | "warn" | "neutral"> = {
  done: "ok",
  in_progress: "accent",
  needs_attention: "warn",
  not_started: "neutral",
};

/**
 * Cold = nothing captured for the year (readiness's `nothing_captured` finding). Keyed on the finding,
 * not the step states: the legacy residency scalar always has a value, so About you can read "in
 * progress" for a tenant who has brought nothing in.
 */
function isCold(j: Journey): boolean {
  return j.whats_left.some((w) => w.id === "nothing_captured");
}

function Hero({ j, label }: { j: Journey; label: string }) {
  if (isCold(j)) {
    return (
      <FtCard className="p-6">
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.02em] text-ink">Nothing in for FY {label} yet</h1>
        <p className="mt-1 max-w-[65ch] text-[15px] text-muted">Start by checking you can get into myTax and answering a few questions about your year. Each step builds on the one before.</p>
        <div className="mt-4">
          <FtLink to={STEP_ROUTE.setup} variant="primary">
            Get set up
          </FtLink>
        </div>
      </FtCard>
    );
  }
  const { blockers, review, estimate } = j.readiness;
  const headline = blockers === 0 && review === 0 ? "Nothing to fix or check right now" : `${blockers} to fix · ${review} to check`;
  return (
    <FtCard className="p-6">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted">FY {label}</p>
      <h1 className="mt-1 text-[26px] font-semibold leading-tight tracking-[-0.02em] text-ink">{headline}</h1>
      {estimate && (
        <div className="mt-3">
          <p className="text-[15px] text-ink">
            Estimated taxable position:{" "}
            <span className="font-semibold tnum">
              {estimate.confirmed_cents != null && estimate.confirmed_cents !== estimate.tracked_cents
                ? `${money(estimate.confirmed_cents)} confirmed → ${money(estimate.tracked_cents)} tracked`
                : money(estimate.tracked_cents)}
            </span>
          </p>
          <p className="mt-0.5 text-xs text-muted">Estimate only. {estimate.caption}</p>
        </div>
      )}
      <GeneralInfoNote className="mt-3" />
    </FtCard>
  );
}

/** Grow suggestions (A11b, #592): "Looks like you have X: add it?". Yes switches the layer on; No declines it for the FY. */
function GrowSuggestions({ j }: { j: Journey }) {
  const set = useSetGrowLayer();
  const pending = set.isPending ? set.variables?.layer : undefined;
  if (j.grow.suggestions.length === 0) return null;
  return (
    <div className="space-y-2">
      {j.grow.suggestions.map((s) => (
        <GrowSuggestionCard
          key={s.layer}
          title={s.title}
          body={s.body}
          busy={pending === s.layer}
          onYes={() => set.mutate({ layer: s.layer, state: "on", source: "detected" })}
          onNo={() => set.mutate({ layer: s.layer, state: "off", source: "detected" })}
        />
      ))}
    </div>
  );
}

function WhatsLeft({ j }: { j: Journey }) {
  return (
    <section aria-labelledby="whats-left" className="space-y-2">
      <h2 id="whats-left" className="mb-2 text-[17px] font-semibold tracking-[-0.02em] text-ink">
        What's left
      </h2>
      <GrowSuggestions j={j} />
      {j.whats_left.length === 0 ? (
        j.grow.suggestions.length > 0 ? null : (
        <EmptyState title="Nothing on the list" body="When something needs your attention, it shows up here with a link to the step it belongs to." />
        )
      ) : (
        <FtCard>
          <ul className="divide-y divide-line">
            {j.whats_left.map((w) => (
              <li key={w.id} className="flex flex-wrap items-center gap-3 px-4 py-2">
                <Badge tone={w.severity === "blocker" ? "warn" : "info"}>{w.severity === "blocker" ? "To fix" : "To check"}</Badge>
                <span className="min-w-0 flex-1 text-[15px] text-ink">{w.title}</span>
                <FtLink to={STEP_ROUTE[w.step]} className="text-sm">
                  {STEP_LABEL[w.step]}
                </FtLink>
              </li>
            ))}
          </ul>
        </FtCard>
      )}
    </section>
  );
}

function StepRow({ j }: { j: Journey }) {
  const byKey = new Map(j.steps.map((s) => [s.key, s]));
  return (
    <section aria-labelledby="your-steps">
      <h2 id="your-steps" className="mb-2 text-[17px] font-semibold tracking-[-0.02em] text-ink">
        Your steps
      </h2>
      <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {JOURNEY_STEP_KEYS.map((k, i) => {
          const s = byKey.get(k);
          return (
            <li key={k}>
              <FtLink to={STEP_ROUTE[k]} variant="secondary" className="w-full justify-between">
                <span className="flex items-center gap-2">
                  <span className="font-mono text-xs text-muted">{i + 1}</span>
                  <span>{STEP_LABEL[k]}</span>
                </span>
                {s && (
                  <span className="flex items-center gap-1.5">
                    {s.count > 0 && <span className="text-xs text-muted tnum">{s.count}</span>}
                    <Badge tone={TONE[s.status]}>{STATUS_LABEL[s.status]}</Badge>
                  </span>
                )}
              </FtLink>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function Home() {
  const { label } = useActiveFy();
  const journey = useJourney();
  const status = journey.isLoading ? "loading" : journey.isError ? "error" : "ready";
  return (
    <div className="space-y-8">
      <StatusGate
        what="your year"
        status={status}
        error={journey.error}
        onRetry={() => void journey.refetch()}
        skeleton={
          <div className="space-y-6">
            <Skeleton block className="h-36 rounded-[14px]" />
            <Skeleton lines={3} />
          </div>
        }
      >
        {journey.data && (
          <>
            <Hero j={journey.data} label={label} />
            <WhatsLeft j={journey.data} />
            <StepRow j={journey.data} />
          </>
        )}
      </StatusGate>
    </div>
  );
}
