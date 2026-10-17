/**
 * R2 storage for the tax-agent-receipts bucket: what we compress, what we never touch, and how every read
 * copes with an object that is no longer there.
 *
 * - JSON sidecars (`.lines`, `.rows`) and CSV originals are gzipped on write (CompressionStream), keyed
 *   exactly as before. The object carries `httpMetadata.contentEncoding = "gzip"` plus a
 *   `customMetadata.qenc = "gzip"` marker. Reads decompress only when the bytes actually START with the gzip
 *   magic number, so an object written before this change (plain JSON / CSV) reads back unchanged, and a
 *   runtime that ever decoded the body for us would also read correctly.
 * - Statement PDFs and documents are stored byte-for-byte. A PDF is evidence (ATO "true and clear" copy) and
 *   is already internally compressed — re-encoding it would buy almost nothing and break the file hash.
 * - Receipt images are compressed in the SPA before upload (web/src/lib/compress-image.ts). Images that
 *   arrive server-side (email, /ingest device path) can be re-encoded through the Cloudflare Images binding
 *   behind the `receipt_image_compression` flag (see maybeCompressImage).
 * - A row can outlive its object (the owner cleared the bucket and keeps the originals offline). Every read
 *   path goes through readStored / readStoredJson, which return null instead of throwing, and callers show
 *   ORIGINAL_MISSING_MESSAGE rather than a 500.
 */
import type { Env } from "../env";
import { featureOn } from "./features";

export const ORIGINAL_MISSING_MESSAGE = "The original file is no longer stored. Upload it again if you need it on file.";
export const STATEMENT_LINES_MISSING_MESSAGE = "The original file is no longer stored, so this statement can't be imported — upload the statement again.";
export const CAPITAL_ROWS_MISSING_MESSAGE = "The original file is no longer stored, so this import can't be committed — upload the file again.";

/** The slice of R2Bucket this module uses — small enough to fake in tests. */
export type Bucket = Pick<R2Bucket, "get" | "put" | "head" | "delete">;

const enc = new TextEncoder();
const dec = new TextDecoder();

function toU8(b: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof b === "string") return enc.encode(b);
  return b instanceof Uint8Array ? b : new Uint8Array(b);
}

export function isGzip(b: Uint8Array): boolean {
  return b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export function gzip(bytes: ArrayBuffer | Uint8Array | string): Promise<Uint8Array> {
  return pipe(toU8(bytes), new CompressionStream("gzip"));
}

export function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  return pipe(bytes, new DecompressionStream("gzip"));
}

/**
 * Write `body` gzipped when that is smaller (it always is for JSON/CSV of any real size). Returns the byte
 * counts so callers/tests can see the saving. Same key as an uncompressed write.
 */
export async function putCompressed(
  bucket: Bucket,
  key: string,
  body: ArrayBuffer | Uint8Array | string,
  contentType: string,
): Promise<{ original: number; stored: number; gzipped: boolean }> {
  const raw = toU8(body);
  const gz = await gzip(raw);
  if (gz.byteLength < raw.byteLength) {
    await bucket.put(key, gz, {
      httpMetadata: { contentType, contentEncoding: "gzip" },
      customMetadata: { qenc: "gzip", orig_bytes: String(raw.byteLength) },
    });
    return { original: raw.byteLength, stored: gz.byteLength, gzipped: true };
  }
  await bucket.put(key, raw, { httpMetadata: { contentType } });
  return { original: raw.byteLength, stored: raw.byteLength, gzipped: false };
}

export function putJson(bucket: Bucket, key: string, value: unknown) {
  return putCompressed(bucket, key, JSON.stringify(value), "application/json");
}

/**
 * Read an object's ORIGINAL bytes (decompressing a gzipped write). Null when the object is missing — the
 * caller decides what that means (404/410 for a viewer, "re-upload" for a confirm). Never throws for a
 * missing key; a genuinely corrupt gzip body does throw (that is data loss, not a missing file).
 */
export async function readStored(bucket: Bucket, key: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const obj = await bucket.get(key);
  if (!obj) return null;
  let bytes: Uint8Array = new Uint8Array(await obj.arrayBuffer());
  if (isGzipMarked(obj) && isGzip(bytes)) bytes = await gunzip(bytes);
  return { bytes, contentType: obj.httpMetadata?.contentType ?? "application/octet-stream" };
}

/** A JSON sidecar, or null when it is missing. Throws on unparseable JSON (callers already handle that). */
export async function readStoredJson<T>(bucket: Bucket, key: string): Promise<T | null> {
  const got = await readStored(bucket, key);
  if (!got) return null;
  return JSON.parse(dec.decode(got.bytes)) as T;
}

/**
 * Does any row OTHER than the one being deleted still point at `key`? A duplicate receipt reuses its
 * original's object (ingest) and a document-routed receipt shares its document's object, so deletes must not
 * pull an object out from under another row. `exceptTxnId` excludes the transaction being deleted;
 * `includeDocuments` also counts documents.r2_key (false when deleting the document itself).
 */
export async function keyStillReferenced(
  db: D1Database,
  userId: string,
  key: string,
  opts: { exceptTxnId?: string; includeDocuments: boolean },
): Promise<boolean> {
  const txn = await db.prepare(`SELECT 1 AS x FROM transactions WHERE user_id = ? AND receipt_key = ? AND id <> ? LIMIT 1`)
    .bind(userId, key, opts.exceptTxnId ?? "")
    .first<{ x: number }>();
  if (txn) return true;
  if (!opts.includeDocuments) return false;
  const doc = await db.prepare(`SELECT 1 AS x FROM documents WHERE user_id = ? AND r2_key = ? LIMIT 1`).bind(userId, key).first<{ x: number }>();
  return !!doc;
}

