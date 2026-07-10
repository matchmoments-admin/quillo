#!/usr/bin/env tsx
// Mobile-shell guard: the bottom tab bar, the floating-chat launcher/panel and the sonner toasts
// all occupy the SAME bottom-right corner below `lg`. Before this guard they silently collided —
// the chat bubble covered the Position/More tabs, and (worse) toasts rendered BEHIND the bar, which
// made UndoToast's "Undo" unreachable. Every gate in `npm test` is server-side, so nothing caught it;
// the local runtime is deploy-only, so nothing caught it locally either. It shipped to prod.
//
// This is the cheap, deterministic half of the guard: it asserts the four call sites still derive
// their spacing from the ONE source of truth (--tabbar-clearance in web/src/index.css) and that
// viewport-fit=cover is present (without it, env(safe-area-inset-bottom) resolves to 0 and every
// safe-area rule silently no-ops). It reads source only — no build, no browser, no network.
//
// The expensive half — real geometry in a real Chromium at real viewports, plus a negative control
// that proves the assertions can fail — lives in scripts/sim-mobile-shell.mjs (`npm run sim:shell`).
//
// Run: npx tsx scripts/check-mobile-shell.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

const html = read("web/index.html");
const css = read("web/src/index.css");
const app = read("web/src/App.tsx");
const chat = read("web/src/components/chat/FloatingChat.tsx");

type Check = { name: string; pass: boolean; why: string };
const checks: Check[] = [];
const assert = (name: string, pass: boolean, why: string) => checks.push({ name, pass, why });

// ── The inset must actually resolve on device ────────────────────────────────
assert(
  // Match the meta tag's content attribute specifically. A bare /viewport-fit=cover/ over the whole
  // file is satisfied by the explanatory HTML comment sitting right above the tag — a false negative
  // this guard shipped with for exactly one mutation test.
  "index.html sets viewport-fit=cover on the viewport meta",
  /<meta\s+name="viewport"\s+content="[^"]*viewport-fit=cover[^"]*"/.test(html),
  "without it env(safe-area-inset-*) is 0 and every safe-area rule is a silent no-op",
);

// ── One source of truth ──────────────────────────────────────────────────────
assert("index.css defines --tabbar-h", /--tabbar-h:\s*4rem/.test(css), "the bar's nominal height");
assert(
  "index.css defines --safe-b with an env() fallback",
  /--safe-b:\s*env\(safe-area-inset-bottom,\s*0px\)/.test(css),
  "the fallback keeps the calc() valid on browsers without safe-area support",
);
assert(
  "index.css defines --tabbar-clearance from the other two",
  /--tabbar-clearance:\s*calc\(var\(--tabbar-h\)\s*\+\s*var\(--safe-b\)\s*\+\s*0\.5rem\)/.test(css),
  "derived, never hand-copied",
);
assert(
  "index.css collapses --tabbar-clearance at lg",
  /@media\s*\(min-width:\s*1024px\)[\s\S]{0,120}--tabbar-clearance:\s*2rem/.test(css),
  "the bar is lg:hidden, so nothing needs clearing; this lets the Toaster pass ONE value at every width",
);

// ── The four consumers must derive from it ───────────────────────────────────
assert(
  "BottomTabBar pads for the home indicator",
  /<nav[\s\S]{0,240}pb-\[var\(--safe-b\)\][\s\S]{0,240}aria-label="Primary"/.test(app),
  "otherwise the tab labels sit under the iOS home indicator",
);
assert(
  "main clears the bar",
  /pb-\[calc\(var\(--tabbar-h\)_\+_var\(--safe-b\)\)\]\s+lg:pb-0/.test(app),
  "Tailwind arbitrary values need _ for the spaces calc() requires; `calc(4rem+…)` is INVALID CSS",
);
assert(
  "Toaster sets BOTH offset and mobileOffset",
  /offset=\{has\("mobile_bottom_tabs"\)[\s\S]{0,120}mobileOffset=\{has\("mobile_bottom_tabs"\)/.test(app),
  "sonner swaps between them at its own 600px breakpoint; setting only one leaves 600-1023px behind the bar",
);
assert(
  "Toaster offsets use --tabbar-clearance",
  (app.match(/bottom:\s*"var\(--tabbar-clearance\)"/g) ?? []).length >= 2,
  "a covered toast is an unreachable Undo",
);
assert(
  "chat launcher clears the bar below lg",
  /const launcherBottom = tabs \? "bottom-\[var\(--tabbar-clearance\)\] lg:bottom-4"/.test(chat),
  "this is the exact regression: a bare `bottom-4` puts the bubble on top of the Position/More tabs",
);
assert(
  "chat panel clears the bar below lg",
  /const panelBottom = tabs \? "md:bottom-\[var\(--tabbar-clearance\)\] lg:bottom-4"/.test(chat),
  "the md-docked panel shares the corner between md and lg",
);
assert(
  "chat launcher has no hard-coded bottom-4 in its class",
  !/aria-label="Open chat with Quillo"[\s\S]{0,200}fixed bottom-4/.test(chat),
  "the pre-fix shape — guard against a revert",
);

// ── Hooks-above-early-return (the React #310 class this repo has shipped before) ──
assert(
  "FloatingChat gates in a wrapper, so no hook sits after an early return",
  /export function FloatingChat\(\)[\s\S]{0,400}return <FloatingChatInner \/>;/.test(chat),
  "hooks after a conditional return crash prod with React #310",
);

const failed = checks.filter((c) => !c.pass);
for (const c of checks) console.log(`  ${c.pass ? "✓" : "✗"} ${c.name}${c.pass ? "" : `\n      → ${c.why}`}`);
console.log(
  failed.length === 0
    ? `\n=== mobile-shell: PASS — ${checks.length} invariants hold (geometry: npm run sim:shell) ===`
    : `\n=== mobile-shell: FAIL — ${failed.length}/${checks.length} invariant(s) broken ===`,
);
process.exit(failed.length === 0 ? 0 : 1);
