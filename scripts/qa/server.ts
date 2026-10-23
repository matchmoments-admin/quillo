// Local Worker for the browser QA suite (#699): seeds a scratch D1, then runs `wrangler dev` with the
// DEV_AUTH_BYPASS tenant, the QA inference stub and every first-timer journey flag ON.
//
// Hermetic by construction:
//   - state lives in .qa/state-<name> (its own persist dir), so it never touches the developer's
//     .wrangler/state or another run;
//   - the Worker reads ONLY .qa/qa.env (written here, DEV_AUTH_BYPASS=1). `--env-file` replaces the
//     default .dev.vars, so no real API key is ever loaded and a missed stub fails instead of spending;
//   - CLERK_ISSUER is overridden to empty (the bypass path) and QA_LLM_STUB=1 swaps every model call for
//     src/lib/llm-stub.ts;
//   - the SPA is the `--mode qa` bundle in web/dist-qa (main.tsx QA_AUTH_BYPASS), never web/dist.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const QA_DIR = path.join(ROOT, ".qa");
const WRANGLER = path.join(ROOT, "node_modules", ".bin", "wrangler");

/** The eight first-timer journey flags, in docs/first-timer/spec.md §A15 / map #692 order. */
export const JOURNEY_FLAGS = [
  "ft_journey", "situation_profile", "relevance_scan", "wages_payer",
  "reconcile_proposals", "mytax_worksheet", "residency_assessability", "bank_minimisation",
] as const;

export function prodFeatures(): string[] {
  const toml = fs.readFileSync(path.join(ROOT, "wrangler.toml"), "utf8");
  return (/^FEATURES\s*=\s*"([^"]*)"/m.exec(toml)?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** The inference provider a tenant with no override gets (wrangler.toml DEFAULT_INFERENCE_PROVIDER). */
export function defaultProvider(): string {
  const toml = fs.readFileSync(path.join(ROOT, "wrangler.toml"), "utf8");
  return /^DEFAULT_INFERENCE_PROVIDER\s*=\s*"([^"]*)"/m.exec(toml)?.[1] ?? "anthropic";
}

export interface QaServer {
  base: string;
  /** Run SQL against this server's local D1 (seeding, e.g. a zero wallet). */
  sql(command: string): unknown[];
  stop(): Promise<void>;
  logFile: string;
}

function wrangler(args: string[]): string {
  return execFileSync(WRANGLER, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
}

// Every wrangler this process started; an interrupted run (Ctrl-C, CI cancel) still takes them down.
const live = new Set<ChildProcess>();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    for (const c of live) { try { process.kill(-c.pid!, "SIGKILL"); } catch { /* gone */ } }
    process.exit(130);
  });
}

async function portInUse(port: number): Promise<boolean> {
  const net = await import("node:net");
  for (const host of ["127.0.0.1", "::1"]) {
    const busy = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ port, host }, () => { sock.destroy(); resolve(true); });
      sock.on("error", () => resolve(false));
    });
    if (busy) return true;
  }
  return false;
}

export async function startServer(opts: { name: string; port: number; flags?: string[] }): Promise<QaServer> {
  // Never share a port: a /healthz from someone else's wrangler would silently run the suite against it.
  if (await portInUse(opts.port)) throw new Error(`port ${opts.port} is already in use — set QA_PORT to a free port`);
  fs.mkdirSync(QA_DIR, { recursive: true });
  const envFile = path.join(QA_DIR, "qa.env");
  fs.writeFileSync(envFile, "DEV_AUTH_BYPASS=1\n");
  const persist = path.join(QA_DIR, `state-${opts.name}`);
  fs.rmSync(persist, { recursive: true, force: true });
  wrangler(["d1", "execute", "tax-agent-db", "--local", "--persist-to", persist, "--file=schema.sql"]);

  // api_rate_limit is dropped: a scripted sweep loads ~45 pages a minute (each fires 10–20 /api calls) and
  // trips the 300/min per-user limiter, which turns every later check into a 429. The limiter has its own
  // goldens in check-units; here it would only make the run order-dependent.
  const flags = (opts.flags ?? [...prodFeatures().filter((f) => !(JOURNEY_FLAGS as readonly string[]).includes(f)), ...JOURNEY_FLAGS])
    .filter((f) => f !== "api_rate_limit");
  const logFile = path.join(QA_DIR, `wrangler-${opts.name}.log`);
  const log = fs.openSync(logFile, "w");
  const child: ChildProcess = spawn(WRANGLER, [
    "dev", "--port", String(opts.port), "--ip", "127.0.0.1",
    "--persist-to", persist, "--env-file", envFile, "--assets", "web/dist-qa",
    "--var", "CLERK_ISSUER:", "--var", "QA_LLM_STUB:1", "--var", "CATEGORISE_MODE:live",
    "--var", `FEATURES:${flags.join(",")}`,
    "--show-interactive-dev-session=false",
  ], { cwd: ROOT, stdio: ["ignore", log, log], env: { ...process.env, NO_COLOR: "1" }, detached: true });

  const base = `http://localhost:${opts.port}`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode != null) throw new Error(`wrangler dev exited (${child.exitCode}); see ${logFile}`);
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) { try { process.kill(-child.pid!, "SIGTERM"); } catch { /* gone */ } throw new Error(`wrangler dev did not come up; see ${logFile}`); }
    await new Promise((r) => setTimeout(r, 500));
  }

  live.add(child);
  child.once("exit", () => live.delete(child));
  return {
    base,
    logFile,
    sql(command: string) {
      const out = wrangler(["d1", "execute", "tax-agent-db", "--local", "--persist-to", persist, "--json", "--command", command]);
      const parsed = JSON.parse(out) as { results: unknown[] }[];
      return parsed[0]?.results ?? [];
    },
    async stop() {
      if (child.exitCode != null) return;
      const exited = new Promise<void>((r) => child.once("exit", () => r()));
      try { process.kill(-child.pid!, "SIGTERM"); } catch { /* gone */ }
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      if (child.exitCode == null) { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }
    },
  };
}
