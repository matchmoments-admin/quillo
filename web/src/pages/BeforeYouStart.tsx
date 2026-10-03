import { Link, useLoaderData } from "react-router-dom";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Card, Term } from "../components/ui";
import { ATO_LINKS, BEFORE_YOU_START as C, BEFORE_YOU_START_LINKS, type ExtLink } from "../content/beforeYouStart";

/** What the public probe returns (src/lib/before-you-start.ts). */
export interface BeforeYouStartData {
  price_line: string | null;
}

/**
 * Router loader for /start. The screen is public (mounted outside <Protected />), so it can't read
 * the feature list from the authenticated dashboard payload; the public probe is its flag check.
 * Flag OFF (or any failure) ⇒ throw the same 404 the router renders for an unmatched URL, so with
 * ft_journey OFF /start looks exactly as it does today.
 */
export async function beforeYouStartLoader(): Promise<BeforeYouStartData> {
  let res: Response;
  try {
    res = await fetch("/api/public/before-you-start", { headers: { accept: "application/json" } });
  } catch {
    throw new Response("Not Found", { status: 404, statusText: "Not Found" });
  }
  if (!res.ok) throw new Response("Not Found", { status: 404, statusText: "Not Found" });
  const body = (await res.json()) as Partial<BeforeYouStartData>;
  return { price_line: typeof body.price_line === "string" && body.price_line.trim() ? body.price_line : null };
}

function ExternalLink({ link }: { link: ExtLink }) {
  return (
    <a href={link.url} target="_blank" rel="noopener noreferrer" className="text-ink underline underline-offset-2 hover:text-green">
      {link.label}
    </a>
  );
}

function List({ items }: { items: readonly string[] }) {
  return (
    <ul className="mt-2 space-y-1.5 text-sm leading-relaxed text-ink-2">
      {items.map((t) => (
        <li key={t} className="flex gap-2">
          <span aria-hidden className="mt-2 h-1.5 w-1.5 flex-none rounded-full bg-ink-3/60" />
          <span>{t}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Before you start (spec A10, #584; flag ft_journey): a no-account "is Quillo right for you?"
 * screen. Standalone route so the new shell (A11) can link to it; it carries its own Tooltip
 * provider because it renders outside <App />. Never states whether the visitor must lodge — it
 * points to the ATO's tool (owner ruling 2026-10-03).
 */
export function BeforeYouStart() {
  const data = useLoaderData() as BeforeYouStartData;

  return (
    <Tooltip.Provider delayDuration={200} skipDelayDuration={400}>
      <div className="min-h-screen bg-paper px-4 py-8 sm:px-8 sm:py-12">
        <main className="mx-auto max-w-2xl space-y-5">
          <header>
            <div className="text-xs font-semibold uppercase tracking-wider text-muted">Quillo</div>
            <h1 className="mt-1 font-display text-3xl text-forest sm:text-4xl">{C.title}</h1>
            <p className="mt-2 text-sm leading-relaxed text-ink-2">{C.lede}</p>
          </header>

          <Card className="p-5">
            <h2 className="font-display text-lg text-forest">{C.fitHeading}</h2>
            <List items={C.fits} />
          </Card>

          <div className="grid gap-5 sm:grid-cols-2">
            <Card className="p-5">
              <h2 className="font-display text-lg text-forest">{C.doesHeading}</h2>
              <List items={C.does} />
              <p className="mt-3 text-xs text-muted">
                You lodge in <Term k="mytax" />.
              </p>
            </Card>
            <Card className="p-5">
              <h2 className="font-display text-lg text-forest">{C.doesntHeading}</h2>
              <List items={C.doesnt} />
              <p className="mt-3 text-xs text-muted">
                What's a <Term k="registered_tax_agent">registered tax agent</Term>?
              </p>
            </Card>
          </div>

          <Card className="p-5">
            <h2 className="font-display text-lg text-forest">{C.lodgeHeading}</h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-2">
              {C.lodgeLine} <ExternalLink link={ATO_LINKS.lodgeTool} />
            </p>
            <p className="mt-2 text-sm leading-relaxed text-ink-2">{C.lodgeEvenIf}</p>
            <p className="mt-2 text-sm leading-relaxed text-ink-2">
              {C.lodgeNonLodgment} <ExternalLink link={ATO_LINKS.nonLodgment} />
            </p>
          </Card>

          <Card className="p-5">
            <h2 className="font-display text-lg text-forest">{C.linksHeading}</h2>
            <ul className="mt-2 space-y-1.5 text-sm">
              {BEFORE_YOU_START_LINKS.map((l) => (
                <li key={l.url}>
                  <ExternalLink link={l} />
                </li>
              ))}
            </ul>
          </Card>

          {/* Price/fit slot (#523): renders nothing until the pack sets it. */}
          {data.price_line && <p className="text-sm leading-relaxed text-ink-2">{data.price_line}</p>}

          <div className="flex flex-wrap items-center gap-3">
            <Link
              to="/sign-up"
              className="inline-flex h-10 items-center justify-center rounded-full bg-ink px-5 text-sm font-semibold text-cream transition hover:bg-green"
            >
              {C.ctaPrimary}
            </Link>
            <Link to="/sign-in" className="text-sm text-ink underline underline-offset-2">
              {C.ctaSecondary}
            </Link>
          </div>

          <footer className="pt-2 text-xs leading-relaxed text-muted">{C.footnote}</footer>
        </main>
      </div>
    </Tooltip.Provider>
  );
}
