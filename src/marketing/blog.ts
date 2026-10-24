// Public blog served by the Worker on the apex host (quillo.au/blog, quillo.au/blog/<slug>).
// Same green "Claim Better" system as landing.ts (forest + sage + cream, Anton display, Inter body),
// inlined here because landing.ts keeps its own :root too. No framework and NO <script>: the enforced
// CSP allows inline scripts only by hash (LANDING_INLINE_SCRIPT_HASH), so these pages render without JS.
//
// Posts live in POSTS below as reviewed HTML (no markdown renderer in the Worker). A post is one entry;
// its hero image goes in web/public/images/blog/ and is served straight from ASSETS on either host.
//
// Copy discipline is the landing page's: general information only, not a registered tax agent, does
// not lodge, never holds money, no refund or savings figures, no invented pricing or reviews. The
// footer disclaimer matches the landing footer verbatim. scripts/check-units.ts enforces these.

const APP_URL = "https://app.quillo.au";
const SITE = "https://quillo.au";

export const DISCLAIMER =
  "General information only — not tax advice. Quillo is not a registered tax or BAS agent, does not lodge returns, and never holds or moves your money. Confirm your situation with a registered tax/BAS agent. © 2026 Quillo.";

export interface BlogPost {
  slug: string;
  title: string;
  /** One or two sentences: the index card, <meta description> and og:description. */
  summary: string;
  date: string; // ISO yyyy-mm-dd
  author: string;
  readMinutes: number;
  hero: { src: string; alt: string };
  /** Reviewed HTML for the article body. Plain elements only; the stylesheet owns the look. */
  body: string;
}

