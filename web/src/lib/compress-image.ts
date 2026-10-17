/**
 * Shrink a receipt photo in the browser before it is uploaded, so R2 stores ~0.3-0.6 MB instead of a 3-4 MB
 * phone original.
 *
 * - Longest edge capped at MAX_EDGE (2000px): receipt text stays legible (the ATO "true and clear" copy bar)
 *   and it is above what the vision model reads anyway (~1568px).
 * - Re-encoded as JPEG at QUALITY 0.8 (universally decodable; Safari can't encode WebP from a canvas).
 * - EXIF is dropped whenever the re-encode is used (a canvas re-encode carries no metadata, so the photo's GPS
 *   doesn't leave the device), while the EXIF orientation is honoured first (`imageOrientation: "from-image"`)
 *   so a sideways photo stays upright. When we fall back to the original (below) its EXIF is uploaded as-is.
 * - Falls back to the ORIGINAL file whenever the result isn't smaller, the file isn't a raster image (PDFs are
 *   never touched), it is an animated GIF, or the browser can't decode it (e.g. HEIC outside Safari). A
 *   compression failure must never block an upload.
 */
export const MAX_EDGE = 2000;
export const QUALITY = 0.8;

const COMPRESSIBLE = /^image\/(jpeg|jpg|pjpeg|png|webp|heic|heif|avif|bmp|tiff)$/i;

/** Never shrink the SHORT edge below this: a tall full-page screenshot (1179×10000) must stay readable. */
export const MIN_SHORT_EDGE = 1000;

/**
 * Target size for a source of w×h: longest edge at most maxEdge — unless that would push the short edge under
 * MIN_SHORT_EDGE (long receipts / scrolling screenshots), in which case the short edge is held at
 * MIN_SHORT_EDGE instead. Never upscales; aspect preserved. Mirrored server-side in src/lib/r2-store.ts.
 */
export function fitWithin(w: number, h: number, maxEdge = MAX_EDGE, minShort = MIN_SHORT_EDGE): { width: number; height: number } {
  const longest = Math.max(w, h);
  const shortest = Math.min(w, h);
  if (longest <= maxEdge || shortest <= 0) return { width: w, height: h };
  let scale = maxEdge / longest;
  if (shortest * scale < minShort) scale = Math.min(1, minShort / shortest);
  if (scale >= 1) return { width: w, height: h };
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

// Flag receipt_client_compression, fed from the dashboard payload (api.dashboard). OFF / not yet known ⇒
// every file is uploaded exactly as picked (the pre-compression behaviour).
let clientCompressionOn = false;
export function setClientCompression(on: boolean): void {
  clientCompressionOn = on;
}

export function isCompressibleImage(file: { type: string }): boolean {
  return COMPRESSIBLE.test(file.type);
}

function jpegName(name: string): string {
  const base = name.replace(/\.[^./\\]+$/, "");
  return `${base || "receipt"}.jpg`;
}

export async function compressImageForUpload(file: File): Promise<File> {
  if (!clientCompressionOn || !isCompressibleImage(file) || typeof createImageBitmap !== "function" || typeof document === "undefined") return file;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    // JPEG has no alpha: paint white first so a transparent PNG screenshot doesn't turn black.
    ctx.fillStyle = "white"; // image pixels, not a UI colour
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", QUALITY));
    if (!blob || blob.size === 0 || blob.size >= file.size) return file;
    return new File([blob], jpegName(file.name), { type: "image/jpeg", lastModified: file.lastModified });
  } catch {
    return file; // undecodable here (e.g. HEIC on Chrome) — the server stores it as received
  } finally {
    bitmap?.close();
  }
}

/**
 * Compress for upload AND report the original photo's SHA-256 when the bytes changed, so the server's
 * exact-duplicate check (image_hash) still matches receipts stored before client-side compression.
 */
export async function prepareImageUpload(file: File): Promise<{ file: File; originalHash: string | null }> {
  const out = await compressImageForUpload(file);
  if (out === file || typeof crypto === "undefined" || !crypto.subtle) return { file: out, originalHash: null };
  try {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
    return { file: out, originalHash: Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("") };
  } catch {
    return { file: out, originalHash: null };
  }
}

/** Compress every image in a list (PDFs and other files pass through untouched). */
export function compressImagesForUpload(files: File[]): Promise<File[]> {
  return Promise.all(files.map((f) => compressImageForUpload(f)));
}
