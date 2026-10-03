import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useActiveFy, fyLabel } from "../lib/activeFy";
import { useFeatures } from "../lib/features";
import { useEducation } from "../lib/education";
import { STEP_LABEL, STEP_ROUTE } from "../lib/journey";
import {
  aboutScreens,
  aboutYouWrites,
  answersFromPeriods,
  fillPlan,
  fyBoundsFor,
  hasAnswersForFy,
  occupationToken,
  parseMyTaxCheck,
  residencyProblem,
  residencyValuesFromAnswers,
  residencyValuesInFy,
  setOccupation,
  spouseProblem,
  toggleTick,
  type AboutAnswers,
  type FyBounds,
  type MyTaxCheck,
} from "../lib/aboutYou";
import {
  ABN_KIND_CHOICES,
  ABOUT_Q,
  CARRY_INS_COPY,
  CONSENT_COPY,
  FACT_LABEL,
  PEOPLE_COPY,
  PROFILE_FACTS,
  RESIDENCY_CHOICES,
  STUDY_LOAN_LABEL,
  TICK_CHOICES,
  VALUE_LABEL,
  VISA_CHOICES,
} from "../content/aboutYou";
import { OCCUPATIONS, normaliseOccupation, occupationLabel } from "../content/occupations";
import {
  Chip,
  ChipGroup,
  FtButton,
  FtCard,
  FtInput,
  GeneralInfoNote,
  MyTaxAccessCheck,
  NewcomerCard,
  PeriodEditor,
  SetupIntro,
  SituationQuestion,
  StateEducationCard,
  StepFooter,
  StepHeader,
  TaxHelpCard,
  useWhyDrawer,
  type PeriodDraft,
} from "../components/ft";
import { CarryIns, PeopleList } from "../components/ProfileSections";
import { CONSENT_TEXT } from "./Onboarding";
import type { Situation, SituationPeriod } from "../types";

// Get set up — step 1 of 4 (spec §0 design review + A2, #585; flags ft_journey + situation_profile). It is
// About you plus #584's Before you start intro and the "Can you get into myTax?" self-check (myGov account ·
// ATO linked · myID Standard/Strong; the user's own ticks in ui_state, Quillo never sees myGov), the
// non-lodgment line and Tax Help. Two modes of one page:
//   • First run — the intro screen, the APP-8 consent screen (when not yet given), then ~6 questions in
//     myTax Personalise order, one per screen, then a summary. Answers are written ONLY on confirm, each POSTed with
//     fill_only (#438 carried over): a fact the person already has for those dates is skipped, never
//     overwritten, so re-entering is safe (re-running with the same answers writes zero rows).
//   • Profile — the same facts as editable cards with their dated periods (the only path that edits an
//     existing period), "People in this return", and "From last year's return" (carry-ins, #435).
// Every hook sits above the first conditional return (hooks lint gate; React #310 history).

const fmtDay = (iso: string | null) =>
  iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : null;
const span = (p: Pick<SituationPeriod, "starts_on" | "ends_on">) => `${fmtDay(p.starts_on) ?? "Any time before"} to ${fmtDay(p.ends_on) ?? "now"}`;

function valueLabel(fact: string, value: string | null, states: readonly { code: string; name: string }[]): string {
  if (value == null) return "Not answered";
  if (fact === "employment") return value === "none" ? "Not working yet" : occupationLabel(value);
  if (fact === "state") return states.find((s) => s.code === value)?.name ?? value;
  return VALUE_LABEL[fact]?.[value] ?? value;
}

