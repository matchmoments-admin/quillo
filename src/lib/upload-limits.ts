// Upload size ceilings (security sweep #694, finding S-08 / #713).
//
// Every upload route buffers the whole body, then base64-encodes it for the model and copies it again over
// the Durable Object RPC. A 60-100 MB body (the Cloudflare plan cap) blows the 128 MB isolate limit, or reaches
// the model and wastes spend before the provider refuses it. So each route reads its body through
// readBodyCapped / readFormCapped (below), which refuse a declared Content-Length over the ceiling before
// reading and otherwise STREAM the body, stopping at the ceiling. Content-Length alone is not a bound: a
// chunked body has none, and `req.formData()` / `req.arrayBuffer()` buffer all of it before any per-file
// check could run. Each file part's size is still checked after the multipart parse.
//
// Ceilings, from real files rather than round numbers:
//   - receipt:   a phone photo is 2-12 MB before the SPA's client-side compression (and stays that size when
//                receipt_client_compression is OFF or the device can't decode it); a receipt PDF is well under
//                1 MB. 20 MB leaves headroom for a 48 MP HEIC/JPEG.
//   - document:  payslips, NOAs, agent rental summaries, dividend statements: almost all under 2 MB; a
//                scanned multi-page PDF can reach 10-15 MB. 25 MB. (The model's request cap is 32 MB AFTER
//                base64, about 24 MB of raw bytes, so a bigger document can't be read anyway.)
//   - statement: a CSV for several years of a busy account is under 5 MB; a 12-month bank PDF is typically
//                0.2-3 MB, and a scanned one can reach 15-20 MB. 25 MB, the same model-cap reasoning.
//   - capital:   a broker / registry / exchange CSV export. 10 MB is many thousands of trades.
//   - email:     Cloudflare Email Routing accepts messages up to 25 MB; the raw MIME is about 4/3 of the
//                attachment bytes, so each decoded attachment is held to the receipt-or-document ceiling.
//
// Multi-file receipt uploads (several screenshots = one receipt) are capped in total as well as per file.
// The SPA mirrors these numbers (web/src/lib/upload-limits.ts) so an oversized file is refused before it
// is sent; scripts/check-units.ts fails if the two drift.

export const MB = 1024 * 1024;

export const UPLOAD_LIMITS = {
  receipt: 20 * MB,
  receiptTotal: 40 * MB,
  document: 25 * MB,
  statement: 25 * MB,
  statementCsv: 5 * MB, // a CSV this size is already ~60k rows; a personal year is a few thousand (#746)
  capital: 10 * MB,
  emailRaw: 40 * MB,
} as const;

export type UploadKind = keyof typeof UPLOAD_LIMITS;

/** Room for the multipart boundaries, part headers and small text fields around the file bytes. */
export const MULTIPART_OVERHEAD = 1 * MB;

const LABEL: Record<UploadKind, string> = {
  receipt: "receipt",
  receiptTotal: "set of receipt images",
  document: "document",
  statement: "statement",
  statementCsv: "CSV statement",
  capital: "import file",
  emailRaw: "email",
};

export function formatMb(bytes: number): string {
  return `${Math.round(bytes / MB)} MB`;
}

/** The user-facing refusal. Plain language, names the ceiling, and says what to do next. */
export function tooLargeMessage(kind: UploadKind): string {
  const max = formatMb(UPLOAD_LIMITS[kind]);
  const hint =
    kind === "statement"
      ? " Split it into shorter date ranges, or download it as CSV instead of PDF."
      : kind === "statementCsv"
        ? " A year of personal banking is usually far smaller. Split it into shorter date ranges, one account per file."
      : kind === "receiptTotal"
        ? " Upload fewer images at once."
        : " Try a smaller photo or scan, or split the file.";
  return `That ${LABEL[kind]} is too large (the limit is ${max}).${hint}`;
}

/**
 * True when the request DECLARES a body over the ceiling (plus multipart overhead when it is a form).
 * A missing or unparseable Content-Length passes here, so this is only an early refusal: the body itself
 * must still be read through readBodyCapped / readFormCapped, which bound it whatever the header says.
 */
export function declaredTooLarge(req: Request, kind: UploadKind, multipart = true): boolean {
  const raw = req.headers.get("content-length");
  if (raw == null || raw.trim() === "") return false;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return false;
  return n > UPLOAD_LIMITS[kind] + (multipart ? MULTIPART_OVERHEAD : 0);
}

/** True when a parsed file part (Blob.size, or a buffer's byteLength) is over the ceiling. */
export function fileTooLarge(size: number, kind: UploadKind): boolean {
  return size > UPLOAD_LIMITS[kind];
}

/** The 413 JSON the SPA's errFrom() turns into the toast / inline note text. */
export function tooLargeResponse(kind: UploadKind): Response {
  return Response.json({ error: tooLargeMessage(kind) }, { status: 413 });
}

// ── Bounded body reads (review F8) ───────────────────────────────────────────────────────────────
// `await req.arrayBuffer()` / `req.text()` / `req.formData()` buffer the WHOLE body, and a chunked body
// carries no Content-Length to refuse it by. readBodyCapped streams req.body and stops at the limit, so a
// route never holds more than maxBytes, whatever the client declared.

export type CappedBody = { ok: true; bytes: ArrayBuffer } | { ok: false; response: Response };

/** The default refusal: a plain-text 413 (public routes; the upload routes pass their own JSON one). */
export const payloadTooLarge = (): Response => new Response("payload too large", { status: 413 });

/**
 * Read the request body, refusing with 413 once it passes `maxBytes`. A declared Content-Length over the
 * limit is refused before a byte is read; otherwise the stream is read chunk by chunk and cancelled the
 * moment the running total passes the limit.
 */
export async function readBodyCapped(req: Request, maxBytes: number, tooLarge: () => Response = payloadTooLarge): Promise<CappedBody> {
  const raw = req.headers.get("content-length");
  if (raw != null && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > maxBytes) return { ok: false, response: tooLarge() };
  }
  if (!req.body) return { ok: true, bytes: new ArrayBuffer(0) };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return { ok: false, response: tooLarge() };
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return { ok: true, bytes: out.buffer };
}

/** A text body, capped (see readBodyCapped). */
export async function readTextCapped(req: Request, maxBytes: number, tooLarge?: () => Response): Promise<{ ok: true; text: string } | { ok: false; response: Response }> {
  const r = await readBodyCapped(req, maxBytes, tooLarge);
  return r.ok ? { ok: true, text: new TextDecoder().decode(r.bytes) } : r;
}

/**
 * A multipart upload, cap-read BEFORE it is parsed: the body may not pass the kind's ceiling plus the
 * multipart overhead, with or without a Content-Length. The per-file checks after the parse still apply.
 */
export async function readFormCapped(req: Request, kind: UploadKind): Promise<{ ok: true; form: FormData } | { ok: false; response: Response }> {
  const r = await readBodyCapped(req, UPLOAD_LIMITS[kind] + MULTIPART_OVERHEAD, () => tooLargeResponse(kind));
  if (!r.ok) return r;
  const ct = req.headers.get("content-type") ?? "";
  return { ok: true, form: await new Response(r.bytes, { headers: { "content-type": ct } }).formData() };
}

/** Caps for the small public, non-upload bodies (bytes). */
export const PUBLIC_BODY_LIMITS = {
  cspReport: 8 * 1024, // a violation report is ~1 KB
  stripeWebhook: 64 * 1024, // a checkout.session.completed event is a few KB
  correct: 16 * 1024, // { txnId, field, value }: one field edit
  consent: 64 * 1024, // the consent text the user agreed to, plus the method
} as const;
