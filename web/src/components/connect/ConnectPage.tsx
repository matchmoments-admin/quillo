// The Connect step (first-timer spec §0 step 2, #586; flag ft_journey). Mobile-first, one primary action:
// "Connect your bank" when bank_feed_cdr is ON, otherwise "Upload a statement". After the bank callback
// (?connected=1) the server has already selected every consented account and started the first import
// (#612), so this page only SHOWS progress (bank_sync_runs via /api/bank/sync-status): importing / still
// importing in the background / done / partial or failed with Retry. Connected accounts are a plain list
// with an on/off per account; linking to an existing Quillo account sits behind an Advanced disclosure.
// The income statement is a WAITING item until the employer marks it Tax ready. No "We noticed" cards
// here: they live in the Review queue (#587).
//
// Every hook in each component sits above its first conditional return (hooks lint gate; React #310).

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../../api";
import { useFeatures } from "../../lib/features";
import { useActiveFy } from "../../lib/activeFy";
import { Income } from "../../pages/Income";
import { Accounts } from "../../pages/Accounts";
import { Badge, ErrorState, FtButton, FtCard, FtLink, GeneralInfoNote, PreflightSteps, Skeleton, YoullNeed, cx } from "../ft";
import { INPUT_CLASS } from "../ui";
import { CdrPolicyNote } from "../CdrPolicyLink";
import type { Account, StatementInfo } from "../../types";
import {
  FIRST_RUN_WAIT_MS,
  connectFailedCopy,
  connectedAccounts,
  importHeading,
  importSummary,
  incomeWaitItems,
  linesLabel,
  pollInterval,
  statementView,
  toggleSelection,
  type ConnectedAccountRow,
} from "./model";

const INPUT = `min-h-[44px] w-full ${INPUT_CLASS}`;

// The opening card's "what happens", one line per step. The same facts the hero's prose carried, numbered.
const CONNECT_STEPS = [
  { key: "bank", title: "Sign in at your bank", body: "Never in Quillo: Quillo never sees your banking password." },
  { key: "choose", title: "Choose the accounts to share", body: "Only the accounts you pick come through." },
  { key: "import", title: "Quillo imports the year you're lodging", body: "Straight away, and you can leave the page while it runs." },
] as const;
const UPLOAD_STEPS = [
  { key: "download", title: "Download a statement", body: "A CSV or PDF for the year you're lodging, from your bank's app or website." },
  { key: "upload", title: "Upload it here", body: "Pick the account it's for, and Quillo reads the lines in." },
] as const;

function Section({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 space-y-3">
      <h2 className="font-display text-xl tracking-wide text-forest">{title}</h2>
      {children}
    </section>
  );
}

export function ConnectPage() {
  const { has } = useFeatures();
  const [params] = useSearchParams();
  const [showUpload, setShowUpload] = useState(false);
  const bankOn = has("bank_feed_cdr");
  const connected = params.get("connected");

  const connect = useMutation({
    mutationFn: () => api.bankConnect("connect"),
    // The aggregator's hosted consent flow: the user signs in at their bank, never in Quillo.
    onSuccess: (r) => {
      window.location.href = r.url;
    },
    onError: (e: Error) => toast.error("Couldn't open the bank connection", { description: e.message }),
  });

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        {connected === "0" && (
          <div role="alert" className="rounded-2xl border border-danger/30 bg-danger-surface p-4 text-sm text-danger">
            {connectFailedCopy(params.get("reason"))}
          </div>
        )}
        {/* The opening card (H&R Block review (d)9, P1 + P7): what happens, numbered; what you'll need; one primary. */}
        <FtCard className="space-y-4 p-5">
          <h2 className="font-display text-xl tracking-wide text-forest">{bankOn ? "Connect your bank" : "Upload a statement"}</h2>
          <PreflightSteps label="What happens" items={bankOn ? CONNECT_STEPS : UPLOAD_STEPS} />
          <YoullNeed items={["Your internet banking login"]} />
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            {bankOn ? (
              <FtButton variant="primary" className="w-full sm:w-auto" onClick={() => connect.mutate()} busy={connect.isPending}>
                {connect.isPending ? "Opening your bank…" : "Connect your bank"}
              </FtButton>
            ) : (
              <FtButton variant="primary" className="w-full sm:w-auto" onClick={() => setShowUpload((v) => !v)} aria-expanded={showUpload}>
                Upload a statement
              </FtButton>
            )}
            {bankOn && (
              <FtButton variant="link" className="justify-center text-sm" onClick={() => setShowUpload((v) => !v)} aria-expanded={showUpload}>
                Upload a statement instead
              </FtButton>
            )}
          </div>
          {bankOn && <CdrPolicyNote />}
          {showUpload && <StatementUpload />}
        </FtCard>
      </div>

      {bankOn && <ImportProgress connected={connected === "1"} />}
      {bankOn && <ConnectedAccounts />}
      <Statements />
      <IncomeWaiting />
      <details className="rounded-2xl border border-line bg-paper p-3">
        <summary className="min-h-[44px] cursor-pointer py-2 text-sm font-semibold text-ink">Advanced: manage accounts and statements</summary>
        <p className="mt-1 text-sm text-muted">Rename, archive or delete an account, remove a statement uploaded to the wrong account, or add a loan or investment account.</p>
        <div className="mt-3">
          <Accounts embedded />
        </div>
      </details>
      <GeneralInfoNote />
    </div>
  );
}

