// Public legal pages (Terms / EULA + Privacy Policy) served by the Worker on the apex host
// (quillo.au/terms, quillo.au/privacy). Required by Intuit to issue production QuickBooks
// keys (public EULA + privacy URLs), and good practice generally. Same token-driven style
// as the landing page. Copy follows Quillo's "stay in your lane" discipline: general info
// only, NOT a registered tax/BAS agent, does NOT lodge, never custodial. This is reasonable
// boilerplate, not a substitute for review by an Australian lawyer before public launch.

import { cssRootVars } from "../../design/tokens.mjs";

const APP_URL = "https://app.quillo.au";
const CONTACT = "hello@quillo.au";
const UPDATED = "2 June 2026";

type Kind = "terms" | "privacy";

function shell(title: string, body: string): string {
  return /* html */ `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Quillo — ${title}</title>
<meta name="description" content="Quillo ${title}." />
<meta name="robots" content="index, follow" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700;800&family=Spectral:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500&display=swap" rel="stylesheet" />
<style>
  ${cssRootVars()}
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body { margin: 0; background: var(--paper); color: var(--ink); font-family: var(--sans); font-size: 17px; line-height: 1.6; -webkit-font-smoothing: antialiased; }
  a { color: inherit; }
  .nav { position: sticky; top: 0; z-index: 50; background: color-mix(in oklab, var(--paper) 90%, transparent); backdrop-filter: blur(10px); border-bottom: 1px solid var(--line); }
  .nav-in { max-width: 820px; margin: 0 auto; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; }
  .brand { font-family: var(--serif); font-size: 23px; font-weight: 600; letter-spacing: -0.02em; text-decoration: none; }
  .nav a.cta { font-family: var(--sans); font-weight: 600; font-size: 14px; padding: 8px 16px; border-radius: 999px; background: var(--ink); color: var(--paper); text-decoration: none; }
  main { max-width: 820px; margin: 0 auto; padding: 56px 24px 80px; }
  h1 { font-family: var(--serif); font-weight: 500; font-size: clamp(34px, 5vw, 52px); letter-spacing: -0.02em; line-height: 1.05; margin: 0 0 8px; }
  .updated { color: var(--ink-3); font-size: 14px; margin: 0 0 36px; }
  h2 { font-family: var(--serif); font-weight: 600; font-size: 24px; letter-spacing: -0.01em; margin: 40px 0 12px; }
  p, li { color: var(--ink-2); }
  ul { padding-left: 22px; }
  li { margin: 6px 0; }
  .callout { background: var(--paper-2, #f1ede2); border: 1px solid var(--line); border-radius: 14px; padding: 18px 20px; margin: 28px 0; font-size: 15.5px; }
  .fine { margin-top: 56px; padding-top: 24px; border-top: 1px solid var(--line); font-size: 13px; color: var(--ink-3); line-height: 1.5; }
  .foot-links { margin-top: 14px; font-size: 14px; }
  .foot-links a { color: var(--ink-2); text-decoration: underline; text-underline-offset: 2px; margin-right: 18px; }
</style>
</head>
<body>
<header class="nav"><div class="nav-in">
  <a class="brand" href="https://quillo.au">Quillo<span>*</span></a>
  <a class="cta" href="${APP_URL}">Open app</a>
</div></header>
<main>
  <h1>${title}</h1>
  <p class="updated">Last updated: ${UPDATED}</p>
  ${body}
  <div class="fine">
    General information only — not tax advice. Quillo is not a registered tax or BAS agent, does not lodge returns,
    and never holds or moves your money. Confirm your situation with a registered tax/BAS agent.
    <div class="foot-links">
      <a href="https://quillo.au/terms">Terms</a>
      <a href="https://quillo.au/privacy">Privacy</a>
      <a href="mailto:${CONTACT}">Contact</a>
    </div>
  </div>
</main>
</body>
</html>`;
}

