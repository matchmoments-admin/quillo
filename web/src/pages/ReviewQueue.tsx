import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../api";
import { money } from "../components/ui";
import {
  CheckItem,
  Chip,
  CompletenessMeter,
  EmptyState,
  ErrorState,
  FtButton,
  FtCard,
  FtLink,
  GeneralInfoNote,
  MatchProposalRow,
  NoticedCard,
  RecordRow,
  Skeleton,
  cx,
  FOCUS,
  useWhyDrawer,
  type MatchSide,
} from "../components/ft";
import { NoticedConfirmed } from "../components/NoticedPanel";
import { WorthALookCard } from "../components/review/WorthALookCard";
import { FactCard, NeedsRecordCard, groupName, recordMeta } from "../components/review/RecordCards";
import { useActiveFy } from "../lib/activeFy";
import { useFeatures } from "../lib/features";
import { useEducation } from "../lib/education";
import { JOURNEY_STEP_KEYS, STEP_LABEL, STEP_ROUTE, useJourney } from "../lib/journey";
import { findingFixLinkForKind, type FixLink } from "../lib/findingLinks";
import { confirmedByLabel, groupWorthALook } from "../lib/claims";
import {
  QUEUE_KIND_LABEL,
  activeKinds,
  doneRecordRows,
  effectiveFilter,
  openFacts,
  openRecordRows,
  queueCounts,
  queueHeadline,
  recordsProgress,
  showKind,
  type QueueFilter,
  type QueueKind,
} from "../lib/reviewQueue";
import { Documents } from "./Documents";
import { RulesSettings } from "./Settings";
import { Review as ByLabel } from "./Review";
import type { Journey, JourneyStepKey, NoticedConfirmResult, NoticedSignal, ReconcileRow } from "../types";

// Step 3, Review (spec §0 design review 2026-10-04; #587, absorbing #588 Records and #589 Check). Routed only
// with ft_journey ON (pages/Steps.tsx). ONE self-completing card queue, in the order it's worth doing:
//   To fix (readiness blockers) → We noticed (#577) → Worth a look (#578 claims, golden rules + ATO guide, #591)
//   → Records (confirmed claims needing a record, record-keeping exception, facts like WFH hours / car km)
//   → Receipts to match (#574 proposals; one tap each, never auto-confirmed) → Worth checking (review findings).
// Each card leaves the queue once it's handled; a claimed item comes back as a record card until it has one
// (claim → record → done). Done items (records, stated facts, matches incl. the import-time auto-links with
// Undo) sit under a collapsed Done list.
// Header: one counts line, the records meter, the filter chips, never a refund figure; the estimate sits beside Done behind an
// "estimate only, general information" link. Everyday spending is never shown here (power users have the
// All transactions link). Every hook sits above the first conditional return (hooks lint gate; React #310).

/** The journey step this page is mounted on. */
const STEP: JourneyStepKey = "review";
const STEP_URL = STEP_ROUTE[STEP];
/** The two-pane fallback picker for one receipt (today's Reconcile), mounted under this step. */
export const MATCH_PICKER_ROUTE = `${STEP_URL}/match`;
const pickerFor = (receiptId: string) => `${MATCH_PICKER_ROUTE}?receipt=${encodeURIComponent(receiptId)}`;

const day = (d: string | null) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short" }) : "undated");
const cents = (r: ReconcileRow) => r.amount_aud_cents ?? r.amount_cents;
const receiptSide = (r: ReconcileRow): MatchSide => ({ name: r.merchant ?? "Receipt", amount: money(cents(r)), date: day(r.txn_date) });
const lineSide = (l: ReconcileRow): MatchSide => ({ name: l.raw_description ?? l.merchant ?? "Bank line", amount: money(cents(l)), date: day(l.txn_date) });

/**
 * A finding's fix link from inside Review: its evidence kind's page when that is specific, else the step it
 * points into. A transaction finding that points here goes to the transaction list (where lines are
 * sorted), never back to this page.
 */
function fixFor(w: Journey["whats_left"][number]): FixLink {
  if (w.evidence_kind && w.evidence_kind !== "transaction") return findingFixLinkForKind(w.evidence_kind, { journey: true });
  if (w.step !== STEP) return { to: STEP_ROUTE[w.step], label: `Go to ${STEP_LABEL[w.step]}` };
  return { to: "/transactions", label: "Sort it out" };
}