export function AboutYou() {
  const { fy } = useActiveFy();
  const [params, setParams] = useSearchParams();
  const sit = useQuery({ queryKey: ["situation"], queryFn: () => api.situation() });
  const why = useWhyDrawer("setup");

  const data = sit.data;
  const self = data?.persons?.find((p) => p.role === "self") ?? data?.persons?.[0];
  const bounds = useMemo(() => fyBoundsFor(fy, data?.tax_period), [fy, data?.tax_period]);
  const periods = data?.profile_periods ?? [];
  // First run per FY: no answers recorded for this person in the year being prepared ⇒ ask (next year asks again).
  const firstRun = params.get("mode") === "questions" || !self || !hasAnswersForFy(periods, self.id, bounds);

  if (sit.isLoading || sit.isError || !data || !self) {
    return (
      <div className="space-y-6">
        <StepHeader
          step="setup"
          status={sit.isLoading ? "loading" : sit.isError ? "error" : "empty"}
          error={sit.error}
          onRetry={() => sit.refetch()}
          emptyTitle="Your profile isn't ready yet"
          emptyBody="Reload the page in a moment."
        />
      </div>
    );
  }
  return (
    <>
      {firstRun ? (
        <FirstRun
          key={`${self.id}:${fy}`}
          situation={data}
          personId={self.id}
          fy={fy}
          bounds={bounds}
          onWhy={() => why.openWhy()}
          onLeaveQuestions={params.get("mode") === "questions" ? () => setParams({}, { replace: true }) : undefined}
        />
      ) : (
        <Profile situation={data} fy={fy} bounds={bounds} onWhy={() => why.openWhy()} onAskAgain={() => setParams({ mode: "questions" })} />
      )}
      {why.drawer}
    </>
  );
}

// ── First run ────────────────────────────────────────────────────────────────────────────────────

