#!/usr/bin/env tsx
// Automated new-user QA suite (#699, map #692) — `npm run qa:browser`.
//
// Drives the real SPA in Chromium against a local `wrangler dev` (scripts/qa/server.ts: scratch D1, the
// DEV_AUTH_BYPASS tenant, the QA inference stub, every first-timer journey flag ON), at 1280px and 390px:
//   1. first-timer journey — Before you start → Get set up → Connect (zero-credit, bad-file and oversize
//      error paths, then the CSV happy path) → Review → Check → Position → Lodge (+ mark lodged) → Ask;
//   2. billing (no Stripe call) and Settings → Privacy (consent, export, delete-account dry path);
//   3. a route sweep of every inventory route, empty and seeded, with the journey flags ON, and again with
//      production's flag set (the legacy pages);
//   4. life-situation personas (P1 Maya, P6 Susan & Greg, P4 Priya, P8 James) seeded through the API.
// Every page load asserts: no React error screen, no uncaught console/page error, no 5xx, no horizontal
// scroll at 390px, and nothing requested off localhost.
//
// Output: .qa/report.json + .qa/report.md (journey × viewport table, per-flag verdict, failures, gaps).
// Exit 1 on any failed check. `--only=journeys,routes,legacy,personas` narrows a run.
//
// Not in `npm test`: it needs a ~60s wrangler boot per server and a Chromium binary, so it is neither fast
// nor hermetic enough for the unit gate. It runs as its own CI job (.github/workflows/qa.yml). Decision
// recorded in scripts/qa/README.md.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadChromium, Recorder, type Ctx, type Result, type ViewportName } from "./harness";
import { accountJourneys, firstTimerJourney, flagTags, routeSweep, writeFixtures, type SetupAnswers } from "./journeys";
import { PERSONAS, personaRun } from "./personas";
import { JOURNEY_FLAGS, QA_DIR, ROOT, prodFeatures, startServer } from "./server";

const only = new Set((process.argv.find((a) => a.startsWith("--only="))?.slice(7) ?? "journeys,routes,legacy,personas").split(","));
const PORT = Number(process.env.QA_PORT ?? 8796);
const VPS = (process.argv.find((a) => a.startsWith("--vp="))?.slice(5) ?? "desktop,mobile").split(",") as ViewportName[];

const chromium = loadChromium();
if (!chromium) {
  console.log("SKIP — playwright not resolvable (it is a transitive dependency). Run `npm ci` first.");
  process.exit(0);
}

