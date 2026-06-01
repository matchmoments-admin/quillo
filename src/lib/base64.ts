/**
 * Safe base64 for arbitrary byte sizes.
 *
 * Fixes review finding H2: `btoa(String.fromCharCode(...new Uint8Array(bytes)))`
 * throws "Maximum call stack size exceeded" for inputs over ~65KB (most receipt
 * PDFs) because all bytes are spread as function arguments. We encode in 32KB
 * windows so the argument list never grows unbounded.
 */
export function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000; // 32KB
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Hex string -> bytes (for HMAC signature comparison). Returns null on bad input. */
export function hexToBytes(hex: string): Uint8Array | null {
  const clean = hex.trim().toLowerCase();
  if (clean.length === 0 || clean.length % 2 !== 0 || /[^0-9a-f]/.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

/** SHA-256 hex digest of a UTF-8 string (used by the audit hash-chain). */
export async function sha256hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 hex digest of raw bytes (used for exact-duplicate receipt detection). */
export async function sha256hexBytes(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
