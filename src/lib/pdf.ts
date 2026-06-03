import { PDFDocument } from "@cantoo/pdf-lib";

// PDF page utilities for chunked statement extraction. @cantoo/pdf-lib is an API-compatible fork
// of pdf-lib (pure JS, bundles cleanly in a Worker) that adds real decryption. Splitting a large
// statement into page-range sub-PDFs bounds the per-call output (each chunk emits far fewer lines
// than max_tokens) and keeps cost predictable; reconciliation across the stitched result proves
// no page was dropped.

// Bank statements (e.g. CommBank) ship with empty-password owner encryption. Stock pdf-lib's
// `ignoreEncryption` only skips the *check* — it leaves the object streams encrypted, so the page
// tree won't resolve and copyPages throws "Expected instance of PDFDict … undefined" (and Claude
// can't read the bytes either). The @cantoo fork's `password` option actually DECRYPTS; "" covers
// the empty user password. Re-saving a split then emits clean, unencrypted sub-PDFs for Claude.
const LOAD_OPTS = { updateMetadata: false, ignoreEncryption: true, password: "", throwOnInvalidObject: false } as const;

/**
 * Load + re-save a PDF, decrypting empty-password encryption so EVERY downstream consumer
 * (Claude document input + splitPdf) gets clean, unencrypted bytes. Returns the original bytes
 * unchanged if it can't be parsed — let Claude try the raw file rather than hard-fail.
 */
export async function normalizePdf(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  try {
    const doc = await PDFDocument.load(bytes, LOAD_OPTS);
    const saved = await doc.save();
    return saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength) as ArrayBuffer;
  } catch {
    return bytes;
  }
}

export async function pdfPageCount(bytes: ArrayBuffer): Promise<number> {
  try {
    const doc = await PDFDocument.load(bytes, LOAD_OPTS);
    return doc.getPageCount();
  } catch {
    return 1; // unreadable as PDF → treat as single (Claude may still handle it)
  }
}

/** Split a PDF into sub-PDFs of `pagesPerChunk` pages each (in order). */
export async function splitPdf(bytes: ArrayBuffer, pagesPerChunk: number): Promise<ArrayBuffer[]> {
  const src = await PDFDocument.load(bytes, LOAD_OPTS);
  const total = src.getPageCount();
  const out: ArrayBuffer[] = [];
  for (let start = 0; start < total; start += pagesPerChunk) {
    const chunk = await PDFDocument.create();
    const idxs = [];
    for (let p = start; p < Math.min(start + pagesPerChunk, total); p++) idxs.push(p);
    const pages = await chunk.copyPages(src, idxs);
    for (const pg of pages) chunk.addPage(pg);
    const saved = await chunk.save();
    // copy into a fresh ArrayBuffer (Claude/document input expects ArrayBuffer)
    out.push(saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength) as ArrayBuffer);
  }
  return out;
}
