import type { Env } from "../env";
import { featureOn } from "./features";
import { isAdmin } from "./roles";
import { getProfile } from "./db";
import { signBedrockInvoke } from "./sigv4";
import { AU_DESCRIPTOR } from "./jurisdiction";
import { awsCredentialsFor, bedrockModelIdFor, resolveProvider } from "../llm";

// ── Security & compliance dashboard (#636, A3 of epic #633) ──────────────────────────────────────
//
// One admin-only page the owner can show Fiskil: every Schedule 2 / readiness signal in one place.
// Owner direction (2026-10-08): NO always-on scanning and NO alert emails. So:
//   • GET  /api/admin/security        — a PASSIVE read: cheap D1/KV counts + the last stored check
//                                        snapshot + whatever the other A/B tickets have published.
//   • POST /api/admin/security/check  — runs the LIVE checks (outbound probes) and stores the snapshot.
//                                        Only while `security_monitoring` is ON.
//   • the 10-minute cron              — runs the same checks at most once a day, only while the flag is ON.
// Both routes 404 for a non-admin (the page doesn't exist for them), enforced server-side here.
//
// PRIVACY CONTRACT: the payload carries COUNTS, IDS (tenant user_id, object keys, workflow names) and
// TIMESTAMPS only. Never an email, a name, a merchant, a description, a CDR field or a vendor error
// body — check errors are reduced to an HTTP status / error class. A unit test asserts this.
//
// Storage: KV (`RULES`), not a table. The snapshot is ONE global document overwritten each run, with
// no per-tenant rows and no query need, so a table (migration 0089) would add a schema + purge
// surface for nothing. It is platform telemetry, not tenant data ⇒ nothing for PURGE_TABLES.

export const SECURITY_REPO = "matchmoments-admin/quillo";
export const SECURITY_ORIGIN = "https://app.quillo.au";
/** Scheduled cadence while the flag is ON: the 10-minute cron runs the checks at most this often. */
export const SCHEDULED_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
/** "Run checks now" can't be hammered: at most one manual run per minute. */
export const MANUAL_MIN_INTERVAL_MS = 60 * 1000;

export const SECURITY_KV = {
  snapshot: "security:snapshot",
  /** Where another ticket publishes its panel's source record (see SecuritySourceRecord). */
  source: (k: SecuritySourceKey) => `security:source:${k}`,
} as const;

// ── Panel source contract ────────────────────────────────────────────────────────────────────────
// Each panel whose source is built by ANOTHER ticket lights up when that ticket writes ONE JSON
// document to KV `security:source:<key>` (binding RULES) in the SecuritySourceRecord shape below.
// Until then the panel says "Not yet set up" — never a fabricated status.
//
//   key              ticket  writer                                   expected metrics / rows
//   control_matrix   #642    `npm run security:push-docs` (parses     rows = one per Schedule 2 control
//                            docs/security/control-matrix.md)         (id, label, status ok|warn|todo)
//   osp_register     #642    same script (docs/security/osp-register) rows = one per OSP (label = country)
//   backups          #635    the daily D1-export cron, after a        last_restore_test_at, last_restore_result,
//                            restore test                              (the latest export itself is read live from BACKUPS)
//   zap              #640    the weekly ZAP baseline workflow         high, medium, low, run_url
//   mfa              #638    whoever moves Clerk to production         mfa_enforced_for_admin (bool), instance
//   retention        #639    the retention / minimisation cron        last_run_at, flagged, deleted, deletion_queue
//   residency        #641    the residency verification               au_inference_verified_at, refusal_test
export const SECURITY_SOURCE_KEYS = ["control_matrix", "osp_register", "backups", "zap", "mfa", "retention", "residency"] as const;
export type SecuritySourceKey = (typeof SECURITY_SOURCE_KEYS)[number];

export type PanelStatus = "ok" | "warn" | "fail" | "not_set_up" | "not_checked";
type Metric = number | string | boolean | null;
export interface EvidenceLink { label: string; href: string }
export interface StatusRow { id: string; label: string; status: "ok" | "warn" | "todo"; note?: string }

export interface SecuritySourceRecord {
  at: string; // ISO timestamp the source last ran / was published
  status: "ok" | "warn" | "fail";
  summary: string;
  metrics?: Record<string, Metric>;
  rows?: StatusRow[];
  evidence?: EvidenceLink[];
}

export interface CheckResult {
  status: "ok" | "warn" | "fail" | "not_set_up";
  checked_at: string;
  summary: string;
  metrics: Record<string, Metric>;
}
export const CHECK_KEYS = ["healthz", "headers", "bedrock", "backups", "github"] as const;
export type CheckKey = (typeof CHECK_KEYS)[number];
export interface CheckSnapshot { at: string; trigger: "manual" | "schedule"; checks: Record<CheckKey, CheckResult> }

export interface Panel {
  key: string;
  title: string;
  status: PanelStatus;
  checked_at: string | null;
  summary: string;
  metrics: Record<string, Metric>;
  rows?: StatusRow[];
  evidence: EvidenceLink[];
  /** The ticket whose work lights this panel up when it's still "Not yet set up". */
  pending_ticket?: number;
}