function FirstRun({
  situation,
  personId,
  fy,
  bounds,
  onWhy,
  onLeaveQuestions,
}: {
  situation: Situation;
  personId: string;
  fy: number;
  bounds: FyBounds;
  onWhy: () => void;
  onLeaveQuestions?: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const usingBedrock = situation.profile?.inference_provider === "bedrock";
  const hasConsent = (situation.profile?.consent_xborder ?? 0) === 1 || usingBedrock;
  // Fixed at mount: once consent is recorded the screen stays (showing "recorded") so Back still works.
  const [screens] = useState(() => aboutScreens(!hasConsent));
  const [i, setI] = useState(0);
  const [a, setA] = useState<AboutAnswers>(() => answersFromPeriods(situation.profile_periods ?? [], personId, bounds));
  const [occText, setOccText] = useState(() => (a.occupation && a.occupation !== "none" ? occupationLabel(a.occupation) : ""));
  const [showFullConsent, setShowFullConsent] = useState(false);
  const edu = useEducation();
  const states = edu.data?.state_education?.states ?? [];

  const consent = useMutation({
    mutationFn: () => api.consent(CONSENT_TEXT),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["situation"] }),
  });

  const save = useMutation({
    mutationFn: async () => {
      let written = 0;
      // Residency is one answer stored as up to two periods: fill-gaps applies to it as a unit (fillPlan).
      for (const w of fillPlan(aboutYouWrites(a, personId, bounds), situation.profile_periods ?? [], personId, bounds)) {
        const r = await api.fillSituationPeriod(w.write, fy);
        if (r.skipped) continue;
        written++;
        // A newly written ABN activity gets its business income activity (so attribution has a target).
        // Only on a fresh write: a skipped answer never creates a second activity.
        if (w.linkBusinessActivity && !r.period.ref_id) {
          const label = ABN_KIND_CHOICES.find((k) => k.key === a.abnKind)?.label ?? "Side income";
          const act = await api.addIncomeActivity({ activity_type: "business", label });
          await api.updateSituationPeriod(r.period.id, { ref_id: act.id });
        }
      }
      return written;
    },
    onSuccess: () => {
      navigate(STEP_ROUTE.connect);
      qc.invalidateQueries({ queryKey: ["situation"] });
    },
  });

  const screen = screens[i]!;
  const problem =
    screen === "residency" ? (a.residency ? residencyProblem(a, bounds) : null) : screen === "spouse" ? spouseProblem(a, bounds) : null;
  const blocked = (screen === "consent" && !hasConsent) || problem != null;
  const back = () => (i > 0 ? setI(i - 1) : onLeaveQuestions ? onLeaveQuestions() : navigate("/"));
  const next = () => setI(Math.min(i + 1, screens.length - 1));
  const isLast = screen === "confirm";
  const questions: readonly string[] = screens.filter((s) => s !== "consent" && s !== "intro");
  const questionN = questions.indexOf(screen) + 1;
  const questionTotal = questions.length;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <StepHeader
        step="setup"
        intro={screen === "consent" || screen === "intro" ? undefined : `Question ${questionN} of ${questionTotal}, for ${fyLabel(fy)}. You can change any answer later.`}
      />

      {screen === "intro" && (
        <>
          <SetupIntro />
          <MyTaxCheckCard situation={situation} />
          <TaxHelpCard />
        </>
      )}

      {screen === "consent" && (
        <SituationQuestion title={CONSENT_COPY.title}>
          {usingBedrock ? (
            <p className="text-sm text-muted">{CONSENT_COPY.bedrock}</p>
          ) : hasConsent ? (
            <p className="text-sm text-ok">{CONSENT_COPY.done}</p>
          ) : (
            <div className="space-y-3">
              <p className="max-w-[65ch] text-sm leading-relaxed text-ink">{CONSENT_COPY.body}</p>
              <FtButton variant="ghost" className="text-sm" onClick={() => setShowFullConsent((v) => !v)} aria-expanded={showFullConsent}>
                {showFullConsent ? "Hide the full wording" : "Read the full wording"}
              </FtButton>
              {showFullConsent && <p className="rounded-lg bg-surface p-3 text-xs text-muted">{CONSENT_TEXT}</p>}
              <div>
                <FtButton variant="primary" busy={consent.isPending} onClick={() => consent.mutate()}>
                  I consent
                </FtButton>
              </div>
              {consent.isError && (
                <p role="alert" className="text-sm text-danger">
                  Couldn't record that: {(consent.error as Error).message}
                </p>
              )}
            </div>
          )}
        </SituationQuestion>
      )}

      {screen === "residency" && (
        <>
          <SituationQuestion
            title={ABOUT_Q.residency.title}
            help={ABOUT_Q.residency.help}
            options={RESIDENCY_CHOICES}
            value={a.residency}
            onChange={(k) => setA({ ...a, residency: k })}
            problem={problem}
          >
            {a.residency === "part_year" && (
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <Chip selected={a.partYear.direction === "arrived"} onToggle={() => setA({ ...a, partYear: { ...a.partYear, direction: "arrived" } })}>
                    I arrived during the year
                  </Chip>
                  <Chip selected={a.partYear.direction === "left"} onToggle={() => setA({ ...a, partYear: { ...a.partYear, direction: "left" } })}>
                    I left during the year
                  </Chip>
                </div>
                <label className="block space-y-1 text-sm">
                  <span className="font-medium text-ink">{a.partYear.direction === "arrived" ? "Date you arrived" : "Date you left"}</span>
                  <FtInput type="date" min={bounds.start} max={bounds.end} value={a.partYear.date} onChange={(e) => setA({ ...a, partYear: { ...a.partYear, date: e.target.value } })} />
                </label>
              </div>
            )}
            {a.residency === "not_resident" && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-ink">Which is closest to your visa?</p>
                <div className="flex flex-wrap gap-2">
                  {VISA_CHOICES.map((v) => (
                    <Chip key={v.key} selected={a.visa === v.key} onToggle={() => setA({ ...a, visa: v.key })}>
                      {v.label}
                    </Chip>
                  ))}
                </div>
              </div>
            )}
          </SituationQuestion>
          <NewcomerCard residency={residencyValuesFromAnswers(a, bounds)} />
        </>
      )}

      {screen === "spouse" && (
        <SituationQuestion
          title={ABOUT_Q.spouse.title}
          help={ABOUT_Q.spouse.help}
          options={[
            { key: "yes" as const, label: "Yes" },
            { key: "no" as const, label: "No" },
          ]}
          value={a.spouse}
          onChange={(k) => setA({ ...a, spouse: k })}
          problem={problem}
        >
          {a.spouse === "yes" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1 text-sm">
                <span className="font-medium text-ink">From (optional)</span>
                <FtInput type="date" className="w-full" value={a.spouseFrom} onChange={(e) => setA({ ...a, spouseFrom: e.target.value })} />
              </label>
              <label className="block space-y-1 text-sm">
                <span className="font-medium text-ink">To (optional)</span>
                <FtInput type="date" className="w-full" value={a.spouseTo} onChange={(e) => setA({ ...a, spouseTo: e.target.value })} />
              </label>
              <p className="text-xs text-muted sm:col-span-2">Leave the dates empty if it was the whole year.</p>
            </div>
          )}
        </SituationQuestion>
      )}

      {screen === "state" && (
        <>
          <SituationQuestion
            title={ABOUT_Q.state.title}
            help={ABOUT_Q.state.help}
            options={states.map((s) => ({ key: s.code, label: s.name }))}
            value={a.state}
            onChange={(k) => setA({ ...a, state: k })}
            status={edu.isLoading && edu.fetchStatus !== "idle" ? "loading" : edu.isError ? "error" : states.length ? "ready" : "empty"}
            error={edu.error}
            onRetry={() => edu.refetch()}
            emptyTitle="No states to show right now"
            emptyBody="You can skip this one and add it later from your profile."
          />
          <StateEducationCard stateCode={a.state || null} />
        </>
      )}

      {screen === "occupation" && (
        <SituationQuestion title={ABOUT_Q.occupation.title} help={ABOUT_Q.occupation.help}>
          <div className="space-y-3">
            <label className="block space-y-1 text-sm" htmlFor="about-occupation">
              <span className="font-medium text-ink">Occupation</span>
              <FtInput
                id="about-occupation"
                className="w-full"
                list="about-occupations"
                placeholder="Start typing, e.g. Retail worker"
                value={occText}
                onChange={(e) => {
                  setOccText(e.target.value);
                  setA(setOccupation(a, occupationToken(e.target.value, normaliseOccupation)));
                }}
              />
              <datalist id="about-occupations">
                {OCCUPATIONS.map((o) => (
                  <option key={o.token} value={o.label} />
                ))}
              </datalist>
            </label>
            <Chip
              selected={a.occupation === "none"}
              onToggle={() => {
                setOccText("");
                setA(setOccupation(a, a.occupation === "none" ? "" : "none"));
              }}
            >
              Not working yet
            </Chip>
          </div>
        </SituationQuestion>
      )}

      {screen === "ticks" && (
        <SituationQuestion title={ABOUT_Q.ticks.title} help={ABOUT_Q.ticks.help}>
          <div className="space-y-4">
            <ChipGroup
              label={<span className="sr-only">What applies</span>}
              options={TICK_CHOICES}
              selected={a.ticks}
              onToggle={(k) => {
                if (k === "job") setOccText((t) => (a.ticks.includes("job") ? "" : t));
                setA(toggleTick(a, k));
              }}
            />
            {a.ticks.includes("job") && !a.occupation && (
              <p className="text-sm text-muted">
                Add your occupation on the previous question so Quillo can point you to the right ATO guide.
              </p>
            )}
            {a.ticks.includes("study") && (
              <Chip selected={a.ticks.includes("study_loan")} onToggle={() => setA(toggleTick(a, "study_loan"))}>
                {STUDY_LOAN_LABEL}
              </Chip>
            )}
            {a.ticks.includes("abn") && (
              <ChipGroup
                label={<span className="text-sm font-medium">What kind of side income?</span>}
                options={ABN_KIND_CHOICES}
                selected={[a.abnKind]}
                onToggle={(k) => setA({ ...a, abnKind: k })}
              />
            )}
          </div>
        </SituationQuestion>
      )}

      {screen === "confirm" && <ConfirmSummary a={a} states={states} fy={fy} />}

      <StepFooter
        onBack={back}
        onWhy={onWhy}
        primary={
          isLast
            ? { label: `Save and ${STEP_LABEL.connect.toLowerCase()}`, onClick: () => save.mutate(), busy: save.isPending }
            : { label: "Next", onClick: next, disabled: blocked }
        }
        status={save.isError ? "error" : "ready"}
        error={save.error}
        onRetry={() => save.mutate()}
      />
    </div>
  );
}

