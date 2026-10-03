import { Term } from "../ui";
import { goldenRuleStates, goldenRulesMet, type GoldenRuleInput } from "./model";
import { cx, FtLink, Skeleton, StatusGate, type StatusProps } from "./primitives";

/**
 * The golden-rules strip (spec A10 ticket b, #591; owner ruling #537): the inline "why" on every claim
 * card and step intro. "You spent it · It's for earning your income · You have a record", each ticking
 * green when this card meets it and staying grey when it doesn't yet. Grey is "not yet", never a red
 * ruling: the user decides every item. Optionally links the ATO's own guide for their occupation
 * (`ato_url`, #579). Pass no `rules` for a step intro (all three listed, none ticked).
 */
export function GoldenRules({
  rules,
  guide,
  compact = false,
  ...status
}: {
  /** What this card knows; omitted ⇒ the strip only names the rules (step intros). */
  rules?: GoldenRuleInput;
  /** The ATO occupation guide to link, from GET /api/education. */
  guide?: { label: string; ato_url: string | null } | null;
  /** Hide the heading line (inside a claim card). */
  compact?: boolean;
} & StatusProps) {
  const states = goldenRuleStates(rules);
  const scored = rules !== undefined;
  return (
    <StatusGate what="the golden rules" {...status} skeleton={<Skeleton lines={1} />}>
      <div className="space-y-1.5">
        {!compact && (
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">
            <Term k="golden_rules">The ATO's three golden rules</Term>
            {scored && <span className="ml-2 normal-case tracking-normal">{goldenRulesMet(states)}</span>}
          </p>
        )}
        <ul aria-label="The ATO's three golden rules" className="flex flex-wrap gap-x-3 gap-y-1 text-[13px]">
          {states.map((s) => (
            <li key={s.key} title={s.hint} className={cx("inline-flex items-center gap-1.5", scored && s.met ? "text-ok" : "text-muted")}>
              <Tick on={scored && s.met} />
              <span>{s.label}</span>
              {scored && <span className="sr-only">{s.met ? "(done)" : "(not yet)"}</span>}
            </li>
          ))}
        </ul>
        {guide?.ato_url && (
          <FtLink href={guide.ato_url} className="text-[13px]">
            ATO guide for {guide.label}
          </FtLink>
        )}
      </div>
    </StatusGate>
  );
}

function Tick({ on }: { on: boolean }) {
  return (
    <svg aria-hidden width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6.5" />
      {on && <path d="M5 8.2l2 2 4-4.4" />}
    </svg>
  );
}