export interface SecurityDashboard {
  generated_at: string;
  monitoring_enabled: boolean;
  last_check_at: string | null;
  last_check_trigger: "manual" | "schedule" | null;
  panels: Panel[];
}

// ── Sanitisers (everything that reaches the payload passes through these) ──────────────────────

const clip = (s: unknown, n = 160): string => String(s ?? "").replace(/[\r\n\t]+/g, " ").slice(0, n);
const isIso = (s: unknown): s is string => typeof s === "string" && !Number.isNaN(Date.parse(s));

function cleanMetrics(m: unknown): Record<string, Metric> {
  const out: Record<string, Metric> = {};
  if (!m || typeof m !== "object") return out;
  for (const [k, v] of Object.entries(m as Record<string, unknown>).slice(0, 30)) {
    const key = clip(k, 60);
    if (v === null || typeof v === "boolean") out[key] = v;
    else if (typeof v === "number") out[key] = Number.isFinite(v) ? v : null;
    else if (typeof v === "string") out[key] = clip(v);
  }
  return out;
}

function cleanEvidence(e: unknown): EvidenceLink[] {
  if (!Array.isArray(e)) return [];
  return e
    .filter((x): x is { label: unknown; href: unknown } => !!x && typeof x === "object")
    .map((x) => ({ label: clip(x.label, 80), href: clip(x.href, 300) }))
    // Only https links or repo-relative doc paths — never javascript:/data: into an admin page.
    .filter((x) => x.label && (/^https:\/\//.test(x.href) || /^(docs|src|scripts|\.github)\//.test(x.href)))
    .map((x) => ({ ...x, href: x.href.startsWith("https://") ? x.href : repoLink(x.href) }))
    .slice(0, 10);
}

function cleanRows(r: unknown): StatusRow[] | undefined {
  if (!Array.isArray(r)) return undefined;
  return r
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x): StatusRow => ({
      id: clip(x.id, 40),
      label: clip(x.label, 160),
      status: x.status === "ok" || x.status === "warn" ? x.status : ("todo" as const),
      ...(x.note ? { note: clip(x.note, 160) } : {}),
    }))
    .slice(0, 120);
}

/** Parse + validate a published source record. Malformed ⇒ null (the panel then says "Not yet set up"). */
export function parseSourceRecord(raw: string | null): SecuritySourceRecord | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== "object" || !isIso(v.at)) return null;
    const status = v.status === "ok" || v.status === "warn" || v.status === "fail" ? v.status : null;
    if (!status) return null;
    return { at: v.at, status, summary: clip(v.summary, 240), metrics: cleanMetrics(v.metrics), rows: cleanRows(v.rows), evidence: cleanEvidence(v.evidence) };
  } catch {
    return null;
  }
}

export const repoLink = (path: string) => `https://github.com/${SECURITY_REPO}/blob/main/${path}`;

// ── Markdown status-table parser (the control matrix + OSP register docs → a source record) ──────

/** A cell's status glyph/word → row status. ✅/done/yes ⇒ ok; 🟡/partial/in progress ⇒ warn; else todo. */
export function statusFromCell(cell: string): StatusRow["status"] {
  const c = cell.toLowerCase();
  if (/✅|\bdone\b|\bmet\b|\bcomplete/.test(c)) return "ok";
  if (/🟡|partial|in progress|\bwip\b/.test(c)) return "warn";
  return "todo";
}

/**
 * Parse every GitHub-flavoured markdown table in `md` into rows. `idCol` / `labelCol` / `statusCol` /
 * `noteCol` are matched case-insensitively against header text (first match wins); a table missing
 * the id or label column is skipped. No status column ⇒ every row is "ok" (e.g. the OSP register).
 */
