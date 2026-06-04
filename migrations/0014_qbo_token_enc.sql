-- 0014: envelope-encrypt QuickBooks OAuth tokens at the application layer.
--
-- `enc_ver` marks the storage format of access_token / refresh_token in qbo_connections:
--   0 = legacy plaintext (pre-encryption rows — read as-is)
--   1 = AES-256-GCM sealed (base64 of iv ++ ciphertext+tag), key = QBO_TOKEN_KEY Worker secret
--
-- Additive + apply-once: existing rows default to 0 and keep working unchanged; the dual-read in
-- src/lib/token-crypto.ts handles both formats, and the next token refresh re-writes a row sealed
-- once QBO_TOKEN_KEY is configured. Cloudflare already encrypts D1 at rest; this is defence-in-depth.
ALTER TABLE qbo_connections ADD COLUMN enc_ver INTEGER NOT NULL DEFAULT 0;
