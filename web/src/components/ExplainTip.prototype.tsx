// PROTOTYPE — throwaway (map #692, ticket #698 "Prototype the Explain tooltip"). Not production code.
// Question: how should the shared what/why Explain tip look and behave? Three structurally different
// variants of InfoTip/Term, switchable with ?tip=A|B|C on any page (dev builds only):
//   A — today's floating bubble: hover/tap shows the one-paragraph `short` copy.
//   B — anchored "Explain card": tap opens an interactive card with WHAT / WHY IT MATTERS / ATO link.
//   C — bottom sheet: tap slides up a full-width learn sheet (mobile-first), with related terms.
import { useEffect, useState, type ReactNode } from "react";
import { ANY_GLOSSARY, type AnyGlossaryKey } from "../content/glossary";

// Prototype-only extra copy (the real decision decides where this lives). GENERAL INFORMATION only.
interface Extra { what: string; why: string; ato?: { label: string; url: string }; related?: AnyGlossaryKey[] }
const EXTRA: Partial<Record<AnyGlossaryKey, Extra>> = {
  mytax: {
    what: "myTax is the ATO's free online form for lodging your own individual tax return, inside your myGov account.",
    why: "It's where your return actually gets lodged. Quillo gets your records ready; you copy the figures into myTax and press lodge.",
    ato: { label: "ATO: lodge with myTax", url: "https://www.ato.gov.au/individuals-and-families/your-tax-return/how-to-lodge-your-tax-return/lodge-your-tax-return-online" },
    related: ["prefill", "income_statement", "registered_tax_agent"],
  },
  registered_tax_agent: {
    what: "A tax practitioner registered with the Tax Practitioners Board who can give you tax advice and lodge your return for you.",
    why: "Quillo gives general information, not advice. If your situation is unusual, an agent can confirm what you can claim — and their fee is itself deductible next year.",
    ato: { label: "TPB register", url: "https://www.tpb.gov.au/public-register" },
    related: ["mytax", "deduction"],
  },
  golden_rules: {
    what: "The ATO's three tests for a work-related deduction: you paid for it yourself, it's directly related to earning your income, and you have a record.",
    why: "Every claim you make is checked against these. Quillo asks for the record (receipt) because without it the claim usually fails.",
    ato: { label: "ATO: the 3 golden rules", url: "https://www.ato.gov.au/individuals-and-families/income-deductions-offsets-and-records/deductions-you-can-claim" },
    related: ["deduction", "record_keeping_exception"],
  },
};

const body = (k?: AnyGlossaryKey, tip?: ReactNode) => tip ?? (k ? ANY_GLOSSARY[k].short : null);

/** Variant B — anchored interactive card (Popover-style; click/tap toggles, links are clickable). */
export function ExplainCard({ k, tip, trigger }: { k?: AnyGlossaryKey; tip?: ReactNode; trigger: ReactNode }) {
  const [open, setOpen] = useState(false);
  const x = k ? EXTRA[k] : undefined;
  return (
    <span className="relative inline-block">
      <button type="button" onClick={(e) => { e.preventDefault(); setOpen((o) => !o); }} aria-expanded={open}
        className="cursor-help rounded-sm underline decoration-dotted decoration-ink-3/60 underline-offset-2">
        {trigger}
      </button>
      {open && (
        <span role="dialog" className="absolute left-0 top-full z-[70] mt-2 block w-[19rem] rounded-xl border border-line bg-card p-3 text-left text-xs leading-relaxed text-ink-2 shadow-card">
          <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted">What it is</span>
          <span className="block">{x?.what ?? body(k, tip)}</span>
          {x && <>
            <span className="mt-2 block text-[10px] font-semibold uppercase tracking-wider text-muted">Why it matters for your tax</span>
            <span className="block">{x.why}</span>
            {x.ato && <a href={x.ato.url} target="_blank" rel="noreferrer" className="mt-2 block font-semibold text-forest underline">{x.ato.label} ↗</a>}
          </>}
          <span className="mt-2 flex justify-between">
            <a href={`/glossary#${k ?? ""}`} className="text-muted underline">Glossary</a>
            <button type="button" onClick={() => setOpen(false)} className="text-muted">Close</button>
          </span>
        </span>
      )}
    </span>
  );
}

/** Variant C — full-width bottom sheet with related terms (thumb-reachable on phones). */
export function ExplainSheet({ k, tip, trigger }: { k?: AnyGlossaryKey; tip?: ReactNode; trigger: ReactNode }) {
  const [cur, setCur] = useState<AnyGlossaryKey | null>(null);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setCur(null);
    window.addEventListener("keydown", esc); return () => window.removeEventListener("keydown", esc);
  }, []);
  const x = cur ? EXTRA[cur] : undefined;
  return (
    <>
      <button type="button" onClick={(e) => { e.preventDefault(); if (k) setCur(k); }}
        className="inline-flex items-center gap-1 rounded-full bg-surface px-1.5 font-medium text-forest">
        {trigger}<span aria-hidden className="text-[10px]">Learn</span>
      </button>
      {cur && (
        <div className="fixed inset-0 z-[70] flex items-end bg-ink/30" onClick={() => setCur(null)}>
          <div role="dialog" onClick={(e) => e.stopPropagation()} className="w-full rounded-t-2xl bg-card p-5 text-sm leading-relaxed text-ink-2 shadow-card sm:mx-auto sm:max-w-xl">
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line" />
            <h3 className="font-display text-xl text-forest">{ANY_GLOSSARY[cur].term}</h3>
            <p className="mt-2"><b>What it is.</b> {x?.what ?? body(cur, tip)}</p>
            {x && <p className="mt-2"><b>Why it matters for your tax.</b> {x.why}</p>}
            {x?.ato && <a href={x.ato.url} target="_blank" rel="noreferrer" className="mt-3 inline-block font-semibold text-forest underline">{x.ato.label} ↗</a>}
            {x?.related && (
              <div className="mt-4 flex flex-wrap gap-2">
                {x.related.map((r) => (
                  <button key={r} type="button" onClick={() => setCur(r)} className="rounded-full border border-line px-3 py-1 text-xs">{ANY_GLOSSARY[r].term}</button>
                ))}
              </div>
            )}
            <p className="mt-4 text-xs text-muted">General information only — not tax advice.</p>
          </div>
        </div>
      )}
    </>
  );
}

/** Floating switcher bar (dev only): ← variant → ; arrow keys cycle. */
export function TipVariantSwitcher() {
  const v = tipVariant();
  const names: Record<string, string> = { A: "A (bubble — today)", B: "B (Explain card)", C: "C (bottom sheet)" };
  const go = (d: number) => {
    const keys = ["A", "B", "C"]; const n = keys[(keys.indexOf(v) + d + 3) % 3]!;
    const u = new URL(location.href); u.searchParams.set("tip", n); location.replace(u.toString());
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input,textarea,[contenteditable]")) return;
      if (e.key === "ArrowLeft") go(-1); if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h);
  });
  return (
    <div className="fixed bottom-4 left-1/2 z-[80] flex -translate-x-1/2 items-center gap-3 rounded-full bg-black px-4 py-2 text-sm text-white shadow-lg">
      <button onClick={() => go(-1)}>←</button><span>PROTOTYPE tip {names[v]}</span><button onClick={() => go(1)}>→</button>
    </div>
  );
}

export function tipVariant(): string {
  if (!import.meta.env.DEV) return "A";
  const v = new URLSearchParams(location.search).get("tip") ?? "A";
  return ["A", "B", "C"].includes(v) ? v : "A";
}