// ── Build: the production bundle (asserted clean of the QA bypass) and the QA bundle ──
console.log("Building the SPA (production + QA mode)…");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
execFileSync(npm, ["run", "web:build"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
const rec = new Recorder();
{
  const dist = path.join(ROOT, "web", "dist", "assets");
  const leaked = fs.readdirSync(dist).filter((f) => f.endsWith(".js") && /cWEuaW52YWxpZCQ/.test(fs.readFileSync(path.join(dist, f), "utf8")));
  rec.expect("build", "-", "production bundle carries no QA auth bypass", leaked.length === 0, leaked.join(", "));
}
// The QA bundle must never carry a real Clerk key: a developer's web/.env would otherwise win and the page
// would fetch clerk-js from Clerk (not hermetic). A process env var beats .env files in Vite.
execFileSync(path.join(ROOT, "web", "node_modules", ".bin", "vite"), ["build", "--mode", "qa", "--outDir", "dist-qa", "--emptyOutDir"], {
  cwd: path.join(ROOT, "web"),
  stdio: ["ignore", "ignore", "inherit"],
  env: { ...process.env, VITE_CLERK_PUBLISHABLE_KEY: "pk_test_cWEuaW52YWxpZCQ" },
});
const fx = writeFixtures();
const browser = await chromium.launch();

// Desktop answers a resident PAYG first-timer (FT1 Jess-like); mobile answers a WHM newcomer (FT4 Lena),
// which exercises residency_assessability through the same screens.
const ANSWERS: Record<ViewportName, SetupAnswers> = {
  desktop: { residency: "Yes, all year", spouse: "No", state: "New South Wales", occupation: "Retail worker", ticks: ["A job", "Worked from home"] },
  mobile: { residency: "No, not a resident", visa: "Working holiday visa", spouse: "No", state: "Victoria", occupation: "Hospitality worker", ticks: ["A job"] },
};

try {
  if (only.has("journeys") || only.has("routes")) {
    for (const vp of VPS) {
      console.log(`\n▶ first-timer server (journey flags ON) @${vp}`);
      const server = await startServer({ name: `ft-${vp}`, port: PORT });
      const ctx: Ctx = { browser, base: server.base, vp, rec };
      try {
        if (only.has("routes")) await routeSweep(ctx, "empty", { flags: ["ft_journey"] });
        if (only.has("journeys")) {
          await firstTimerJourney(ctx, server, ANSWERS[vp], fx);
          await accountJourneys(ctx);
        }
        if (only.has("routes")) await routeSweep(ctx, "seeded", { flags: ["ft_journey"] });
      } finally {
        await server.stop();
      }
    }
  }

  if (only.has("legacy")) {
    console.log("\n▶ legacy server (production flag set)");
    const server = await startServer({ name: "legacy", port: PORT, flags: prodFeatures() });
    try {
      for (const vp of VPS) await routeSweep({ browser, base: server.base, vp, rec }, "flags-off", {}, { expect404: ["/start"] });
    } finally {
      await server.stop();
    }
  }

  if (only.has("personas")) {
    for (const p of PERSONAS) {
      console.log(`\n▶ persona ${p.name}`);
      const server = await startServer({ name: `persona-${p.key}`, port: PORT });
      try {
        for (const vp of VPS) await personaRun({ browser, base: server.base, vp, rec }, p);
      } finally {
        await server.stop();
      }
    }
  }
} finally {
  await browser.close();
}

// ── Report ──
const results = rec.results;
const suiteOf = (r: Result) => r.suite;
const suites = [...new Set(results.map(suiteOf))];
const cell = (rs: Result[]) => (rs.length === 0 ? "–" : rs.some((r) => r.status === "fail") ? `FAIL (${rs.filter((r) => r.status === "fail").length}/${rs.length})` : rs.some((r) => r.status === "known") ? `KNOWN (${rs.filter((r) => r.status === "known").length}/${rs.length})` : rs.some((r) => r.status === "gap") ? `pass, ${rs.filter((r) => r.status === "gap").length} gap` : `pass (${rs.length})`);
const lines: string[] = [];
lines.push(`# New-user QA run — ${new Date().toISOString()}`, "", `Commit \`${execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim()}\`. ${results.length} checks: ${results.filter((r) => r.status === "pass").length} pass, ${rec.failed} fail, ${results.filter((r) => r.status === "known").length} known, ${results.filter((r) => r.status === "gap").length} gap.`, "");
lines.push("## Journey × viewport", "", "| Suite | 1280px | 390px | n/a |", "|---|---|---|---|");
for (const s of suites) {
  const rs = results.filter((r) => suiteOf(r) === s);
  lines.push(`| ${s} | ${cell(rs.filter((r) => r.viewport === "desktop"))} | ${cell(rs.filter((r) => r.viewport === "mobile"))} | ${cell(rs.filter((r) => r.viewport === "-"))} |`);
}
lines.push("", "## Journey flags (spec §A15 order)", "", "| Flag | 1280px | 390px | Verdict |", "|---|---|---|---|");
const flagVerdict: Record<string, string> = {};
for (const f of JOURNEY_FLAGS) {
  const rs = results.filter((r) => flagTags.get(`${r.suite}|${r.check}`)?.includes(f));
  const d = rs.filter((r) => r.viewport === "desktop"), m = rs.filter((r) => r.viewport === "mobile");
  const verdict = rs.length === 0 ? "NOT COVERED" : rs.some((r) => r.status === "fail") ? "FAIL" : rs.some((r) => r.status === "known") ? "PASS with known defects" : "PASS";
  flagVerdict[f] = verdict;
  lines.push(`| \`${f}\` | ${cell(d)} | ${cell(m)} | **${verdict}** |`);
}
const fails = results.filter((r) => r.status === "fail");
const gaps = results.filter((r) => r.status === "gap");
const knowns = results.filter((r) => r.status === "known");
lines.push("", "## Failures", "", ...(fails.length ? fails.map((r) => `- [${r.suite} @${r.viewport}] ${r.check} — ${r.detail ?? ""}`) : ["None."]));
lines.push("", "## Known defects (ticketed; scripts/qa/known.ts)", "", ...(knowns.length ? knowns.map((r) => `- [${r.suite} @${r.viewport}] ${r.check} — ${r.detail ?? ""}`) : ["None."]));
lines.push("", "## Gaps (engine accepts the data, the UI doesn't show it)", "", ...(gaps.length ? gaps.map((r) => `- [${r.suite} @${r.viewport}] ${r.check} — ${r.detail ?? ""}`) : ["None."]));
fs.mkdirSync(QA_DIR, { recursive: true });
fs.writeFileSync(path.join(QA_DIR, "report.json"), JSON.stringify({ results, flagVerdict }, null, 2));
fs.writeFileSync(path.join(QA_DIR, "report.md"), lines.join("\n") + "\n");
console.log(`\n${lines.join("\n")}\n\nReport: .qa/report.md`);
process.exit(rec.failed === 0 ? 0 : 1);
