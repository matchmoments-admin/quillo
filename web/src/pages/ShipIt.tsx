import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, saveBlob } from "../api";
import { useActiveFy, useLodgedMark, localIsoDay, fyLabel } from "../lib/activeFy";
import { useFeatures } from "../lib/features";
import { useJourney } from "../lib/journey";
import { useWorksheetTicks } from "../lib/useWorksheetTicks";
import { isTickable, tickId, tickProgress } from "../lib/worksheetTicks";
import { Badge, EmptyState, ErrorState, FtButton, FtCard, FtCheckbox, FtLink, GeneralInfoNote, Skeleton, WorksheetLine } from "../components/ft";
import { NoaCloseOff } from "./Filing";
import { INPUT_CLASS } from "../components/ui";
import type { MytaxWorksheet, MytaxWorksheetLine, MytaxWorksheetSection } from "../types";

// Lodge in myTax — the last step of the first-timer journey (spec §0 design review + A9 ticket b, #590; flag
// ft_journey). Replaces the legacy Filing page when the flag is ON (/filing redirects here via lib/legacyRoutes.ts):
//   • a "Tax ready" gate (docs/first-timer/ato-lodgement-process.md §b rows 4, 8): self-attest ticks that the
//     user can get into myTax and that each income statement says Tax ready — never a hard block (row 10);
//   • the myTax worksheet (GET /api/mytax-worksheet, #575 — needs mytax_worksheet too) in myTax's own order:
//     Contact and bank details → Personalise (what to tick) → Income → Deductions → Losses/offsets/adjustments →
//     Medicare and PHI → Spouse and income tests. Every line leads with the myTax banner name (the paper item
//     number second), then the figure, Copy, See records, and a tick persisted per FY in ui_state.
//   • a print / save-as-PDF view at /ship/print (browser print; no server PDF);
//   • Filing folded in: the readiness summary (from the shell's /api/journey read, so no extra request) links
//     to Check, the soft sign-off becomes "I've lodged in myTax" (/api/lodged, #572 — needs situation_profile),
//     and the notice-of-assessment capture moves to the After you lodge panel;
//   • Reports stays at /reports as the detail view ("See the full breakdown"), with the accountant schedule.
// Quillo never lodges and never shows a refund, tax payable, rate or levy figure. Every hook sits above the
// first conditional return (hooks lint gate; React #310 history).

const SECTION_HINT: Record<string, string> = {
  contact_bank: "myTax shows these first, filled in from what the ATO holds. Check each one, then tick it.",
  personalise: "Personalise return is the first thing myTax asks. Answer these and tick the items listed, so myTax shows the right sections.",
  income_check: "myTax fills these in from your employers, banks and Services Australia. Don't rely on prefill alone: tick each one when myTax shows the same figure.",
  income_type_in: "myTax doesn't know about these. Type each figure in, then tick it.",
  rental: "Type these into the rental schedule for each property, then tick them.",
  business: "In myTax these sit under Income, in the business and professional items schedule. Type them in, then tick them.",
  deductions: "One line per deduction label. Type each figure in, then tick it.",
  adjustments: "myTax asks these when your situation needs them. Answer each one, then tick it.",
  medicare: "myTax asks these questions. There's nothing to type from Quillo; tick each once you've answered it.",
  spouse_income_tests: "The last part of Prepare return. Tick each once you've answered it.",
};

function tickLabel(line: MytaxWorksheetLine): string {
  if (line.kind === "check") return "Matches myTax";
  if (line.key.startsWith("tick:")) return "Ticked in myTax";
  if (line.kind === "answer") return "Answered in myTax";
  return "Done in myTax";
}

// ATO pages (ato-lodgement-process.md sources) — linked, never paraphrased into a verdict.
const ATO_LINK_MYGOV =
  "https://www.ato.gov.au/online-services/online-services-for-individuals-and-sole-traders/ato-online-services-and-mygov/create-a-mygov-account-and-link-it-to-the-ato";
const ATO_AMEND = "https://www.ato.gov.au/individuals-and-families/your-tax-return/amend-your-tax-return/how-to-request-an-amendment-to-your-tax-return";

/** The Tax-ready gate's own tick section (stored beside the worksheet ticks; never counted as a worksheet line). */
const GATE = "gate";