export function parseStatusTables(
  md: string,
  cols: { id: RegExp; label: RegExp; status?: RegExp; note?: RegExp },
): StatusRow[] {
  const lines = md.split(/\r?\n/);
  const rows: StatusRow[] = [];
  const cellsOf = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  for (let i = 0; i + 1 < lines.length; i++) {
    const head = lines[i]!;
    const sep = lines[i + 1]!;
    if (!head.trim().startsWith("|") || !/^\s*\|?\s*:?-{3,}/.test(sep)) continue;
    const h = cellsOf(head).map((c) => c.replace(/[*_`]/g, "").toLowerCase());
    const find = (re?: RegExp) => (re ? h.findIndex((c) => re.test(c)) : -1);
    const iId = find(cols.id);
    const iLabel = find(cols.label);
    const iStatus = find(cols.status);
    const iNote = find(cols.note);
    if (iId < 0 || iLabel < 0) continue;
    let j = i + 2;
    for (; j < lines.length && lines[j]!.trim().startsWith("|"); j++) {
      const c = cellsOf(lines[j]!);
      const id = (c[iId] ?? "").replace(/[*_`]/g, "");
      if (!id) continue;
      rows.push({
        id: clip(id, 40),
        label: clip((c[iLabel] ?? "").replace(/[*_`]/g, ""), 160),
        status: iStatus >= 0 ? statusFromCell(c[iStatus] ?? "") : "ok",
        ...(iNote >= 0 && c[iNote] ? { note: clip(c[iNote], 160) } : {}),
      });
    }
    i = j - 1;
  }
  return rows;
}

/** docs/security/control-matrix.md → the control_matrix source record (null when no table parsed). */
export function controlMatrixRecord(md: string, at: string): SecuritySourceRecord | null {
  const rows = parseStatusTables(md, { id: /^(id|#|ref|clause|control id)$/, label: /control|requirement|description/, status: /status/, note: /evidence/ });
  if (!rows.length) return null;
  const done = rows.filter((r) => r.status === "ok").length;
  const partial = rows.filter((r) => r.status === "warn").length;
  const todo = rows.length - done - partial;
  return {
    at, status: todo === 0 && partial === 0 ? "ok" : "warn",
    summary: `${done} of ${rows.length} controls met, ${partial} partial, ${todo} not started`,
    metrics: { total: rows.length, done, partial, todo },
    rows,
    evidence: [{ label: "docs/security/control-matrix.md", href: repoLink("docs/security/control-matrix.md") }],
  };
}

/** docs/security/osp-register.md → the osp_register source record (label = country). */
export function ospRegisterRecord(md: string, at: string): SecuritySourceRecord | null {
  const rows = parseStatusTables(md, { id: /service|provider|osp|name/, label: /country|location|region/, note: /role|purpose|data/ });
  if (!rows.length) return null;
  const countries = [...new Set(rows.map((r) => r.label).filter(Boolean))].sort();
  return {
    at, status: "ok",
    summary: `${rows.length} outsourced service providers across ${countries.length} ${countries.length === 1 ? "country" : "countries"}`,
    metrics: { providers: rows.length, countries: countries.join(", ") },
    rows,
    evidence: [{ label: "docs/security/osp-register.md", href: repoLink("docs/security/osp-register.md") }],
  };
}

// ── Live checks (outbound; flag-gated by the callers) ────────────────────────────────────────────

export interface CheckDeps { fetch: typeof fetch; now: () => Date }
const defaultDeps = (): CheckDeps => ({ fetch: (i, init) => fetch(i, init), now: () => new Date() });

const errClass = (e: unknown): string => {
  const name = e instanceof Error ? e.name : "Error";
  return name === "TimeoutError" || name === "AbortError" ? "timeout" : clip(name, 40);
};
const withTimeout = (init: RequestInit = {}): RequestInit => ({ ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

async function checkHealthz(d: CheckDeps): Promise<CheckResult> {
  const at = d.now().toISOString();
  const t0 = Date.now();
  try {
    const res = await d.fetch(`${SECURITY_ORIGIN}/healthz`, withTimeout());
    const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
    const ok = res.ok && body?.ok === true;
    return { status: ok ? "ok" : "fail", checked_at: at, summary: ok ? "/healthz answered ok" : `/healthz returned HTTP ${res.status}`, metrics: { http_status: res.status, latency_ms: Date.now() - t0 } };
  } catch (e) {
    return { status: "fail", checked_at: at, summary: `/healthz unreachable (${errClass(e)})`, metrics: { error: errClass(e) } };
  }
}

/** Pure: which security headers does this response carry? */
export function assessHeaders(h: Headers): CheckResult["metrics"] & { hsts: boolean; csp_enforcing: boolean } {
  const hstsRaw = h.get("strict-transport-security") ?? "";
  const maxAge = Number(/max-age=(\d+)/i.exec(hstsRaw)?.[1] ?? 0);
  return {
    hsts: maxAge >= 15552000, // ≥ 180 days (Mozilla Observatory's bar)
    hsts_max_age: maxAge || null,
    csp_enforcing: !!h.get("content-security-policy"),
    csp_report_only: !!h.get("content-security-policy-report-only"),
    x_content_type_options: (h.get("x-content-type-options") ?? "").toLowerCase() === "nosniff",
    referrer_policy: clip(h.get("referrer-policy") ?? "", 60) || null,
  };
}

async function checkHeaders(d: CheckDeps): Promise<CheckResult> {
  const at = d.now().toISOString();
  try {
    const res = await d.fetch(`${SECURITY_ORIGIN}/`, withTimeout({ redirect: "manual" }));
    const m = assessHeaders(res.headers);
    const missing = [!m.hsts && "HSTS", !m.csp_enforcing && "enforcing CSP"].filter(Boolean);
    return {
      status: missing.length ? "warn" : "ok", checked_at: at,
      summary: missing.length ? `Missing: ${missing.join(", ")}${m.csp_report_only && !m.csp_enforcing ? " (CSP is report-only)" : ""}` : "HSTS present and CSP enforcing",
      metrics: { ...m, http_status: res.status },
    };
  } catch (e) {
    return { status: "fail", checked_at: at, summary: `Couldn't fetch ${SECURITY_ORIGIN} (${errClass(e)})`, metrics: { error: errClass(e) } };
  }
}

/**
 * Bedrock `au.` reachability: one InvokeModel with a FIXED, content-free prompt ("ping", max_tokens 1)
 * against the AU inference profile in the first AU region. No tenant data; cost is a few tokens. Proves
 * the credentials, the region, model access and the use-case form all line up — the A8 precondition.
 */
async function checkBedrock(env: Env, d: CheckDeps): Promise<CheckResult> {
  const at = d.now().toISOString();
  const { accessKeyId, secretAccessKey } = awsCredentialsFor(env, AU_DESCRIPTOR);
  const region = AU_DESCRIPTOR.residency.regions[0]!;
  const modelId = bedrockModelIdFor(AU_DESCRIPTOR);
  if (!accessKeyId || !secretAccessKey) {
    return { status: "not_set_up", checked_at: at, summary: "AWS AU credentials aren't configured", metrics: { region, profile: modelId } };
  }
  try {
    const body = JSON.stringify({ anthropic_version: "bedrock-2023-05-31", max_tokens: 1, messages: [{ role: "user", content: "ping" }] });
    const signed = await signBedrockInvoke({ region, accessKeyId, secretAccessKey, modelId, body, now: d.now() });
    const res = await d.fetch(signed.url, withTimeout({ method: "POST", headers: signed.headers, body: signed.body }));
    await res.body?.cancel(); // only the status matters; never read (or keep) the model output
    return {
      status: res.ok ? "ok" : "fail", checked_at: at,
      summary: res.ok ? `au. inference reachable in ${region}` : `Bedrock ${region} returned HTTP ${res.status}`,
      metrics: { region, profile: modelId, http_status: res.status },
    };
  } catch (e) {
    return { status: "fail", checked_at: at, summary: `Bedrock ${region} unreachable (${errClass(e)})`, metrics: { region, profile: modelId, error: errClass(e) } };
  }
}

/** Newest object in the BACKUPS bucket (listing only — never reads a body). */
async function checkBackups(env: Env, d: CheckDeps): Promise<CheckResult> {
  const at = d.now().toISOString();
  if (!env.BACKUPS) return { status: "not_set_up", checked_at: at, summary: "No BACKUPS bucket bound", metrics: {} };
  try {
    let newest: R2Object | null = null;
    let count = 0;
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const l = await env.BACKUPS.list({ limit: 1000, cursor });
      for (const o of l.objects) {
        count++;
        if (!newest || o.uploaded > newest.uploaded) newest = o;
      }
      if (!l.truncated) break;
      cursor = l.cursor;
    }
    if (!newest) return { status: "fail", checked_at: at, summary: "Backup bucket is empty", metrics: { objects: 0 } };
    const ageH = Math.round((d.now().getTime() - newest.uploaded.getTime()) / 36e5);
    return {
      status: ageH <= 36 ? "ok" : "warn", checked_at: at,
      summary: `Latest export ${ageH}h old`,
      metrics: { last_export_at: newest.uploaded.toISOString(), key: clip(newest.key, 120), size_bytes: newest.size, age_hours: ageH, objects: count },
    };
  } catch (e) {
    return { status: "fail", checked_at: at, summary: `Couldn't list the backup bucket (${errClass(e)})`, metrics: { error: errClass(e) } };
  }
}

/**
 * GitHub scanning: open alert counts (code scanning, Dependabot, secret scanning) — these endpoints
 * need a token even on a public repo, so without GITHUB_TOKEN they show "needs token" — plus the
 * latest CodeQL / ZAP workflow runs from the PUBLIC Actions API (no token needed).
 */
async function checkGithub(env: Env, d: CheckDeps): Promise<CheckResult> {
  const at = d.now().toISOString();
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "quillo-security-dashboard", "x-github-api-version": "2022-11-28" };
  if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const api = `https://api.github.com/repos/${SECURITY_REPO}`;
  const metrics: Record<string, Metric> = { token: !!env.GITHUB_TOKEN };
  const count = async (k: string, path: string) => {
    try {
      const res = await d.fetch(`${api}/${path}?state=open&per_page=100`, withTimeout({ headers }));
      if (!res.ok) {
        // Unauthenticated calls share Cloudflare's egress IPs (60/h) — a 403 with no quota left is a rate limit, not "needs token".
        const rateLimited = res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
        metrics[k] = rateLimited ? "rate limited"
          : res.status === 401 || res.status === 403 || res.status === 404 ? (env.GITHUB_TOKEN ? `HTTP ${res.status}` : "needs token")
          : `HTTP ${res.status}`;
        await res.body?.cancel();
        return;
      }
      const arr = (await res.json()) as unknown;
      metrics[k] = Array.isArray(arr) ? arr.length : null; // 100 ⇒ "100+" in the UI
    } catch (e) {
      metrics[k] = errClass(e);
    }
  };
  await Promise.all([
    count("code_scanning_open", "code-scanning/alerts"),
    count("dependabot_open", "dependabot/alerts"),
    count("secret_scanning_open", "secret-scanning/alerts"),
    (async () => {
      try {
        const res = await d.fetch(`${api}/actions/runs?per_page=100`, withTimeout({ headers }));
        if (!res.ok) { metrics.workflows = `HTTP ${res.status}`; return; }
        const runs = ((await res.json()) as { workflow_runs?: { name?: string; conclusion?: string | null; status?: string; created_at?: string; html_url?: string }[] }).workflow_runs ?? [];
        for (const [k, re] of [["codeql", /codeql/i], ["zap", /zap/i]] as const) {
          const r = runs.find((x) => re.test(x.name ?? ""));
          if (r) {
            metrics[`${k}_last_run_at`] = isIso(r.created_at) ? r.created_at : null;
            metrics[`${k}_conclusion`] = clip(r.conclusion ?? r.status ?? "", 30);
            if (typeof r.html_url === "string" && r.html_url.startsWith("https://github.com/")) metrics[`${k}_run_url`] = clip(r.html_url, 200);
          }
        }
      } catch (e) {
        metrics.workflows = errClass(e);
      }
    })(),
  ]);
  const counts = ["code_scanning_open", "dependabot_open", "secret_scanning_open"].map((k) => metrics[k]);
  const numeric = counts.filter((c): c is number => typeof c === "number");
  const anyCodeql = !!metrics.codeql_last_run_at;
  const status: CheckResult["status"] =
    numeric.some((n) => n > 0) || metrics.codeql_conclusion === "failure" ? "warn"
    : numeric.length === counts.length && anyCodeql ? "ok"
    : !anyCodeql && numeric.length === 0 ? "not_set_up"
    : "warn";
  const summary =
    numeric.length === counts.length ? `${numeric.reduce((a, b) => a + b, 0)} open alerts across code, dependency and secret scanning`
    : anyCodeql ? "CodeQL runs found; alert counts need a GITHUB_TOKEN"
    : "No CodeQL runs or alert access yet";
  return { status, checked_at: at, summary, metrics };
}

/** Run every live check and store the snapshot in KV. Callers enforce the flag. */
export async function runSecurityChecks(env: Env, trigger: CheckSnapshot["trigger"], deps: CheckDeps = defaultDeps()): Promise<CheckSnapshot> {
  const [healthz, headers, bedrock, backups, github] = await Promise.all([
    checkHealthz(deps), checkHeaders(deps), checkBedrock(env, deps), checkBackups(env, deps), checkGithub(env, deps),
  ]);
  const snap: CheckSnapshot = { at: deps.now().toISOString(), trigger, checks: { healthz, headers, bedrock, backups, github } };
  await env.RULES.put(SECURITY_KV.snapshot, JSON.stringify(snap));
  return snap;
}

/**
 * The cron hook. Flag OFF ⇒ returns immediately having touched NOTHING (no KV read, no fetch).
 * Flag ON ⇒ runs the checks only when the last snapshot is older than SCHEDULED_INTERVAL_MS.
 */
export async function runScheduledSecurityChecks(env: Env, deps: CheckDeps = defaultDeps()): Promise<"flag_off" | "fresh" | "ran"> {
  if (!featureOn(env, "security_monitoring")) return "flag_off";
  const last = await readSnapshot(env);
  if (last && deps.now().getTime() - Date.parse(last.at) < SCHEDULED_INTERVAL_MS) return "fresh";
  await runSecurityChecks(env, "schedule", deps);
  return "ran";
}

export async function readSnapshot(env: Env): Promise<CheckSnapshot | null> {
  try {
    const raw = await env.RULES.get(SECURITY_KV.snapshot);
    if (!raw) return null;
    const v = JSON.parse(raw) as CheckSnapshot;
    return isIso(v?.at) && v.checks ? v : null;
  } catch {
    return null;
  }
}

// ── Passive reads (counts only) ──────────────────────────────────────────────────────────────────

/** Run a count query; a missing table / transient error ⇒ null (the panel shows "—", never a fake 0). */
async function n(env: Env, sql: string, ...binds: unknown[]): Promise<number | null> {
  try {
    const r = await env.DB.prepare(sql).bind(...binds).first<{ n: number }>();
    return Number(r?.n ?? 0);
  } catch {
    return null;
  }
}

async function kvNum(env: Env, key: string): Promise<number> {
  try {
    return Number((await env.RULES.get(key)) ?? 0) || 0;
  } catch {
    return 0;
  }
}

const fromCheck = (c: CheckResult | undefined): Pick<Panel, "status" | "checked_at" | "summary" | "metrics"> =>
  c ? { status: c.status, checked_at: c.checked_at, summary: c.summary, metrics: c.metrics }
    : { status: "not_checked", checked_at: null, summary: "Not checked yet — run checks to populate", metrics: {} };

const worst = (...s: PanelStatus[]): PanelStatus => {
  for (const x of ["fail", "warn", "ok", "not_checked", "not_set_up"] as const) if (s.includes(x)) return x;
  return "not_set_up";
};

export async function buildSecurityDashboard(env: Env, now: Date = new Date()): Promise<SecurityDashboard> {
  const snap = await readSnapshot(env);
  const src = Object.fromEntries(
    await Promise.all(SECURITY_SOURCE_KEYS.map(async (k) => [k, parseSourceRecord(await env.RULES.get(SECURITY_KV.source(k)).catch(() => null))] as const)),
  ) as Record<SecuritySourceKey, SecuritySourceRecord | null>;
  const c = snap?.checks;
  const day = now.toISOString().slice(0, 10);
  const yday = new Date(now.getTime() - 864e5).toISOString().slice(0, 10);

  const notSetUp = (key: string, title: string, ticket: number, why: string, evidence: EvidenceLink[] = []): Panel =>
    ({ key, title, status: "not_set_up", checked_at: null, summary: `Not yet set up — ${why} (#${ticket})`, metrics: {}, evidence, pending_ticket: ticket });
  const fromSource = (key: string, title: string, r: SecuritySourceRecord, evidence: EvidenceLink[] = []): Panel =>
    ({ key, title, status: r.status, checked_at: r.at, summary: r.summary, metrics: r.metrics ?? {}, rows: r.rows, evidence: [...(r.evidence ?? []), ...evidence] });

  const panels: Panel[] = [];

  // 1. Schedule 2 control matrix (#642)
  panels.push(src.control_matrix ? fromSource("control_matrix", "Schedule 2 control matrix", src.control_matrix)
    : notSetUp("control_matrix", "Schedule 2 control matrix", 642, "publish docs/security/control-matrix.md with `npm run security:push-docs`"));

  // 2. Backups and DR (#635): latest export read live from BACKUPS + the restore-test record.
  {
    const b = c?.backups;
    const r = src.backups;
    // A daily job that stopped firing leaves its last "ok" record behind forever — age it here so a
    // dead cron shows as stale even while the live checks (security_monitoring) are OFF.
    const stale = !!r && now.getTime() - Date.parse(r.at) > 36 * 36e5;
    const rStatus: PanelStatus = r ? (stale ? worst(r.status, "warn") : r.status) : "not_set_up";
    if ((!b || b.status === "not_set_up") && !r) panels.push(notSetUp("backups", "Backups and DR", 635, "no D1 export bucket or restore test recorded"));
    else {
      const live = fromCheck(b);
      panels.push({
        key: "backups", title: "Backups and DR",
        status: r ? worst(live.status === "not_set_up" || live.status === "not_checked" ? rStatus : live.status, rStatus) : live.status,
        checked_at: live.checked_at ?? r?.at ?? null,
        summary: [stale ? `No backup run recorded since ${r!.at.slice(0, 10)} — the daily export may have stopped` : null, b && b.status !== "not_set_up" ? b.summary : null, r?.summary].filter(Boolean).join(" · ") || live.summary,
        metrics: { ...live.metrics, ...(r?.metrics ?? {}) },
        evidence: [...(r?.evidence ?? []), { label: "D1 Time Travel (30 days, built in)", href: "https://developers.cloudflare.com/d1/reference/time-travel/" }],
      });
    }
  }

  // 3. Security scanning (#640): GitHub alerts/runs (live) + the ZAP record.
  {
    const g = c?.github;
    const z = src.zap;
    const ghEvidence = { label: "GitHub security overview", href: `https://github.com/${SECURITY_REPO}/security` };
    if ((!g || g.status === "not_set_up") && !z) {
      panels.push(g ? { ...notSetUp("scanning", "Security scanning", 640, "no CodeQL / Dependabot / secret-scanning / ZAP results yet", [ghEvidence]), checked_at: g.checked_at, metrics: g.metrics }
        : { key: "scanning", title: "Security scanning", ...fromCheck(undefined), evidence: [ghEvidence], pending_ticket: 640 });
    } else {
      const live = fromCheck(g);
      panels.push({
        key: "scanning", title: "Security scanning",
        status: z ? worst(live.status === "not_set_up" ? z.status : live.status, z.status) : live.status,
        checked_at: live.checked_at ?? z?.at ?? null,
        summary: [g?.summary, z ? `ZAP: ${z.summary}` : "ZAP baseline not recorded yet"].filter(Boolean).join(" · "),
        metrics: { ...live.metrics, ...Object.fromEntries(Object.entries(z?.metrics ?? {}).map(([k, v]) => [`zap_${k}`, v])) },
        evidence: [ghEvidence, ...(z?.evidence ?? [])],
      });
    }
  }

  // 4. Security headers (#634) — live.
  panels.push({ key: "headers", title: "Security headers", ...fromCheck(c?.headers), evidence: [{ label: "src/index.ts (withSecurityHeaders)", href: repoLink("src/index.ts") }] });

  // 5. Errors and health — live counts + the healthz self-check.
  {
    const costErrors = (await kvNum(env, `cost_errors:${day}`)) + (await kvNum(env, `cost_errors:${yday}`));
    const syncFailed = await n(env, `SELECT COUNT(*) AS n FROM bank_sync_runs WHERE status = 'failed' AND created_at >= datetime('now','-7 days')`);
    const syncPartial = await n(env, `SELECT COUNT(*) AS n FROM bank_sync_runs WHERE status = 'partial' AND created_at >= datetime('now','-7 days')`);
    const syncStale = await n(env, `SELECT COUNT(*) AS n FROM bank_sync_runs WHERE status = 'running' AND COALESCE(updated_at, created_at) < datetime('now','-1 hour')`);
    const purgeFailures = await n(env, `SELECT COUNT(*) AS n FROM cdr_audit_log WHERE event = 'upstream_revoke_failed' AND created_at >= datetime('now','-30 days')`);
    const cap = Number(env.MAX_DAILY_COST_CENTS ?? 0);
    const capHits = cap > 0 ? await n(env, `SELECT COUNT(*) AS n FROM daily_cost WHERE scope <> 'global' AND day = ? AND cents_e4 >= ?`, day, cap * 10000) : 0;
    const globalCeiling = Number(env.MAX_DAILY_COST_CENTS_GLOBAL ?? 0);
    const globalToday = await n(env, `SELECT COALESCE(MAX(cents_e4), 0) AS n FROM daily_cost WHERE scope = 'global' AND day = ?`, day);
    const globalHit = globalCeiling > 0 && globalToday !== null && globalToday / 10000 >= globalCeiling;
    const h = c?.healthz;
    const problems = [costErrors > 0, (syncFailed ?? 0) > 0, (syncStale ?? 0) > 0, (purgeFailures ?? 0) > 0, (capHits ?? 0) > 0, globalHit].filter(Boolean).length;
    const status: PanelStatus = h?.status === "fail" ? "fail" : problems ? "warn" : "ok";
    panels.push({
      key: "errors", title: "Errors and health", status, checked_at: h?.checked_at ?? now.toISOString(),
      summary: `${problems ? `${problems} signal${problems === 1 ? "" : "s"} need a look` : "No errors in the window"}${h ? ` · ${h.summary}` : " · /healthz not checked yet"}`,
      metrics: {
        cost_errors_48h: costErrors, bank_sync_failed_7d: syncFailed, bank_sync_partial_7d: syncPartial, bank_sync_stalled: syncStale,
        purge_or_revoke_failures_30d: purgeFailures, tenants_at_daily_cap_today: capHits, global_ceiling_hit_today: globalHit,
        healthz: h ? h.status : null, healthz_latency_ms: (h?.metrics.latency_ms as number | undefined) ?? null,
      },
      evidence: [{ label: "src/lib/usage.ts (cost_errors counter)", href: repoLink("src/lib/usage.ts") }, { label: "src/lib/bank-sync.ts (run outcomes)", href: repoLink("src/lib/bank-sync.ts") }],
    });
  }

  // 6. Access control (#638): admin accounts (ids only), Clerk instance, MFA record.
  {
    let adminIds: string[] = [];
    try {
      const rows = await env.DB.prepare(`SELECT user_id FROM profiles WHERE roles LIKE '%"admin"%' ORDER BY user_id LIMIT 20`).all<{ user_id: string }>();
      adminIds = (rows.results ?? []).map((r) => clip(r.user_id, 64));
    } catch { /* leave empty */ }
    const issuer = env.CLERK_ISSUER ?? "";
    const clerk = !issuer ? "not configured" : /\.clerk\.accounts\.dev/i.test(issuer) ? "development" : "production";
    const mfa = src.mfa;
    const mfaOn = mfa?.metrics?.mfa_enforced_for_admin === true;
    panels.push({
      key: "access", title: "Access control",
      status: mfa ? worst(mfa.status, clerk === "production" && mfaOn ? "ok" : "warn") : "warn",
      checked_at: mfa?.at ?? now.toISOString(),
      summary: `${adminIds.length} admin account${adminIds.length === 1 ? "" : "s"} · ${clerk === "not configured" ? "Clerk not configured" : `Clerk ${clerk} instance`} ·${mfa ? (mfaOn ? "MFA enforced for admins" : "MFA not enforced") : "MFA not yet set up (#638)"}`,
      metrics: { admin_accounts: adminIds.length, admin_ids: adminIds.join(", "), clerk_instance: clerk, mfa_enforced_for_admin: mfa ? mfaOn : null, ...(mfa?.metrics ?? {}) },
      evidence: [{ label: "src/lib/roles.ts (isAdmin, server-enforced)", href: repoLink("src/lib/roles.ts") }, ...(mfa?.evidence ?? [])],
      ...(mfa ? {} : { pending_ticket: 638 }),
    });
  }

  // 7. CDR activity — counts from cdr_audit_log (never a detail field).
  {
    const ev = async (e: string, days?: number) =>
      n(env, `SELECT COUNT(*) AS n FROM cdr_audit_log WHERE event = ?${days ? ` AND created_at >= datetime('now','-${days} days')` : ""}`, e);
    const [granted, withdrawn, expired, deleted, purged, granted30, withdrawn30] = await Promise.all([
      ev("consent_granted"), ev("consent_withdrawn"), ev("consent_expired"), ev("data_deleted"), ev("tenant_purged"), ev("consent_granted", 30), ev("consent_withdrawn", 30),
    ]);
    const active = await n(env, `SELECT COUNT(*) AS n FROM bank_connections WHERE access_type = 'cdr' AND status = 'active'`);
    const lastEvent = await (async () => {
      try {
        return (await env.DB.prepare(`SELECT MAX(created_at) AS t FROM cdr_audit_log`).first<{ t: string | null }>())?.t ?? null;
      } catch { return null; }
    })();
    panels.push({
      key: "cdr", title: "CDR activity",
      status: granted === null ? "fail" : "ok", checked_at: now.toISOString(),
      summary: granted === null ? "Couldn't read the CDR audit log" : `${active ?? 0} active CDR consent${active === 1 ? "" : "s"} · ${granted} granted, ${withdrawn} withdrawn, ${expired} expired all-time`,
      metrics: {
        active_cdr_connections: active, consents_granted: granted, consents_withdrawn: withdrawn, consents_expired: expired,
        data_deletions: deleted, tenant_purges: purged, granted_30d: granted30, withdrawn_30d: withdrawn30, last_event_at: lastEvent,
        bank_feed_flag: featureOn(env, "bank_feed_cdr"),
      },
      evidence: [{ label: "src/lib/bank-consent.ts (cdr_audit_log)", href: repoLink("src/lib/bank-consent.ts") }],
    });
  }

  // 8. Data lifecycle (#639)
  panels.push(src.retention ? fromSource("lifecycle", "Data lifecycle", src.retention, [{ label: "src/lib/retention.ts", href: repoLink("src/lib/retention.ts") }])
    : notSetUp("lifecycle", "Data lifecycle", 639, "no retention / minimisation run or deletion queue recorded", [{ label: "src/lib/retention.ts", href: repoLink("src/lib/retention.ts") }]));

  // 9. Residency (#641): the live au. probe + CDR-tainted tenants' routing + the verification record.
  {
    const live = fromCheck(c?.bedrock);
    let tainted = 0, onAu = 0;
    try {
      const rows = await env.DB.prepare(`SELECT inference_provider, inference_region FROM profiles WHERE cdr_tainted = 1`).all<{ inference_provider: string | null; inference_region: string | null }>();
      for (const r of rows.results ?? []) {
        tainted++;
        const region = r.inference_region ?? env.DEFAULT_INFERENCE_REGION ?? AU_DESCRIPTOR.residency.regions[0]!;
        if (resolveProvider(env, r) === "bedrock" && AU_DESCRIPTOR.residency.regions.includes(region)) onAu++;
      }
    } catch { /* table/column missing ⇒ zero */ }
    const r = src.residency;
    // A tainted tenant NOT on the AU path isn't a leak — getLLM refuses its inference (fail closed) —
    // but it does mean that tenant has no AI, so it's a warning.
    const routing: PanelStatus = tainted === onAu ? "ok" : "warn";
    panels.push({
      key: "residency", title: "Residency",
      // No AU credentials yet ⇒ the residency path isn't set up: say so rather than "ok" on routing alone.
      status: live.status === "not_set_up" && !r && routing === "ok" ? "not_set_up"
        : worst(live.status === "not_checked" || live.status === "not_set_up" ? routing : live.status, routing, ...(r ? [r.status] : [])),
      checked_at: live.checked_at ?? r?.at ?? now.toISOString(),
      summary: `${live.summary} · ${tainted} CDR-tainted tenant${tainted === 1 ? "" : "s"}, ${onAu} on the AU path${tainted > onAu ? `, ${tainted - onAu} refused non-AU inference` : ""}${r ? "" : " · verification not yet recorded (#641)"}`,
      metrics: { ...live.metrics, cdr_tainted_tenants: tainted, tainted_on_au_path: onAu, tainted_refused_non_au: tainted - onAu, ...(r?.metrics ?? {}) },
      evidence: [{ label: "src/llm.ts (residency seam)", href: repoLink("src/llm.ts") }, ...(r?.evidence ?? [])],
      ...(r ? {} : { pending_ticket: 641 }),
    });
  }

  // 10. OSP register (#642)
  panels.push(src.osp_register ? fromSource("osp", "OSP register", src.osp_register)
    : notSetUp("osp", "OSP register", 642, "publish docs/security/osp-register.md with `npm run security:push-docs`"));

  return {
    generated_at: now.toISOString(),
    monitoring_enabled: featureOn(env, "security_monitoring"),
    last_check_at: snap?.at ?? null,
    last_check_trigger: snap?.trigger ?? null,
    panels,
  };
}

// ── Route ────────────────────────────────────────────────────────────────────────────────────────

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/**
 * GET /api/admin/security and POST /api/admin/security/check. Returns null when the path isn't ours.
 * Non-admin ⇒ 404 (not 403): the page shouldn't be discoverable. Checked against the caller's
 * server-side profile — never a client header.
 */
export async function handleAdminSecurity(req: Request, env: Env, uid: string, parts: string[], deps?: CheckDeps): Promise<Response | null> {
  if (parts[0] !== "admin" || parts[1] !== "security") return null;
  if (!isAdmin(await getProfile(env, uid))) return json({ error: "not found" }, 404);
  if (req.method === "GET" && parts.length === 2) return json(await buildSecurityDashboard(env, deps?.now()));
  if (req.method === "POST" && parts[2] === "check" && parts.length === 3) {
    if (!featureOn(env, "security_monitoring")) return json({ error: "security_monitoring is off — turn the flag on to run live checks" }, 409);
    // Light throttle: each run makes a few-token Bedrock call and ~4 GitHub requests (60/h unauthenticated).
    const last = await readSnapshot(env);
    const nowMs = (deps?.now() ?? new Date()).getTime();
    if (last && nowMs - Date.parse(last.at) < MANUAL_MIN_INTERVAL_MS) return json({ error: "checks ran less than a minute ago — try again shortly" }, 429);
    await runSecurityChecks(env, "manual", deps);
    return json(await buildSecurityDashboard(env, deps?.now()));
  }
  return json({ error: "not found" }, 404);
}
