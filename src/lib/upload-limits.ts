// Upload size ceilings (security sweep #694, finding S-08 / #713).
//
// Every upload route buffers the whole body, then base64-encodes it for the model and copies it again over
// the Durable Object RPC. A 60-100 MB body (the Cloudflare plan cap) blows the 128 MB isolate limit, or reaches
// the model and wastes spend before the provider refuses it. So each route checks Content-Length BEFORE it
// reads the body, and each file part's size after the multipart parse (a body sent without Content-Length is
// still bounded per file).
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
      : kind === "receiptTotal"
        ? " Upload fewer images at once."
        : " Try a smaller photo or scan, or split the file.";
  return `That ${LABEL[kind]} is too large (the limit is ${max}).${hint}`;
}

/**
 * True when the request DECLARES a body over the ceiling (plus multipart overhead when it is a form).
 * A missing or unparseable Content-Length passes here; the per-file check after the parse still applies.
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
