#!/usr/bin/env node
// Test client: sign a file with a tenant ingest key and POST it to /ingest.
// Usage:
//   node scripts/upload.mjs <url> <keyId> <secret> <file> [mime] [bucketHint]
// Example:
//   node scripts/upload.mjs https://tax-agent.<you>.workers.dev/ingest k_me <secret> receipt.jpg image/jpeg company
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const [, , url, keyId, secret, file, mime = "image/jpeg", bucketHint] = process.argv;
if (!url || !keyId || !secret || !file) {
  console.error("usage: node scripts/upload.mjs <url> <keyId> <secret> <file> [mime] [bucketHint]");
  process.exit(1);
}

const body = readFileSync(file);
const ts = Date.now().toString();
const nonce = randomUUID();
const signed = Buffer.concat([Buffer.from(`${ts}.${nonce}.`), body]);
const sig = createHmac("sha256", secret).update(signed).digest("hex");

const headers = {
  "content-type": mime,
  "x-key-id": keyId,
  "x-timestamp": ts,
  "x-nonce": nonce,
  "x-signature": sig,
  "x-source": "upload",
};
if (bucketHint) headers["x-bucket"] = bucketHint;

const res = await fetch(url, { method: "POST", headers, body });
console.log(res.status, await res.text());
