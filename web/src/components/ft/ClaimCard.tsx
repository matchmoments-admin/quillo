import type { ReactNode } from "react";
import { money } from "../ui";
import { GoldenRules } from "./GoldenRules";
import { CLAIM_BADGE_LABEL, type ClaimBadge, type GoldenRuleInput } from "./model";
import { Badge, FtButton, FtCard, Skeleton, StatusGate, type StatusProps } from "./primitives";

const BADGE_TONE: Record<ClaimBadge, "highlight" | "ok" | "neutral" | "warn"> = {
  worth_a_look: "highlight",
  confirmed: "ok",
  not_work: "neutral",
  needs_record: "warn",
};

/**
 * Claim card (design-system.md §4): title, figure, badge, why, evidence, and the two decisions:
 * Claim it / Not work-related. The figure is what was spent, never an estimate of tax back. The
 * user decides every item; the card only explains why it was surfaced. Every card shows the ATO's
 * three golden rules (#591), ticked from `rules`, with the occupation guide link when given; `onWhy`
 * adds a Why? that opens the Why? drawer about this item.
 */
export function ClaimCard({
  title,
  amountCents,
  meta,
  badge = "worth_a_look",
  why,
  evidence,
  onClaim,
  onNotWork,
  busy,
  rules,
  guide,
  onWhy,
  ...status
}: {
  title: ReactNode;
  /** What was spent, in cents. */
  amountCents: number | null;
  /** Date / merchant line under the title. */
  meta?: ReactNode;
  badge?: ClaimBadge;
  /** Why this was surfaced (a prompt to check, not a ruling). */
  why?: ReactNode;
  /** The record behind it, e.g. "Receipt attached" or a link to add one. */
  evidence?: ReactNode;
  onClaim?: () => void;
  onNotWork?: () => void;
  /** Which decision is in flight. */
  busy?: "claim" | "not_work";
  /** What this item meets of the three golden rules (unknown ⇒ grey). */
  rules?: GoldenRuleInput;
  /** The ATO occupation guide to link under the rules. */
  guide?: { label: string; ato_url: string | null } | null;
  /** Opens the Why? drawer for this item. */
  onWhy?: () => void;
} & StatusProps) {
  return (
    <StatusGate
      what="this item"
      {...status}
      emptyTitle={status.emptyTitle ?? "Nothing to look at here"}
      skeleton={
        <FtCard className="space-y-3 p-4">
          <div className="flex justify-between gap-4">
            <Skeleton className="w-1/2" />
            <Skeleton block className="h-5 w-20 rounded-full" />
          </div>
          <Skeleton lines={2} />
          <div className="flex gap-2">
            <Skeleton block className="h-11 w-28 rounded-lg" />
            <Skeleton block className="h-11 w-36 rounded-lg" />
          </div>
        </FtCard>
      }
    >
      <FtCard className="p-4">
        <article className="space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <Badge tone={BADGE_TONE[badge]}>{CLAIM_BADGE_LABEL[badge]}</Badge>
              <h3 className="mt-2 text-base font-semibold leading-snug text-ink">{title}</h3>
              {meta && <p className="mt-0.5 text-xs text-muted">{meta}</p>}
            </div>
            <span className="shrink-0 text-base font-semibold text-ink tnum">{money(amountCents)}</span>
          </div>
          {why && <p className="max-w-[65ch] text-sm leading-relaxed text-muted">{why}</p>}
          {evidence && <div className="text-xs text-ink">{evidence}</div>}
          <GoldenRules compact rules={rules ?? {}} guide={guide} />
          {(onClaim || onNotWork || onWhy) && (
            <div className="flex flex-wrap gap-2 pt-1">
              {onClaim && (
                <FtButton variant="primary" onClick={onClaim} busy={busy === "claim"} disabled={busy !== undefined}>
                  Claim it
                </FtButton>
              )}
              {onNotWork && (
                <FtButton variant="secondary" onClick={onNotWork} busy={busy === "not_work"} disabled={busy !== undefined}>
                  Not work-related
                </FtButton>
              )}
              {onWhy && (
                <FtButton variant="ghost" onClick={onWhy} aria-haspopup="dialog">
                  Why?
                </FtButton>
              )}
            </div>
          )}
        </article>
      </FtCard>
    </StatusGate>
  );
}
