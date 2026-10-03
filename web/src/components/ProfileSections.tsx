// Profile sections shared by Settings (flag OFF) and About you's profile mode (#585, spec A2: "carry-ins
// move here (#435)" and "People in this return" moves here from Settings). Moved verbatim from
// pages/Settings.tsx so the flag-OFF Settings markup is byte-identical; Settings renders them only while
// About you isn't live (ft_journey + situation_profile).

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, isDeleteBlocked } from "../api";
import { money, parseMoneyToCents } from "./ui";
import { PersonFields, personToBody, personToValue, emptyPerson, type PersonValue } from "./SituationFields";
import type { Person } from "../types";

const input = "rounded-lg border border-line bg-card px-3 py-2 text-sm";
const btn = "rounded-lg bg-ink px-3 py-2 text-sm font-medium text-white hover:bg-ink/90 disabled:opacity-50";
const del = "text-xs text-muted hover:text-danger";

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-1 text-xs text-muted">{children}</p>;
}

/** The People list: one editable row per person, the empty line, and the add row (Settings' "People" section). */
export function PeopleList({ persons, onDone }: { persons: Person[]; onDone: () => void }) {
  return (
    <>
      {persons.map((p) => (
        <EditablePerson key={p.id} person={p} onDone={onDone} />
      ))}
      {!persons.length && <Empty>No people yet. Add yourself (and a spouse, if relevant) — your occupation tailors the deduction hints Quillo suggests.</Empty>}
      <AddPerson onDone={onDone} />
    </>
  );
}

// Run a delete; on a blocked-delete (409, dependent records still reference the row) surface the
// reason and offer Archive when the parent supports it — instead of silently swallowing the error.
export async function runDelete(
  del: () => Promise<unknown>,
  opts: { onDone: () => void; label: string; archive?: () => Promise<unknown> },
): Promise<void> {
  try {
    await del();
    opts.onDone();
  } catch (e) {
    if (isDeleteBlocked(e)) {
      if (opts.archive && e.archivable) {
        toast.error(e.message, {
          description: "Archive it instead to hide it without losing the data.",
          action: {
            label: "Archive",
            onClick: () =>
              opts
                .archive!()
                .then(() => opts.onDone())
                .catch((er) => toast.error("Couldn't archive", { description: (er as Error).message })),
          },
        });
      } else {
        toast.error(e.message, { description: "Remove or reassign those records first, then delete." });
      }
    } else {
      toast.error(`Couldn't delete ${opts.label}`, { description: (e as Error).message });
    }
  }
}

