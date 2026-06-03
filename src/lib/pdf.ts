import { PDFDocument } from "pdf-lib";

// PDF page utilities for chunked statement extraction. pdf-lib is pure JS (bundles cleanly in
// a Worker, unlike the AWS SDK). Splitting a large statement into page-range sub-PDFs bounds
// the per-call output (each chunk emits far fewer lines than max_tokens) and keeps cost
// predictable; reconciliation across the stitched result proves no page was dropped.

// `ignoreEncryption: true` — bank statements (e.g. CommBank) ship with empty-password owner
// encryption; pdf-lib otherwise throws "Input document … is encrypted" on load. Re-saving a
// split also strips that encryption, so Claude receives clean sub-PDFs.
export async function pdfPageCount(bytes: ArrayBuffer): Promise<number> {
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
    return doc.getPageCount();
  } catch {
    return 1; // unreadable as PDF → treat as single (Claude may still handle it)
  }
}

/** Split a PDF into sub-PDFs of `pagesPerChunk` pages each (in order). */
export async function splitPdf(bytes: ArrayBuffer, pagesPerChunk: number): Promise<ArrayBuffer[]> {
  const src = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
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
