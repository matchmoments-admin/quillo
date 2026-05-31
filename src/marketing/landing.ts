// Self-contained public marketing page served by the Worker for the apex host
// (quillo.au). No framework, no build step — one HTML string with inline CSS whose
// :root tokens mirror web/tailwind.config.js so the landing page and the app share one
// visual language. The inline <script> wires the waitlist forms to POST /waitlist.
//
// Copy discipline (Quillo "stay in your lane" rules): non-custodial, NOT a registered
// tax agent, does NOT lodge. No fabricated user/savings numbers. The footer disclaimer
// is mandatory and is kept verbatim-matched to the app footer.

const APP_URL = "https://app.quillo.au";

const HTML = /* html */ `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Quillo — the tax brain that sees your whole picture</title>
<meta name="description" content="Quillo sits above your salary, your side company and your properties, reasoning across all of them against current ATO rules. General information only — not a tax agent, never holds your money." />
<link rel="preconnect" href="https://rsms.me" />
<link rel="stylesheet" href="https://rsms.me/inter/inter.css" />
<style>
  :root{
    --ink:#0f172a; --muted:#64748b; --line:#e7ebf0; --surface:#f8fafc;
    --paper:#fbfaf8; --accent:#2563eb; --accent-soft:#eff4ff;
    --safe:#16a34a; --warn:#d97706; --danger:#dc2626;
    --maxw:64rem;
  }
  *{box-sizing:border-box}
  html{-webkit-text-size-adjust:100%}
  body{
    margin:0; background:var(--paper); color:var(--ink);
    font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;
    font-feature-settings:"cv05","cv08","ss01"; line-height:1.55;
    -webkit-font-smoothing:antialiased;
  }
  a{color:inherit}
  h1,h2,h3{letter-spacing:-0.022em; line-height:1.1; margin:0}
  p{margin:0}
  .wrap{max-width:var(--maxw); margin:0 auto; padding:0 1.5rem}
  .muted{color:var(--muted)}

  /* buttons — shared language with the app's bg-ink CTA */
  .btn{display:inline-flex; align-items:center; justify-content:center; gap:.5rem;
    height:2.75rem; padding:0 1.15rem; border-radius:.75rem; font-weight:600;
    font-size:.95rem; text-decoration:none; border:1px solid transparent; cursor:pointer;
    transition:transform .04s ease, background .15s ease}
  .btn:active{transform:translateY(1px)}
  .btn-primary{background:var(--ink); color:#fff}
  .btn-primary:hover{background:#1e293b}
  .btn-ghost{background:transparent; color:var(--ink); border-color:var(--line)}
  .btn-ghost:hover{background:#fff}

  /* header */
  header{position:sticky; top:0; z-index:20; background:rgba(251,250,248,.82);
    backdrop-filter:saturate(180%) blur(8px); border-bottom:1px solid var(--line)}
  .nav{display:flex; align-items:center; justify-content:space-between; height:3.75rem}
  .brand{display:flex; align-items:center; gap:.55rem; text-decoration:none; font-weight:600}
  .mark{display:grid; place-items:center; width:1.75rem; height:1.75rem; border-radius:.5rem;
    background:var(--ink); color:#fff; font-weight:700; font-size:.85rem}

  /* hero */
  .hero{padding:5rem 0 3.5rem; text-align:center}
  .eyebrow{display:inline-block; font-size:.8rem; font-weight:600; letter-spacing:.02em;
    color:var(--accent); background:var(--accent-soft); padding:.35rem .75rem; border-radius:999px}
  .hero h1{font-size:clamp(2.4rem,6vw,4rem); margin:1.5rem auto 0; max-width:18ch}
  .hero .sub{font-size:clamp(1.05rem,2.2vw,1.3rem); color:var(--muted);
    max-width:42ch; margin:1.25rem auto 0}
  .cta-row{display:flex; gap:.75rem; justify-content:center; flex-wrap:wrap; margin-top:2rem}
  .micro{margin-top:1rem; font-size:.82rem; color:var(--muted)}

  /* waitlist form */
  .wl{display:flex; gap:.5rem; flex-wrap:wrap; justify-content:center; margin-top:1.5rem}
  .wl input{height:2.75rem; padding:0 .9rem; border:1px solid var(--line); border-radius:.75rem;
    font-size:.95rem; min-width:16rem; background:#fff; color:var(--ink)}
  .wl input:focus{outline:2px solid var(--accent); outline-offset:1px; border-color:transparent}
  .wl .note{flex-basis:100%; text-align:center; font-size:.82rem; margin-top:.35rem; min-height:1.1rem}
  .wl .note.ok{color:var(--safe)} .wl .note.err{color:var(--danger)}

  /* sections */
  section{padding:3.5rem 0}
  .sec-title{font-size:clamp(1.6rem,3.5vw,2.1rem); text-align:center; max-width:22ch; margin:0 auto}
  .sec-lead{text-align:center; color:var(--muted); max-width:46ch; margin:1rem auto 0}

  .steps{display:grid; gap:1.25rem; grid-template-columns:repeat(3,1fr); margin-top:2.5rem}
  .step{padding:1.5rem; background:#fff; border-radius:1rem; box-shadow:0 1px 2px rgba(15,23,42,.04),0 4px 16px rgba(15,23,42,.06)}
  .step .n{display:grid; place-items:center; width:2rem; height:2rem; border-radius:.6rem;
    background:var(--accent-soft); color:var(--accent); font-weight:700; font-size:.9rem}
  .step h3{font-size:1.15rem; margin-top:1rem}
  .step p{color:var(--muted); margin-top:.5rem; font-size:.95rem}

  .cards{display:grid; gap:1.25rem; grid-template-columns:repeat(2,1fr); margin-top:2.5rem}
  .card{padding:1.6rem; background:#fff; border-radius:1rem; border:1px solid var(--line)}
  .card h3{font-size:1.15rem}
  .card p{color:var(--muted); margin-top:.6rem; font-size:.97rem}

  .stats{background:var(--ink); color:#fff; border-radius:1.25rem; padding:2.5rem 1.5rem;
    display:grid; gap:1.5rem; grid-template-columns:repeat(3,1fr); text-align:center}
  .stat .k{font-size:1.5rem; font-weight:700; letter-spacing:-.02em}
  .stat .v{color:#cbd5e1; font-size:.9rem; margin-top:.4rem}
  .founder{max-width:46ch; margin:2rem auto 0; text-align:center; color:var(--muted); font-style:italic}

  .beta{background:#fff; border:1px solid var(--line); border-radius:1.25rem; padding:2.5rem 1.5rem; text-align:center}

  details{border-bottom:1px solid var(--line); padding:1.1rem 0}
  details summary{cursor:pointer; font-weight:600; list-style:none; display:flex; justify-content:space-between; gap:1rem}
  details summary::-webkit-details-marker{display:none}
  details summary::after{content:"+"; color:var(--muted)}
  details[open] summary::after{content:"–"}
  details p{color:var(--muted); margin-top:.75rem; font-size:.97rem}

  footer{border-top:1px solid var(--line); padding:2.5rem 0; margin-top:1rem}
  .foot-top{display:flex; justify-content:space-between; gap:1.5rem; flex-wrap:wrap; align-items:center}
  .foot-links{display:flex; gap:1.25rem; flex-wrap:wrap; font-size:.92rem}
  .foot-links a{color:var(--muted); text-decoration:none}
  .foot-links a:hover{color:var(--ink)}
  .disclaimer{margin-top:1.5rem; font-size:.8rem; color:var(--muted); max-width:60ch; line-height:1.6}

  @media (max-width:760px){
    .steps,.cards,.stats{grid-template-columns:1fr}
    .hero{padding:3.5rem 0 2.5rem}
  }
</style>
</head>
<body>
<header>
  <div class="wrap nav">
    <a class="brand" href="/"><span class="mark">Q</span><span>Quillo</span></a>
    <a class="btn btn-ghost" href="${APP_URL}">Log in</a>
  </div>
</header>

<main>
  <!-- HERO -->
  <section class="hero">
    <div class="wrap">
      <span class="eyebrow">For working Australians with more than one income</span>
      <h1>The tax brain that sees your whole picture.</h1>
      <p class="sub">Quillo sits above your salary, your side company and your properties — reasoning across all of them against current ATO rules, so nothing slips through the cracks.</p>
      <div class="cta-row">
        <a class="btn btn-primary" href="${APP_URL}">Log in</a>
        <a class="btn btn-ghost" href="#waitlist">Join the waitlist</a>
      </div>
      <form class="wl" data-source="landing-hero">
        <input type="email" name="email" placeholder="you@email.com" autocomplete="email" required aria-label="Email address" />
        <button class="btn btn-primary" type="submit">Join the waitlist</button>
        <div class="note" role="status"></div>
      </form>
      <p class="micro">General information only. Quillo never holds or moves your money.</p>
    </div>
  </section>

  <!-- HOW IT WORKS -->
  <section>
    <div class="wrap">
      <h2 class="sec-title">One brain, three jobs.</h2>
      <div class="steps">
        <div class="step"><span class="n">1</span><h3>Capture</h3><p>Forward a receipt, email or bank line. Quillo reads it and files it to the right part of your tax life.</p></div>
        <div class="step"><span class="n">2</span><h3>Reason</h3><p>It checks each item against current ATO rules across PAYG, your company and each property — and flags what needs a human.</p></div>
        <div class="step"><span class="n">3</span><h3>Learn</h3><p>Every correction you make sharpens Quillo. It gets better on your real money, not a generic template.</p></div>
      </div>
    </div>
  </section>

  <!-- FEATURES -->
  <section>
    <div class="wrap">
      <h2 class="sec-title">Built for a complicated income.</h2>
      <div class="cards">
        <div class="card"><h3>Cross-bucket thinking</h3><p>Most tools look at one entity at a time. Quillo reasons across employee, company and property together — where the real mistakes hide.</p></div>
        <div class="card"><h3>Proactive, not a shoebox</h3><p>Quillo surfaces issues before deadlines instead of waiting for you to ask: missing logbooks, un-apportioned property costs, GST edge cases.</p></div>
        <div class="card"><h3>Teaches the "why"</h3><p>Every call comes with a plain-English reason, tied to the ATO rule and your own numbers — so you actually learn your tax.</p></div>
        <div class="card"><h3>Self-improving</h3><p>Correct it once and it remembers. Quillo tunes to your situation over time instead of staying static.</p></div>
      </div>
    </div>
  </section>

  <!-- STATS / CAPABILITY -->
  <section>
    <div class="wrap">
      <div class="stats">
        <div class="stat"><div class="k">3 income types, 1 view</div><div class="v">PAYG, company and property in one engine</div></div>
        <div class="stat"><div class="k">Current ATO rules</div><div class="v">Every item reasoned against the rules that apply to it</div></div>
        <div class="stat"><div class="k">Shows its working</div><div class="v">Every decision keeps an audit trail you can read</div></div>
      </div>
      <p class="founder">"I built Quillo because my own tax spanned a payslip, a Pty Ltd and two rentals — and nothing on the market could see all three at once."</p>
    </div>
  </section>

  <!-- BETA / WAITLIST -->
  <section id="waitlist">
    <div class="wrap">
      <div class="beta">
        <h2 class="sec-title">Simple, while we're in private beta.</h2>
        <p class="sec-lead">Quillo is invite-only right now. Join the waitlist and we'll reach out as we open seats.</p>
        <form class="wl" data-source="landing-beta">
          <input type="email" name="email" placeholder="you@email.com" autocomplete="email" required aria-label="Email address" />
          <button class="btn btn-primary" type="submit">Request access</button>
          <div class="note" role="status"></div>
        </form>
      </div>
    </div>
  </section>

  <!-- FAQ -->
  <section>
    <div class="wrap" style="max-width:48rem">
      <h2 class="sec-title">Questions, answered.</h2>
      <div style="margin-top:2rem">
        <details><summary>Does Quillo lodge my return?</summary><p>No. Quillo organises and explains your position so you — or your registered tax agent — can lodge with confidence. It doesn't lodge for you.</p></details>
        <details><summary>Is Quillo a tax agent?</summary><p>No. Quillo is software that gives general information, not personal tax advice. For advice specific to you, see a registered tax or BAS agent.</p></details>
        <details><summary>Does Quillo touch my money?</summary><p>Never. Quillo reads documents and reasons about tax. It doesn't hold, route or move funds — it's a layer over your existing accounts.</p></details>
        <details><summary>Who is it for?</summary><p>Working Australians with a more complex picture — a salary plus side income or an early Pty Ltd, plus one or two investment properties.</p></details>
        <details><summary>What about my data?</summary><p>Your records are yours. Quillo keeps an audit trail of every decision so you can see exactly why it did what it did.</p></details>
      </div>
    </div>
  </section>
</main>

<footer>
  <div class="wrap">
    <div class="foot-top">
      <a class="brand" href="/"><span class="mark">Q</span><span>Quillo</span></a>
      <nav class="foot-links">
        <a href="${APP_URL}">Log in</a>
        <a href="#waitlist">Join the waitlist</a>
        <a href="#">Privacy</a>
        <a href="#">Terms</a>
      </nav>
    </div>
    <p class="disclaimer">General information only — not tax advice. Quillo is not a registered tax or BAS agent, does not lodge returns, and never holds or moves your money. Confirm your situation with a registered tax/BAS agent.</p>
  </div>
</footer>

<script>
(function(){
  function handle(form){
    form.addEventListener("submit", function(e){
      e.preventDefault();
      var note = form.querySelector(".note");
      var input = form.querySelector("input[name=email]");
      var btn = form.querySelector("button");
      var email = (input.value || "").trim();
      note.className = "note"; note.textContent = "";
      btn.disabled = true;
      fetch("/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email, source: form.getAttribute("data-source") })
      }).then(function(r){
        if (r.ok) {
          form.innerHTML = '<div class="note ok" role="status">You\\u2019re on the list. We\\u2019ll be in touch.</div>';
          return;
        }
        btn.disabled = false;
        note.className = "note err";
        note.textContent = r.status === 429 ? "Slow down a sec, then try again." : "Check that email and try again.";
      }).catch(function(){
        btn.disabled = false;
        note.className = "note err";
        note.textContent = "Something went wrong. Try again.";
      });
    });
  }
  document.querySelectorAll("form.wl").forEach(handle);
})();
</script>
</body>
</html>`;

export function marketingResponse(): Response {
  return new Response(HTML, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  });
}