// ── Import progress ──────────────────────────────────────────────────────────────────────────────

function ImportProgress({ connected }: { connected: boolean }) {
  const qc = useQueryClient();
  const [landedAt] = useState(() => Date.now());
  const q = useQuery({
    queryKey: ["bank-sync-status"],
    queryFn: () => api.bankSyncStatus(),
    refetchInterval: (query) => {
      // A failing endpoint stops the poll (the card shows Retry), so an outage can't poll forever. The
      // first-run wait is measured on successful fetches, the same clock the card renders from, so the
      // last poll always lands past the window and the card moves on from "Starting your import…".
      if (query.state.status === "error") return false;
      const s = importSummary(query.state.data?.runs ?? []);
      return pollInterval(s, connected && query.state.dataUpdatedAt - landedAt < FIRST_RUN_WAIT_MS);
    },
  });
  const summary = importSummary(q.data?.runs ?? []);
  // A live run finishing brings in new lines: refresh everything that reads them (Home, Review, counts).
  const prevPhase = useRef(summary.phase);
  useEffect(() => {
    if (prevPhase.current === "running" && summary.phase !== "running") {
      for (const key of ["transactions", "journey", "progress", "dashboard", "accounts", "bank-connections"]) qc.invalidateQueries({ queryKey: [key] });
    }
    prevPhase.current = summary.phase;
  }, [summary.phase, qc]);

  const retry = useMutation({
    mutationFn: () => api.bankSync(),
    onSuccess: (r) => {
      for (const e of r.errors) toast.error(e);
      qc.invalidateQueries({ queryKey: ["bank-sync-status"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["journey"] });
    },
    onError: (e: Error) => toast.error("Couldn't start the import", { description: e.message }),
  });
  const reconnect = useMutation({
    mutationFn: () => api.bankConnect("connect"),
    onSuccess: (r) => {
      window.location.href = r.url;
    },
    onError: (e: Error) => toast.error("Couldn't open the bank connection", { description: e.message }),
  });

  if (q.isLoading) {
    return connected ? (
      <FtCard className="p-4">
        <Skeleton lines={2} />
      </FtCard>
    ) : null;
  }
  if (q.isError) return <ErrorState what="your import progress" error={q.error} onRetry={() => q.refetch()} />;

  const awaiting = connected && summary.phase === "none" && q.dataUpdatedAt - landedAt < FIRST_RUN_WAIT_MS;
  if (summary.phase === "none") {
    if (awaiting) {
      return (
        <FtCard className="p-4">
          <p role="status" aria-live="polite" className="text-sm font-semibold text-ink">
            Bank connected. Starting your import…
          </p>
        </FtCard>
      );
    }
    return connected ? (
      <FtCard className="p-4">
        <p className="text-sm font-semibold text-ink">Bank connected</p>
        <p className="mt-1 text-sm text-muted">No accounts came through to import. Check the list below, or connect again and pick the accounts to share.</p>
      </FtCard>
    ) : null;
  }

  // How long the oldest live run has been going (server time) as of this poll: no clock in render.
  const live = (q.data?.runs ?? []).filter((r) => r.status === "running" && !r.stale);
  const startedAt = Math.min(...live.map((r) => Date.parse(`${r.created_at.replace(" ", "T")}Z`)).filter(Number.isFinite));
  const elapsed = Number.isFinite(startedAt) ? q.dataUpdatedAt - startedAt : 0;

  return (
    <FtCard className={cx("space-y-3 p-4", summary.phase === "attention" && "border-warn/40")}>
      <div role="status" aria-live="polite">
        <p className="text-sm font-semibold text-ink">{importHeading(summary, elapsed)}</p>
        {summary.phase === "running" && (
          <p className="mt-1 text-sm text-muted">
            {summary.imported > 0 ? `${linesLabel(summary.imported)} so far. ` : ""}
            You can leave this page: the import keeps going and your transactions appear in Review as they land.
          </p>
        )}
        {summary.phase === "done" && summary.imported > 0 && <p className="mt-1 text-sm text-muted">They're ready to look through in Review.</p>}
      </div>
      {summary.phase === "running" && (
        <div aria-hidden className="h-1.5 overflow-hidden rounded-full bg-surface">
          <div className="h-full w-1/3 rounded-full bg-green motion-safe:animate-pulse" />
        </div>
      )}
      {summary.problems.length > 0 && (
        <ul className="space-y-2">
          {summary.problems.map((p) => (
            <li key={p.connection_id} className="flex flex-col gap-2 rounded-lg bg-warn/10 p-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-ink">
                {p.institution ? <span className="font-semibold">{p.institution}: </span> : null}
                {p.message}
              </p>
              {p.kind === "expired" ? (
                <FtButton onClick={() => reconnect.mutate()} busy={reconnect.isPending}>
                  Connect again
                </FtButton>
              ) : (
                <FtButton onClick={() => retry.mutate()} busy={retry.isPending}>
                  Try again
                </FtButton>
              )}
            </li>
          ))}
        </ul>
      )}
    </FtCard>
  );
}

// ── Connected accounts ───────────────────────────────────────────────────────────────────────────

function ConnectedAccounts() {
  const qc = useQueryClient();
  const conns = useQuery({ queryKey: ["bank-connections"], queryFn: () => api.bankConnections() });
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api.accounts() });
  const [link, setLink] = useState<Record<string, string>>({});

  const sync = useMutation({
    mutationFn: () => api.bankSync(),
    onSettled: () => qc.invalidateQueries({ queryKey: ["bank-sync-status"] }),
    onError: (e: Error) => toast.error("Couldn't start the import", { description: e.message }),
  });
  const save = useMutation({
    mutationFn: (sel: { providerAccountId: string; selected: boolean; accountId: string | null }[]) => api.bankSelectAccounts(sel),
    onSuccess: (r, sel) => {
      // Conflicts are per account and actionable (one source per account, no split history): show each verbatim.
      for (const c of r.conflicts) toast.error(c);
      setLink({});
      qc.invalidateQueries({ queryKey: ["bank-connections"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      // Switching an account on (or re-linking it) brings its lines in straight away.
      if (r.updated > 0 && r.conflicts.length === 0 && sel.some((s) => s.selected)) sync.mutate();
    },
    onError: (e: Error) => toast.error("Couldn't save", { description: e.message }),
  });

  if (conns.isLoading) return null;
  if (conns.isError) return <ErrorState what="your connected accounts" error={conns.error} onRetry={() => conns.refetch()} />;
  const rows = connectedAccounts(conns.data ?? []);
  if (rows.length === 0) return null;
  const busy = save.isPending || sync.isPending;
  const linkable = (accounts.data ?? []).filter((a) => a.source !== "qbo_feed");

  return (
    <Section title="Connected accounts">
      <FtCard>
        <ul className="divide-y divide-line">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">
                  {r.name}
                  {r.masked && <span className="ml-2 text-sm text-muted">••••{r.masked}</span>}
                </p>
                <p className="truncate text-xs text-muted">
                  {r.institution}
                  {r.connection_status === "expired" ? " · consent ended" : ""}
                </p>
              </div>
              <FtButton
                variant={r.on ? "primary" : "secondary"}
                aria-pressed={r.on}
                aria-label={`${r.name}: ${r.on ? "importing, tap to turn off" : "off, tap to turn on"}`}
                disabled={busy || r.connection_status !== "active"}
                onClick={() => save.mutate([toggleSelection(r, !r.on)])}
              >
                {r.on ? "On" : "Off"}
              </FtButton>
            </li>
          ))}
        </ul>
      </FtCard>
      <p className="text-xs text-muted">Only accounts that are on are imported. Turning one off stops new imports; lines already brought in stay.</p>
      <details className="rounded-2xl border border-line bg-paper p-3">
        <summary className="min-h-[44px] cursor-pointer py-2 text-sm font-semibold text-ink">Advanced: link to an existing account</summary>
        <div className="mt-2 space-y-3">
          <p className="text-sm text-muted">
            Each bank account gets its own account in Quillo. If you already set one up (say, for uploaded statements), you can link to it instead. An account has one
            source: a bank connection or statements, never both.
          </p>
          {rows.map((r) => (
            <LinkRow
              key={r.id}
              row={r}
              accounts={linkable}
              value={link[r.provider_account_id] ?? r.account_id ?? ""}
              onChange={(v) => setLink((prev) => ({ ...prev, [r.provider_account_id]: v }))}
              onSave={() => save.mutate([{ providerAccountId: r.provider_account_id, selected: true, accountId: link[r.provider_account_id] ?? null }])}
              dirty={!!link[r.provider_account_id] && link[r.provider_account_id] !== r.account_id}
              busy={busy}
            />
          ))}
          <p className="text-sm">
            <FtLink to="/settings#bank-connections">See what you've shared, or withdraw consent</FtLink>
          </p>
        </div>
      </details>
    </Section>
  );
}

