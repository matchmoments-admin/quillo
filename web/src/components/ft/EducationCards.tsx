import { NEWCOMER_TOPICS, newcomerTopics } from "../../content/newcomer";
import { useEducation } from "../../lib/education";
import { Badge, FtCard, FtLink, Skeleton, StatusGate, type StatusProps } from "./primitives";

/**
 * State education card (spec A10 ticket b, #591): About you mounts it after the state question. Links
 * the chosen state or territory revenue office's general pages from the pack's `state_education`,
 * labelled "for your information; your return is federal". Education only: no state figures. Renders
 * nothing until a state is chosen or when the pack has no entry for it.
 */
export function StateEducationCard({ stateCode, ...status }: { stateCode: string | null | undefined } & StatusProps) {
  const q = useEducation();
  const block = q.data?.state_education ?? null;
  const entry = stateCode ? block?.states.find((s) => s.code === stateCode) : undefined;
  const loadStatus = status.status ?? (q.isError ? "error" : q.isLoading && q.fetchStatus !== "idle" ? "loading" : "ready");
  if (!stateCode || (loadStatus === "ready" && (!block || !entry))) return null;
  return (
    <StatusGate what="state information" {...status} status={loadStatus} error={status.error ?? q.error} onRetry={status.onRetry ?? (() => q.refetch())} skeleton={<Skeleton lines={2} />}>
      {block && entry && (
        <FtCard className="space-y-2 p-4">
          <Badge tone="info">{block.label}</Badge>
          <p className="text-sm font-semibold text-ink">{entry.name}</p>
          {block.intro && <p className="max-w-[65ch] text-sm leading-relaxed text-muted">{block.intro}</p>}
          <FtLink href={entry.url} className="text-sm">
            {entry.office}
          </FtLink>
        </FtCard>
      )}
    </StatusGate>
  );
}

/**
 * Newcomer education (spec A10 ticket b, #591): About you mounts it inline under Q1 (residency) with
 * the residency values the person has in the year. Text only, no figures. Resident all year ⇒ nothing.
 */
export function NewcomerCard({ residency, ...status }: { residency: readonly (string | null | undefined)[] } & StatusProps) {
  const topics = newcomerTopics(residency);
  if (topics.length === 0 && (status.status ?? "ready") === "ready") return null;
  return (
    <StatusGate what="newcomer information" {...status} skeleton={<Skeleton lines={3} />}>
      <FtCard className="space-y-4 p-4">
        <Badge tone="info">New to Australia</Badge>
        {topics.map((k) => {
          const t = NEWCOMER_TOPICS[k];
          return (
            <div key={k} className="space-y-1">
              <p className="text-sm font-semibold text-ink">{t.title}</p>
              <p className="max-w-[65ch] text-sm leading-relaxed text-muted">{t.body}</p>
              <FtLink href={t.link.url} className="text-sm">
                {t.link.label}
              </FtLink>
            </div>
          );
        })}
      </FtCard>
    </StatusGate>
  );
}
