import { useMemo, useState } from "react";
import { GLOSSARY } from "../content/glossary";
import { Card, Input } from "../components/ui";

// A browsable, searchable version of the same copy the in-app "What's this?" tooltips use
// (content/glossary.ts is the single source of truth). Makes the learning durable rather than
// only incidental — and gives tooltips a "read more" home later via #term anchors.
export function Glossary() {
  const [q, setQ] = useState("");
  const entries = useMemo(() => {
    const all = Object.entries(GLOSSARY).map(([key, v]) => ({ key, ...v }));
    const needle = q.trim().toLowerCase();
    if (!needle) return all.sort((a, b) => a.term.localeCompare(b.term));
    return all
      .filter((e) => e.term.toLowerCase().includes(needle) || e.short.toLowerCase().includes(needle))
      .sort((a, b) => a.term.localeCompare(b.term));
  }, [q]);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="font-display text-4xl text-forest">Glossary</h1>
        <p className="mt-1.5 text-sm text-muted">
          Plain-English explanations of the tax terms Quillo uses. General information only — not tax advice; confirm
          anything you'll act on with a registered tax/BAS agent.
        </p>
      </div>

      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search terms…" className="w-full" />

      {entries.length === 0 ? (
        <Card className="p-6 text-sm text-muted">No terms match "{q}".</Card>
      ) : (
        <div className="space-y-3">
          {entries.map((e) => (
            <div key={e.key} id={e.key} className="scroll-mt-20">
              <Card className="p-4">
                <div className="font-display text-lg tracking-wide text-forest">{e.term}</div>
                <p className="mt-1 text-sm leading-relaxed text-ink-2">{e.short}</p>
              </Card>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