function LinkRow({
  row,
  accounts,
  value,
  onChange,
  onSave,
  dirty,
  busy,
}: {
  row: ConnectedAccountRow;
  accounts: Account[];
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  dirty: boolean;
  busy: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <label className="min-w-0 flex-1 text-sm">
        <span className="block text-muted">
          {row.name}
          {row.masked ? ` ••••${row.masked}` : ""}
        </span>
        <select aria-label={`Quillo account for ${row.name}`} className={INPUT} value={value} onChange={(e) => onChange(e.target.value)} disabled={busy || row.connection_status !== "active"}>
          {!row.account_id && <option value="">A new account (default)</option>}
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <FtButton onClick={onSave} disabled={!dirty || busy}>
        Link
      </FtButton>
    </div>
  );
}

// ── Statement upload ─────────────────────────────────────────────────────────────────────────────

function StatementUpload() {
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api.accounts() });
  const fileRef = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<string>("");
  const [bankName, setBankName] = useState("");
  const [note, setNote] = useState<string | null>(null);
  // A parse holds the tenant's single Durable Object; one at a time, app-wide (the legacy page shares the key).
  const anyParsing = useIsMutating({ mutationKey: ["parseStatement"] }) > 0;
  const statementAccounts = (accounts.data ?? []).filter((a) => a.source === "statement" || a.source === "manual");
  const chosen = target || statementAccounts[0]?.id || "new";
  const hasFeed = (accounts.data ?? []).some((a) => a.source === "cdr_feed");

  const upload = useMutation({
    mutationKey: ["parseStatement"],
    mutationFn: async (file: File) => {
      let accountId = chosen;
      if (accountId === "new") {
        const name = bankName.trim() || "Bank account";
        accountId = (await api.addAccount({ name, institution: bankName.trim() || null, type: "transaction", source: "statement" })).id;
      }
      return api.parseStatement(file, accountId);
    },
    onMutate: () => setNote("Reading your statement…"),
    onSuccess: (p) => {
      setNote(p.duplicate ? "This exact file was already uploaded." : "Read. Check it below, then import.");
      setBankName("");
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["statements"] });
    },
    onError: (e: Error) => {
      setNote(null);
      toast.error("Couldn't read that file", { description: e.message });
    },
    onSettled: () => {
      if (fileRef.current) fileRef.current.value = "";
    },
  });

  return (
    <FtCard className="space-y-3 p-4">
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-ink">Which account is it for?</span>
        <select className={INPUT} value={chosen} onChange={(e) => setTarget(e.target.value)} disabled={upload.isPending}>
          {statementAccounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
          <option value="new">A new account</option>
        </select>
      </label>
      {chosen === "new" && (
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-ink">Bank and account name</span>
          <input className={INPUT} value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="e.g. CommBank Everyday" disabled={upload.isPending} />
        </label>
      )}
      {hasFeed && (
        <p className="text-sm text-warn">Already importing this account through your bank connection? Don't upload its statement as well: the same spending would be in two accounts.</p>
      )}
      <input
        ref={fileRef}
        type="file"
        accept=".csv,.pdf,text/csv,application/pdf"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) upload.mutate(f);
        }}
      />
      <FtButton variant="primary" className="w-full sm:w-auto" onClick={() => fileRef.current?.click()} busy={upload.isPending} disabled={anyParsing && !upload.isPending}>
        {upload.isPending ? "Reading…" : "Choose a file (CSV or PDF)"}
      </FtButton>
      {note && (
        <p role="status" aria-live="polite" className="text-sm text-muted">
          {note}
        </p>
      )}
    </FtCard>
  );
}

