/**
 * Simulation: does the mobile shell actually lay out without overlaps?
 *
 * The bug this guards was pure client-side CSS geometry — invisible to every server-side
 * gate in `npm test`. So we render the REAL built CSS against the REAL class strings
 * (extracted from source, not retyped) in a REAL Chromium, and measure boxes.
 *
 * Safe-area insets: Chromium desktop reports env(safe-area-inset-bottom) = 0. We test both
 * the 0 case (the TIGHT case — launcher sits lowest, closest to the bar) and an emulated
 * iPhone home indicator (34px) by overriding --safe-b.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(REPO, "package.json"));

// playwright is present only TRANSITIVELY (promptfoo → playwright-extra). We do not declare it: this
// sim is a diagnostic, not a build dependency, and Chromium is a ~200MB install. Skip loudly rather
// than block — same posture as check-schema-drift.ts with sqlite3.
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.log("SKIP — playwright not resolvable. Static invariants still run via `npm run test:shell`.");
  process.exit(0);
}

const dist = join(REPO, "web/dist/assets");
if (!existsSync(dist)) {
  console.log("SKIP — web/dist not built. Run `npm run web:build` first (the sim measures the REAL built CSS).");
  process.exit(0);
}

const app = readFileSync(join(REPO, "web/src/App.tsx"), "utf8");
const chat = readFileSync(join(REPO, "web/src/components/chat/FloatingChat.tsx"), "utf8");
const html = readFileSync(join(REPO, "web/index.html"), "utf8");

const cssFile = readdirSync(dist).filter((f) => f.endsWith(".css")).sort().pop();
const css = readFileSync(join(dist, cssFile), "utf8");

// ── Extract the live class strings from source (drift detection) ──────────────
const grab = (re, what, src) => {
  const m = src.match(re);
  if (!m) throw new Error(`EXTRACTION FAILED: ${what} — source shape changed, update the sim`);
  return m[1];
};

const navCls = grab(/className="(fixed inset-x-0 bottom-0[^"]*)"/, "BottomTabBar nav", app);
const mainCls = grab(/has\("mobile_bottom_tabs"\) \? "(flex-1 pb-[^"]*)"/, "main padding", app);
const tabCls = grab(/const cls = \(isActive: boolean\) => `(relative flex flex-1[^`$]*)/, "tab item", app);
const launcherBottom = grab(/const launcherBottom = tabs \? "([^"]+)"/, "launcherBottom", chat);
const panelBottom = grab(/const panelBottom = tabs \? "([^"]+)"/, "panelBottom", chat);
const launcherTpl = grab(/aria-label="Open chat with Quillo"\s*\n\s*className=\{`([^`]+)`\}/, "launcher tpl", chat);
const panelTpl = grab(/aria-label="Ask Quillo"\s*\n\s*className=\{`([^`]+)`\}/, "panel tpl", chat);

const launcherCls = launcherTpl.replace("${launcherBottom}", launcherBottom);
const panelCls = panelTpl.replace("${panelBottom}", panelBottom);

const viewportFitCover = /viewport-fit=cover/.test(html);

console.log("Extracted from source:");
console.log("  nav      :", navCls);
console.log("  main     :", mainCls);
console.log("  launcher :", launcherCls.slice(0, 70) + "…");
console.log("  panel    :", panelCls.slice(0, 70) + "…");
console.log("  viewport-fit=cover:", viewportFitCover);
console.log("  built css:", cssFile, `(${(css.length / 1024).toFixed(1)}kB)`);
console.log();

const ICON = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 5h12M3 9h12M3 13h12"/></svg>`;
const tab = (label) => `<a class="${tabCls}" href="#">${ICON}<span>${label}</span></a>`;

// NEGATIVE CONTROL: `--legacy` restores the pre-fix geometry (launcher at bottom-4, sonner on
// its ~2rem default offset). A harness that can't fail on the broken code proves nothing.
const LEGACY = process.argv.includes("--legacy");
// !important because the probe carries an inline style, and an id selector alone won't beat it.
const legacyCss = LEGACY ? `<style>#launcher{bottom:1rem!important}#toastprobe{bottom:2rem!important}</style>` : "";

const page = (safeB) => `<!doctype html><html><head><meta charset="utf-8">
<style>${css}</style>
${safeB != null ? `<style>:root{--safe-b:${safeB}px}</style>` : ""}
${legacyCss}
</head><body>
<main id="main" class="${mainCls}"><div style="height:2000px">content</div></main>
<nav id="nav" class="${navCls}" aria-label="Primary">
  ${tab("Home")}${tab("Bring in")}${tab("Sort")}${tab("Position")}${tab("More")}
</nav>
<button id="launcher" class="${launcherCls}">chat</button>
<div id="panel" class="${panelCls}">panel</div>
</body></html>`;

const VIEWPORTS = [
  { name: "iPhone 14 (390×844)", w: 390, h: 844, barVisible: true },
  { name: "iPhone Pro Max (430×932)", w: 430, h: 932, barVisible: true },
  { name: "sonner bp edge (600×900)", w: 600, h: 900, barVisible: true },
  { name: "iPad portrait (768×1024)", w: 768, h: 1024, barVisible: true },
  { name: "just below lg (1023×800)", w: 1023, h: 800, barVisible: true },
  { name: "lg exactly (1024×800)", w: 1024, h: 800, barVisible: false },
  { name: "desktop (1440×900)", w: 1440, h: 900, barVisible: false },
];

// Chromium may be resolvable without its browser binaries downloaded.
let browser;
try {
  browser = await chromium.launch();
} catch (e) {
  console.log(`SKIP — Chromium binary unavailable (${String(e).split("\n")[0]}).`);
  process.exit(0);
}
const results = [];

for (const safeB of [null, 34]) {
  const label = safeB == null ? "safe-area = 0 (Chromium default; the TIGHT case)" : `safe-area = ${safeB}px (emulated iPhone home indicator)`;
  console.log(`\n━━ ${label} ━━`);
  for (const v of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: v.w, height: v.h } });
    const p = await ctx.newPage();
    await p.setContent(page(safeB), { waitUntil: "load" });

    const m = await p.evaluate(() => {
      const box = (id) => {
        const el = document.getElementById(id);
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return { top: r.top, bottom: r.bottom, h: r.height, display: cs.display, visible: cs.display !== "none" && r.height > 0 };
      };
      const clearance = getComputedStyle(document.documentElement).getPropertyValue("--tabbar-clearance").trim();
      // Resolve the var to px the way sonner's inline style would. #toastprobe lets the
      // --legacy control override it to sonner's stock offset.
      const probe = document.createElement("div");
      probe.id = "toastprobe";
      probe.style.cssText = "position:fixed;bottom:var(--tabbar-clearance);height:1px";
      document.body.appendChild(probe);
      const toastBottomPx = window.innerHeight - probe.getBoundingClientRect().bottom;
      probe.remove();
      return {
        nav: box("nav"), launcher: box("launcher"), panel: box("panel"),
        mainPadBottom: parseFloat(getComputedStyle(document.getElementById("main")).paddingBottom),
        clearanceRaw: clearance, toastBottomPx, vh: window.innerHeight,
      };
    });

    const barVisible = m.nav.visible;
    const barTop = barVisible ? m.nav.top : m.vh;
    const barH = barVisible ? m.nav.h : 0;

    const checks = [];
    const ok = (name, pass, detail) => { checks.push({ name, pass, detail }); return pass; };

    ok("bar visibility matches lg:hidden", barVisible === v.barVisible, `visible=${barVisible} expected=${v.barVisible}`);
    // The launcher's LOWEST edge must sit at or above the bar's top edge.
    ok("launcher clears tab bar", !barVisible || m.launcher.bottom <= barTop + 0.5,
       `launcher.bottom=${m.launcher.bottom.toFixed(1)} barTop=${barTop.toFixed(1)} gap=${(barTop - m.launcher.bottom).toFixed(1)}px`);
    ok("chat panel clears tab bar", !barVisible || m.panel.bottom <= barTop + 0.5 || m.panel.top <= 1,
       `panel.bottom=${m.panel.bottom.toFixed(1)} barTop=${barTop.toFixed(1)}`);
    ok("toast offset clears tab bar", !barVisible || m.toastBottomPx >= barH,
       `toastBottom=${m.toastBottomPx.toFixed(1)}px barH=${barH.toFixed(1)}px`);
    ok("main content not hidden behind bar", !barVisible || m.mainPadBottom >= barH,
       `main.pb=${m.mainPadBottom.toFixed(1)}px barH=${barH.toFixed(1)}px`);
    ok("desktop launcher unchanged (16px)", barVisible || Math.abs(m.vh - m.launcher.bottom - 16) < 0.5,
       `bottom inset=${(m.vh - m.launcher.bottom).toFixed(1)}px`);

    const failed = checks.filter((c) => !c.pass);
    results.push({ safeB, viewport: v.name, failed: failed.length });
    console.log(`\n  ${failed.length === 0 ? "✓" : "✗"} ${v.name}  bar=${barVisible ? `${barH.toFixed(0)}px` : "hidden"} clearance=${m.clearanceRaw}`);
    for (const c of checks) console.log(`      ${c.pass ? "✓" : "✗"} ${c.name.padEnd(34)} ${c.detail}`);
    await ctx.close();
  }
}

await browser.close();
const totalFailed = results.reduce((s, r) => s + r.failed, 0);
console.log(`\n${"═".repeat(70)}`);

if (LEGACY) {
  // Negative control: we RESTORED the pre-fix geometry, so the assertions MUST fail. A harness that
  // passes on broken code proves nothing — this run is what gives the green run its meaning.
  const ok = totalFailed > 0;
  console.log(ok
    ? `PASS (negative control) — ${totalFailed} assertion(s) correctly failed on the pre-fix geometry`
    : `FAIL (negative control) — the harness is INERT: it passed on known-broken geometry`);
  process.exit(ok ? 0 : 1);
}

console.log(totalFailed === 0
  ? `PASS — ${results.length} viewport×safe-area combinations, 0 failed assertions`
  : `FAIL — ${totalFailed} assertion(s) failed across ${results.length} combinations`);
if (!viewportFitCover) console.log("WARN — viewport-fit=cover missing: env() insets would resolve to 0 on device");
process.exit(totalFailed === 0 ? 0 : 1);