export function ShipIt() {
  const { fy, label, setFy } = useActiveFy();
  const { has } = useFeatures();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const worksheetOn = has("mytax_worksheet");
  const lodgedOn = has("situation_profile");
  const noaOn = has("noa_capture");

  const journey = useJourney();
  const ws = useQuery({ queryKey: ["mytax-worksheet", fy], queryFn: () => api.mytaxWorksheet(fy), enabled: worksheetOn });
  const ticks = useWorksheetTicks(fy);
  const lodgedNow = useQuery({ queryKey: ["fy-lodged", fy], queryFn: () => api.fyLodged(fy).then((r) => r.lodged), enabled: lodgedOn });
  const lodgedPrev = useQuery({ queryKey: ["fy-lodged", fy - 1], queryFn: () => api.fyLodged(fy - 1).then((r) => r.lodged), enabled: lodgedOn });
  const noa = useQuery({ queryKey: ["noa"], queryFn: () => api.noaCarryovers(), enabled: noaOn });
  const sit = useQuery({ queryKey: ["situation"], queryFn: () => api.situation() });
  const [csvBusy, setCsvBusy] = useState(false);

  const lodgedAt = lodgedOn ? lodgedNow.data?.lodged_at ?? null : null;
  const prevLodgedAt = lodgedOn ? lodgedPrev.data?.lodged_at ?? null : null;
  const startedNext = (() => {
    try {
      const v = (JSON.parse(sit.data?.profile?.ui_state ?? "{}") as { next_year_started?: unknown }).next_year_started;
      return typeof v === "number" ? v : null;
    } catch {
      return null;
    }
  })();
  const noaConfirmedFor = (y: number) => (noa.data ?? []).some((c) => c.source_fy === y && c.status === "confirmed");
  // The After you lodge panel: the year on screen when it's lodged; otherwise last year, right after it was
  // marked (the app has moved on to this year), until its notice of assessment is in or next year is started.
  const afterFy = lodgedAt ? fy : prevLodgedAt && startedNext !== fy - 1 && !noaConfirmedFor(fy - 1) ? fy - 1 : null;
  const afterLodgedAt = afterFy === fy ? lodgedAt : prevLodgedAt;

  const downloadCsv = async () => {
    setCsvBusy(true);
    try {
      const { blob, filename } = await api.reportCsv(fy);
      saveBlob(blob, filename);
    } catch (e) {
      toast.error("Couldn't prepare the schedule", { description: e instanceof Error ? e.message : undefined });
    } finally {
      setCsvBusy(false);
    }
  };

  const readiness = journey.data?.readiness;
  const progress = ws.data ? tickProgress(ws.data.sections, ticks.ticks, fy) : null;
  // After the self-lodger date, on the user's LOCAL day (never the server's UTC day).
  const pastDue = !!ws.data?.header.self_lodge_due_on && localIsoDay() > ws.data.header.self_lodge_due_on;
  // Each employer on the worksheet (a salary check line, statement in or not) gets its own "Tax ready?" tick.
  const employers = (ws.data?.sections.find((x) => x.key === "income_check")?.lines ?? [])
    .filter((l) => l.key === "salary" || l.key.startsWith("salary:"))
    .map((l) => ({ key: l.key, name: l.name.includes(" — ") ? l.name.slice(l.name.lastIndexOf(" — ") + 3) : "your employer" }));
  const hasBusiness = !!ws.data?.sections.some((x) => x.key === "business");

  return (
    <div className="space-y-6">
      {afterFy != null && afterLodgedAt && (
        <AfterYouLodge
          fy={afterFy}
          lodgedAt={afterLodgedAt}
          noaOn={noaOn}
          header={ws.data?.header}
          hasBusiness={hasBusiness}
          onStartNext={() => {
            // Remembered in ui_state so this panel stops showing on next year's Ship it page.
            api.setUiState({ next_year_started: afterFy }).then(() => qc.invalidateQueries({ queryKey: ["situation"] }), () => {});
            if (afterFy === fy) setFy(fy + 1);
            navigate("/connect");
          }}
        />
      )}

      <FtCard className="space-y-2 p-5">
        <p className="text-sm leading-relaxed text-ink">
          {ws.data?.header.intro ?? "Wait until your income statement says Tax ready in myGov before you lodge. You lodge in myTax; Quillo helps you get ready, and this isn't tax advice."}
        </p>
        {pastDue && ws.data && (
          <p className="rounded-lg border border-line bg-surface p-3 text-sm text-ink">
            {ws.data.header.after_due_note}{" "}
            <FtLink href="https://www.ato.gov.au/individuals-and-families/paying-the-ato/interest-and-penalties/penalties/failure-to-lodge-on-time-penalty" className="text-sm">
              What the ATO says
            </FtLink>
          </p>
        )}
        {ws.data?.header.early_lodge_note && <p className="text-sm text-ink">{ws.data.header.early_lodge_note}</p>}
        <ReadinessSummary loading={journey.isLoading} blockers={readiness?.blockers ?? 0} review={readiness?.review ?? 0} known={!!readiness} />
      </FtCard>

      {!lodgedAt && <TaxReadyGate employers={employers} ticks={ticks} known={!worksheetOn || !!ws.data} />}

      {!worksheetOn ? (
        <EmptyState
          title="The myTax worksheet isn't switched on yet"
          body="Your figures are still in the full breakdown below, and you can mark the year as lodged once you've lodged in myTax."
        />
      ) : ws.isLoading ? (
        <FtCard className="space-y-3 p-5">
          <Skeleton lines={4} />
        </FtCard>
      ) : ws.error ? (
        <ErrorState what="your myTax worksheet" error={ws.error} onRetry={() => ws.refetch()} />
      ) : ws.data ? (
        <Worksheet ws={ws.data} ticks={ticks} progress={progress} />
      ) : null}

      <FtCard className="space-y-3 p-5">
        <h2 className="font-display text-xl tracking-wide text-forest">The full breakdown</h2>
        <p className="text-sm text-muted">
          Every figure behind this worksheet, line by line, is in Reports.{" "}
          {ws.data && !pastDue ? ws.data.header.agent_note : "Prefer a registered tax agent? Take this pack to any registered agent."}
        </p>
        <div className="flex flex-wrap gap-2">
          <FtLink to="/reports" variant="secondary">
            See the full breakdown
          </FtLink>
          <FtButton variant="ghost" onClick={downloadCsv} busy={csvBusy}>
            {csvBusy ? "Preparing…" : "Download the accountant schedule (CSV)"}
          </FtButton>
        </div>
      </FtCard>

      {!lodgedOn && <SoftSignoff fy={fy} label={label} />}
      {lodgedOn && !lodgedAt && <MarkLodged fy={fy} label={label} progress={progress} processingHint={ws.data?.header.processing_hint} />}

      <GeneralInfoNote />
      {ws.data && <p className="max-w-[65ch] text-xs leading-relaxed text-muted">{ws.data.disclaimer}</p>}
    </div>
  );
}