export const POSTS: BlogPost[] = [
  {
    slug: "quillo-is-open",
    title: "Quillo is open: your tax year, sorted as you go",
    summary:
      "What we built, how to use it, and why we think it beats the shoebox. Quillo turns your bank statements and receipts into a tidy, evidence-backed picture of your tax year.",
    date: "2026-10-24",
    author: "Brendan Milton, founder",
    readMinutes: 6,
    hero: {
      src: "/images/blog/quillo-launch-hero.webp",
      alt: "A person at a kitchen table photographs a receipt with their phone. A laptop shows a checklist with ticks, a mug of tea steams beside a calendar, and a shoebox of loose receipts sits pushed aside on the floor.",
    },
    body: /* html */ `
<p class="lede">Every year it's the same. June ends, and somewhere there's a shoebox, a folder of screenshots and twelve months of bank statements you've never looked at. You know some of it is claimable. Working out which bits, and proving it, takes a weekend you don't have.</p>

<p>Quillo is our answer to that weekend. As of today it's open to anyone in Australia. Here's what it does, how to use it, and why we think you should.</p>

<h2>Why we built it</h2>

<p>Most people don't miss deductions because they're careless. They miss them because the evidence is scattered: half on a bank statement, half on a receipt, and the rule that connects the two lives in an ATO page nobody reads in October.</p>

<p>We wanted something that does the boring sorting all year, keeps the proof next to every claim, and then gets out of the way when it's time to lodge. Not a tax agent, and not a refund calculator. Just a well-kept record you can trust.</p>

<h2>What we built</h2>

<ul>
  <li><strong>Bring in your money, your way.</strong> Upload a bank statement as CSV or PDF, or snap a receipt on your phone. Quillo reads it and files it against the right account. Everyday tax documents like payslips and income statements go in the same way.</li>
  <li><strong>Every line sorted against current ATO rules.</strong> Each transaction is categorised in the background, including big statements with thousands of lines. Anything Quillo isn't sure about is flagged for you, not guessed.</li>
  <li><strong>You stay in charge.</strong> Similar lines are grouped so you can confirm a month of coffee in one tap, fix a category inline, or turn one correction into a rule for next time. Nothing counts as a claim until you've confirmed it.</li>
  <li><strong>Receipts matched to bank lines.</strong> Quillo pairs receipts with the payments they belong to, so each claim has its evidence attached.</li>
  <li><strong>A work-from-home diary.</strong> Log your hours week by week, the way the ATO expects a record to be kept.</li>
  <li><strong>The less common stuff too.</strong> Rental properties, depreciation on work equipment, more than one employer, a first year in Australia. Tell Quillo about your situation once, and the checklist adapts to it.</li>
  <li><strong>A readiness check and a clear summary.</strong> Before tax time, Quillo lists what's still missing, then lays out your income, deductions and the evidence behind each one.</li>
  <li><strong>A myTax mirror.</strong> Your figures arranged in the same order as the myTax screens, each one traced back to its source, so filling in your return is copying, not hunting.</li>
  <li><strong>Ask anything.</strong> Plain-English answers to questions like "can I claim my phone?", with a pointer to a registered tax agent when your situation needs one.</li>
</ul>

<p>Your documents are read by AI running in Sydney, on Amazon's Australian region. You can export everything or delete your account from Settings at any time. Quillo never holds or moves your money.</p>

<hr />

<h2>How to use it</h2>

<ol>
  <li><strong>Sign up.</strong> It takes an email address. It's free to start, and new accounts come with credit to try it on a real year.</li>
  <li><strong>Get set up.</strong> Answer a few questions: residency, partner, state, occupation, and what your year involved (a job, working from home, a rental, study). This decides what Quillo checks for.</li>
  <li><strong>Bring in your year.</strong> Download a CSV or PDF statement from your bank for each account and upload it. Add receipts as they happen, straight from your phone.</li>
  <li><strong>Review.</strong> Work through the grouped lines Quillo flags. Most people spend their time here confirming, not typing.</li>
  <li><strong>Check, then see your position.</strong> Clear the readiness list, then open your summary to see income and deductions with the evidence attached.</li>
  <li><strong>Lodge.</strong> Open the myTax mirror next to myTax and lodge it yourself through myGov, or hand the accountant pack to your registered tax agent. Mark the year as lodged when you're done.</li>
</ol>

<blockquote><p><strong>Tip.</strong> You don't have to wait until June. Ten minutes a month keeps the review queue short and the receipts matched while you still remember what they were for.</p></blockquote>

<h2>Why you should</h2>

<ul>
  <li><strong>The proof is already there.</strong> Each deduction sits next to the bank line and receipt that support it. If the ATO ever asks, you're not starting from scratch.</li>
  <li><strong>It works the way you already do.</strong> Statements from your bank and photos from your phone. No new habits beyond the ones you have.</li>
  <li><strong>It's honest about its limits.</strong> Quillo gives general information, tells you when something needs a professional, and never promises a refund. The decisions stay yours.</li>
  <li><strong>Your data stays yours.</strong> AI processing happens in Australia, and you can export or delete everything whenever you like.</li>
</ul>

<p>If your affairs are complex (a business, a trust, a big capital gain), keep your accountant. Quillo makes that meeting shorter, because you'll walk in with a clean record instead of a shoebox.</p>

<h2>What's next</h2>

<p>We're working on connecting your bank directly through the Consumer Data Right, so statements arrive without downloading anything. Until then, uploads do the job. If something is confusing or broken, tell us at <a href="mailto:hello@quillo.au">hello@quillo.au</a>. We read every message.</p>

<p class="cta-row"><a class="btn" href="${APP_URL}">Start your tax year</a></p>
`,
  },
];

const fmtDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CSS = /* css */ `
  :root {
    --forest: #0c3f26; --green: #15643a; --green-2: #1c7a48;
    --sage: #c9d2a8; --olive: #e8ecca; --cream: #f4f3dd; --moss: #97a86f;
    --anton: "Anton", Impact, sans-serif; --inter: "Inter", system-ui, -apple-system, sans-serif;
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body { margin: 0; background: var(--cream); color: var(--forest); font-family: var(--inter); font-size: 17px; line-height: 1.65; -webkit-font-smoothing: antialiased; overflow-x: hidden; }
  a { color: inherit; }
  img { display: block; max-width: 100%; height: auto; }
  ::selection { background: var(--forest); color: var(--cream); }

  .nav { position: sticky; top: 0; z-index: 50; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 24px; background: color-mix(in oklab, var(--cream) 92%, transparent); backdrop-filter: blur(10px); border-bottom: 1px solid color-mix(in oklab, var(--forest) 12%, transparent); }
  .nav-logo { font-family: var(--anton); font-size: 24px; letter-spacing: 0.04em; text-transform: uppercase; text-decoration: none; }
  .nav-links { display: flex; align-items: center; gap: 4px; }
  .nav-links a { font-weight: 600; font-size: 14px; padding: 8px 14px; border-radius: 999px; text-decoration: none; }
  .nav-links a:hover, .nav-links a.on { background: var(--forest); color: var(--cream); }
  .nav-links a.cta { background: var(--green); color: var(--cream); margin-left: 6px; }
  .nav-links a.cta:hover { background: var(--green-2); }

  .label { font-weight: 700; font-size: 11px; letter-spacing: 0.24em; text-transform: uppercase; color: var(--green); }
  .wrap { max-width: 760px; margin: 0 auto; padding: 56px 24px 72px; }
  .wide { max-width: 1040px; }
  h1 { font-family: var(--anton); font-weight: 400; text-transform: uppercase; letter-spacing: 0.01em; line-height: 1.02; font-size: clamp(40px, 7vw, 72px); margin: 10px 0 18px; overflow-wrap: anywhere; }
  .meta { font-size: 14px; color: color-mix(in oklab, var(--forest) 70%, transparent); margin: 0 0 32px; }
  .hero { border-radius: 28px; overflow: hidden; background: var(--olive); margin: 0 0 40px; }

  .post h2 { font-family: var(--anton); font-weight: 400; text-transform: uppercase; letter-spacing: 0.02em; font-size: clamp(26px, 4vw, 34px); line-height: 1.1; margin: 48px 0 14px; }
  .post p, .post li { color: color-mix(in oklab, var(--forest) 88%, transparent); }
  .post .lede { font-size: 20px; line-height: 1.55; color: var(--forest); }
  .post ul, .post ol { padding-left: 22px; }
  .post li { margin: 10px 0; }
  .post li::marker { color: var(--green); font-weight: 700; }
  .post hr { border: 0; text-align: center; margin: 48px 0; }
  .post hr::before { content: "· · ·"; letter-spacing: 0.6em; color: var(--moss); font-weight: 700; }
  .post blockquote { margin: 32px 0; padding: 18px 22px; background: var(--olive); border-left: 5px solid var(--green); border-radius: 0 18px 18px 0; }
  .post blockquote p { margin: 0; }
  .post a { color: var(--green); text-underline-offset: 3px; }
  .cta-row { margin: 40px 0 0; }
  .btn { display: inline-block; background: var(--forest); color: var(--cream) !important; text-decoration: none; font-weight: 700; padding: 14px 26px; border-radius: 999px; }
  .btn:hover { background: var(--green); }
  .back { display: inline-block; margin-top: 48px; font-weight: 600; text-decoration: none; }

  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 28px; margin-top: 36px; }
  .card { display: block; text-decoration: none; background: #fbfaee; border-radius: 28px; overflow: hidden; border: 1px solid color-mix(in oklab, var(--forest) 10%, transparent); transition: transform .2s ease; }
  .card:hover { transform: translateY(-3px); }
  .card-body { padding: 22px 24px 26px; }
  .card h3 { font-family: var(--anton); font-weight: 400; text-transform: uppercase; font-size: 26px; line-height: 1.1; margin: 8px 0 10px; }
  .card p { margin: 0; font-size: 15.5px; color: color-mix(in oklab, var(--forest) 80%, transparent); }
  .intro { font-size: 19px; max-width: 620px; }

  footer { background: var(--forest); color: var(--cream); padding: 36px 24px; }
  .foot { max-width: 1040px; margin: 0 auto; display: flex; flex-wrap: wrap; gap: 14px 28px; justify-content: space-between; font-size: 13px; line-height: 1.5; }
  .foot .ff { max-width: 680px; opacity: .85; }
  .foot a { margin-right: 16px; }

  @media (max-width: 640px) {
    .nav { padding: 12px 16px; }
    .nav-links a:not(.cta):not(.on) { display: none; }
    .wrap { padding: 36px 16px 56px; }
    .hero, .card { border-radius: 20px; }
  }
`;

