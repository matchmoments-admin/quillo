# Tax Agent — Android companion app

A thin Kotlin/Compose client for the tax-agent Worker. Lives in the monorepo under
`android/`; the Worker stays at the repo root. The app signs every request to match
the Worker's `/ingest` HMAC contract exactly (see `../src/ingest/auth.ts`).

## Capabilities

1. **Share-sheet target** (reliable backbone) — share any receipt image/PDF from any
   app to "Tax Agent"; it signs + uploads. `ShareReceiverActivity`.
2. **Quick-snap tile** — open the app, pick a bucket (PAYG / Company / Property),
   "Snap receipt" → camera → signed upload with an `x-bucket` hint. `MainActivity`.
3. **Wallet tap-to-pay capture** — OPTIONAL, **best-effort**. `TxnListener` observes
   Google Wallet notifications. On Android 15+ this is frequently blocked for
   sideloaded apps and/or the payment content is redacted, so it runs in **self-test
   mode**: the Diagnostics screen shows exactly what your device exposed. It does not
   auto-log anything.

## Tech

Kotlin · Jetpack Compose · Gradle Kotlin DSL · `minSdk 23` / `compileSdk 36` ·
OkHttp · Android Keystore (AES-GCM envelope) for the at-rest secret. No
EncryptedSharedPreferences (deprecated 2025).

## Build & run

1. Open the **`android/`** folder in Android Studio (latest stable). Let Gradle sync —
   it fetches the wrapper jar + SDK on first run. (Versions in the `.kts` files are
   2026-current; accept Studio's suggested minor bumps if prompted.)
2. Build the **debug** APK and install on your device (sideload — no Play review).
3. **Provision** (one time): in the tax-agent repo run
   `node scripts/seed-tenant.mjs me me android`, then paste the printed `KEY_ID`,
   `SECRET`, and your deployed Worker base URL into the app's connect screen.
4. **Reliable capture:** share a receipt photo to "Tax Agent" (or use Snap receipt).
   Verify server-side:
   ```bash
   wrangler d1 execute tax-agent-db --command \
     "SELECT merchant,amount_cents,bucket,status FROM transactions ORDER BY created_at DESC LIMIT 5"
   ```

## Optional: enable the Wallet self-test

Settings → Apps → Special app access → Notification access → enable "Tax Agent".
If your Android build blocks that for a sideloaded app, grant via ADB:

```bash
adb shell cmd notification allow_listener \
  au.askarthur.taxagent/au.askarthur.taxagent.TxnListener
```

Make a tap-to-pay, then open the app's **Diagnostics** screen to see whether your
device delivered the merchant/amount or redacted it. Decide from there whether the
Wallet path is worth promoting to an actionable "Log $X?" prompt.

## Prerequisites

The Worker must be deployed and your tenant seeded first (see the top-level
`../README.md`, Stage 1 first-run). Until then, uploads will fail with a network/401.
