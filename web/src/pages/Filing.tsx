import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, saveBlob } from "../api";
import { useActiveFy } from "../lib/activeFy";
import { useFeatures } from "../lib/features";
import { Card, Spinner, money } from "../components/ui";
import type { PositionLine, ReadinessFinding, ClaimReview, ClaimReviewItem, OccupationRuleCandidate } from "../types";

const SEVERITY_ORDER: ReadinessFinding["severity"][] = ["blocker", "review", "info"];
const SEVERITY_LABEL: Record<ReadinessFinding["severity"], string> = { blocker: "Must fix", review: "Review", info: "Good to know" };
const SEVERITY_CLASS: Record<ReadinessFinding["severity"], string> = {
  blocker: "bg-danger/10 text-danger",
  review: "bg-warn/10 text-warn",
  info: "bg-ink/5 text-ink",
};
const GROUP_LABEL: Record<PositionLine["group"], string> = { income: "Income", deduction: "Deductions", depreciation: "Depreciation", property: "Per-property position", company: "Company (separate return — not in your position)", excluded: "Excluded as private / non-deductible" };

// Where to go to fix a flagged finding — derived from the kind of evidence it points at, mirroring
// FindMyClaims' evidenceLink convention below. A blocker without evidence_refs falls back to the
// Inbox (where uncategorised transactions are sorted), the most common thing to fix.
function findingFixLink(f: ReadinessFinding): { to: string; label: string } {
  const kind = f.evidence_refs[0]?.kind;
  switch (kind) {
    case "asset": return { to: "/assets", label: "Review assets" };
    case "income": return { to: "/income", label: "Review income" };
    case "property": return { to: "/income", label: "Review property records" };
    case "document": return { to: "/inbox", label: "Add evidence" };
    case "transaction":
    default: return { to: "/inbox", label: "Sort it out" };
  }
}

// Soft, per-FY sign-off: the user's own attestation that this position is ready to hand to their
// agent. Re-openable (not a lock); a later import doesn't auto-clear it, so the timestamp stays
// visible. Quillo never lodges — this is the user's record, for their accountant.
function SignOff({ fy, ready }: { fy: number; ready: boolean }) {
  const qc = useQueryClient();
  const { data: signoff } = useQuery({ queryKey: ["fy-signoff", fy], queryFn: () => api.fySignoff(fy) });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["fy-signoff", fy] });
  const sign = useMutation({ mutationFn: () => api.signOff(fy), onSuccess: invalidate });
  const unsign = useMutation({ mutationFn: () => api.clearSignOff(fy), onSuccess: invalidate });

  if (signoff) {
    const when = new Date(signoff.signed_off_at.replace(" ", "T") + "Z");
    return (
      <Card className="flex flex-wrap items-center justify-between gap-2 border-safe/40 p-4 print:hidden">
        <div className="text-sm">
          <span className="font-semibold text-safe">Signed off</span> — you marked this position ready to hand off on{" "}
          {isNaN(when.getTime()) ? signoff.signed_off_at : when.toLocaleDateString()}. Your own attestation; Quillo doesn't lodge.
        </div>
        <button onClick={() => unsign.mutate()} disabled={unsign.isPending} className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-surface">
          {unsign.isPending ? "…" : "Re-open"}
        </button>
      </Card>
    );
  }
  return (
    <Card className="flex flex-wrap items-center justify-between gap-2 p-4 print:hidden">
      <div className="text-sm text-muted">
        {ready
          ? "Looks ready — sign off to mark this as your final position for your agent."
          : "Clear the items flagged above first, then you can sign off."}
      </div>
      <button
        onClick={() => sign.mutate()}
        disabled={!ready || sign.isPending}
        title={ready ? "" : "Fix the flagged items above first"}
        className="rounded-lg bg-ink px-4 py-2 text-sm font-medium text-white hover:bg-ink/90 disabled:opacity-50"
      >
        {sign.isPending ? "…" : "Sign off this position"}
      </button>
    </Card>
  );
}