// ── Uploaded statements ──────────────────────────────────────────────────────────────────────────

const TONE_BADGE = { ok: "ok", warn: "warn", danger: "danger", neutral: "neutral" } as const;

function Statements() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["statements"],
    queryFn: () => api.statements(),
    refetchInterval: (query) => ((query.state.data ?? []).some((s) => s.status === "categorising") ? 5000 : false),
  });
  const confirm = useMutation({
    mutationFn: ({ id, force }: { id: string; force: boolean }) => api.confirmImport(id, force),
    onSuccess: (r) => {
      toast.success(`Imported ${linesLabel(r.imported)}`, { description: r.skipped ? `${r.skipped} were already on file.` : "Sorting them now. You can keep going." });
      for (const key of ["statements", "accounts", "transactions", "journey", "progress", "dashboard"]) qc.invalidateQueries({ queryKey: [key] });
    },
    onError: (e: Error) => toast.error("Import didn't go through", { description: e.message }),
  });

  if (q.isLoading || q.isError) return q.isError ? <ErrorState what="your statements" error={q.error} onRetry={() => q.refetch()} /> : null;
  const rows = q.data ?? [];
  if (rows.length === 0) return null;
  return (
    <Section title="Uploaded statements">
      <FtCard>
        <ul className="divide-y divide-line">
          {rows.map((s: StatementInfo) => {
            const v = statementView(s);
            return (
              <li key={s.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{s.filename ?? "Statement"}</p>
                  <div className="mt-1">
                    <Badge tone={TONE_BADGE[v.tone]}>{v.label}</Badge>
                  </div>
                </div>
                {v.action && (
                  <FtButton
                    variant={v.action === "import" ? "primary" : "danger"}
                    onClick={() => confirm.mutate({ id: s.id, force: v.action === "force" })}
                    busy={confirm.isPending && confirm.variables?.id === s.id}
                    disabled={confirm.isPending}
                  >
                    {v.action === "import" ? "Import" : "Import anyway"}
                  </FtButton>
                )}
              </li>
            );
          })}
        </ul>
      </FtCard>
    </Section>
  );
}

