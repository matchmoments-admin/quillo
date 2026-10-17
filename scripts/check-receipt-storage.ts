#!/usr/bin/env tsx
// R2 storage for tax-agent-receipts (src/lib/r2-store.ts + web/src/lib/compress-image.ts):
//   1. JSON sidecars / CSVs are gzipped on write and read back byte-exact; objects written BEFORE this change
//      (plain JSON / CSV) still read unchanged.
//   2. Statement PDFs are stored byte-for-byte (evidence integrity).
//   3. A row that outlives its object (the owner cleared the bucket) reads as null / a 410 with a clear
//      message — never a throw / 500 — and purgeTenant still succeeds.
//   4. Server-side image compression (flag receipt_image_compression) is a strict no-op when OFF, without the
//      Images binding, for non-images, on a transform error, or when the result isn't smaller.
//   5. Source guards for the Durable Object paths (a DO can't be instantiated outside workerd — see
//      scripts/e2e-first-timer.ts header): duplicates are detected BEFORE anything is stored, every sidecar
//      read goes through readStoredJson, and shared objects aren't deleted out from under another row.
// Run: npx tsx scripts/check-receipt-storage.ts
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { Env } from "../src/env";
import {
  ORIGINAL_MISSING_MESSAGE, STATEMENT_LINES_MISSING_MESSAGE, CAPITAL_ROWS_MISSING_MESSAGE, gzip, gunzip, isGzip, maybeCompressImage, objectExists, originalResponse, putCompressed, putJson,
  putStatementOriginal, readStored, readStoredJson, statementFileKey, IMAGE_MAX_EDGE, IMAGE_QUALITY, fitImage, keyStillReferenced,
} from "../src/lib/r2-store";
import { compressImageForUpload, fitWithin, isCompressibleImage, MAX_EDGE, QUALITY } from "../web/src/lib/compress-image";
import { purgeTenant } from "../src/lib/retention";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`  FAIL ${name}`, detail ?? ""); }
};

// ── In-memory R2 (the subset the app uses) ────────────────────────────────────────────────────────────────
type Obj = { bytes: Uint8Array; httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> };
class FakeR2 {
  m = new Map<string, Obj>();
  puts = 0;
  async put(key: string, value: ArrayBuffer | Uint8Array | string, opts?: { httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> }) {
    this.puts++;
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value instanceof Uint8Array ? value : new Uint8Array(value));
    this.m.set(key, { bytes: new Uint8Array(bytes), httpMetadata: opts?.httpMetadata, customMetadata: opts?.customMetadata });
    return {} as R2Object;
  }
  async get(key: string) {
    const o = this.m.get(key);
    if (!o) return null;
    const copy = o.bytes.slice();
    return { body: new Blob([copy]).stream(), arrayBuffer: async () => copy.buffer, text: async () => new TextDecoder().decode(copy), httpMetadata: o.httpMetadata, customMetadata: o.customMetadata } as unknown as R2ObjectBody;
  }
  async head(key: string) { return this.m.has(key) ? ({} as R2Object) : null; }
  async delete(keys: string | string[]) { for (const k of Array.isArray(keys) ? keys : [keys]) this.m.delete(k); }
  async list(o: { prefix?: string }) {
    return { objects: [...this.m.keys()].filter((k) => k.startsWith(o.prefix ?? "")).map((key) => ({ key })), truncated: false };
  }
}
const asBucket = (r: FakeR2) => r as unknown as R2Bucket;

