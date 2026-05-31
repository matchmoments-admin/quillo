#!/usr/bin/env node
// Batch expense feeder for the Quillo agent. Signs each item with a tenant ingest key
// (same HMAC scheme as scripts/upload.mjs) and POSTs it to /ingest, then prints the
// resulting transactions table so you can see how each one was categorised.
//
// Usage:
//   node scripts/feed-expenses.mjs <baseUrl> <keyId> <secret> <dir|file.txt|file.jpg> [--alert]
//
//   <dir>       → uploads every supported image/PDF in the directory (vision path)
//   <file.txt>  → posts each non-empty line as a typed expense (Claude categorises it)
//                 add --alert to instead test the bank-alert parser (capture only)
//   <file.jpg>  → uploads a single image/PDF
//
// Example:
//   node scripts/feed-expenses.mjs https://app.quillo.au k_xxx <secret> ~/receipts
//   node scripts/feed-expenses.mjs https://app.quillo.au k_xxx <secret> expenses.txt
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, extname, basename } from "node:path";

const alert = process.argv.includes("--alert");
const [baseUrlRaw, keyId, secret, target] = process.argv.slice(2).filter((a) => a !== "--alert");
if (!baseUrlRaw || !keyId || !secret || !target) {
  console.error("usage: node scripts/feed-expenses.mjs <baseUrl> <keyId> <secret> <dir|file.txt|file.jpg> [--alert]");
  process.exit(1);
}
const baseUrl = baseUrlRaw.replace(/\/$/, "");
const ingestUrl = `${baseUrl}/ingest`;

const MIME = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
};

function post(body, mime, extraHeaders = {}) {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const signed = Buffer.concat([Buffer.from(`${ts}.${nonce}.`), body]);
  const sig = createHmac("sha256", secret).update(signed).digest("hex");
  return fetch(ingestUrl, {
    method: "POST",
    headers: {
      "content-type": mime,
      "x-key-id": keyId,
      "x-timestamp": ts,
      "x-nonce": nonce,
      "x-signature": sig,
      "x-source": "feed",
      ...extraHeaders,
    },
    body,
  });
}

async function sendImage(filePath, label) {
  const mime = MIME[extname(filePath).toLowerCase()];
  const body = readFileSync(filePath);
  process.stdout.write(`→ ${label} (${mime}) ... `);
  const res = await post(body, mime);
  console.log(res.status, (await res.text()).slice(0, 140));
}

async function sendText(line) {
  process.stdout.write(`→ "${line}"${alert ? " [alert]" : ""} ... `);
  const res = await post(Buffer.from(line, "utf8"), "text/plain", alert ? { "x-parse": "alert" } : {});
  console.log(res.status, (await res.text()).slice(0, 140));
}

const st = statSync(target);
let sent = 0;

if (st.isDirectory()) {
  const all = readdirSync(target).filter((f) => extname(f));
  const supported = all.filter((f) => MIME[extname(f).toLowerCase()]);
  const skipped = all.filter((f) => !MIME[extname(f).toLowerCase()]);
  for (const f of supported) {
    await sendImage(join(target, f), f);
    sent++;
  }
  if (skipped.length) {
    console.log(`\n(skipped ${skipped.length} unsupported: ${skipped.join(", ")})`);
    if (skipped.some((f) => /\.heic$/i.test(f))) {
      console.log("  HEIC isn't supported by the vision API — convert first: sips -s format jpeg in.heic --out out.jpg");
    }
  }
} else if (target.toLowerCase().endsWith(".txt")) {
  const lines = readFileSync(target, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    await sendText(line);
    sent++;
  }
} else if (MIME[extname(target).toLowerCase()]) {
  await sendImage(target, basename(target));
  sent++;
} else {
  console.error(`unsupported target: ${target} (want a directory, a .txt, or an image/PDF)`);
  process.exit(1);
}

// Show how they landed. /ingest awaits extraction synchronously, so the rows are ready.
// The /api read is gated by Cloudflare Access; if that's enabled this returns HTML/401,
// so report that rather than silently printing an empty table (the uploads still worked).
let rows = [];
try {
  const res = await fetch(`${baseUrl}/api/transactions?limit=25`);
  const ct = res.headers.get("content-type") ?? "";
  if (!res.ok || !ct.includes("application/json")) {
    console.log(`\n(couldn't read /api/transactions: HTTP ${res.status} ${ct} — Cloudflare Access likely gates it now.`);
    console.log(` The ${sent} uploads succeeded regardless; review them at ${baseUrl}.)`);
  } else {
    rows = (await res.json()).transactions ?? [];
  }
} catch (e) {
  console.log(`\n(couldn't read /api/transactions: ${e.message}. The ${sent} uploads still succeeded.)`);
}

console.log(`\n=== latest transactions (${sent} sent this run) ===`);
const pad = (s, n) => String(s ?? "—").padEnd(n).slice(0, n);
console.log([pad("merchant", 26), "amount".padStart(10), pad("bucket", 16), pad("ato_label", 24), "conf", "status"].join("  "));
for (const t of rows) {
  const amt = t.amount_cents == null ? "—" : `$${(t.amount_cents / 100).toFixed(2)}`;
  console.log(
    [
      pad(t.merchant, 26),
      amt.padStart(10),
      pad(t.bucket, 16),
      pad(t.ato_label, 24),
      t.confidence == null ? "—  " : t.confidence.toFixed(2),
      t.status,
    ].join("  "),
  );
}