export function Filing() {
  // Driven by the global active-FY switcher (in the app header).
  const { fy, label } = useActiveFy();
  const features = useFeatures();
  const { data, isLoading, error } = useQuery({ queryKey: ["filing-readiness", fy], queryFn: () => api.filingReadiness(fy) });
  const downloadCsv = useMutation({ mutationFn: () => api.reportCsv(fy), onSuccess: ({ blob, filename }) => saveBlob(blob, filename) });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between print:hidden">
        <h1 className="text-2xl font-semibold tracking-tight">Year-end handoff</h1>
        <span className="text-sm tabular-nums text-muted">FY {label}</span>
      </div>

      <p className="text-sm text-muted print:hidden">
        Everything you've captured, pulled together so you and your registered tax agent can see the position and what's worth a second look.{" "}
        <span className="text-ink">Quillo prepares your return for a registered tax agent — it doesn't lodge for you.</span>
      </p>

      {features.has("claim_review") && <FindMyClaims fy={fy} />}

      {isLoading ? (
        <Spinner />
      ) : error ? (
        <Card className="p-6 text-sm text-muted">Couldn't load: {(error as Error).message}</Card>
      ) : data && data.findings.some((x) => x.id === "nothing_captured") ? (
        /* Empty FY — don't present a $0 return as "ready". Point the user at the first action (#74). */
        <Card className="space-y-3 border-warn/40 p-6">
          <div className="text-lg font-semibold">Nothing captured for FY {label} yet</div>
          <p className="text-sm text-muted">
            Your return for this year is empty, so there's nothing to hand off to your agent. Start by importing a bank
            statement or snapping a receipt — Quillo will categorise it and build your position from there.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link to="/accounts" className="rounded-lg bg-ink px-4 py-2 text-sm font-medium text-white hover:bg-ink/90">Import a statement</Link>
            <Link to="/inbox" className="rounded-lg border border-line px-4 py-2 text-sm font-medium hover:bg-surface">Add a receipt</Link>
          </div>
          <p className="text-xs text-muted">{data.disclaimer}</p>
        </Card>
      ) : data ? (
        <>
          {/* Readiness banner. When not ready, surface the ACTUAL blocking findings (title + note +
              a deep-link to where to fix each) right here — a bare count left the user asking "what
              do I fix?". The full findings list still renders in "Things to double-check" below. */}
          {(() => {
            const blockers = data.findings.filter((x) => x.severity === "blocker");
            return (
          <Card className={`p-4 ${data.readiness_score.ready ? "border-safe/40" : "border-warn/40"}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-lg font-semibold">
                  {data.readiness_score.ready
                    ? data.readiness_score.review > 0
                      ? `${data.readiness_score.review} item(s) worth a look before you hand off`
                      : "Nothing flagged — but always confirm with your agent"
                    : `${data.readiness_score.blockers} item(s) to fix first`}
                </div>
                {!data.readiness_score.ready && blockers.length > 0 && (
                  <ul className="mt-2 space-y-2">
                    {blockers.map((b) => {
                      const link = findingFixLink(b);
                      return (
                        <li key={b.id} className="rounded-lg bg-warn/5 px-3 py-2 text-sm">
                          <div className="font-medium">{b.title}</div>
                          <div className="mt-0.5 text-muted">{b.general_info_note}</div>
                          <Link to={link.to} className="mt-1 inline-block text-ink underline underline-offset-2 print:hidden">{link.label} →</Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <div className="mt-2 text-sm text-muted">{data.handoff.situation_summary}</div>
              </div>
              <div className="flex flex-none gap-2 print:hidden">
                <button onClick={() => window.print()} className="rounded-lg bg-ink px-4 py-2 text-sm font-medium text-white hover:bg-ink/90">Print / Save as PDF</button>
                <button onClick={() => downloadCsv.mutate()} disabled={downloadCsv.isPending} className="rounded-lg border border-line px-4 py-2 text-sm font-medium hover:bg-surface disabled:opacity-60">{downloadCsv.isPending ? "Preparing…" : features.has("accountant_schedule") ? "Accountant schedule (CSV)" : "CSV for your agent"}</button>
              </div>
            </div>
          </Card>
            );
          })()}

          {/* Soft sign-off — the user's own "ready to hand off" attestation (re-openable, never a lock). */}
          <SignOff fy={fy} ready={data.readiness_score.ready} />

          {/* Indicative position with reasoning */}
          <Card className="p-4">
            <div className="text-xs uppercase tracking-wide text-muted">Indicative taxable position</div>
            <div className="mt-1 text-3xl font-semibold tabular-nums">{money(data.position.indicative_taxable_position_cents)}</div>
            <div className="mt-1 text-xs text-muted">{data.position.caption}</div>
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted">
              <span>PAYG withheld <span className="tabular-nums text-ink">{money(data.position.credits.withholding_cents)}</span></span>
              <span>Franking credits <span className="tabular-nums text-ink">{money(data.position.credits.franking_credit_cents)}</span></span>
              <span>Foreign tax (FITO) <span className="tabular-nums text-ink">{money(data.position.credits.foreign_tax_paid_cents)}</span></span>
              <span>GST credits <span className="tabular-nums text-ink">{money(data.position.credits.gst_credits_cents)}</span></span>
            </div>
          </Card>

          {/* Why each line is what it is */}
          {SEVERITY_ORDER.length > 0 && data.position.lines.length > 0 && (
            <Card className="overflow-hidden">
              <div className="px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-muted">How that's made up — and why</div>
              {(["income", "deduction", "depreciation", "property", "company", "excluded"] as PositionLine["group"][]).map((g) => {
                const rows = data.position.lines.filter((l) => l.group === g);
                if (!rows.length) return null;
                return (
                  <div key={g}>
                    <div className="border-t border-line bg-surface px-4 py-1.5 text-xs font-medium text-muted">{GROUP_LABEL[g]}</div>
                    {rows.map((l, i) => (
                      <details key={i} className="border-t border-line px-4 py-2">
                        <summary className="flex cursor-pointer items-center justify-between text-sm">
                          <span>{l.label}</span>
                          <span className="tabular-nums font-medium">{money(l.amount_cents)}</span>
                        </summary>
                        <div className="mt-1 text-xs text-muted">{l.basis} — {l.why}</div>
                      </details>
                    ))}
                  </div>
                );
              })}
            </Card>
          )}

          {/* Things to double-check */}
          <Card className="overflow-hidden">
            <div className="px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-muted">Things to double-check {data.findings.length ? `(${data.findings.length})` : ""}</div>
            {data.findings.length === 0 ? (
              <div className="border-t border-line px-4 py-4 text-sm text-muted">Nothing flagged from your records for this year. That's not a clearance — your agent should still confirm.</div>
            ) : (
              SEVERITY_ORDER.map((sev) => {
                const items = data.findings.filter((x) => x.severity === sev);
                if (!items.length) return null;
                return items.map((x) => (
                  <div key={x.id} className="border-t border-line px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_CLASS[sev]}`}>{SEVERITY_LABEL[sev]}</span>
                      <span className="text-sm font-medium">{x.title}</span>
                      {x.defer_to_agent && <span className="rounded-full bg-ink/5 px-2 py-0.5 text-xs text-muted">agent decides</span>}
                    </div>
                    <div className="mt-1 text-sm text-muted">{x.general_info_note}</div>
                  </div>
                ));
              })
            )}
          </Card>

          {/* Claims + checklist live on the Dashboard; link rather than duplicate the accept/dismiss controls. */}
          <Card className="p-4 text-sm print:hidden">
            Suggested deductions and your FY checklist are on the{" "}
            <Link to="/dashboard" className="text-ink underline underline-offset-2">Dashboard</Link> — accept or dismiss them there, then re-check this page.
          </Card>

          <p className="text-xs text-muted">{data.disclaimer}</p>
        </>
      ) : null}
    </div>
  );
}

