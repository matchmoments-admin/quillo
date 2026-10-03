import { useState } from "react";
import { MYTAX_CHECK, SETUP_INTRO, TAX_HELP } from "../../content/getSetUp";
import { MYTAX_CHECK_KEYS, type MyTaxCheck } from "../../lib/aboutYou";
import { Badge, FtButton, FtCard, FtCheckbox, FtLink } from "./primitives";

// Get set up (#585, spec §0): the Before you start intro (#584's content), the "Can you get into myTax?"
// self-check and the Tax Help card. Presentational: the page owns loading the stored ticks and saving them.

/** Before you start, condensed for the signed-in step: who lodges where, what Quillo doesn't do, the ATO's lodge tool. */
export function SetupIntro({ compact = false }: { compact?: boolean }) {
  return (
    <FtCard className="space-y-4 p-4">
      <div className="space-y-1">
        <p className="text-[15px] font-semibold text-ink">{SETUP_INTRO.title}</p>
        <p className="max-w-[65ch] text-sm leading-relaxed text-muted">{SETUP_INTRO.lede}</p>
      </div>
      {!compact && (
        <div className="space-y-1">
          <p className="text-sm font-medium text-ink">{SETUP_INTRO.doesntHeading}</p>
          <ul className="max-w-[65ch] list-disc space-y-1 pl-5 text-sm leading-relaxed text-muted">
            {SETUP_INTRO.doesnt.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="space-y-1">
        <p className="text-sm font-medium text-ink">{SETUP_INTRO.lodgeHeading}</p>
        <p className="max-w-[65ch] text-sm leading-relaxed text-muted">
          {SETUP_INTRO.lodgeLine} {SETUP_INTRO.lodgeEvenIf}
        </p>
        <p className="max-w-[65ch] text-sm leading-relaxed text-muted">{SETUP_INTRO.nonLodgment}</p>
        <div className="flex flex-wrap gap-x-4">
          {SETUP_INTRO.lodgeLinks.map((l) => (
            <FtLink key={l.url} href={l.url} className="text-sm">
              {l.label}
            </FtLink>
          ))}
        </div>
      </div>
    </FtCard>
  );
}

/**
 * "Can you get into myTax?" — myGov account · ATO linked to myGov · myID Standard/Strong, each with the ATO
 * page that fixes it. The user's OWN check: Quillo can't see myGov and never asks for credentials. An unticked
 * item shows how to get there; ticking it collapses that help.
 */
export function MyTaxAccessCheck({ value, onChange, saving }: { value: MyTaxCheck; onChange: (next: MyTaxCheck) => void; saving?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const all = MYTAX_CHECK_KEYS.every((k) => value[k]);
  return (
    <FtCard className="space-y-4 p-4">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[15px] font-semibold text-ink">{MYTAX_CHECK.title}</p>
          <Badge tone={all ? "ok" : "neutral"}>{all ? "All set" : `${MYTAX_CHECK_KEYS.filter((k) => value[k]).length} of ${MYTAX_CHECK_KEYS.length}`}</Badge>
        </div>
        <p className="max-w-[65ch] text-sm leading-relaxed text-muted">{MYTAX_CHECK.lede}</p>
      </div>
      <ul className="space-y-2" aria-busy={saving || undefined}>
        {MYTAX_CHECK.items.map((item) => {
          const ticked = value[item.key];
          const showHelp = !ticked || open === item.key;
          return (
            <li key={item.key} className="rounded-lg bg-surface px-3 py-2">
              <FtCheckbox checked={ticked} onChange={(c) => onChange({ ...value, [item.key]: c })}>
                {item.label}
              </FtCheckbox>
              {showHelp ? (
                <div className="space-y-1 pb-1 pl-8">
                  <p className="max-w-[65ch] text-sm leading-relaxed text-muted">{item.help}</p>
                  <FtLink href={item.fix.url} className="text-sm">
                    {item.fix.label}
                  </FtLink>
                </div>
              ) : (
                <FtButton variant="ghost" className="ml-6 text-xs text-muted" onClick={() => setOpen(item.key)}>
                  How to check this
                </FtButton>
              )}
            </li>
          );
        })}
      </ul>
      <p className="max-w-[65ch] text-sm text-ink">{all ? MYTAX_CHECK.allTicked : MYTAX_CHECK.notYet}</p>
      <p className="max-w-[65ch] text-xs leading-relaxed text-muted">{MYTAX_CHECK.privacy}</p>
    </FtCard>
  );
}

/** Tax Help, named as the ATO's free option (exclusions stated as information). */
export function TaxHelpCard() {
  return (
    <FtCard className="space-y-1 p-4">
      <p className="text-[15px] font-semibold text-ink">{TAX_HELP.title}</p>
      <p className="max-w-[65ch] text-sm leading-relaxed text-muted">{TAX_HELP.body}</p>
      <FtLink href={TAX_HELP.link.url} className="text-sm">
        {TAX_HELP.link.label}
      </FtLink>
    </FtCard>
  );
}
