#!/usr/bin/env node
// API route smoke test against the deployed Worker (dev-bypass auth, i.e. before
// Cloudflare Access is enforced). Read-only checks on all GETs; write checks
// create-then-delete temp rows so prod data stays clean. No Claude calls (no cost).
// Usage: node scripts/api-smoke.mjs [baseUrl]
const BASE = process.argv[2] || "https://app.quillo.au";

let pass = 0,
  fail = 0;
const results = [];
function ok(name, cond, info = "") {
  (cond ? pass++ : fail++);
  results.push(`${cond ? "✅" : "❌"} ${name}${info ? ` — ${info}` : ""}`);
}
async function j(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-json (e.g. receipt) */
  }
  return { status: res.status, data, res };
}

const run = async () => {
  // health
  ok("GET /healthz", (await j("GET", "/healthz")).data?.ok === true);

  // core reads
  const txns = await j("GET", "/api/transactions");
  ok("GET /api/transactions", txns.status === 200 && Array.isArray(txns.data?.transactions));
  const firstTxn = txns.data?.transactions?.[0]?.id;

  const sit = await j("GET", "/api/situation");
  ok("GET /api/situation", sit.status === 200 && Array.isArray(sit.data?.properties), `${sit.data?.properties?.length ?? "?"} properties`);

  ok("GET /api/dashboard", (await j("GET", "/api/dashboard")).status === 200);
  ok("GET /api/notifications", Array.isArray((await j("GET", "/api/notifications")).data?.notifications));
  ok("GET /api/report", (await j("GET", "/api/report")).data?.fy != null);

  // qbo (no tokens -> connected:false, must not 500)
  const qs = await j("GET", "/api/qbo/status");
  ok("GET /api/qbo/status", qs.status === 200 && qs.data?.connected === false);
  const qr = await j("GET", "/api/qbo/reconcile");
  ok("GET /api/qbo/reconcile", qr.status === 200 && qr.data?.connected === false, "expected not-connected");

  // transaction detail + receipt (read-only) if we have one
  if (firstTxn) {
    const td = await j("GET", `/api/transactions/${firstTxn}`);
    ok("GET /api/transactions/:id", td.status === 200 && td.data?.id === firstTxn);
    const rc = await fetch(`${BASE}/api/receipt/${firstTxn}`);
    ok("GET /api/receipt/:id", rc.status === 200, `content-type=${rc.headers.get("content-type")}`);
  } else {
    results.push("⚠️  no transaction present — skipped detail/receipt checks");
  }
  // cross-tenant guard: a random id must 404
  ok("GET /api/transactions/<bogus> 404s", (await j("GET", "/api/transactions/does-not-exist")).status === 404);

  // ── write checks: create then delete (net-clean) ──
  const prop = await j("POST", "/api/properties", { label: "SMOKE TEST PROP", status: "vacant" });
  ok("POST /api/properties", prop.status === 200 && !!prop.data?.id);
  if (prop.data?.id) ok("DELETE /api/properties/:id", (await j("DELETE", `/api/properties/${prop.data.id}`)).data?.ok === true);

  const ent = await j("POST", "/api/entities", { kind: "company", name: "SMOKE TEST CO" });
  ok("POST /api/entities", !!ent.data?.id);
  if (ent.data?.id) ok("DELETE /api/entities/:id", (await j("DELETE", `/api/entities/${ent.data.id}`)).data?.ok === true);

  const rule = await j("POST", "/api/rules", { pattern: "smoketest", bucket: "company", ato_label: "company:test" });
  ok("POST /api/rules", !!rule.data?.id);
  if (rule.data?.id) ok("DELETE /api/rules/:id", (await j("DELETE", `/api/rules/${rule.data.id}`)).data?.ok === true);

  const key = await j("POST", "/api/keys", { label: "smoke-test" });
  ok("POST /api/keys (mint)", !!key.data?.keyId && !!key.data?.secret);
  const keys = await j("GET", "/api/keys");
  ok("GET /api/keys", Array.isArray(keys.data?.keys));
  if (key.data?.keyId) ok("POST /api/keys/:id/revoke", (await j("POST", `/api/keys/${key.data.keyId}/revoke`)).data?.ok === true);

  // consent is idempotent — safe to re-record
  ok("POST /api/consent", (await j("POST", "/api/consent", { text: "smoke test re-consent", method: "smoke" })).data?.ok === true);

  console.log(`\n${BASE}\n` + results.join("\n"));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};
run().catch((e) => {
  console.error("smoke run crashed:", e);
  process.exit(1);
});