// ── Find My Claims ───────────────────────────────────────────────────────────
// One-click situational sweep: review → (if an occupation has no authored rule) AI gap-fill draft →
// user confirms candidates → persist → re-review → render the three groups with deep-links to add
// evidence. NO dollar figure is ever rendered (situational claims answer "what could you claim", not
// "how much"); every defer row reads "confirm with a registered tax agent".

const GROUP_META: { key: "capturing" | "check" | "defer"; title: string; sub: string; pill: string }[] = [
  { key: "capturing", title: "Already capturing", sub: "Evidence is flowing in for these.", pill: "bg-safe/10 text-safe" },
  { key: "check", title: "Worth checking", sub: "You might be able to claim these — add evidence if they apply.", pill: "bg-warn/10 text-warn" },
  { key: "defer", title: "Confirm with your agent", sub: "Judgement calls — confirm with a registered tax agent.", pill: "bg-ink/5 text-ink" },
];

// Map a claim to the page where its evidence lives. div40 = depreciating assets; div43/property
// status → rental income/property; everything else → the Inbox (receipts).
function evidenceLink(item: ClaimReviewItem): { to: string; label: string } {
  if (item.claim_type === "div40") return { to: "/assets", label: "Add an asset" };
  if (item.claim_type === "div43" || item.scope_type === "property_status") return { to: "/income", label: "Add property records" };
  return { to: "/inbox", label: "Add a receipt" };
}

