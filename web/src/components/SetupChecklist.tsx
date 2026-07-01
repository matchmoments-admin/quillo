import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useActiveFy } from "../lib/activeFy";
import { Panel, PanelHead, QueryError } from "./ui";

// #246 (Wave 3): the onboarding-completeness checklist. Tells the user WHICH evidence to bring in and
// WHY, so nothing is discovered missing at hand-off (the founder-E2E gap). It DERIVES status from data
// the app already has (situation + accounts + income + work-use) — no new table — and persists per-item
// "done"/"skip" for the items we can't reliably auto-detect (rental docs) in localStorage. WHY-first +
// deep links, per the #248 research. Flag-gated by `onboarding_checklist`; auto-hides once everything is
// done or skipped, so it never nags a set-up user. General information only — not tax advice.

const LS_KEY = "quillo:setup-checklist";
type Marks = { done: string[]; skip: string[] };
function readMarks(): Marks {
  try {
    const m = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    return { done: Array.isArray(m.done) ? m.done : [], skip: Array.isArray(m.skip) ? m.skip : [] };
  } catch {
    return { done: [], skip: [] };
  }
}

type Item = { id: string; title: string; why: string; href: string; done: boolean; manual: boolean };

export function SetupChecklist({ embedded = false }: { embedded?: boolean } = {}) {
  const { fy } = useActiveFy();
  const [marks, setMarks] = useState<Marks>(readMarks);

  const sitQ = useQuery({ queryKey: ["situation"], queryFn: () => api.situation() });
  const accQ = useQuery({ queryKey: ["accounts"], queryFn: () => api.accounts() });
  const incQ = useQuery({ queryKey: ["income", "all"], queryFn: () => api.income({}) });
  const wuQ = useQuery({ queryKey: ["work-use", fy], queryFn: () => api.workUse(fy) });

  // Render nothing until the inputs are loaded (avoids a flicker of wrong states). Each query is also
  // used elsewhere, so this is almost always warm from cache.
  if (sitQ.isLoading || accQ.isLoading || incQ.isLoading || wuQ.isLoading) return null;
  // If a source query ERRORED, the derived "done" status would be wrong (e.g. income exists but its
  // query failed ⇒ the item shows as still-to-do, or a real gap is masked). Surface it instead of
  // silently deriving the checklist from undefined data.
  if (sitQ.isError || accQ.isError || incQ.isError || wuQ.isError) {
    return (
      <QueryError
        what="your setup checklist"
        error={sitQ.error ?? accQ.error ?? incQ.error ?? wuQ.error}
        onRetry={() => {
          sitQ.refetch();
          accQ.refetch();
          incQ.refetch();
          wuQ.refetch();
        }}
      />
    );
  }

  const sit = sitQ.data;
  const accounts = accQ.data ?? [];
  const income = incQ.data ?? [];
  const wu = wuQ.data;
  const self = (sit?.persons ?? []).find((p) => p.role === "self");
  const entities = sit?.entities ?? [];
  const properties = sit?.properties ?? [];
  const employed = !!(self?.occupation?.trim()) || entities.some((e) => e.kind === "payg");

  const mark = (kind: "done" | "skip", id: string) => {
    setMarks((prev) => {
      const next: Marks = { done: prev.done.filter((x) => x !== id), skip: prev.skip.filter((x) => x !== id) };
      next[kind] = [...next[kind], id];
      try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch { /* private mode — in-memory only */ }
      return next;
    });
  };

  // Auto-derived items (status read from real data) + manual rental-doc items (checked off by hand,
  // because agent summaries / rates can't be reliably auto-detected). Only show what's relevant.
  const items: Item[] = [
    {
      id: "statements",
      title: "Add your bank & card statements",
      why: "We categorise your spending from these — without them, deductions get missed.",
      href: "/accounts",
      done: accounts.some((a) => (a.line_count ?? 0) > 0),
      manual: false,
    },
    {
      id: "income",
      title: "Add your income (payslips / payment summary)",
      why: "Your assessable income is the other half of your tax position.",
      href: "/income",
      done: income.length > 0,
      manual: false,
    },
    ...(employed
      ? [{
          id: "wfh",
          title: "Add your work-from-home hours",
          why: "Home-office running costs are the most-claimed PAYG deduction — capture the hours so they count.",
          href: "/",
          done: (wu?.wfh_hours ?? 0) > 0 || (wu?.wfh_days_per_week ?? 0) > 0,
          manual: false,
        } as Item]
      : []),
    ...properties.map<Item>((p) => ({
      id: `prop:${p.id}`,
      title: `Attach rental documents for ${p.label}`,
      why: "Loan annual summary, managing-agent summary, and council & water rates — the biggest rental deductions.",
      href: "/accounts",
      done: marks.done.includes(`prop:${p.id}`),
      manual: true,
    })),
  ];

  // Hide skipped, then hide the whole card once nothing is left to do.
  const visible = items.filter((it) => !marks.skip.includes(it.id));
  const remaining = visible.filter((it) => !it.done);
  if (remaining.length === 0) return null;

  const doneCount = visible.length - remaining.length;

  const itemsList = (
    <div className="space-y-2">
      {visible.map((it) => (
        <div key={it.id} className="flex items-start gap-3 rounded-lg border border-line bg-surface px-3 py-2.5">
          <span
            aria-hidden
            className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-bold ${it.done ? "bg-safe text-white" : "border border-line bg-card text-muted"}`}
          >
            {it.done ? "✓" : ""}
          </span>
          <div className="min-w-0 flex-1">
            <div className={`text-sm font-medium ${it.done ? "text-muted line-through" : "text-ink"}`}>{it.title}</div>
            {!it.done && <div className="text-xs text-ink-3">{it.why}</div>}
          </div>
          {!it.done && (
            <div className="flex shrink-0 items-center gap-2">
              <Link to={it.href} className="rounded-full bg-ink px-3 py-1 text-xs font-semibold text-cream hover:bg-green">Add</Link>
              {it.manual && (
                <button onClick={() => mark("done", it.id)} className="text-xs text-muted hover:text-ink">Done</button>
              )}
              <button onClick={() => mark("skip", it.id)} className="text-xs text-muted hover:text-ink">Skip</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );

  // Slice 8 (checklist_v2): rendered INSIDE ChecklistCard's Panel as a "Bring these in" sub-section
  // (no own Panel), so the two checklists read as one. Same items/marks/GENERAL-INFO — just unwrapped.
  if (embedded) {
    return (
      <div>
        <div className="mb-1 text-sm font-semibold text-ink">Bring these in <span className="font-normal text-muted">· {doneCount} of {visible.length} done</span></div>
        <p className="mb-3 text-xs text-ink-2">A few evidence sources so nothing's missing when you hand off your year. General information only — not tax advice.</p>
        {itemsList}
      </div>
    );
  }

  return (
    <Panel>
      <PanelHead title="Bring these in" sub={`${doneCount} of ${visible.length} done`} />
      <p className="-mt-1 mb-3 text-sm text-ink-2">
        A few evidence sources so nothing's missing when you hand off your year. General information only — not tax advice.
      </p>
      {itemsList}
    </Panel>
  );
}