// ── Income statement: waiting until Tax ready ────────────────────────────────────────────────────

function IncomeWaiting() {
  const { fy, label } = useActiveFy();
  // A legacy /income link lands here as /connect#income: open the form it was pointing at.
  const { hash } = useLocation();
  const [adding, setAdding] = useState(hash === "#income");
  // Keyed under ["income", label] so every Income write (which invalidates that prefix) refreshes the card.
  const q = useQuery({ queryKey: ["income", label, "statement-wait"], queryFn: () => api.incomeStatements(fy) });

  if (q.isLoading) return null;
  return (
    <Section id="income" title="Your income statement">
      {q.isError ? (
        <ErrorState what="your income statement status" error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <ul className="space-y-2">
          {incomeWaitItems(q.data!).map((it) => (
            <li key={it.key}>
              <FtCard className="space-y-2 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={it.state === "added" ? "ok" : "neutral"}>{it.state === "added" ? "Added" : "Waiting"}</Badge>
                  <p className="text-sm font-semibold text-ink">{it.title}</p>
                </div>
                <p className="max-w-[65ch] text-sm text-muted">{it.body}</p>
                {it.chase && <p className="max-w-[65ch] text-sm font-medium text-warn">{it.chase}</p>}
              </FtCard>
            </li>
          ))}
        </ul>
      )}
      <FtButton className="w-full sm:w-auto" onClick={() => setAdding((v) => !v)} aria-expanded={adding}>
        {adding ? "Done adding" : "Add an income statement or other income"}
      </FtButton>
      {adding && (
        <div className="rounded-2xl border border-line bg-paper p-3">
          <Income />
        </div>
      )}
    </Section>
  );
}