async function compression() {
  console.log("\n== gzip sidecars / CSVs ==");
  const r2 = new FakeR2();
  const lines = Array.from({ length: 300 }, (_, i) => ({ date: "2026-03-01", description: `EFTPOS PURCHASE WOOLWORTHS ${i}`, amount_cents: -1234 - i, balance_cents: 100000 }));
  const out = await putJson(asBucket(r2), "u1/statements/x.lines", lines);
  const stored = r2.m.get("u1/statements/x.lines")!;
  check("putJson gzips a sidecar (stored bytes start with the gzip magic number)", out.gzipped && isGzip(stored.bytes));
  check("…and records it: contentEncoding gzip + customMetadata.qenc", stored.httpMetadata?.contentEncoding === "gzip" && stored.customMetadata?.qenc === "gzip" && stored.httpMetadata?.contentType === "application/json");
  check(`…much smaller (${out.original} → ${out.stored} bytes)`, out.stored < out.original / 3, out);
  const back = await readStoredJson<typeof lines>(asBucket(r2), "u1/statements/x.lines");
  check("readStoredJson round-trips the gzipped sidecar exactly", JSON.stringify(back) === JSON.stringify(lines));

  // Backwards compatibility: an object written by the OLD code (plain JSON, no metadata) reads unchanged.
  await r2.put("u1/statements/old.lines", JSON.stringify(lines), { httpMetadata: { contentType: "application/json" } });
  check("a pre-compression plain-JSON sidecar still reads", JSON.stringify(await readStoredJson(asBucket(r2), "u1/statements/old.lines")) === JSON.stringify(lines));
  await r2.put("u1/capital-imports/old.rows", JSON.stringify([{ source_row: 1 }])); // the old .rows put carried no metadata at all
  check("a pre-compression .rows sidecar with no httpMetadata still reads", (await readStoredJson<{ source_row: number }[]>(asBucket(r2), "u1/capital-imports/old.rows"))?.[0]?.source_row === 1);
  // Marked gzip but delivered decoded (if a runtime ever decoded content-encoding for us): read as-is.
  await r2.put("u1/x/decoded.lines", JSON.stringify([1, 2]), { httpMetadata: { contentType: "application/json", contentEncoding: "gzip" }, customMetadata: { qenc: "gzip" } });
  check("an object marked gzip whose body is already plain reads as-is (no double decode)", JSON.stringify(await readStoredJson(asBucket(r2), "u1/x/decoded.lines")) === "[1,2]");

  const csv = "Date,Description,Amount\n" + Array.from({ length: 80 }, (_, i) => `01/03/2026,EFTPOS COLES ${i},-${i}.50`).join("\n");
  await putStatementOriginal(asBucket(r2), "u1/statements/c", new TextEncoder().encode(csv).buffer as ArrayBuffer, "csv");
  const c = r2.m.get("u1/statements/c")!;
  check("a statement CSV is gzipped", isGzip(c.bytes) && c.httpMetadata?.contentType === "text/csv");
  check("…and readStored returns the exact original CSV", new TextDecoder().decode((await readStored(asBucket(r2), "u1/statements/c"))!.bytes) === csv);

  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x35, ...Array.from({ length: 500 }, () => 0x20)]); // "%PDF-1.5" + very compressible padding
  await putStatementOriginal(asBucket(r2), "u1/statements/p", pdf.buffer as ArrayBuffer, "pdf");
  const p = r2.m.get("u1/statements/p")!;
  check("a statement PDF is stored byte-for-byte even when gzip would shrink it", Buffer.compare(Buffer.from(p.bytes), Buffer.from(pdf)) === 0 && !p.customMetadata?.qenc && p.httpMetadata?.contentType === "application/pdf");

  const tiny = await putCompressed(asBucket(r2), "u1/t", "{}", "application/json");
  check("a body gzip can't shrink is stored plain", !tiny.gzipped && new TextDecoder().decode(r2.m.get("u1/t")!.bytes) === "{}");
  const roundtrip = await gunzip(await gzip("héllo ✓"));
  check("gzip/gunzip round-trip UTF-8", new TextDecoder().decode(roundtrip) === "héllo ✓");
}