export function CarryIns() {
  const qc = useQueryClient();
  const losses = useQuery({ queryKey: ["capital-losses"], queryFn: () => api.capitalLosses() });
  const openings = useQuery({ queryKey: ["opening-depreciation"], queryFn: () => api.openingDepreciation() });
  const toCents = (s: string) => parseMoneyToCents(s) ?? 0; // #249: comma/$ tolerant

  const [lossFy, setLossFy] = useState("");
  const [lossAmt, setLossAmt] = useState("");
  const addLoss = useMutation({
    mutationFn: () => api.addCapitalLoss({ prior_fy: Number(lossFy), loss_cents: toCents(lossAmt) }),
    onSuccess: () => { setLossFy(""); setLossAmt(""); qc.invalidateQueries({ queryKey: ["capital-losses"] }); },
  });
  const delLoss = useMutation({ mutationFn: (id: string) => api.deleteCapitalLoss(id), onSuccess: () => qc.invalidateQueries({ queryKey: ["capital-losses"] }) });

  const [depFy, setDepFy] = useState("");
  const [depAmt, setDepAmt] = useState("");
  const addDep = useMutation({
    mutationFn: () => api.addOpeningDepreciation({ fy: Number(depFy), opening_adjustable_value_cents: toCents(depAmt) }),
    onSuccess: () => { setDepFy(""); setDepAmt(""); qc.invalidateQueries({ queryKey: ["opening-depreciation"] }); },
  });
  const delDep = useMutation({ mutationFn: (id: string) => api.deleteOpeningDepreciation(id), onSuccess: () => qc.invalidateQueries({ queryKey: ["opening-depreciation"] }) });

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1 text-xs font-medium">Carried-forward capital losses</div>
        {(losses.data ?? []).map((l) => (
          <div key={l.id} className="flex items-center justify-between rounded-lg bg-surface px-3 py-2 text-sm">
            <span>FY {l.prior_fy} · {money(l.loss_cents)} <span className="text-muted">— offsets future capital gains only, not income</span></span>
            <button onClick={() => delLoss.mutate(l.id)} disabled={delLoss.isPending} className={del}>delete</button>
          </div>
        ))}
        {!(losses.data ?? []).length && <Empty>None recorded. Add a prior-year capital loss for your agent to carry forward.</Empty>}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <input className={`${input} w-36`} type="number" placeholder="Prior FY (e.g. 2023)" value={lossFy} onChange={(e) => setLossFy(e.target.value)} aria-label="Prior FY" />
          <input className={`${input} w-28`} type="number" placeholder="$ loss" value={lossAmt} onChange={(e) => setLossAmt(e.target.value)} aria-label="Capital loss in dollars" />
          <button className={btn} disabled={!lossFy || !lossAmt || addLoss.isPending} onClick={() => addLoss.mutate()}>Add</button>
        </div>
      </div>
      <div>
        <div className="mb-1 text-xs font-medium">Opening depreciation (adjustable values)</div>
        {(openings.data ?? []).map((d) => (
          <div key={d.id} className="flex items-center justify-between rounded-lg bg-surface px-3 py-2 text-sm">
            <span>FY {d.fy} · {money(d.opening_adjustable_value_cents)} <span className="text-muted">— for your agent to apply</span></span>
            <button onClick={() => delDep.mutate(d.id)} disabled={delDep.isPending} className={del}>delete</button>
          </div>
        ))}
        {!(openings.data ?? []).length && <Empty>None recorded. Add an opening adjustable value from last year's depreciation schedule.</Empty>}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <input className={`${input} w-36`} type="number" placeholder="FY (e.g. 2024)" value={depFy} onChange={(e) => setDepFy(e.target.value)} aria-label="FY" />
          <input className={`${input} w-32`} type="number" placeholder="$ opening value" value={depAmt} onChange={(e) => setDepAmt(e.target.value)} aria-label="Opening adjustable value in dollars" />
          <button className={btn} disabled={!depFy || !depAmt || addDep.isPending} onClick={() => addDep.mutate()}>Add</button>
        </div>
      </div>
    </div>
  );
}

function EditablePerson({ person, onDone }: { person: Person; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<PersonValue>(() => personToValue(person));
  const isSelf = person.role === "self";
  const save = useMutation({ mutationFn: () => api.updatePerson(person.id, personToBody(value)), onSuccess: () => { setEditing(false); onDone(); } });
  if (!editing) {
    const bits = [person.display_name, person.role, person.occupation].filter(Boolean);
    return (
      <div className="flex items-center justify-between rounded-lg bg-surface px-3 py-2 text-sm">
        <span className="truncate">{bits.join(" · ")}{person.tax_residency && person.tax_residency !== "AU" ? " · foreign resident" : ""}</span>
        <div className="flex flex-none gap-3">
          <button onClick={() => { setValue(personToValue(person)); setEditing(true); }} className={del}>edit</button>
          {/* The 'self' person anchors entities/properties/income — never deletable here. */}
          {!isSelf && <button onClick={() => runDelete(() => api.deletePerson(person.id), { onDone, label: "person" })} className={del}>delete</button>}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-start gap-2 rounded-lg bg-surface px-3 py-2">
      <div className="flex-1"><PersonFields value={value} onChange={setValue} lockRole={isSelf} /></div>
      <button className={btn} disabled={save.isPending} onClick={() => save.mutate()}>Save</button>
      <button className={del} onClick={() => setEditing(false)}>cancel</button>
    </div>
  );
}

function AddPerson({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState<PersonValue>(emptyPerson());
  const m = useMutation({ mutationFn: () => api.addPerson(personToBody(value)), onSuccess: () => { setValue(emptyPerson()); onDone(); } });
  return (
    <div className="flex flex-wrap items-start gap-2 pt-2">
      <div className="flex-1"><PersonFields value={value} onChange={setValue} /></div>
      <button className={btn} disabled={!value.display_name || m.isPending} onClick={() => m.mutate()}>Add</button>
    </div>
  );
}