function ConfirmSummary({ a, states, fy }: { a: AboutAnswers; states: readonly { code: string; name: string }[]; fy: number }) {
  const residency =
    a.residency === "part_year"
      ? `${a.partYear.direction === "arrived" ? "Arrived" : "Left"} on ${fmtDay(a.partYear.date) ?? "?"}`
      : a.residency === "not_resident"
        ? `Not a resident (${VISA_CHOICES.find((v) => v.key === a.visa)?.label ?? "visa not chosen"})`
        : RESIDENCY_CHOICES.find((r) => r.key === a.residency)?.label;
  const spouse = a.spouse === "yes" ? `Yes${a.spouseFrom || a.spouseTo ? ` (${fmtDay(a.spouseFrom || null) ?? "start of year"} to ${fmtDay(a.spouseTo || null) ?? "end of year"})` : ""}` : a.spouse === "no" ? "No" : undefined;
  const ticks = TICK_CHOICES.filter((t) => a.ticks.includes(t.key)).map((t) => (t.key === "abn" ? `${t.label}: ${ABN_KIND_CHOICES.find((k) => k.key === a.abnKind)?.label}` : t.label));
  if (a.ticks.includes("study") && a.ticks.includes("study_loan")) ticks.push(STUDY_LOAN_LABEL);
  const rows: [string, string | undefined][] = [
    ["Residency for tax", residency],
    ["Spouse", spouse],
    ["State or territory", states.find((s) => s.code === a.state)?.name ?? (a.state || undefined)],
    ["Main job", a.occupation === "none" ? "Not working yet" : a.occupation ? occupationLabel(a.occupation) : undefined],
    ["What applies", ticks.length ? ticks.join(", ") : undefined],
  ];
  return (
    <SituationQuestion title={ABOUT_Q.confirm.title} help={ABOUT_Q.confirm.help}>
      <dl className="divide-y divide-line">
        {rows.map(([k, v]) => (
          <div key={k} className="flex flex-wrap justify-between gap-2 py-2.5 text-sm">
            <dt className="text-muted">{k}</dt>
            <dd className="font-medium text-ink">{v ?? "Not answered"}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted">These answers are for {fyLabel(fy)}. Next, connect your bank.</p>
    </SituationQuestion>
  );
}

// ── The "Can you get into myTax?" self-check ────────────────────────────────────────────────────────

/**
 * The user's own ticks, stored as a UI flag in profiles.ui_state.mytax_check (never credentials). Shown
 * optimistically; a failed save rolls back to the stored value and says so.
 */
function MyTaxCheckCard({ situation }: { situation: Situation }) {
  const qc = useQueryClient();
  const stored = parseMyTaxCheck(situation.profile?.ui_state);
  const [local, setLocal] = useState<MyTaxCheck | null>(null);
  const save = useMutation({
    mutationFn: (next: MyTaxCheck) => api.setUiState({ mytax_check: next }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["situation"] }),
    onError: () => setLocal(null),
  });
  return (
    <div className="space-y-2">
      <MyTaxAccessCheck
        value={local ?? stored}
        saving={save.isPending}
        onChange={(next) => {
          setLocal(next);
          save.mutate(next);
        }}
      />
      {save.isError && (
        <p role="alert" className="text-sm text-danger">
          Couldn't save that tick: {(save.error as Error).message}
        </p>
      )}
    </div>
  );
}

// ── Profile ──────────────────────────────────────────────────────────────────────────────────────

function Profile({ situation, fy, bounds, onWhy, onAskAgain }: { situation: Situation; fy: number; bounds: FyBounds; onWhy: () => void; onAskAgain: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const persons = situation.persons ?? [];
  const self = persons.find((p) => p.role === "self") ?? persons[0];
  const [personId, setPersonId] = useState<string>(self?.id ?? "");
  const person = persons.find((p) => p.id === personId) ?? self;
  const periods = (situation.profile_periods ?? []).filter((p) => p.subject_kind === "person" && p.subject_id === person?.id);
  const edu = useEducation();
  const states = edu.data?.state_education?.states ?? [];
  const stateNow = periods.filter((p) => p.fact === "state" && (p.starts_on ?? "") <= bounds.end && (p.ends_on ?? "9999") >= bounds.start).at(-1)?.value ?? null;
  const invalidate = () => qc.invalidateQueries({ queryKey: ["situation"] });

  return (
    <div className="space-y-6">
      <StepHeader
        step="setup"
        intro={`Your answers for ${fyLabel(fy)}, each with the dates it applies. Edit anything that's changed.`}
        right={
          person?.id === self?.id ? (
            <FtButton variant="secondary" onClick={onAskAgain}>
              Go through the questions
            </FtButton>
          ) : undefined
        }
      />

      <MyTaxCheckCard situation={situation} />

      {persons.length > 1 && (
        <div className="flex flex-wrap gap-2" aria-label="Whose answers">
          {persons.map((p) => (
            <Chip key={p.id} selected={p.id === person?.id} onToggle={() => setPersonId(p.id)}>
              {p.display_name || (p.role === "self" ? "You" : p.role)}
            </Chip>
          ))}
        </div>
      )}

      {person && (
        <div className="space-y-4">
          {PROFILE_FACTS.map((fact) => (
            <div key={`${person.id}:${fact}`} className="space-y-3">
              <FactCard fact={fact} periods={periods.filter((p) => p.fact === fact)} personId={person.id} fy={fy} states={states} onChanged={invalidate} />
              {fact === "residency" && <NewcomerCard residency={residencyValuesInFy(periods, person.id, bounds)} />}
              {fact === "state" && <StateEducationCard stateCode={stateNow} />}
            </div>
          ))}
        </div>
      )}

      <section className="space-y-3">
        <h2 className="text-[19px] font-semibold text-ink">{PEOPLE_COPY.title}</h2>
        <p className="max-w-[65ch] text-sm text-muted">{PEOPLE_COPY.intro}</p>
        <FtCard className="space-y-2 p-4">
          <PeopleList persons={persons} onDone={invalidate} />
        </FtCard>
      </section>

      <LastYear />

      <SetupIntro compact />
      <TaxHelpCard />

      <GeneralInfoNote />
      <StepFooter
        onBack={() => navigate("/")}
        onWhy={onWhy}
        primary={{ label: `Next: ${STEP_LABEL.connect}`, onClick: () => navigate(STEP_ROUTE.connect) }}
      />
    </div>
  );
}

function FactCard({
  fact,
  periods,
  personId,
  fy,
  states,
  onChanged,
}: {
  fact: string;
  periods: SituationPeriod[];
  personId: string;
  fy: number;
  states: readonly { code: string; name: string }[];
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null); // period id, or "new"
  const rows = [...periods].sort((x, y) => ((x.starts_on ?? "") < (y.starts_on ?? "") ? -1 : 1));
  const options =
    fact === "employment"
      ? undefined
      : fact === "state"
        ? states.map((s) => ({ value: s.code, label: s.name }))
        : Object.entries(VALUE_LABEL[fact] ?? {}).map(([value, label]) => ({ value, label }));
  const suggestions = fact === "employment" ? [{ value: "none", label: "Not working yet" }, ...OCCUPATIONS.map((o) => ({ value: o.token, label: o.label }))] : undefined;
  const toValue = (v: string) => (fact === "employment" ? (v.trim().toLowerCase() === "not working yet" ? "none" : occupationToken(v, normaliseOccupation)) : v);
  const toDraft = (p?: SituationPeriod): PeriodDraft => ({
    value: p ? (fact === "employment" ? valueLabel(fact, p.value, states) : (p.value ?? "")) : "",
    starts_on: p?.starts_on ?? "",
    ends_on: p?.ends_on ?? "",
  });
  const done = () => {
    setEditing(null);
    onChanged();
  };

  return (
    <FtCard className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[15px] font-semibold text-ink">{FACT_LABEL[fact] ?? fact}</h3>
        {editing !== "new" && (
          <FtButton variant="ghost" className="text-sm" onClick={() => setEditing("new")}>
            Add
          </FtButton>
        )}
      </div>
      {rows.length === 0 && editing !== "new" && <p className="text-sm text-muted">Not answered yet.</p>}
      <ul className="space-y-2">
        {rows.map((p) =>
          editing === p.id ? (
            <li key={p.id}>
              <PeriodEditor
                label={FACT_LABEL[fact] ?? fact}
                initial={toDraft(p)}
                options={options}
                suggestions={suggestions}
                onCancel={() => setEditing(null)}
                onSave={async (d) => {
                  await api.updateSituationPeriod(p.id, { value: toValue(d.value), starts_on: d.starts_on || null, ends_on: d.ends_on || null });
                  done();
                }}
                onDelete={async () => {
                  await api.deleteSituationPeriod(p.id);
                  done();
                }}
              />
            </li>
          ) : (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface px-3 py-2 text-sm">
              <span>
                <span className="font-medium text-ink">{valueLabel(fact, p.value, states)}</span>
                <span className="text-muted"> · {span(p)}</span>
              </span>
              <FtButton variant="ghost" className="text-sm" onClick={() => setEditing(p.id)} aria-label={`Edit ${FACT_LABEL[fact] ?? fact}: ${valueLabel(fact, p.value, states)}`}>
                Edit
              </FtButton>
            </li>
          ),
        )}
      </ul>
      {editing === "new" && (
        <PeriodEditor
          label={FACT_LABEL[fact] ?? fact}
          initial={toDraft()}
          options={options}
          suggestions={suggestions}
          onCancel={() => setEditing(null)}
          onSave={async (d) => {
            // No dates ⇒ the server spans the year being prepared (so next year asks again).
            await api.addSituationPeriod({ person_id: personId, fact, value: toValue(d.value), starts_on: d.starts_on || null, ends_on: d.ends_on || null, source: "user" }, fy);
            done();
          }}
        />
      )}
    </FtCard>
  );
}

/** "From last year's return" (#435): the prior-year carry-ins, collapsed unless there's last-year data. */
function LastYear() {
  const { has } = useFeatures();
  const losses = useQuery({ queryKey: ["capital-losses"], queryFn: () => api.capitalLosses() });
  const openings = useQuery({ queryKey: ["opening-depreciation"], queryFn: () => api.openingDepreciation() });
  const noa = useQuery({ queryKey: ["noa", "all"], queryFn: () => api.noaCarryovers(), enabled: has("noa_capture") });
  const auto = (losses.data?.length ?? 0) > 0 || (openings.data?.length ?? 0) > 0 || (noa.data ?? []).some((c) => c.status === "confirmed");
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? auto;
  return (
    <section className="space-y-3">
      <FtButton variant="ghost" className="-ml-4 text-[19px]" aria-expanded={expanded} aria-controls="about-last-year" onClick={() => setOpen(!expanded)}>
        <span aria-hidden>{expanded ? "▾" : "▸"}</span> {CARRY_INS_COPY.title}
      </FtButton>
      {expanded && (
        <div id="about-last-year" className="space-y-3">
          <p className="max-w-[65ch] text-sm text-muted">{CARRY_INS_COPY.intro}</p>
          <FtCard className="p-4">
            <CarryIns />
          </FtCard>
        </div>
      )}
    </section>
  );
}