async function missingOriginals() {
  console.log("\n== missing originals (bucket cleared) ==");
  const r2 = new FakeR2();
  check("readStored of a missing key is null (no throw)", (await readStored(asBucket(r2), "u1/gone")) === null);
  check("readStoredJson of a missing sidecar is null (no throw)", (await readStoredJson(asBucket(r2), "u1/statements/gone.lines")) === null);
  check("objectExists false for a missing key", !(await objectExists(asBucket(r2), "u1/gone")));
  const res = await originalResponse(asBucket(r2), "u1/gone");
  const body = (await res.json()) as { error: string; code: string };
  check("originalResponse → 410 with the 'no longer stored' message (not a 404/500)", res.status === 410 && body.error === ORIGINAL_MISSING_MESSAGE && body.code === "original_missing", { status: res.status, body });
  check("every missing-original message says the original is no longer stored", [ORIGINAL_MISSING_MESSAGE, STATEMENT_LINES_MISSING_MESSAGE, CAPITAL_ROWS_MISSING_MESSAGE].every((m) => /no longer stored/i.test(m)));

  await r2.put("u1/r1", new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]), { httpMetadata: { contentType: "image/jpeg" } });
  const ok = await originalResponse(asBucket(r2), "u1/r1");
  check("originalResponse streams a present object with its content type", ok.status === 200 && ok.headers.get("content-type") === "image/jpeg" && (await ok.arrayBuffer()).byteLength === 6);
  await putStatementOriginal(asBucket(r2), "u1/statements/csv", new TextEncoder().encode("a,b\n1,2\n".repeat(40)).buffer as ArrayBuffer, "csv");
  const csvRes = await originalResponse(asBucket(r2), "u1/statements/csv");
  check("originalResponse serves a gzipped CSV DECOMPRESSED", (await csvRes.text()) === "a,b\n1,2\n".repeat(40));

  // purgeTenant over a tenant whose D1 rows reference objects that no longer exist: the R2 step is a prefix
  // list + delete, so missing objects are simply not listed — the purge completes and wipes D1.
  const db = new DatabaseSync(":memory:");
  for (const f of fs.readdirSync(path.join(root, "migrations")).filter((f) => f.endsWith(".sql")).sort()) db.exec(fs.readFileSync(path.join(root, "migrations", f), "utf8"));
  class Stmt {
    private params: unknown[] = [];
    constructor(private sql: string) {}
    bind(...a: unknown[]) { this.params = a.map((x) => (x === undefined ? null : x)); return this; }
    async all<T>() { return { results: db.prepare(this.sql).all(...(this.params as never[])) as T[], success: true, meta: {} }; }
    async first<T>() { return (db.prepare(this.sql).get(...(this.params as never[])) as T) ?? null; }
    async run() { const r = db.prepare(this.sql).run(...(this.params as never[])); return { success: true, meta: { changes: Number(r.changes ?? 0) } }; }
    async settle() { return /^\s*(select|with)/i.test(this.sql) ? this.all() : this.run(); }
  }
  const D1 = { prepare: (s: string) => new Stmt(s), batch: async (ss: Stmt[]) => { db.exec("BEGIN"); try { const o = []; for (const s of ss) o.push(await s.settle()); db.exec("COMMIT"); return o; } catch (e) { db.exec("ROLLBACK"); throw e; } } };
  const kv = { get: async () => null, put: async () => {}, delete: async () => {}, list: async () => ({ keys: [], list_complete: true }) };
  const env = { DB: D1, RECEIPTS: r2, RULES: kv, FEATURES: "" } as unknown as Env;
  db.prepare(`INSERT INTO profiles (user_id) VALUES ('u9')`).run();
  db.prepare(`INSERT INTO transactions (id, user_id, source, status, receipt_key) VALUES ('t1', 'u9', 'web', 'extracted', 'u9/t1')`).run();
  db.prepare(`INSERT INTO documents (id, user_id, doc_type, r2_key) VALUES ('d1', 'u9', 'receipt', 'u9/docs/d1')`).run();
  await r2.put("u9/still-here", "x"); // one object that DOES still exist
  let threw: unknown = null;
  try { await purgeTenant(env, "u9"); } catch (e) { threw = e; }
  check("purgeTenant succeeds when the rows' objects are already gone", threw === null, threw);
  check("…deletes what is still stored and wipes the rows", !r2.m.has("u9/still-here") && (db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE user_id = 'u9'`).get() as { n: number }).n === 0);
}

async function sharedKeys() {
  console.log("\n== shared objects survive deletes (keyStillReferenced over real SQLite) ==");
  const db = new DatabaseSync(":memory:");
  for (const f of fs.readdirSync(path.join(root, "migrations")).filter((f) => f.endsWith(".sql")).sort()) db.exec(fs.readFileSync(path.join(root, "migrations", f), "utf8"));
  const D1 = { prepare: (sql: string) => { let p: unknown[] = []; const st = { bind: (...a: unknown[]) => { p = a; return st; }, first: async () => (db.prepare(sql).get(...(p as never[])) ?? null) }; return st; } } as unknown as D1Database;
  const ins = (sql: string) => db.prepare(sql).run();
  ins(`INSERT INTO transactions (id, user_id, source, status, receipt_key, image_hash) VALUES ('orig', 'u1', 'web', 'extracted', 'u1/orig', 'h')`);
  ins(`INSERT INTO transactions (id, user_id, source, status, receipt_key, image_hash, duplicate_of) VALUES ('dup', 'u1', 'web', 'duplicate', 'u1/orig', 'h', 'orig')`);
  ins(`INSERT INTO documents (id, user_id, doc_type, r2_key) VALUES ('doc', 'u1', 'receipt', 'u1/docs/doc')`);
  ins(`INSERT INTO transactions (id, user_id, source, status, receipt_key, document_id) VALUES ('fromdoc', 'u1', 'email', 'extracted', 'u1/docs/doc', 'doc')`);
  check("deleting the ORIGINAL keeps the object its duplicate row still uses", await keyStillReferenced(D1, "u1", "u1/orig", { exceptTxnId: "orig", includeDocuments: true }));
  check("deleting the DUPLICATE keeps the original's object", await keyStillReferenced(D1, "u1", "u1/orig", { exceptTxnId: "dup", includeDocuments: true }));
  ins(`DELETE FROM transactions WHERE id = 'dup'`);
  check("…once only the original remains, deleting it frees the object", !(await keyStillReferenced(D1, "u1", "u1/orig", { exceptTxnId: "orig", includeDocuments: true })));
  check("deleting a document-routed receipt keeps the document's object", await keyStillReferenced(D1, "u1", "u1/docs/doc", { exceptTxnId: "fromdoc", includeDocuments: true }));
  ins(`DELETE FROM transactions WHERE document_id = 'doc'`);
  check("deleteDocument (its own transactions gone) frees the document's object", !(await keyStillReferenced(D1, "u1", "u1/docs/doc", { includeDocuments: false })));
  check("references are tenant-scoped (another tenant's row never pins u1's object)", !(await keyStillReferenced(D1, "u2", "u1/orig", { includeDocuments: true })));
}

async function images() {
  console.log("\n== image compression ==");
  check("server + client share the 2000px / q80 legibility settings", IMAGE_MAX_EDGE === 2000 && MAX_EDGE === 2000 && IMAGE_QUALITY === 80 && QUALITY === 0.8);
  check("fitWithin: a 4032×3024 phone photo → 2000×1500", JSON.stringify(fitWithin(4032, 3024)) === JSON.stringify({ width: 2000, height: 1500 }));
  check("fitWithin: portrait 3024×4032 → 1500×2000", JSON.stringify(fitWithin(3024, 4032)) === JSON.stringify({ width: 1500, height: 2000 }));
  check("fitWithin never upscales a small image", JSON.stringify(fitWithin(640, 460)) === JSON.stringify({ width: 640, height: 460 }));
  check("fitWithin keeps a tall full-page screenshot readable (1179×10000 → short edge 1000, not 236)", JSON.stringify(fitWithin(1179, 10000)) === JSON.stringify({ width: 1000, height: 8482 }), fitWithin(1179, 10000));
  check("fitWithin leaves a narrow-but-short-edge-under-1000 image at full size (800×6000)", JSON.stringify(fitWithin(800, 6000)) === JSON.stringify({ width: 800, height: 6000 }));
  const cases: [number, number][] = [[4032, 3024], [3024, 4032], [640, 460], [1179, 10000], [800, 6000], [2500, 2500], [12000, 1500]];
  check("server fitImage == client fitWithin on every case (one sizing rule)", cases.every(([w, h]) => JSON.stringify(fitImage(w, h)) === JSON.stringify(fitWithin(w, h))));
  const picked = new File([new Uint8Array(10)], "r.jpg", { type: "image/jpeg" });
  check("client compression OFF by default (flag receipt_client_compression not yet read) ⇒ the picked file is uploaded as-is", (await compressImageForUpload(picked)) === picked);
  check("client compresses JPEG/PNG/HEIC but never a PDF or GIF", isCompressibleImage({ type: "image/jpeg" }) && isCompressibleImage({ type: "image/png" }) && isCompressibleImage({ type: "image/heic" }) && !isCompressibleImage({ type: "application/pdf" }) && !isCompressibleImage({ type: "image/gif" }));

  const big = new Uint8Array(10_000).fill(7).buffer as ArrayBuffer;
  let calls = 0;
  const binding = (outBytes: number | "throw") => ({
    info: async () => ({ format: "image/jpeg", fileSize: 10_000, width: 4032, height: 3024 }),
    input: () => ({
      transform: () => ({
        output: async () => {
          calls++;
          if (outBytes === "throw") throw new Error("9412 not an image");
          return { image: () => new Blob([new Uint8Array(outBytes)]).stream(), contentType: () => "image/jpeg", response: () => new Response() };
        },
      }),
    }),
  });
  const env = (flags: string, images?: unknown) => ({ FEATURES: flags, IMAGES: images }) as unknown as Env;
  const off = await maybeCompressImage(env("", binding(100)), big, "image/jpeg");
  check("flag OFF ⇒ the received bytes are stored verbatim (binding never called)", off.bytes === big && off.mime === "image/jpeg" && !off.compressed && calls === 0);
  const noBinding = await maybeCompressImage(env("receipt_image_compression"), big, "image/jpeg");
  check("flag ON but no Images binding ⇒ verbatim", noBinding.bytes === big && !noBinding.compressed);
  const on = await maybeCompressImage(env("receipt_image_compression", binding(1200)), big, "image/png");
  check("flag ON + binding ⇒ smaller JPEG stored", on.compressed && on.bytes.byteLength === 1200 && on.mime === "image/jpeg");
  const pdf = await maybeCompressImage(env("receipt_image_compression", binding(10)), big, "application/pdf");
  check("a PDF is never sent to the image transform", !pdf.compressed && pdf.bytes === big && pdf.mime === "application/pdf");
  const larger = await maybeCompressImage(env("receipt_image_compression", binding(20_000)), big, "image/jpeg");
  check("a result that isn't smaller keeps the original", !larger.compressed && larger.bytes === big);
  const err = await maybeCompressImage(env("receipt_image_compression", binding("throw")), big, "image/jpeg");
  check("a transform error keeps the original (never lose a receipt)", !err.compressed && err.bytes === big);
}

function sourceGuards() {
  console.log("\n== Durable Object / route source guards ==");
  const agent = fs.readFileSync(path.join(root, "src", "agent.ts"), "utf8");
  const api = fs.readFileSync(path.join(root, "src", "api.ts"), "utf8");
  const body = (name: string) => { const i = agent.indexOf(`async ${name}(`); return agent.slice(i, agent.indexOf("\n  }\n", i)); };

  check("no raw RECEIPTS.get left in agent.ts / api.ts (every read handles gzip + missing objects)", !/RECEIPTS\.get\(/.test(agent) && !/RECEIPTS\.get\(/.test(api));
  check("receipt + document viewers go through originalResponse (410 when the object is gone)", (api.match(/originalResponse\(env\.RECEIPTS/g) ?? []).length === 2);

  const ingest = body("ingest");
  check("ingest: duplicate check runs BEFORE any R2 put", ingest.indexOf("status <> 'duplicate'") > 0 && ingest.indexOf("status <> 'duplicate'") < ingest.indexOf("RECEIPTS.put"));
  check("ingest: a duplicate reuses the original's key, restoring the object THERE if it was cleared", /const dupKey = prior\.receipt_key \?\? key;/.test(ingest) && /RECEIPTS\.put\(dupKey,/.test(ingest));
  check("ingest: the image hash is over the RECEIVED bytes (before compression)", ingest.indexOf("sha256hexBytes(bytes)") < ingest.indexOf("maybeCompressImage"));

  check("ingest: dedupe matches the SPA's pre-compression hash OR the received-bytes hash", /image_hash IN \(\?, \?\)/.test(ingest) && /validHash\(originalHash\) \?\? bytesHash/.test(ingest));
  check("/api/upload + /api/documents/upload forward orig_sha256 to the DO", (api.match(/form\.get\("orig_sha256"\)/g) ?? []).length === 2);
  check("deleteDocument checks keyStillReferenced AFTER deleting its own transactions", body("deleteDocument").indexOf("DELETE FROM transactions") < body("deleteDocument").indexOf("keyStillReferenced"));

  const route = body("classifyAndRoute");
  check("classifyAndRoute: duplicate-document check matches either hash", /image_hash IN \(\?, \?\)/.test(route));
  check("classifyAndRoute: duplicate-document guard runs BEFORE the R2 put (no orphan per re-send)", route.indexOf("dupDoc") > 0 && route.indexOf("return { docId: dupDoc.id") < route.indexOf("RECEIPTS.put(r2key"));

  const parse = body("parseStatement");
  check("parseStatement: content-addressed original key", /const fileKey = statementFileKey\(userId, fileHash\);/.test(parse));
  check("parseStatement: exact re-upload short-circuit kept (duplicate: true)", /duplicate: true/.test(parse));
  check("parseStatement: a re-upload restores a cleared original without re-parsing", /putStatementOriginal\(this\.env\.RECEIPTS, existing\.file_key, bytes, format\)/.test(parse));
  check("parseStatement: a parsed statement whose sidecar is gone is replaced, not dead-ended", /existing\.status === "parsed" && .*objectExists\(this\.env\.RECEIPTS, `\$\{existing\.file_key\}\.lines`\)/.test(parse));
  check("parseStatement: a failed parse removes the unreferenced original it created (not a concurrent retry's)", /if \(wrote && !owner\) await this\.env\.RECEIPTS\.delete\(fileKey\)/.test(parse));
  check("parseStoredStatement re-puts a shared original a concurrent failure removed, before inserting its row", /if \(!\(await objectExists\(this\.env\.RECEIPTS, fileKey\)\)\) await putStatementOriginal/.test(agent));
  check("classifyAndRoute: an exact re-upload restores a cleared document original", /dupDoc\.r2_key && !\(await objectExists\(this\.env\.RECEIPTS, dupDoc\.r2_key\)\)/.test(body("classifyAndRoute")));
  check("statement sidecar written gzipped", /putJson\(this\.env\.RECEIPTS, `\$\{fileKey\}\.lines`, lines\)/.test(agent));

  check("confirmImport: missing sidecar → clear 'no longer stored' error (409 at the route), not a crash", /readStoredJson<StatementLine\[\]>\(this\.env\.RECEIPTS, `\$\{stmt\.file_key\}\.lines`\)/.test(body("confirmImport")) && /if \(!lines\) throw new Error\(STATEMENT_LINES_MISSING_MESSAGE\)/.test(body("confirmImport")));
  check("confirmCapitalImport: missing rows → clear error", /if \(!all\) throw new Error\(CAPITAL_ROWS_MISSING_MESSAGE\)/.test(body("confirmCapitalImport")));
  check("capital import: .rows sidecar + CSV written gzipped", /putJson\(this\.env\.RECEIPTS, `\$\{fileKey\}\.rows`, preview\.rows\)/.test(agent) && /putCompressed\(this\.env\.RECEIPTS, fileKey, bytes, "text\/csv"\)/.test(agent));

  const delTxn = body("deleteTransaction");
  check("deleteTransaction deletes an object only when keyStillReferenced says no other row uses it", /keyStillReferenced\(this\.env\.DB, userId, k, \{ exceptTxnId: txnId, includeDocuments: true \}\)/.test(delTxn));
  check("deleteTransaction tolerates an already-missing object", /RECEIPTS\.delete\(k\)\.catch\(/.test(delTxn));
  check("one statement row per (user_id, file_hash) — so a content-addressed key has one owner", /CREATE UNIQUE INDEX IF NOT EXISTS idx_stmt_filehash ON statements\(user_id, file_hash\)/.test(fs.readFileSync(path.join(root, "schema.sql"), "utf8")));
  check("deleteDocument tolerates an already-missing object", /RECEIPTS\.delete\(doc\.r2_key\)\.catch\(/.test(body("deleteDocument")));
  check("statement keys stay under the tenant prefix (purgeTenant's sweep covers them)", statementFileKey("u1", "ab").startsWith("u1/statements/"));
}

async function main() {
  await compression();
  await missingOriginals();
  await sharedKeys();
  await images();
  sourceGuards();
  console.log(`\n=== receipt storage: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}
main();