const TERMS_BODY = /* html */ `
  <div class="callout">
    <strong>The short version:</strong> Quillo helps you capture and categorise your financial records and suggests how
    items may map to ATO categories. It provides <strong>general information, not tax advice</strong>, is
    <strong>not a registered tax or BAS agent</strong>, does <strong>not lodge</strong> returns on your behalf, and
    never holds or moves your money. Always confirm with a registered tax/BAS agent before relying on anything.
  </div>

  <h2>1. Acceptance</h2>
  <p>By accessing or using Quillo (the “Service”) you agree to these Terms. If you do not agree, do not use the Service.</p>

  <h2>2. What Quillo is — and isn't</h2>
  <p>Quillo captures receipts, transactions and your stated situation, and produces <em>suggested</em> categorisations
  (a tax “bucket”, an ATO label and a confidence score) to help you and your registered tax/BAS agent prepare your
  affairs. Quillo is a software tool only. It is not a registered tax agent or BAS agent under the
  <em>Tax Agent Services Act 2009</em> (Cth), it does not provide tax agent services or financial advice, and it does
  not lodge returns or activity statements. You remain responsible for your tax position.</p>

  <h2>3. Your responsibilities</h2>
  <ul>
    <li>Provide accurate information about your entities, employment and properties.</li>
    <li>Review every suggestion — particularly low-confidence items, which Quillo flags for you.</li>
    <li>Confirm your final position with a registered tax or BAS agent before lodging.</li>
    <li>Keep your account credentials secure and only connect accounts you are authorised to connect.</li>
  </ul>

  <h2>4. Connected services (QuickBooks / Intuit)</h2>
  <p>If you connect Intuit QuickBooks Online, you authorise Quillo to access your QuickBooks data on a
  <strong>read / reconcile</strong> basis to match your receipts against your bank-feed records. Quillo does not post
  duplicate purchases or otherwise write transactions to your books. You can disconnect at any time from the QuickBooks
  page in the app, which revokes Quillo's access.</p>

  <h2>5. Automated processing</h2>
  <p>Categorisation suggestions are produced with the assistance of AI models. Output may be incomplete or incorrect and
  must be reviewed by you. Suggestions are not advice and create no professional relationship.</p>

  <h2>6. No warranty</h2>
  <p>The Service is provided “as is” without warranties of any kind, to the extent permitted by law. Nothing in these
  Terms excludes rights you may have under the Australian Consumer Law that cannot lawfully be excluded.</p>

  <h2>7. Limitation of liability</h2>
  <p>To the maximum extent permitted by law, Quillo is not liable for any indirect or consequential loss, or for any tax,
  penalty or interest arising from your reliance on suggestions you did not have reviewed by a registered agent.</p>

  <h2>8. Termination</h2>
  <p>You may stop using the Service at any time. We may suspend or terminate access if these Terms are breached.</p>

  <h2>9. Governing law</h2>
  <p>These Terms are governed by the laws of New South Wales, Australia.</p>

  <h2>10. Contact</h2>
  <p>Questions about these Terms: <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>
`;

const PRIVACY_BODY = /* html */ `
  <div class="callout">
    <strong>The short version:</strong> Quillo processes your financial records to categorise them for tax. We
    <strong>do not sell your data</strong> and it is <strong>never used to train anyone else's model</strong>. Receipt
    and transaction text is sent to our AI provider (Anthropic, USA) for OCR and categorisation — a cross-border
    disclosure you consent to in the app, and which you can switch to Australian-resident processing instead.
  </div>

  <h2>1. Who we are</h2>
  <p>Quillo (“we”, “us”) provides the Quillo software. This policy explains how we handle your personal information in
  line with the Australian Privacy Principles (APPs) under the <em>Privacy Act 1988</em> (Cth).</p>

  <h2>2. What we collect</h2>
  <ul>
    <li><strong>Account</strong>: your sign-in identity and email.</li>
    <li><strong>Situation</strong>: entities you register (e.g. company, ABN, GST status, employer), and properties.</li>
    <li><strong>Records</strong>: receipts, statements and transactions you upload, forward or sync.</li>
    <li><strong>Connected data</strong>: where you authorise it, read-only data from Intuit QuickBooks Online.</li>
  </ul>

  <h2>3. How we use it</h2>
  <p>To capture, categorise and reconcile your records; to produce suggested ATO categories and reports; and to operate,
  secure and improve the Service for you. We do not use your data to advertise to you.</p>

  <h2>4. Cross-border disclosure (APP 8)</h2>
  <p>To read and categorise your records we disclose receipt and transaction content to <strong>Anthropic, PBC (United
  States)</strong> for OCR and categorisation. We ask for your explicit consent to this cross-border disclosure in the
  app before processing. You may instead choose Australian-resident processing (Amazon Bedrock, Sydney). Our hosting and
  storage run on Cloudflare infrastructure.</p>

  <h2>5. Third parties</h2>
  <p>We share data with service providers only as needed to run the Service — our AI provider (above), our cloud/hosting
  provider (Cloudflare), and, where you connect it, Intuit (QuickBooks) under your authorisation. We do not sell your
  personal information and we do not let third parties use it to train their models.</p>

  <h2>6. Security</h2>
  <p>Data is encrypted in transit and at rest, access is scoped to your account, and connected-service tokens are stored
  encrypted and used only for the access you authorised.</p>

  <h2>7. Retention &amp; your rights</h2>
  <p>We keep your tax records while your account is active and, by default, aligned to the ATO record-keeping rule —
  <strong>five years from the date the relevant return is lodged</strong> (longer for capital-gains and depreciating
  assets). Under the APPs you may request access to, correction of, or deletion of your personal information — from
  <strong>Settings → Privacy</strong>, or email <a href="mailto:${CONTACT}">${CONTACT}</a>. You can withdraw
  cross-border AI-processing consent at any time in Settings, and disconnecting QuickBooks revokes our access to it.</p>

  <h2>8. Complaints</h2>
  <p>Contact us first at <a href="mailto:${CONTACT}">${CONTACT}</a>. If unresolved, you may complain to the Office of the
  Australian Information Commissioner (OAIC) at <a href="https://www.oaic.gov.au">oaic.gov.au</a>.</p>
`;

export function legalResponse(kind: Kind): Response {
  const html = kind === "terms" ? shell("Terms of Service", TERMS_BODY) : shell("Privacy Policy", PRIVACY_BODY);
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  });
}