export async function objectExists(bucket: Bucket, key: string): Promise<boolean> {
  return (await bucket.head(key)) != null;
}

/**
 * The HTTP response for "show me the original": the decompressed bytes with their stored content type, or a
 * 410 carrying ORIGINAL_MISSING_MESSAGE when the row's object is gone. Never a 500 for a missing object.
 */
export async function originalResponse(bucket: Bucket, key: string): Promise<Response> {
  const obj = await bucket.get(key);
  if (!obj) {
    return new Response(JSON.stringify({ error: ORIGINAL_MISSING_MESSAGE, code: "original_missing" }), {
      status: 410,
      headers: { "content-type": "application/json" },
    });
  }
  const headers = { "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream", "cache-control": "private, max-age=60" };
  if (!isGzipMarked(obj)) return new Response(obj.body, { headers }); // stream (large PDFs never buffered)
  let bytes: Uint8Array = new Uint8Array(await obj.arrayBuffer());
  if (isGzip(bytes)) bytes = await gunzip(bytes);
  return new Response(bytes, { headers });
}

function isGzipMarked(obj: { customMetadata?: Record<string, string>; httpMetadata?: R2HTTPMetadata }): boolean {
  return obj.customMetadata?.qenc === "gzip" || obj.httpMetadata?.contentEncoding === "gzip";
}

/**
 * Content-addressed key for a statement original: the same file uploaded twice lands on ONE object (a parse
 * that failed and was retried used to leave a fresh uuid-keyed copy each time). Scoped under the tenant so
 * purgeTenant's `${userId}/` prefix sweep still covers it.
 */
export function statementFileKey(userId: string, fileHash: string): string {
  return `${userId}/statements/sha256-${fileHash}`;
}

/** Statement originals: PDFs are stored untouched (evidence); CSVs are gzipped like sidecars. */
export async function putStatementOriginal(bucket: Bucket, key: string, bytes: ArrayBuffer, format: string): Promise<void> {
  if (format === "pdf") {
    await bucket.put(key, bytes, { httpMetadata: { contentType: "application/pdf" } });
    return;
  }
  await putCompressed(bucket, key, bytes, "text/csv");
}

// ── Server-side image compression (flag receipt_image_compression) ─────────────────────────────────────────

/** Longest-edge cap + JPEG quality: keeps receipt text legible (the ATO "true and clear" bar). */
export const IMAGE_MAX_EDGE = 2000;
export const IMAGE_QUALITY = 80;

export const IMAGE_MIN_SHORT_EDGE = 1000;

/** Server twin of the SPA's fitWithin (kept in step by scripts/check-receipt-storage.ts). */
export function fitImage(w: number, h: number): { width: number; height: number } {
  const longest = Math.max(w, h);
  const shortest = Math.min(w, h);
  if (longest <= IMAGE_MAX_EDGE || shortest <= 0) return { width: w, height: h };
  let scale = IMAGE_MAX_EDGE / longest;
  if (shortest * scale < IMAGE_MIN_SHORT_EDGE) scale = Math.min(1, IMAGE_MIN_SHORT_EDGE / shortest);
  if (scale >= 1) return { width: w, height: h };
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

const COMPRESSIBLE_IMAGE = /^image\/(jpeg|jpg|pjpeg|png|webp|heic|heif|avif|tiff)$/i;

/**
 * Re-encode an inbound receipt image through the Cloudflare Images binding: scale-down to IMAGE_MAX_EDGE,
 * JPEG q80. The binding applies EXIF orientation and discards EXIF metadata (GPS) by default. Returns the
 * input untouched when the flag is OFF, the binding is absent (local tests, an env without [images]), the
 * mime isn't a raster image (PDFs are never touched), the transform fails, or the result isn't smaller.
 * Callers hash the ORIGINAL bytes before calling this so exact-duplicate detection is unchanged.
 */
export async function maybeCompressImage(
  env: Env,
  bytes: ArrayBuffer,
  mime: string,
): Promise<{ bytes: ArrayBuffer; mime: string; compressed: boolean }> {
  const untouched = { bytes, mime, compressed: false };
  if (!featureOn(env, "receipt_image_compression") || !env.IMAGES || !COMPRESSIBLE_IMAGE.test(mime)) return untouched;
  try {
    // Same sizing rule as the SPA (web/src/lib/compress-image.ts fitWithin): longest edge <= 2000px, but a
    // tall receipt / scrolling screenshot keeps its short edge >= 1000px so the text stays readable.
    const info = await env.IMAGES.info(new Blob([bytes]).stream());
    const dims = "width" in info ? fitImage(info.width, info.height) : null;
    if (!dims) return untouched; // SVG / unknown dimensions — store as received
    const result = await env.IMAGES.input(new Blob([bytes]).stream())
      .transform({ width: dims.width, height: dims.height, fit: "scale-down" })
      .output({ format: "image/jpeg", quality: IMAGE_QUALITY });
    const out = await new Response(result.image()).arrayBuffer();
    if (out.byteLength === 0 || out.byteLength >= bytes.byteLength) return untouched;
    return { bytes: out, mime: "image/jpeg", compressed: true };
  } catch {
    return untouched; // never lose a receipt because the transform failed — store the original
  }
}
