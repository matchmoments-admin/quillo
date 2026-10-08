# Outsourced service provider (OSP) register

> Every external service Quillo's code or operations use, with the country, the data it touches, and
> whether it receives **CDR data**. Feeds Fiskil's CDR policy listing (rule 7.2(4)(f)–(g) and (i)) and the
> representative agreement (rule 1.10AA(3)(b): a representative may use an OSP for service data **only**
> as the arrangement provides). Built from the code on 2026-10-08 (`grep` of outbound hosts in `src/`,
> `web/src/`, `wrangler.toml`). Version 0.1.
>
> Rule: a new service that touches personal data is added here **before** it ships; a new service that
> would touch CDR data needs **Fiskil's written approval first** ([acceptable-use.md](acceptable-use.md)).

## 1. Services that receive CDR data (need Fiskil's approval as OSPs)

| Service | Provider (incorporation) | Data location | What it does for Quillo | CDR data it receives | Contract / assurance | Fiskil approval |
|---|---|---|---|---|---|---|
| **Cloudflare Workers + Durable Objects** | Cloudflare, Inc. (US) | Global edge; DO `locationHint: "oc"` (latency hint only) | Runs the app, API, bank connect/sync, per-tenant write coordinator | All service data in transit through the app | Cloudflare Self-Serve Subscription Agreement + DPA; SOC 2 Type II, ISO 27001 (download from dashboard → Compliance) | ⬜ C9 |
| **Cloudflare D1** | Cloudflare, Inc. (US) | Cloudflare data centre chosen at database creation — **confirm and record**; not guaranteed AU | System of record | Transactions, masked accounts, consent metadata, derived data, CDR audit log | As above; encrypted at rest | ⬜ C9 |
| **Cloudflare R2** (backup bucket, planned #635) | Cloudflare, Inc. (US) | Per bucket location hint — set to Oceania where offered | Daily D1 export | Everything in D1 | As above; encrypted at rest | ⬜ C9 |
| **Cloudflare Workers Logs** | Cloudflare, Inc. (US) | Cloudflare | Runtime logs | **None by rule** (ids and error classes only; #634 removes remaining PII) | As above | Disclose |
| **AWS Bedrock** (Claude via `au.` inference profile) | Amazon Web Services (US parent) | **ap-southeast-2 (Sydney) / ap-southeast-4 (Melbourne)** only; IAM denies other regions | Categorisation, explanations and chat for tenants holding CDR data | Transaction descriptions, amounts, dates, derived context in prompts | AWS Customer Agreement + DPA; Bedrock does not use inputs for training and does not share them with model providers; SOC 2, ISO 27001, IRAP | ⬜ C9 |

The PS8 position for these US-incorporated providers (Option A: "reasonable steps" via contract and
technical controls) is in [`docs/cdr-ps8-findings.md`](../cdr-ps8-findings.md) and **needs counsel**
(owner task C7).

## 2. Services that must never receive CDR data

| Service | Provider (country) | Data it touches | CDR? | Why not / control |
|---|---|---|---|---|
| **Fiskil** | Fiskil Pty Ltd (Australia) | Consent, end-user and connection ids; source of CDR data | n/a — **the CDR principal**, not an OSP of Quillo | Onshore |
| **Anthropic API** | Anthropic PBC (US) | Receipts, uploaded statements, situation, chat — for tenants **without** CDR data, after APP-8 cross-border consent | **No** | `getLLM` throws for any tenant with `profiles.cdr_tainted = 1` unless the provider is Bedrock in an AU region ([`src/llm.ts`](../../src/llm.ts)); unit-tested |
| **Clerk** | Clerk, Inc. (US) | Sign-in identity: email, name, auth factors, session; uses Cloudflare Turnstile for bot protection on sign-up | No | Identity only; Quillo never sends app data to Clerk |
| **Cloudflare Turnstile** | Cloudflare, Inc. (US) | Browser signals during sign-up (via Clerk) | No | Bot check only |
| **Cloudflare Email Routing** | Cloudflare, Inc. (US) | Inbound receipt emails to per-tenant mailboxes (parsed by the Worker); forwards `brendan@quillo.au` / `hello@quillo.au` to the owner's Gmail | No | Receipts are not CDR data; staff never email CDR data |
| **Cloudflare KV** | Cloudflare, Inc. (US) | Rule pack, counters, short-lived OAuth/consent state, 30-minute guide cache | No transaction data | Caches/counters only |
| **Cloudflare R2 receipts bucket** | Cloudflare, Inc. (US) | User-uploaded receipts and documents | No | Bank-feed data is never written to R2 |
| **Stripe** | Stripe, Inc. (US) / Stripe Payments Australia Pty Ltd | Top-up payments, customer email, amounts | No | Card data handled by Stripe Checkout; Quillo holds no card data |
| **Intuit QuickBooks Online** | Intuit Inc. (US) | OAuth tokens; ledger accounts/tax codes; reads/writes for users who connect QBO | No | One canonical source per account: a feed account is never also a QBO account; QBO never receives feed lines (`assertCanonicalSource`) |
| **Google Places API (New)** | Google LLC (US) | Search text for health-provider lookup (provider type + suburb/postcode); server-side key | No | Private-health directory feature only |
| **Frankfurter** (api.frankfurter.app) | Open-source FX API (ECB reference rates; EU-hosted) | Currency code and date only | No | No personal data |
| **Google Fonts** | Google LLC (US) | Visitor IP address and user agent when fonts load (app and marketing) | No | Could be self-hosted to remove (low priority) |
| **Unsplash** | Unsplash Inc. (Canada/US) | Visitor IP when the marketing page loads a hero image | No | Marketing site only |
| **Basiq** | Basiq Pty Ltd (Australia) | **Sandbox only** — synthetic data; production refused in code until an arrangement exists | No (Basiq declined to onboard) | Legacy adapter; remove keys when retired |
| **GitHub** | GitHub, Inc. / Microsoft (US) | Source code, CI logs, issues | No | No production data in issues, PRs or fixtures |
| **Google Gmail** (owner's mailbox) | Google LLC (US) | Support and business email | No | Policy: CDR data never emailed |
| **Password manager** | [name the product] | Credentials | No | MFA-protected |

## 3. Wording for Fiskil's CDR policy (rule 7.2(4)(f)–(g), (i))

> **Quillo (Young Milton Pty Ltd)** is a CDR representative of Fiskil. Quillo provides general-information
> tax-record tools that help consumers find what they may be able to claim and keep records for their own
> tax return. Quillo uses these outsourced service providers for CDR data:
> - **Cloudflare, Inc.** — application hosting, database and backup storage. CDR data: bank account
>   details (masked) and transaction data, and data derived from them. Cloudflare is based in the United
>   States and operates data centres globally.
> - **Amazon Web Services** — AI processing of transaction data in Australian regions only (Sydney and
>   Melbourne). CDR data: transaction data and data derived from it. AWS's parent is based in the United
>   States; processing takes place in Australia.

(Owner to confirm the final wording with Fiskil and counsel; country disclosure per rule 7.2(4)(i) and
7.2(7) depends on the D1 location confirmed in §1.)

## 4. Review

Review at each annual review and whenever a service is added or removed. Record changes here.

| Date | Change | By |
|---|---|---|
| 2026-10-08 | Initial register from code scan (#642) | Drafted for the director |