function page(opts: { title: string; description: string; path: string; image?: string; type: "website" | "article"; body: string; active: "blog" }): string {
  const url = SITE + opts.path;
  const img = opts.image ? SITE + opts.image : undefined;
  return /* html */ `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.description)}" />
<link rel="canonical" href="${url}" />
<meta property="og:type" content="${opts.type}" />
<meta property="og:site_name" content="Quillo" />
<meta property="og:title" content="${esc(opts.title)}" />
<meta property="og:description" content="${esc(opts.description)}" />
<meta property="og:url" content="${url}" />
${img ? `<meta property="og:image" content="${img}" />\n<meta name="twitter:card" content="summary_large_image" />` : `<meta name="twitter:card" content="summary" />`}
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
<style>${CSS}</style>
</head>
<body>
<header class="nav">
  <a class="nav-logo" href="/">Quillo</a>
  <nav class="nav-links" aria-label="Main">
    <a href="/">Home</a>
    <a href="/#claim">How it works</a>
    <a href="/blog"${opts.active === "blog" ? ' class="on" aria-current="page"' : ""}>Blog</a>
    <a class="cta" href="${APP_URL}">Sign up free</a>
  </nav>
</header>
<main>
${opts.body}
</main>
<footer>
  <div class="foot">
    <span class="ff">${DISCLAIMER}</span>
    <span><a href="/blog">Blog</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></span>
  </div>
</footer>
</body>
</html>`;
}

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "public, max-age=300",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

/** Newest first. */
const sorted = () => [...POSTS].sort((a, b) => b.date.localeCompare(a.date));

export function blogIndexHtml(): string {
  const cards = sorted()
    .map(
      (p) => /* html */ `
    <a class="card" href="/blog/${p.slug}">
      <img src="${p.hero.src}" alt="" width="1376" height="768" loading="lazy" />
      <div class="card-body">
        <div class="label">${fmtDate(p.date)} · ${p.readMinutes} min read</div>
        <h3>${esc(p.title)}</h3>
        <p>${esc(p.summary)}</p>
      </div>
    </a>`,
    )
    .join("");
  return page({
    title: "Quillo Blog — tax, sorted as you go",
    description: "Product news, how-tos and plain-English explainers from the Quillo team. General information only.",
    path: "/blog",
    type: "website",
    active: "blog",
    body: /* html */ `<div class="wrap wide">
  <div class="label">The Quillo blog</div>
  <h1>Tax, sorted as you go</h1>
  <p class="intro">Product news, how-tos and plain-English explainers. General information only, never tax advice.</p>
  <div class="grid">${cards}</div>
</div>`,
  });
}

export function blogPostHtml(slug: string): string | null {
  const p = POSTS.find((x) => x.slug === slug);
  if (!p) return null;
  return page({
    title: `${p.title} — Quillo`,
    description: p.summary,
    path: `/blog/${p.slug}`,
    image: p.hero.src,
    type: "article",
    active: "blog",
    body: /* html */ `<article class="wrap post">
  <div class="label">${fmtDate(p.date)} · ${p.readMinutes} min read</div>
  <h1>${esc(p.title)}</h1>
  <p class="meta">By ${esc(p.author)}</p>
  <figure class="hero"><img src="${p.hero.src}" alt="${esc(p.hero.alt)}" width="1376" height="768" /></figure>
  ${p.body}
  <a class="back" href="/blog">← All posts</a>
</article>`,
  });
}

/** quillo.au/blog and quillo.au/blog/<slug>. Unknown slug ⇒ 404 page with a link back. */
export function blogResponse(pathname: string): Response {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/blog") return new Response(blogIndexHtml(), { headers: HEADERS });
  const slug = path.slice("/blog/".length);
  const html = /^[a-z0-9-]+$/.test(slug) ? blogPostHtml(slug) : null;
  if (html) return new Response(html, { headers: HEADERS });
  return new Response(
    page({ title: "Post not found — Quillo", description: "That post doesn't exist.", path: "/blog", type: "website", active: "blog", body: `<div class="wrap"><h1>Post not found</h1><p>That post doesn't exist or has moved.</p><a class="btn" href="/blog">See all posts</a></div>` }),
    { status: 404, headers: { ...HEADERS, "cache-control": "no-store" } },
  );
}
