#!/usr/bin/env node
// Security-headers check for the live app (#640, epic #633).
//
//   node scripts/check-security-headers.mjs [url] [--group=baseline|pending]
//
// Two groups, so CI can keep a hard gate on what is already true in prod while still
// reporting the headers that land with #634 (A1 security headers):
//
//   baseline — must pass today; a failure is a regression.
//     X-Content-Type-Options: nosniff, a Referrer-Policy, and a CSP (enforcing OR
//     report-only) that declares frame-ancestors.
//   pending  — expected to FAIL until #634 ships, so the workflow step that runs it is
//     `continue-on-error`. Once #634 is live, flip that step to blocking.
//     Strict-Transport-Security with max-age >= 180 days, an ENFORCING
//     Content-Security-Policy, and framing actually blocked (enforced frame-ancestors or
//     X-Frame-Options).
//
// Exit 0 = every check in the selected group(s) passed; 1 = at least one failed; 2 = fetch
// error. No --group runs both.

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith("--")) ?? "https://app.quillo.au/";
const groupArg = args.find((a) => a.startsWith("--group="))?.split("=")[1];
const groups = groupArg ? [groupArg] : ["baseline", "pending"];

const MIN_HSTS_SECONDS = 15552000; // 180 days

let res;
try {
  res = await fetch(url, { method: "GET", redirect: "manual" });
} catch (err) {
  console.error(`fetch ${url} failed: ${err?.message ?? err}`);
  process.exit(2);
}
const h = (name) => res.headers.get(name);

const csp = h("content-security-policy");
const cspRo = h("content-security-policy-report-only");
const hasFrameAncestors = (policy) => /(^|;)\s*frame-ancestors\s/i.test(policy ?? "");
const hstsMaxAge = Number(/max-age=(\d+)/i.exec(h("strict-transport-security") ?? "")?.[1] ?? 0);

const checks = {
  baseline: [
    ["X-Content-Type-Options: nosniff", (h("x-content-type-options") ?? "").toLowerCase() === "nosniff"],
    ["Referrer-Policy present", Boolean(h("referrer-policy"))],
    ["CSP (enforcing or report-only) declares frame-ancestors", hasFrameAncestors(csp) || hasFrameAncestors(cspRo)],
  ],
  pending: [
    [`Strict-Transport-Security max-age >= ${MIN_HSTS_SECONDS}`, hstsMaxAge >= MIN_HSTS_SECONDS],
    ["Content-Security-Policy is enforcing (not report-only)", Boolean(csp)],
    ["Framing blocked (enforced frame-ancestors or X-Frame-Options)", hasFrameAncestors(csp) || Boolean(h("x-frame-options"))],
  ],
};

console.log(`security headers — ${url} (HTTP ${res.status})`);
let failed = 0;
for (const g of groups) {
  if (!checks[g]) {
    console.error(`unknown group "${g}" (expected baseline|pending)`);
    process.exit(2);
  }
  console.log(`\n[${g}]${g === "pending" ? " — expected to fail until #634 ships" : ""}`);
  for (const [label, ok] of checks[g]) {
    console.log(`  ${ok ? "✓" : "✗"} ${label}`);
    if (!ok) failed++;
  }
}
process.exit(failed ? 1 : 0);