function ReadinessSummary({ loading, known, blockers, review }: { loading: boolean; known: boolean; blockers: number; review: number }) {
  if (loading) return <Skeleton className="w-1/2" />;
  if (!known) return null;
  if (blockers > 0)
    return (
      <p className="text-sm text-ink">
        <span className="font-semibold text-warn">{blockers === 1 ? "1 thing" : `${blockers} things`} to sort out in Review</span> before you copy these
        figures into myTax.{" "}
        <FtLink to="/review" className="text-sm">
          Go to Review
        </FtLink>
      </p>
    );
  if (review > 0)
    return (
      <p className="text-sm text-ink">
        {review === 1 ? "1 thing is" : `${review} things are`} worth a look in Review first.{" "}
        <FtLink to="/review" className="text-sm">
          Go to Review
        </FtLink>
      </p>
    );
  return <p className="text-sm text-muted">Nothing flagged in Review. That's not a clearance: if you're unsure, confirm with a registered tax agent.</p>;
}

function Worksheet({
  ws,
  ticks,
  progress,
}: {
  ws: MytaxWorksheet;
  ticks: ReturnType<typeof useWorksheetTicks>;
  progress: { done: number; total: number } | null;
}) {
  if (!ws.sections.length) {
    return (
      <EmptyState
        title="Nothing to put in myTax yet"
        body="Connect your bank or add your income and expenses first. Your worksheet builds itself from what you confirm."
        action={
          <FtLink to="/connect" variant="primary">
            Connect your money
          </FtLink>
        }
      />
    );
  }
  return (
    <div className="space-y-5">
      {!ws.tie_back.ok && (
        <div role="alert" className="rounded-2xl border border-warn/40 bg-warn/10 p-4 text-sm text-ink">
          <p className="font-semibold text-warn">These lines don't add up to your full breakdown yet</p>
          <p className="mt-1">
            Something in your records is counted in Reports but doesn't land on a worksheet line (or the other way round). Don't copy these figures
            into myTax until it's sorted: compare with the full breakdown, or take it to a registered tax agent.
          </p>
        </div>
      )}
      {ws.unlabelled.n > 0 && (
        <div className="rounded-2xl border border-line bg-surface p-4 text-sm text-ink">
          <p>
            {ws.unlabelled.n === 1 ? "1 work expense needs" : `${ws.unlabelled.n} work expenses need`} a deduction label before it can go on a line here.{" "}
            <FtLink to="/review" className="text-sm">
              Confirm the label in Review
            </FtLink>
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        {progress && progress.total > 0 && (
          <p className="text-sm text-muted" aria-live="polite">
            <span className="font-semibold text-ink tnum">
              {progress.done} of {progress.total}
            </span>{" "}
            done in myTax
          </p>
        )}
        <FtLink to="/lodge/print" variant="secondary">
          Print or save as PDF
        </FtLink>
      </div>

      {ws.sections.map((s) => (
        <WorksheetSectionCard key={s.key} section={s} ticks={ticks} />
      ))}
    </div>
  );
}

function WorksheetSectionCard({ section, ticks }: { section: MytaxWorksheetSection; ticks: ReturnType<typeof useWorksheetTicks> }) {
  return (
    <FtCard className="p-5">
      <h2 className="font-display text-xl tracking-wide text-forest">{section.title}</h2>
      {SECTION_HINT[section.key] && <p className="mt-1 max-w-[65ch] text-sm text-muted">{SECTION_HINT[section.key]}</p>}
      <div className="mt-3">
        {section.lines.map((l) => {
          const id = tickId(section.key, l.key);
          const state = ticks.stateOf(id, l.amount_cents);
          const figure =
            l.kind === "answer" ? (
              <Badge tone="info">You'll be asked this</Badge>
            ) : l.kind === "note" ? (
              <span className="text-sm text-muted">Nothing to enter</span>
            ) : l.amount_cents == null ? (
              <Badge tone="warn">Not entered</Badge>
            ) : undefined;
          return (
            <WorksheetLine
              key={id}
              code={l.label || undefined}
              codeAfter
              label={l.name}
              amountCents={l.amount_cents}
              note={l.note}
              figure={figure}
              record={l.record_href ? { to: l.record_href, label: "See records" } : undefined}
              tick={
                isTickable(l) && ticks.ready
                  ? { checked: state === "ticked", stale: state === "stale", label: `${tickLabel(l)}: ${l.label} ${l.name}`, onToggle: () => ticks.toggle(id, l.amount_cents) }
                  : undefined
              }
            />
          );
        })}
      </div>
    </FtCard>
  );
}

function MarkLodged({ fy, label, progress, processingHint }: { fy: number; label: string; progress: { done: number; total: number } | null; processingHint?: string }) {
  const lodged = useLodgedMark();
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState(localIsoDay());
  const mark = useMutation({
    mutationFn: () => lodged.mark(fy, day),
    onSuccess: () => {
      setOpen(false);
      toast.success(`FY ${label} marked as lodged`, { description: "You've moved on to next year. Add your notice of assessment when it arrives in your myGov Inbox." });
    },
  });
  const left = progress && progress.total > progress.done ? progress.total - progress.done : 0;
  return (
    <FtCard className="space-y-3 p-5">
      <h2 className="font-display text-xl tracking-wide text-forest">Lodged in myTax?</h2>
      <p className="max-w-[65ch] text-sm text-muted">
        When you tick myTax's declaration, you're confirming every figure, including the prefilled ones, is right and that you hold the records. Then
        select Lodge.
      </p>
      <p className="max-w-[65ch] text-sm text-muted">
        Once you've lodged FY {label} in myTax, mark it here. The ATO emails you a receipt, most myTax returns are processed in{" "}
        {processingHint ?? "about 12 business days"}, and your notice of assessment arrives in your myGov Inbox. Marking it is your own record:
        Quillo doesn't lodge.
      </p>
      {!open ? (
        <FtButton variant="primary" onClick={() => setOpen(true)}>
          I've lodged in myTax
        </FtButton>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            mark.mutate();
          }}
        >
          {left > 0 && (
            <p className="text-sm text-warn">
              {left === 1 ? "1 line isn't" : `${left} lines aren't`} ticked yet. You can still mark it as lodged.
            </p>
          )}
          <label className="block text-sm font-semibold text-ink">
            The day you lodged
            <input
              type="date"
              value={day}
              max={localIsoDay()}
              required
              onChange={(e) => setDay(e.target.value)}
              className={`mt-1 block min-h-[44px] font-normal ${INPUT_CLASS}`}
            />
          </label>
          {mark.error && (
            <p role="alert" className="text-sm text-danger">
              {(mark.error as Error).message}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <FtButton variant="primary" type="submit" busy={mark.isPending}>
              {mark.isPending ? "Saving…" : "Confirm: I've lodged"}
            </FtButton>
            <FtButton variant="ghost" onClick={() => setOpen(false)} disabled={mark.isPending}>
              Cancel
            </FtButton>
          </div>
        </form>
      )}
    </FtCard>
  );
}

function AfterYouLodge({
  fy,
  lodgedAt,
  noaOn,
  header,
  hasBusiness,
  onStartNext,
}: {
  fy: number;
  lodgedAt: string;
  noaOn: boolean;
  header?: MytaxWorksheet["header"];
  hasBusiness: boolean;
  onStartNext: () => void;
}) {
  const lodged = useLodgedMark();
  const undo = useMutation({
    mutationFn: () => lodged.undo(fy),
    onError: (e) => toast.error("Couldn't undo the lodged mark", { description: (e as Error).message }),
  });
  const when = new Date(`${lodgedAt}T00:00:00`);
  return (
    <FtCard className="space-y-4 border-safe/40 p-5">
      <div>
        <h2 className="font-display text-xl tracking-wide text-forest">After you lodge: FY {fyLabel(fy)}</h2>
        <p className="mt-1 text-sm text-muted">
          You marked FY {fyLabel(fy)} as lodged on {isNaN(when.getTime()) ? lodgedAt : when.toLocaleDateString()}. Your own record: Quillo doesn't
          lodge.
        </p>
      </div>
      <div>
        <h3 className="text-sm font-semibold text-ink">What happens next</h3>
        <ul className="mt-1 max-w-[65ch] list-disc space-y-1 pl-5 text-sm text-muted">
          <li>The ATO emails you a lodgment receipt.</li>
          <li>Most myTax returns are processed in {header?.processing_hint ?? "about 12 business days"}. You can follow it in myTax under Manage tax returns.</li>
          <li>
            Your notice of assessment arrives in your myGov Inbox. If a statement of account comes with it, the amount paid can differ from the
            assessment, for example when it's offset against a debt. Anything to pay is due on the date shown on the notice.
          </li>
          {hasBusiness && <li>With business income, you may get a PAYG instalment letter in your myGov Inbox. That's information from the ATO, not a bill yet.</li>}
          <li>Keep your records for {header?.records_keep ?? "5 years from the date you lodge"}. Quillo keeps what you've added here.</li>
        </ul>
      </div>
      <div>
        <h3 className="text-sm font-semibold text-ink">When your notice of assessment arrives</h3>
        <p className="mt-1 max-w-[65ch] text-sm text-muted">Add it here to close the year and carry anything forward.</p>
      </div>
      {noaOn && <NoaCloseOff />}
      <div>
        <h3 className="text-sm font-semibold text-ink">Found something you missed?</h3>
        <p className="mt-1 max-w-[65ch] text-sm text-muted">
          Wait until your notice of assessment arrives, then in myGov go to ATO, Manage tax returns, and choose Amend. You can amend{" "}
          {header?.amend_window ?? "generally within 2 years of the day after your notice of assessment"}, and there's no fee. A new type of income or
          deduction is ticked on Personalise return; this worksheet's lines still apply. If you're unsure, confirm with a registered tax agent.{" "}
          <FtLink href={ATO_AMEND} className="text-sm">
            How the ATO says to amend
          </FtLink>
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <FtButton variant="primary" onClick={onStartNext}>
          Start next year's records
        </FtButton>
        <FtButton variant="ghost" onClick={() => undo.mutate()} busy={undo.isPending}>
          Undo lodged mark
        </FtButton>
      </div>
    </FtCard>
  );
}

/**
 * The Tax-ready gate (ato §b rows 4 + 8): before opening myTax, can you get in, and does every income statement
 * say Tax ready? Self-attested ticks, stored with the worksheet ticks. A soft gate: it says "not yet", never
 * hides the worksheet (someone leaving Australia can lodge early, row 10). Quillo never touches myGov.
 */
function TaxReadyGate({ employers, ticks, known }: { employers: { key: string; name: string }[]; ticks: ReturnType<typeof useWorksheetTicks>; known: boolean }) {
  const items = [
    { id: tickId(GATE, "mygov_linked"), label: "I can sign in to myGov, and it's linked to the ATO" },
    ...employers.map((e) => ({ id: tickId(GATE, e.key), label: `My income statement from ${e.name} says "Tax ready" in myGov` })),
  ];
  const done = items.filter((i) => ticks.stateOf(i.id, null) === "ticked").length;
  // No verdict until the employer list is known (the worksheet has loaded), or ticking myGov alone would read as ready.
  const ready = ticks.ready && known && done === items.length;
  return (
    <FtCard className="space-y-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-xl tracking-wide text-forest">Before you open myTax</h2>
        {ticks.ready && known && <Badge tone={ready ? "ok" : "warn"}>{ready ? "Ready for myTax" : "Not yet"}</Badge>}
      </div>
      <ul className="space-y-1">
        {items.map((i) => (
          <li key={i.id}>
            {ticks.ready ? (
              <FtCheckbox checked={ticks.stateOf(i.id, null) === "ticked"} onChange={() => ticks.toggle(i.id, null)}>
                {i.label}
              </FtCheckbox>
            ) : (
              <span className="text-sm text-ink">{i.label}</span>
            )}
          </li>
        ))}
      </ul>
      <p className="max-w-[65ch] text-sm text-muted">
        To link myGov to the ATO you answer questions from ATO records; a recent payslip or your TFN application receipt number can help. Signing in
        with myID at Standard or Strong is the ATO's recommended way. If you can't confirm online, the ATO tells you what to do next. Quillo never asks for your myGov or myID details.{" "}
        <FtLink href={ATO_LINK_MYGOV} className="text-sm">
          Link myGov to the ATO
        </FtLink>
      </p>
      {!ready && ticks.ready && (
        <p className="text-sm text-ink">
          You can start getting the figures ready below, but wait until every income statement says "Tax ready" before you lodge.
        </p>
      )}
    </FtCard>
  );
}

/**
 * Without situation_profile there's no dated lodged mark (/api/lodged), so the journey keeps the legacy Filing
 * page's soft sign-off (/api/signoff) rather than leaving no way to record the year as done.
 */
function SoftSignoff({ fy, label }: { fy: number; label: string }) {
  const qc = useQueryClient();
  const signoff = useQuery({ queryKey: ["fy-signoff", fy], queryFn: () => api.fySignoff(fy) });
  const sign = useMutation({ mutationFn: () => api.signOff(fy), onSuccess: () => qc.invalidateQueries({ queryKey: ["fy-signoff", fy] }) });
  if (signoff.isLoading) return null;
  return (
    <FtCard className="space-y-3 p-5">
      <h2 className="font-display text-xl tracking-wide text-forest">Lodged in myTax?</h2>
      {signoff.data ? (
        <p className="text-sm text-muted">You marked FY {label} as done. Your own record: Quillo doesn't lodge.</p>
      ) : (
        <>
          <p className="max-w-[65ch] text-sm text-muted">
            When you tick myTax's declaration, you're confirming every figure, including the prefilled ones, is right and that you hold the records.
            Once you've lodged FY {label} in myTax, mark it here as your own record.
          </p>
          <FtButton variant="primary" onClick={() => sign.mutate()} busy={sign.isPending}>
            I've lodged in myTax
          </FtButton>
        </>
      )}
    </FtCard>
  );
}