type Tab = "queue" | "labels";

export function ReviewQueue() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("view") === "labels" ? "labels" : "queue";
  const setTab = (t: Tab) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (t === "labels") n.set("view", "labels");
        else n.delete("view");
        return n;
      },
      { replace: true },
    );
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Review view">
        <FtButton variant={tab === "queue" ? "primary" : "secondary"} aria-pressed={tab === "queue"} onClick={() => setTab("queue")}>
          To review
        </FtButton>
        <FtButton variant={tab === "labels" ? "primary" : "secondary"} aria-pressed={tab === "labels"} onClick={() => setTab("labels")}>
          By label
        </FtButton>
      </div>
      {tab === "labels" ? <ByLabel /> : <QueueBody />}
    </div>
  );
}

function SectionTitle({ id, kind, count }: { id: string; kind: QueueKind; count: number }) {
  return (
    <h2 id={id} className="font-display text-xl tracking-wide text-forest">
      {QUEUE_KIND_LABEL[kind]}
      <span className="ml-2 text-sm font-normal text-muted tnum">{count}</span>
    </h2>
  );
}

function QueueBody() {
  const { has } = useFeatures();
  const scanOn = has("relevance_scan");
  const noticedOn = has("wages_payer");
  const proposalsOn = has("reconcile_proposals");
  const summaryOn = has("deductibility_review");
  const { fy, label } = useActiveFy();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { hash } = useLocation();
  // Per-card Why? (#591): Ask Quillo about THIS item; the step footer's Why? is the step-level drawer.
  const { openWhy, drawer } = useWhyDrawer(STEP);
  const [filter, setFilter] = useState<QueueFilter>("all");
  const [estimateOpen, setEstimateOpen] = useState(false);
  const [snapFor, setSnapFor] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Confirmed "we noticed" cards stay on screen with their follow-up (e.g. the income-statement prompt) until the next visit.
  const [noticedDone, setNoticedDone] = useState<Record<string, { signal: NoticedSignal; result: NoticedConfirmResult }>>({});

  const journey = useJourney();
  const rel = useQuery({ queryKey: ["relevance", fy], queryFn: () => api.relevance(fy), enabled: scanOn });
  const noticed = useQuery({ queryKey: ["noticed", fy], queryFn: () => api.noticed(fy), enabled: noticedOn });
  const proposals = useQuery({ queryKey: ["reconcile-proposals", fy], queryFn: () => api.reconcileProposals(fy), enabled: proposalsOn });
  const linked = useQuery({ queryKey: ["reconcile-linked", fy], queryFn: () => api.reconcileLinked(fy), enabled: proposalsOn });
  const records = useQuery({ queryKey: ["records", fy], queryFn: () => api.records(fy) });
  const summary = useQuery({ queryKey: ["review", label], queryFn: () => api.reviewSummary(label), enabled: summaryOn });
  const edu = useEducation();

  const refresh = (keys: string[]) => {
    for (const k of [...keys, "journey"]) void qc.invalidateQueries({ queryKey: [k] });
  };

  const confirmNoticed = useMutation({
    mutationFn: (s: NoticedSignal) => api.confirmNoticed(s.id).then((result) => ({ signal: s, result })),
    onSuccess: ({ signal, result }) => {
      setNoticedDone((d) => ({ ...d, [signal.id]: { signal, result } }));
      refresh(["noticed", "readiness", "income", "report", "transactions", "dashboard", "situation", "relevance"]);
    },
    onError: (e) => toast.error("Couldn't save that", { description: (e as Error).message }),
  });
  const dismissNoticed = useMutation({
    mutationFn: (s: NoticedSignal) => api.dismissNoticed(s.id),
    onSuccess: () => refresh(["noticed"]),
    onError: (e) => toast.error("Couldn't dismiss", { description: (e as Error).message }),
  });

  const matchKeys = ["reconcile-proposals", "reconcile-linked", "reconcile", "records", "transactions", "dashboard"];
  const match = useMutation({
    mutationFn: (p: { receipt_id: string; line_id: string }) => api.matchLink(p.receipt_id, p.line_id),
    onSuccess: () => {
      toast.success("Matched. The bank line now counts once, with your receipt as its record.");
      refresh(matchKeys);
    },
    onError: () => {
      toast.error("Couldn't match that pair. The line may have changed, so the list has been refreshed.");
      refresh(matchKeys);
    },
  });
  const notThisOne = useMutation({
    mutationFn: (p: { receipt_id: string; line_id: string }) => api.reconcileDismiss(p.receipt_id, p.line_id),
    onSuccess: (_r, p) => {
      refresh(matchKeys);
      navigate(pickerFor(p.receipt_id));
    },
    onError: () => {
      toast.error("Couldn't save that. The list has been refreshed.");
      refresh(matchKeys);
    },
  });
  const undo = useMutation({
    mutationFn: (receiptId: string) => api.reconcileUndoLink(receiptId),
    onSuccess: () => {
      toast.success("Unmatched. This pair won't be matched automatically again.");
      refresh(matchKeys);
    },
    onError: () => {
      toast.error("Couldn't undo that match. The list has been refreshed.");
      refresh(matchKeys);
    },
  });
  const matchBusy = match.isPending || notThisOne.isPending || undo.isPending;

  // Snap a receipt: the existing upload, then the existing manual link (POST /api/match/link) to this line,
  // so the receipt becomes the line's record and stops counting separately.
  const snap = useMutation({
    mutationFn: async ({ lineId, file }: { lineId: string; file: File }) => {
      const up = await api.upload(file);
      // Reading the receipt runs the import-time auto-matcher, which may already have paired it with another
      // line. Put that back first (Undo restores what the link changed; 404 when proposals are off) so the
      // receipt ends up on THIS claim only.
      if (proposalsOn) await api.reconcileUndoLink(up.txnId).catch(() => undefined);
      try {
        await api.matchLink(up.txnId, lineId);
      } catch (e) {
        throw new Error(`The receipt was saved, but it couldn't be attached to this claim (${(e as Error).message}). Match it under Receipts to match.`);
      }
    },
    onSuccess: () => {
      toast.success("Receipt added to this claim.");
      refresh(matchKeys);
    },
    onError: (e) => {
      toast.error("Couldn't add the receipt to this claim", { description: (e as Error).message });
      refresh(matchKeys);
    },
    onSettled: () => setSnapFor(null),
  });
  const attest = useMutation({
    mutationFn: ({ txnId, kind }: { txnId: string; kind: string | null }) => api.setRecordException(fy, txnId, kind),
    onSuccess: (r, v) => {
      if (!r.ok) {
        toast.error("Couldn't save that", { description: r.error });
      } else {
        toast.success(v.kind ? "Noted: this claim is under the record-keeping exception." : "Exception removed.");
      }
      refresh(["records"]);
    },
    onError: (e) => toast.error("Couldn't save", { description: (e as Error).message }),
  });

  const j = journey.data;
  const blockers = useMemo(() => j?.whats_left.filter((w) => w.severity === "blocker") ?? [], [j]);
  const reviewFindings = useMemo(() => j?.whats_left.filter((w) => w.severity === "review") ?? [], [j]);
  const groups = useMemo(() => groupWorthALook(rel.data?.worth_a_look ?? []), [rel.data]);
  const openNoticed = noticed.data ?? [];
  const noticedShown = [...Object.values(noticedDone).map((d) => d.signal).filter((s) => !openNoticed.some((o) => o.id === s.id)), ...openNoticed];
  const p = proposals.data;
  const rv = records.data;
  const recRows = openRecordRows(rv);
  const facts = openFacts(rv);
  const counts = queueCounts({
    blockers: blockers.length,
    review: reviewFindings.length,
    noticed: openNoticed.length,
    claimGroups: groups.length,
    proposals: p?.proposals.length ?? 0,
    ambiguous: p?.ambiguous.length ?? 0,
    recordRows: recRows.length,
    factsOpen: facts.length,
  });
  const f = effectiveFilter(filter, counts);
  const progress = recordsProgress(rv?.block ?? j?.records);
  const yours = useMemo(() => confirmedByLabel(summary.data?.rows ?? []), [summary.data]);
  const jobs = useMemo(() => [...new Set((edu.data?.occupation_guides ?? []).map((g) => g.label.toLowerCase()))], [edu.data]);
  const autoPairs = linked.data?.pairs.filter((x) => x.auto) ?? [];
  const yourPairs = linked.data?.pairs.filter((x) => !x.auto) ?? [];
  const recDone = doneRecordRows(rv);
  const factsStated = (rv?.facts ?? []).filter((x) => x.needed && x.done);
  const factsExtra = (rv?.facts ?? []).filter((x) => !x.needed && x.key !== "platform_fees");
  const loading = journey.isLoading || (scanOn && rel.isLoading) || records.isLoading || (proposalsOn && proposals.isLoading) || (noticedOn && noticed.isLoading);
  const nothingIn = scanOn && !!rel.data && Object.values(rel.data.counts).every((n) => n === 0) && (rv?.rows.length ?? 0) === 0 && counts.total === 0;
  const doneCount = recDone.length + factsStated.length + autoPairs.length + yourPairs.length + (p?.no_line.length ?? 0) + yours.length;
  const prevStep = JOURNEY_STEP_KEYS[JOURNEY_STEP_KEYS.indexOf(STEP) - 1];
  const noticedBusy = (confirmNoticed.isPending && confirmNoticed.variables?.id) || (dismissNoticed.isPending && dismissNoticed.variables?.id) || null;
  const show = (k: QueueKind) => showKind(f, k) && counts[k] > 0;

  return (
    <div className="space-y-8">
      <input
        ref={fileRef}
        type="file"
        className="hidden"
        accept="image/*,application/pdf"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file && snapFor) snap.mutate({ lineId: snapFor, file });
          else setSnapFor(null);
          e.target.value = "";
        }}
      />

      {/* ── Header (H&R Block review (d)11): one counts line, the records meter, the filter chips. Never a refund figure. ── */}
      <FtCard className="space-y-4 p-5">
        <p className="text-base font-semibold text-ink" aria-live="polite">
          {loading ? "Checking what's left…" : queueHeadline(counts, progress)}
        </p>
        {progress && <CompletenessMeter label="Records" done={progress.done} total={progress.total} />}
        {activeKinds(counts).length > 1 && (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Show only">
            <Chip selected={f === "all"} onToggle={() => setFilter("all")}>
              All {counts.total}
            </Chip>
            {activeKinds(counts).map((k) => (
              <Chip key={k} selected={f === k} onToggle={() => setFilter(f === k ? "all" : k)}>
                {QUEUE_KIND_LABEL[k]} {counts[k]}
              </Chip>
            ))}
          </div>
        )}
        <p className="max-w-[65ch] text-xs text-muted">
          {jobs.length > 0 ? (
            <>
              Based on your job as a <strong className="text-ink">{jobs.join(" and ")}</strong> and your bank lines.
            </>
          ) : (
            "Based on your bank lines."
          )}{" "}
          You decide what's yours. Everyday spending isn't shown here.
        </p>
      </FtCard>

      {journey.error && <ErrorState what="your checks" error={journey.error} onRetry={() => void journey.refetch()} />}
      {scanOn && rel.error && <ErrorState what="what's worth a look" error={rel.error} onRetry={() => void rel.refetch()} />}
      {records.error && <ErrorState what="your records" error={records.error} onRetry={() => void records.refetch()} />}
      {proposalsOn && proposals.error && <ErrorState what="your receipt matches" error={proposals.error} onRetry={() => void proposals.refetch()} />}
      {noticedOn && noticed.error && <ErrorState what="what we noticed" error={noticed.error} onRetry={() => void noticed.refetch()} />}

      {loading ? (
        <FtCard className="p-4">
          <Skeleton lines={4} />
        </FtCard>
      ) : nothingIn ? (
        <EmptyState
          title="Nothing to look at yet"
          body="Bring in your money first."
          action={
            prevStep && (
              <FtLink to={STEP_ROUTE[prevStep]} variant="primary">
                Go to {STEP_LABEL[prevStep]}
              </FtLink>
            )
          }
        />
      ) : counts.total === 0 ? (
        <FtCard className="p-4">
          <p className="text-sm font-semibold text-ink">All reviewed for now.</p>
          <p className="mt-1 text-sm text-muted">Nothing to fix, claim, record or match. Come back here any time you add something new.</p>
        </FtCard>
      ) : null}

      {!loading && (
        <div className="space-y-8">
          {show("fix") && (
            <section aria-labelledby="q-fix" className="space-y-2">
              <SectionTitle id="q-fix" kind="fix" count={counts.fix} />
              {blockers.map((w) => {
                const fix = fixFor(w);
                return <CheckItem key={w.id} tone="warn" title={w.title} body={w.note} actions={[{ label: fix.label, onClick: () => navigate(fix.to), primary: true }]} />;
              })}
            </section>
          )}

          {noticedOn && noticedShown.length > 0 && showKind(f, "noticed") && (
            <section aria-labelledby="q-noticed" className="space-y-2">
              <SectionTitle id="q-noticed" kind="noticed" count={counts.noticed} />
              {noticedShown.map((s) => (
                <NoticedCard
                  key={s.id}
                  signal={s}
                  amount={money(s.evidence.total_cents)}
                  busy={noticedBusy === s.id}
                  onYes={() => confirmNoticed.mutate(s)}
                  onNo={() => dismissNoticed.mutate(s)}
                  after={noticedDone[s.id] ? <NoticedConfirmed result={noticedDone[s.id]!.result} /> : undefined}
                />
              ))}
            </section>
          )}

          {show("claims") && (
            <section aria-labelledby="q-claims" className="space-y-2">
              <SectionTitle id="q-claims" kind="claims" count={counts.claims} />
              {groups.map((g) => (
                <WorthALookCard key={g.key} group={g} labelNames={rel.data?.label_names ?? {}} onWhy={openWhy} />
              ))}
            </section>
          )}

          {show("records") && rv && (
            <section id="records" aria-labelledby="q-records" className="scroll-mt-20 space-y-2">
              <SectionTitle id="q-records" kind="records" count={counts.records} />
              {recRows.map((r) => (
                <NeedsRecordCard
                  key={r.id}
                  row={r}
                  view={rv}
                  snapBusy={snap.isPending && snapFor === r.id}
                  onSnap={() => {
                    setSnapFor(r.id);
                    fileRef.current?.click();
                  }}
                  attestBusy={attest.isPending && attest.variables?.txnId === r.id}
                  onAttest={(kind) => attest.mutate({ txnId: r.id, kind })}
                />
              ))}
              {facts.map((x) => (
                <FactCard key={x.key} fact={x} view={rv} fy={fy} wfhEditor={has("wfh_car_methods")} carEditor={has("car_methods") || has("car_logbook")} onSaved={() => refresh(["records"])} />
              ))}
            </section>
          )}

          {/* Legacy /reconcile and old /check links land here (#check). */}
          <div id="check" className="scroll-mt-20" />
          {show("matches") && p && (
            <section aria-labelledby="q-matches" className="space-y-2">
              <SectionTitle id="q-matches" kind="matches" count={counts.matches} />
              <p className="max-w-[65ch] text-sm text-muted">
                A receipt matched to its bank line counts once: the bank line is the amount, the receipt is your record. Nothing is matched until you press Match.
              </p>
              {p.proposals.map((x) => (
                <MatchProposalRow
                  key={`${x.receipt_id}:${x.line_id}`}
                  receipt={receiptSide(x.receipt)}
                  line={lineSide(x.line)}
                  badge={x.line.direction === "credit" ? "Money in" : undefined}
                  actions={[
                    { label: "Match", primary: true, onClick: () => match.mutate(x), busy: match.isPending && match.variables?.receipt_id === x.receipt_id, disabled: matchBusy },
                    { label: "Not this one", onClick: () => notThisOne.mutate(x), busy: notThisOne.isPending && notThisOne.variables?.receipt_id === x.receipt_id, disabled: matchBusy },
                  ]}
                />
              ))}
              {p.ambiguous.length > 0 && (
                <FtCard>
                  <p className="px-4 pt-3 text-sm font-semibold text-ink">Pick the bank line yourself</p>
                  <p className="px-4 text-sm text-muted">More than one bank line could fit these receipts, so Quillo won't guess.</p>
                  <ul className="mt-2 divide-y divide-line">
                    {p.ambiguous.map((a) => (
                      <li key={a.receipt.id} className="flex flex-wrap items-center gap-3 px-4 py-2">
                        <span className="min-w-0 flex-1 text-sm text-ink">
                          {a.receipt.merchant ?? "Receipt"} <span className="text-muted">· {money(cents(a.receipt))} · {day(a.receipt.txn_date)}</span>
                        </span>
                        <FtLink to={pickerFor(a.receipt.id)} className="text-sm">
                          Choose a line
                        </FtLink>
                      </li>
                    ))}
                  </ul>
                </FtCard>
              )}
            </section>
          )}

          {show("check") && (
            <section aria-labelledby="q-check" className="space-y-2">
              <SectionTitle id="q-check" kind="check" count={counts.check} />
              {reviewFindings.map((w) => {
                const fix = fixFor(w);
                return <CheckItem key={w.id} tone="info" title={w.title} body={w.note} actions={[{ label: fix.label, onClick: () => navigate(fix.to) }]} />;
              })}
            </section>
          )}

          {p?.truncated && (
            <CheckItem
              tone="info"
              title="Too many receipts to suggest matches"
              body="Use the matcher to pair receipts with bank lines yourself."
              actions={[{ label: "Open the matcher", onClick: () => navigate(MATCH_PICKER_ROUTE) }]}
            />
          )}
          {!proposalsOn && (
            <FtCard className="p-4">
              <p className="text-sm text-muted">Pair each receipt with its bank line yourself.</p>
              <div className="mt-2">
                <FtLink to={MATCH_PICKER_ROUTE} variant="secondary">
                  Open the matcher
                </FtLink>
              </div>
            </FtCard>
          )}

          {/* ── Done: what's handled, still reachable (Undo a match, remove an exception, edit a fact). ── */}
          {doneCount + factsExtra.length > 0 && (
            <details className="rounded-2xl border border-line bg-card shadow-card">
              <summary className={cx(FOCUS, "min-h-[44px] cursor-pointer px-4 py-3 text-sm font-semibold text-ink")}>
                Done <span className="ml-1 text-sm font-normal text-muted tnum">{doneCount}</span>
              </summary>
              <div className="space-y-6 px-4 pb-4">
                {yours.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold text-ink">Your claims</h3>
                    <ul className="divide-y divide-line">
                      {yours.map((y) => (
                        <li key={y.label ?? ""} className="flex flex-wrap items-center justify-between gap-3 py-2">
                          <span className="text-sm text-ink">
                            {y.label ? (rel.data?.label_names[y.label] ? `${y.label} · ${rel.data.label_names[y.label]}` : y.label) : "No label yet"}
                            <span className="ml-2 text-xs text-muted">
                              {y.n} {y.n === 1 ? "item" : "items"}
                            </span>
                          </span>
                          <span className="text-sm font-semibold text-ink tnum">{money(y.cents)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {rv && recDone.length > 0 && (
                  <div className="space-y-1">
                    <h3 className="text-sm font-semibold text-ink">Claims with a record</h3>
                    {recDone.map((r) => (
                      <div key={r.id}>
                        {groupName(rv, r) && <p className="pt-2 text-xs text-muted">{groupName(rv, r)}</p>}
                        <RecordRow
                          label={r.description ?? "Claim"}
                          meta={recordMeta(r)}
                          recordStatus={r.status}
                          action={r.status === "exception" ? { label: "Undo", onClick: () => attest.mutate({ txnId: r.id, kind: null }), busy: attest.isPending && attest.variables?.txnId === r.id } : undefined}
                        />
                      </div>
                    ))}
                  </div>
                )}

                {rv && (factsStated.length > 0 || factsExtra.length > 0) && (
                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold text-ink">Facts you state</h3>
                    {[...factsStated, ...factsExtra].map((x) => (
                      <FactCard
                        key={x.key}
                        fact={x}
                        view={rv}
                        fy={fy}
                        wfhEditor={has("wfh_car_methods")}
                        carEditor={has("car_methods") || has("car_logbook")}
                        onSaved={() => refresh(["records"])}
                        defaultOpen={false}
                      />
                    ))}
                  </div>
                )}

                {proposalsOn && autoPairs.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold text-ink">Matched automatically</h3>
                    <p className="max-w-[65ch] text-sm text-muted">
                      Quillo matched these when your bank lines came in. If a receipt isn't for that payment, undo it: until you match the receipt to another line, the receipt and the bank line both count.
                    </p>
                    {autoPairs.map((x) => (
                      <MatchProposalRow
                        key={x.receipt.id}
                        receipt={receiptSide(x.receipt)}
                        line={lineSide(x.line)}
                        badge="Matched automatically"
                        actions={[{ label: "Undo", onClick: () => undo.mutate(x.receipt.id), busy: undo.isPending && undo.variables === x.receipt.id, disabled: matchBusy }]}
                      />
                    ))}
                  </div>
                )}

                {proposalsOn && yourPairs.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold text-ink">Your matches</h3>
                    <p className="max-w-[65ch] text-sm text-muted">Undo a match only if the receipt isn't for that payment: until you match it again, the receipt and the bank line both count.</p>
                    {yourPairs.map((x) => (
                      <MatchProposalRow
                        key={x.receipt.id}
                        receipt={receiptSide(x.receipt)}
                        line={lineSide(x.line)}
                        actions={[{ label: "Undo", onClick: () => undo.mutate(x.receipt.id), busy: undo.isPending && undo.variables === x.receipt.id, disabled: matchBusy }]}
                      />
                    ))}
                  </div>
                )}
                {linked.data?.truncated && <p className="text-xs text-muted">Showing the most recent matches only.</p>}

                {p && p.no_line.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold text-ink">No bank line this year</h3>
                    <p className="text-sm text-muted">Paid in cash? The receipt is still your record.</p>
                    <ul className="divide-y divide-line">
                      {p.no_line.map((r) => (
                        <li key={r.id} className="flex flex-wrap items-center gap-3 py-2">
                          <span className="min-w-0 flex-1 text-sm text-ink">
                            {r.merchant ?? "Receipt"} <span className="text-muted">· {money(cents(r))} · {day(r.txn_date)}</span>
                          </span>
                          <FtLink to={pickerFor(r.id)} className="text-sm">
                            Match anyway
                          </FtLink>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </details>
          )}

          {/* ── Your estimate, beside Done (H&R Block review (d)11): taxable position, never a refund, behind a disclosure. ── */}
          <div>
            <FtButton variant="link" className="text-sm" aria-expanded={estimateOpen} aria-controls="review-estimate" onClick={() => setEstimateOpen((o) => !o)}>
              Your estimate (estimate only, general information)
            </FtButton>
            {estimateOpen && (
              <div id="review-estimate" className="mt-2 rounded-lg border border-line bg-surface p-3">
                {j?.readiness.estimate ? (
                  <>
                    <p className="text-sm text-ink">
                      Estimated taxable position:{" "}
                      <span className="font-semibold tnum">
                        {j.readiness.estimate.confirmed_cents != null && j.readiness.estimate.confirmed_cents !== j.readiness.estimate.tracked_cents
                          ? `${money(j.readiness.estimate.confirmed_cents)} confirmed → ${money(j.readiness.estimate.tracked_cents)} tracked`
                          : money(j.readiness.estimate.tracked_cents)}
                      </span>{" "}
                      <span className="text-muted">(estimate only, general information)</span>
                    </p>
                    <p className="mt-1 text-xs text-muted">{j.readiness.estimate.caption}</p>
                  </>
                ) : (
                  <p className="text-sm text-muted">
                    {blockers.length > 0 ? "Your estimate shows here once nothing is left to fix." : "Your estimate shows here once you've brought in your income and spending for the year."}
                  </p>
                )}
                {j && <p className="mt-2 max-w-[65ch] text-xs leading-relaxed text-muted">{j.readiness.disclaimer}</p>}
                <GeneralInfoNote className="mt-1" />
              </div>
            )}
          </div>

          {/* ── Your documents (legacy /documents deep links land on #documents). ── */}
          <details id="documents" open={hash === "#documents"} className="scroll-mt-20 rounded-2xl border border-line bg-card shadow-card">
            <summary className={cx(FOCUS, "min-h-[44px] cursor-pointer px-4 py-3 text-sm font-semibold text-ink")}>Your documents</summary>
            <div className="px-4 pb-4">
              <Documents />
            </div>
          </details>

          {/* ── Your sorting rules (moved from Settings, #593; /settings#rules lands here). ── */}
          <details id="rules" open={hash === "#rules"} className="scroll-mt-20 rounded-2xl border border-line bg-card shadow-card">
            <summary className={cx(FOCUS, "min-h-[44px] cursor-pointer px-4 py-3 text-sm font-semibold text-ink")}>Your sorting rules</summary>
            <div className="px-4 pb-4">
              <RulesSettings />
            </div>
          </details>

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <FtLink to="/transactions?view=all">All transactions</FtLink>
            <FtLink to={MATCH_PICKER_ROUTE}>Match receipts yourself</FtLink>
          </div>
        </div>
      )}

      <div className="space-y-1">
        <GeneralInfoNote />
        {rv && <p className="max-w-[65ch] text-xs text-muted">{rv.disclaimer}</p>}
      </div>
      {drawer}
    </div>
  );
}