// Mirror TabGuide's friendly mapping for the AI gap-fill draft errors (consent 403 / budget 429).
function friendlyDraftError(msg: string): string {
  if (msg.includes("consent_required")) return "Turn on AI assistance (onboarding or Settings) to fill gaps for your occupation.";
  if (msg.includes("paused") || msg.includes("429")) return "AI is paused for today (daily limit) — try again after the reset.";
  return "Couldn't draft suggestions just now — try again.";
}

function FindMyClaims({ fy }: { fy?: number }) {
  const qc = useQueryClient();
  const [review, setReview] = useState<ClaimReview | null>(null);
  // Per-occupation candidate drafts the user is confirming (accumulated as each AI draft completes).
  const [gapFill, setGapFill] = useState<{ occupation: string; candidates: (OccupationRuleCandidate & { accept: boolean })[] }[]>([]);
  const [draftError, setDraftError] = useState<string | null>(null);

  const runReview = useMutation({
    mutationFn: () => api.claimReview(fy),
    onSuccess: (r) => {
      setReview(r);
      setGapFill([]);
      setDraftError(null);
      // Keep the Dashboard ClaimsCard + completion spine in sync (the sweep upserts 'check' rows).
      qc.invalidateQueries({ queryKey: ["claims"] });
      qc.invalidateQueries({ queryKey: ["progress"] });
      // NB: no automatic AI fan-out here — gap-fill is an explicit, per-occupation action below, so a
      // single click is a single model call (and each occupation's draft is independent of the others).
    },
  });

  // Draft candidate rules for ONE occupation, only when the user explicitly asks. Independent per
  // occupation: a failure (consent/budget/transient) on one never discards another's drafted results.
  const draftOne = useMutation({
    mutationFn: (occupation: string) => api.draftOccupationRules(occupation),
    onSuccess: (draft, occupation) => {
      setDraftError(null);
      setGapFill((prev) => [
        ...prev.filter((g) => g.occupation !== occupation),
        { occupation, candidates: draft.rules.map((c) => ({ ...c, accept: true })) },
      ]);
    },
    onError: (e) => setDraftError(friendlyDraftError((e as Error).message)),
  });

  const confirmGaps = useMutation({
    mutationFn: async () => {
      const chosen = gapFill.flatMap((g) => g.candidates.filter((c) => c.accept));
      // Strip the local `accept` flag before sending; the server forces defer_to_agent=1.
      const rules: OccupationRuleCandidate[] = chosen.map(({ accept: _accept, ...r }) => r);
      if (rules.length) await api.addClaimabilityRules(rules);
    },
    onSuccess: () => {
      // Re-run the sweep so the confirmed occupation rules now surface in the groups.
      runReview.mutate();
    },
  });

  const busy = runReview.isPending || confirmGaps.isPending;

  return (
    <Card className="p-4 print:hidden">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-lg font-semibold">Find my claims</div>
          <div className="mt-0.5 text-sm text-muted">
            Sweep your whole year against the deduction categories for your situation — general information only, not tax advice.
          </div>
        </div>
        <button
          onClick={() => runReview.mutate()}
          disabled={busy}
          className="flex-none rounded-lg bg-ink px-4 py-2 text-sm font-medium text-white hover:bg-ink/90 disabled:opacity-60"
        >
          {busy ? "Working…" : review ? "Run again" : "Find my claims"}
        </button>
      </div>

      {runReview.isError && (
        <div className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">Couldn't run the sweep: {(runReview.error as Error).message}</div>
      )}
      {draftError && (
        <div className="mt-3 rounded-lg bg-warn/10 px-3 py-2 text-sm text-warn">{draftError}</div>
      )}

      {/* AI gap-fill: occupations with no authored rule. Drafting is EXPLICIT and per-occupation — one
          click = one model call (APP-8 consented + budget-gated server-side) — then confirm checkboxes. */}
      {review && review.uncovered_occupations.length > 0 && (
        <div className="mt-4 rounded-lg border border-line bg-surface p-3">
          <div className="text-sm font-semibold">No tailored rules yet for your occupation</div>
          <p className="mt-0.5 text-xs text-muted">
            We haven't authored deduction rules for {review.uncovered_occupations.join(", ")}. Draft some from general ATO
            guidance with AI — nothing is saved or used until you confirm, and your agent should still confirm each one.
          </p>
          <div className="mt-3 space-y-3">
            {review.uncovered_occupations.map((occ) => {
              const gi = gapFill.findIndex((g) => g.occupation === occ);
              const drafted = gi >= 0 ? gapFill[gi] : null;
              const drafting = draftOne.isPending && draftOne.variables === occ;
              return (
                <div key={occ}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-medium uppercase tracking-wide text-muted">{occ}</div>
                    {!drafted && (
                      <button
                        onClick={() => draftOne.mutate(occ)}
                        disabled={draftOne.isPending}
                        className="flex-none rounded-lg border border-line px-3 py-1 text-xs font-medium hover:bg-paper disabled:opacity-60"
                      >
                        {drafting ? "Drafting…" : "Draft suggestions with AI"}
                      </button>
                    )}
                  </div>
                  {drafted && (
                    <div className="mt-1 space-y-1.5">
                      {drafted.candidates.map((c, ci) => (
                        <label key={ci} className="flex items-start gap-2 rounded-lg bg-paper px-3 py-2 text-sm">
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={c.accept}
                            onChange={(e) =>
                              setGapFill((prev) =>
                                prev.map((gg, j) =>
                                  j === gi ? { ...gg, candidates: gg.candidates.map((cc, k) => (k === ci ? { ...cc, accept: e.target.checked } : cc)) } : gg,
                                ),
                              )
                            }
                          />
                          <span>
                            {c.general_info_note}
                            <span className="ml-2 rounded-full bg-ink/5 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted">{c.claim_type}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {gapFill.length > 0 && (
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => confirmGaps.mutate()}
                disabled={confirmGaps.isPending || !gapFill.some((g) => g.candidates.some((c) => c.accept))}
                className="rounded-lg bg-ink px-4 py-2 text-sm font-medium text-white hover:bg-ink/90 disabled:opacity-60"
              >
                {confirmGaps.isPending ? "Saving…" : "Add selected"}
              </button>
              <button onClick={() => setGapFill([])} className="rounded-lg border border-line px-4 py-2 text-sm font-medium hover:bg-surface">
                Clear
              </button>
            </div>
          )}
        </div>
      )}

      {/* The three grouped lists. No dollar figure is rendered for any situational claim. */}
      {review && (
        <div className="mt-4 space-y-4">
          {GROUP_META.map((meta) => {
            const items = review[meta.key];
            return (
              <div key={meta.key} className="overflow-hidden rounded-lg border border-line">
                <div className="bg-surface px-3 py-2">
                  <div className="text-sm font-semibold">{meta.title} <span className="text-muted">({items.length})</span></div>
                  <div className="text-xs text-muted">{meta.sub}</div>
                </div>
                {items.length === 0 ? (
                  <div className="border-t border-line px-3 py-3 text-sm text-muted">Nothing here right now.</div>
                ) : (
                  items.map((item) => {
                    const link = evidenceLink(item);
                    return (
                      <div key={item.rule_id} className="border-t border-line px-3 py-3 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${meta.pill}`}>{item.claim_type}</span>
                          <span className="font-medium">{item.suggestion}</span>
                        </div>
                        <div className="mt-1 text-xs text-muted">{item.why_applies}</div>
                        {meta.key === "defer" && (
                          <div className="mt-1 text-xs text-muted">Confirm with a registered tax agent.</div>
                        )}
                        {meta.key !== "capturing" && (
                          <Link to={link.to} className="mt-1 inline-block text-xs text-ink underline underline-offset-2">
                            {link.label} →
                          </Link>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            );
          })}
          <p className="text-xs text-muted">General information only — not tax advice. Confirm every claim with a registered tax agent.</p>
          {/* G5 — evidence reminder: numbers aren't enough; the ATO needs the records behind them. */}
          <div className="mt-2 rounded-lg bg-surface px-3 py-2 text-xs text-muted">
            <span className="font-medium text-ink">Keep your evidence for 5 years.</span> The ATO needs written records once your claims pass $300 — keep receipts for anything you've claimed, and a <span className="font-medium text-ink">contemporaneous record of your work-from-home hours</span> (a diary, roster or timesheet — estimates aren't accepted). The ATO myDeductions tool is a simple way to log hours.
          </div>
        </div>
      )}
    </Card>
  );
}
