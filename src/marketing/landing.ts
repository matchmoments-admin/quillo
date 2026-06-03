// Self-contained public marketing page served by the Worker for the apex host
// (quillo.au). No framework, no build step — one HTML string with inline CSS. The
// visual system is the "Organic-Brutalist" GREEN design (deep forest + sage + cream,
// massive Anton display type, Inter body, film-grain, fluid reveals) ported from the
// Claude Design "Claim Better" handoff. It is intentionally decoupled from the app's
// design/tokens.mjs: this page inlines its own green :root.
//
// Copy discipline (Quillo "stay in your lane" rules): non-custodial, NOT a registered
// tax agent, does NOT lodge. No fabricated refund/savings numbers, no invented pricing,
// no fake reviews, no TPB number. The footer disclaimer is mandatory and kept
// verbatim-matched to the app footer. The design mock's copy claimed the opposite
// (registered agent, TPB number, an "estimated refund $3,210", "generate my return") —
// all of that is deliberately stripped here.
//
// CTAs ("Sign in" / "Sign up") point at the gated app. The "Join the tax movement"
// email form posts to the existing /waitlist endpoint. Imagery is hotlinked Unsplash
// with a fallback colour; swap for brand photos later.

const APP_URL = "https://app.quillo.au";

const HTML = /* html */ `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Quillo — Claim Better</title>
<meta name="description" content="Australian tax, sorted for you. Capture every receipt and segment every statement line, categorised against current ATO rules — all year. General information only; not a tax agent, never holds your money." />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
<style>
  /* ============================================================
     Quillo — "Claim Better" landing
     Organic-Brutalist / Nature-Inspired system: deep forest greens
     + earthy sage + cream, massive Anton editorial type, ultra-rounded
     blocks, film-grain overlay, fluid reveal animations.
     Text is never pure black.
     ============================================================ */
  :root {
    --forest:  #0c3f26;   /* deep forest — wordmark, footer, dark text */
    --green:   #15643a;   /* mid green — buttons / accents */
    --green-2: #1c7a48;   /* hover */
    --sage:    #c9d2a8;   /* hero canvas */
    --olive:   #e8ecca;   /* claim-better canvas */
    --cream:   #f4f3dd;   /* lightest paper */
    --moss:    #97a86f;

    --ease: cubic-bezier(0.16, 1, 0.3, 1);
    --anton: "Anton", Impact, sans-serif;
    --inter: "Inter", system-ui, -apple-system, sans-serif;
  }

  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0;
    background: var(--forest);
    color: var(--forest);
    font-family: var(--inter);
    font-size: 16px; line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    overflow-x: hidden;
  }
  img { display: block; max-width: 100%; }
  a { color: inherit; text-decoration: none; }
  ::selection { background: var(--forest); color: var(--cream); }

  .label {
    font-family: var(--inter); font-weight: 700;
    font-size: 11px; letter-spacing: 0.26em; text-transform: uppercase;
  }
  .label.sm { font-size: 10px; letter-spacing: 0.2em; }
  .dot { color: var(--green); }

  /* film-grain overlay */
  .grain {
    position: fixed; inset: 0; z-index: 9999; pointer-events: none;
    opacity: 0.05; mix-blend-mode: multiply;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  }

  /* reveal-on-scroll */
  .reveal { opacity: 0; transform: translateY(46px); transition: opacity 1s var(--ease), transform 1s var(--ease); }
  .reveal.in { opacity: 1; transform: none; }
  .reveal.d1 { transition-delay: .08s; }
  .reveal.d2 { transition-delay: .16s; }
  .reveal.d3 { transition-delay: .24s; }
  @media (prefers-reduced-motion: reduce) { .reveal { opacity: 1; transform: none; transition: none; } }

  /* ============================================================ NAV ============================================================ */
  .nav {
    position: fixed; top: 20px; left: 0; right: 0; z-index: 1000;
    display: grid; grid-template-columns: 1fr auto 1fr; align-items: center;
    padding: 0 28px;
  }
  .nav-logo { font-family: var(--anton); font-size: 24px; letter-spacing: 0.04em; color: var(--forest); text-transform: uppercase; }
  .nav-pill {
    justify-self: center;
    display: flex; gap: 4px; align-items: center;
    padding: 7px; border-radius: 999px;
    background: rgba(12,63,38,0.08);
    backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
    border: 1px solid rgba(12,63,38,0.14);
  }
  .nav-pill a {
    font-weight: 700; font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase;
    color: var(--forest); padding: 9px 16px; border-radius: 999px; transition: background .3s var(--ease), color .3s var(--ease);
  }
  .nav-pill a:hover, .nav-pill a.on { background: var(--forest); color: var(--cream); }
  .nav-right { justify-self: end; display: flex; align-items: center; gap: 14px; }
  .nav-signin {
    font-weight: 700; font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase;
    color: var(--forest); padding: 12px 18px; border-radius: 999px;
    border: 1.5px solid rgba(12,63,38,0.3);
    transition: background .3s var(--ease), color .3s var(--ease);
  }
  .nav-signin:hover { background: var(--forest); color: var(--cream); border-color: var(--forest); }
  .nav-cta {
    display: inline-flex; align-items: center; gap: 9px;
    padding: 12px 20px; border-radius: 999px;
    background: var(--forest); color: var(--cream);
    font-weight: 700; font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase;
    transition: transform .4s var(--ease), background .3s var(--ease);
  }
  .nav-cta:hover { transform: translateY(-2px); background: var(--green); }
  .nav-cta .badge { background: var(--cream); color: var(--forest); border-radius: 999px; padding: 2px 9px; font-size: 10px; }

  /* ============================================================ HERO (sage) ============================================================ */
  .hero {
    position: relative; background: var(--sage);
    min-height: 100vh;
    display: flex; flex-direction: column; justify-content: flex-end;
    padding: 130px 28px 40px;
    border-radius: 0 0 44px 44px;
    overflow: hidden;
  }
  .hero-stage { position: relative; flex: 1; display: flex; align-items: center; justify-content: center; }
  .hero-photo {
    position: absolute; top: 4%; left: 2%;
    width: clamp(220px, 30vw, 420px); aspect-ratio: 4/3;
    border-radius: 26px; overflow: hidden;
    transform: rotate(-4deg);
    box-shadow: 0 40px 80px -30px rgba(12,63,38,0.5);
    z-index: 1;
  }
  .hero-photo img { width: 100%; height: 100%; object-fit: cover; }
  .hero-photo::after { content: ""; position: absolute; inset: 0; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.25); border-radius: 26px; }
  .hero-word {
    position: relative; z-index: 2; margin: 0;
    font-family: var(--anton); color: var(--forest);
    font-size: clamp(92px, 23vw, 360px); line-height: 0.82;
    letter-spacing: 0.005em; text-align: center;
    text-transform: uppercase;
  }
  .hero-word .dot { color: var(--green); }
  .hero-base {
    position: relative; z-index: 3;
    display: flex; justify-content: space-between; align-items: flex-end; gap: 30px;
    flex-wrap: wrap; margin-top: 18px;
  }
  .hero-tag { font-family: var(--anton); font-size: clamp(18px, 2vw, 26px); line-height: 1.1; max-width: 460px; text-transform: uppercase; letter-spacing: 0.01em; }
  .hero-tag span { color: var(--green); }
  .hero-meta { text-align: right; }
  .hero-meta .m-k { font-family: var(--anton); font-size: 15px; letter-spacing: 0.04em; text-transform: uppercase; }
  .hero-meta .m-s { margin-top: 6px; }
  .hero-scroll {
    position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%);
    display: flex; flex-direction: column; align-items: center; gap: 6px;
    color: var(--forest); opacity: .6; z-index: 3;
  }
  .hero-scroll .arr { animation: bob 1.8s var(--ease) infinite; }
  @keyframes bob { 0%,100%{ transform: translateY(0);} 50%{ transform: translateY(6px);} }

  /* ============================================================ CLAIM BETTER (olive) ============================================================ */
  .claim {
    position: relative; background: var(--olive);
    padding: 96px 28px 110px;
    border-radius: 44px; margin-top: -24px;
  }
  .claim-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 30px; flex-wrap: wrap; }
  .claim-eyebrow { color: var(--green); }
  .claim h2 {
    font-family: var(--anton); color: var(--forest); margin: 10px 0 0;
    font-size: clamp(64px, 13vw, 200px); line-height: 0.82; letter-spacing: 0.005em; text-transform: uppercase;
  }
  .claim h2 .dot { color: var(--green); }
  .claim-cta {
    display: inline-flex; align-items: center; gap: 10px; margin-top: 16px;
    padding: 15px 26px; border-radius: 999px; background: var(--forest); color: var(--cream);
    font-weight: 700; font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase;
    transition: transform .4s var(--ease), background .3s var(--ease);
  }
  .claim-cta:hover { transform: translateY(-2px); background: var(--green); }
  .claim-intro { max-width: 460px; margin-top: 22px; font-size: 17px; color: var(--forest); }

  /* three step phones */
  .steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 30px; margin-top: 64px; }
  .step { display: flex; flex-direction: column; align-items: center; }
  .step-tag { align-self: stretch; display: flex; align-items: baseline; gap: 12px; margin-bottom: 22px; padding-bottom: 14px; border-bottom: 1.5px solid rgba(12,63,38,0.18); }
  .step-no { font-family: var(--anton); font-size: 30px; color: var(--green); line-height: 1; }
  .step-info .s-k { font-family: var(--anton); font-size: 19px; text-transform: uppercase; letter-spacing: 0.01em; line-height: 1.05; }
  .step-info .s-s { font-size: 13.5px; color: var(--forest); opacity: .72; margin-top: 3px; }

  /* ---- phone ---- */
  .phone {
    width: 100%; max-width: 282px;
    background: var(--forest); border-radius: 40px; padding: 10px;
    box-shadow: 0 50px 90px -34px rgba(12,63,38,0.55), 0 0 0 1px rgba(12,63,38,0.4);
    position: relative;
  }
  .phone::before { content: ""; position: absolute; top: 18px; left: 50%; transform: translateX(-50%); width: 86px; height: 22px; background: var(--forest); border-radius: 0 0 13px 13px; z-index: 4; }
  .scr { background: var(--cream); border-radius: 31px; overflow: hidden; aspect-ratio: 9/19.2; display: flex; flex-direction: column; }
  .scr-top { display: flex; align-items: center; justify-content: space-between; padding: 15px 18px 8px; font-size: 11px; font-weight: 700; color: var(--forest); }
  .scr-body { flex: 1; padding: 6px 15px 16px; display: flex; flex-direction: column; overflow: hidden; }
  .scr-brand { font-family: var(--anton); font-size: 17px; text-transform: uppercase; letter-spacing: 0.03em; color: var(--forest); }
  .scr-brand .dot { color: var(--green); }
  .scr-h { font-family: var(--anton); font-size: 21px; text-transform: uppercase; line-height: 1.02; margin: 8px 0 3px; color: var(--forest); }
  .scr-sub { font-size: 12px; color: var(--forest); opacity: .68; margin-bottom: 13px; }

  /* progress dots */
  .wiz-steps { display: flex; gap: 5px; margin-bottom: 14px; }
  .wiz-steps i { height: 4px; flex: 1; border-radius: 2px; background: rgba(12,63,38,0.16); }
  .wiz-steps i.on { background: var(--green); }

  /* bucket toggle rows */
  .brow { display: flex; align-items: center; gap: 10px; padding: 11px 12px; border-radius: 13px; background: #fff; border: 1px solid rgba(12,63,38,0.10); margin-bottom: 8px; }
  .brow .bk-sw { width: 9px; height: 9px; border-radius: 3px; flex: 0 0 auto; }
  .brow .bk-nm { font-weight: 700; font-size: 13px; color: var(--forest); }
  .brow .bk-ct { font-size: 11px; color: var(--forest); opacity: .6; }
  .brow .tgl { margin-left: auto; width: 32px; height: 19px; border-radius: 999px; background: rgba(12,63,38,0.16); position: relative; flex: 0 0 auto; }
  .brow .tgl::after { content: ""; position: absolute; top: 2px; left: 2px; width: 15px; height: 15px; border-radius: 50%; background: #fff; transition: left .2s; }
  .brow.on .tgl { background: var(--green); }
  .brow.on .tgl::after { left: 15px; }

  /* upload / segment screen */
  .drop { border: 1.5px dashed rgba(12,63,38,0.3); border-radius: 15px; padding: 18px 12px; text-align: center; margin-bottom: 12px; background: #fff; }
  .drop .di { width: 34px; height: 34px; margin: 0 auto 8px; border-radius: 10px; background: var(--olive); display: grid; place-items: center; }
  .drop .dk { font-weight: 700; font-size: 12.5px; color: var(--forest); }
  .drop .ds { font-size: 11px; color: var(--forest); opacity: .6; margin-top: 2px; }
  .seg-row { display: flex; align-items: center; gap: 9px; padding: 9px 11px; background: #fff; border: 1px solid rgba(12,63,38,0.10); border-radius: 12px; margin-bottom: 7px; }
  .seg-row .sg-ic { width: 26px; height: 26px; border-radius: 7px; background: var(--olive); display: grid; place-items: center; font-family: var(--anton); font-size: 11px; color: var(--forest); flex: 0 0 auto; }
  .seg-row .sg-nm { font-weight: 700; font-size: 12px; color: var(--forest); }
  .seg-row .sg-tag { font-size: 10px; color: var(--green); font-weight: 700; }
  .seg-row .sg-amt { margin-left: auto; font-weight: 700; font-size: 12px; color: var(--forest); }
  .seg-prog { margin-top: auto; padding-top: 10px; }
  .seg-bar { height: 6px; border-radius: 3px; background: rgba(12,63,38,0.14); overflow: hidden; }
  .seg-bar i { display: block; height: 100%; width: 72%; background: var(--green); border-radius: 3px; }
  .seg-lbl { display: flex; justify-content: space-between; font-size: 11px; color: var(--forest); opacity: .7; margin-top: 7px; font-weight: 600; }

  /* ready to claim screen */
  .ready-hero { background: var(--forest); color: var(--cream); border-radius: 16px; padding: 15px 16px; margin-bottom: 12px; }
  .ready-hero .rk { font-size: 11px; opacity: .7; letter-spacing: 0.04em; text-transform: uppercase; font-weight: 700; }
  .ready-hero .rv { font-family: var(--anton); font-size: 26px; margin-top: 5px; text-transform: uppercase; letter-spacing: 0.01em; }
  .ready-hero .rs { font-size: 11px; opacity: .72; margin-top: 4px; }
  .chk { display: flex; align-items: center; gap: 10px; padding: 9px 4px; font-size: 12.5px; color: var(--forest); font-weight: 600; }
  .chk .ck { width: 19px; height: 19px; border-radius: 50%; background: var(--green); display: grid; place-items: center; flex: 0 0 auto; }
  .chk.todo .ck { background: rgba(12,63,38,0.14); }
  .scr-cta { margin-top: auto; background: var(--green); color: var(--cream); border-radius: 13px; padding: 13px; text-align: center; font-weight: 700; font-size: 12.5px; letter-spacing: 0.02em; }

  /* ============================================================ JOIN THE TAX MOVEMENT (forest footer) ============================================================ */
  .movement {
    background: var(--forest); color: var(--cream);
    padding: 110px 28px 44px;
    border-radius: 44px 44px 0 0; margin-top: -24px;
    position: relative;
  }
  .move-grid { display: grid; grid-template-columns: 1.4fr 1fr 1fr; gap: 40px; }
  .move-h { font-family: var(--anton); font-size: clamp(48px, 8vw, 116px); line-height: 0.86; text-transform: uppercase; color: var(--cream); margin: 0; }
  .move-h .dot { color: var(--sage); }
  .move-sign { margin-top: 28px; max-width: 380px; }
  .move-sign .ms-k { font-size: 13px; opacity: .75; margin-bottom: 12px; }
  .signup { display: flex; align-items: center; gap: 10px; border-bottom: 1.5px solid rgba(244,243,221,0.4); padding-bottom: 10px; }
  .signup input { flex: 1; background: transparent; border: none; outline: none; color: var(--cream); font-family: var(--inter); font-size: 15px; }
  .signup input::placeholder { color: rgba(244,243,221,0.5); }
  .signup button { background: transparent; border: none; color: var(--cream); font-weight: 700; font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; cursor: pointer; display: inline-flex; align-items: center; gap: 7px; }
  .signup button:hover { color: var(--sage); }
  .signup button:disabled { opacity: .5; cursor: default; }
  .move-note { margin-top: 12px; font-size: 12px; opacity: 0; transition: opacity .3s var(--ease); min-height: 16px; }
  .move-note.show { opacity: .8; }

  .move-col h4 { color: rgba(244,243,221,0.55); font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase; font-weight: 700; margin: 0 0 18px; }
  .move-col ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 13px; }
  .move-col a { font-size: 14.5px; color: var(--cream); transition: opacity .3s var(--ease); }
  .move-col a:hover { opacity: .55; }

  .move-foot {
    margin-top: 80px; padding-top: 24px; border-top: 1px solid rgba(244,243,221,0.18);
    display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; flex-wrap: wrap;
  }
  .move-foot .ff { font-size: 11px; letter-spacing: 0.04em; opacity: .62; line-height: 1.55; max-width: 640px; }
  .move-foot .ff-links { display: flex; gap: 22px; flex: 0 0 auto; }
  .move-foot .ff-links a { font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; opacity: .7; font-weight: 600; }

  /* big watermark behind movement */
  .move-mark {
    font-family: var(--anton); font-size: clamp(120px, 30vw, 520px);
    text-transform: uppercase; color: rgba(244,243,221,0.05);
    position: absolute; left: 0; right: 0; bottom: -4%; text-align: center; line-height: 0.8;
    pointer-events: none; z-index: 0; letter-spacing: 0.02em;
  }
  .movement > * { position: relative; z-index: 1; }

  /* ============================================================ RESPONSIVE ============================================================ */
  @media (max-width: 940px) {
    .nav-pill { display: none; }
    .steps { grid-template-columns: 1fr; max-width: 320px; margin-left: auto; margin-right: auto; }
    .step { margin-bottom: 14px; }
    .move-grid { grid-template-columns: 1fr; gap: 30px; }
    .hero-photo { display: none; }
  }
  @media (max-width: 560px) {
    .hero-base { flex-direction: column; align-items: flex-start; }
    .hero-meta { text-align: left; }
    .nav-signin { display: none; }
  }
</style>
</head>
<body>
<div class="grain"></div>

<!-- ============ NAV ============ -->
<header class="nav">
  <a class="nav-logo" href="#top">Quillo</a>
  <nav class="nav-pill">
    <a href="#top" class="on">Home</a>
    <a href="#claim">How it works</a>
    <a href="#movement">Join</a>
  </nav>
  <div class="nav-right">
    <a class="nav-signin" href="${APP_URL}">Sign in</a>
    <a class="nav-cta" href="${APP_URL}">Sign up <span class="badge">free</span></a>
  </div>
</header>

<main id="top">

<!-- ============ HERO ============ -->
<section class="hero">
  <div class="hero-stage">
    <div class="hero-photo reveal">
      <img src="https://images.unsplash.com/photo-1521737711867-e3b97375f902?auto=format&fit=crop&w=1100&q=80" alt="Working through receipts at a desk" />
    </div>
    <h1 class="hero-word reveal d1">Quillo<span class="dot">.</span></h1>
  </div>
  <div class="hero-base">
    <p class="hero-tag reveal d2">Australian tax, <span>sorted for you.</span> Capture every receipt, segment every statement line.</p>
    <div class="hero-meta reveal d3">
      <div class="m-k">Built in Australia</div>
      <div class="m-s label sm">Read-only bank feeds · QuickBooks · 256-bit secure</div>
    </div>
  </div>
  <div class="hero-scroll">
    <span class="label sm">Scroll</span>
    <svg class="arr" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 2v12M3 9l5 5 5-5"/></svg>
  </div>
</section>

<!-- ============ CLAIM BETTER ============ -->
<section class="claim" id="claim">
  <div class="claim-head">
    <div>
      <div class="claim-eyebrow label">How Quillo works</div>
      <h2>Claim<br/>Better<span class="dot">.</span></h2>
      <p class="claim-intro reveal">Three simple steps. Set up your buckets once, drop in your receipts and statements, and Quillo gets everything categorised and evidence-ready — no shoebox, no scramble.</p>
    </div>
    <a class="claim-cta reveal d1" href="#movement">See how it works
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 8h10M9 4l4 4-4 4"/></svg>
    </a>
  </div>

  <div class="steps">
    <!-- STEP 1 — define buckets in wizard -->
    <div class="step reveal">
      <div class="step-tag">
        <span class="step-no">01</span>
        <span class="step-info"><span class="s-k">Define your buckets</span><span class="s-s">A quick wizard, tailored to you</span></span>
      </div>
      <div class="phone">
        <div class="scr">
          <div class="scr-top"><span>9:41</span><span>Setup</span><span>●●●</span></div>
          <div class="scr-body">
            <div class="scr-brand">Quillo<span class="dot">.</span></div>
            <div class="scr-h">Set up your buckets</div>
            <div class="scr-sub">Pick what applies — Quillo files the rest.</div>
            <div class="wiz-steps"><i class="on"></i><i class="on"></i><i></i><i></i></div>
            <div class="brow on"><span class="bk-sw" style="background:#3f6bd6"></span><span><div class="bk-nm">PAYG · work-related</div><div class="bk-ct">Salary &amp; wages</div></span><span class="tgl"></span></div>
            <div class="brow on"><span class="bk-sw" style="background:#15643a"></span><span><div class="bk-nm">Rental property</div><div class="bk-ct">104 Womerah Ave</div></span><span class="tgl"></span></div>
            <div class="brow on"><span class="bk-sw" style="background:#caa53d"></span><span><div class="bk-nm">Company</div><div class="bk-ct">Young Milton Pty Ltd</div></span><span class="tgl"></span></div>
            <div class="brow"><span class="bk-sw" style="background:#9356c4"></span><span><div class="bk-nm">Novated lease</div><div class="bk-ct">Optional</div></span><span class="tgl"></span></div>
            <div class="scr-cta">Continue →</div>
          </div>
        </div>
      </div>
    </div>

    <!-- STEP 2 — upload receipts & segments -->
    <div class="step reveal d1">
      <div class="step-tag">
        <span class="step-no">02</span>
        <span class="step-info"><span class="s-k">Upload &amp; segment</span><span class="s-s">Receipts, PDFs &amp; bank statements</span></span>
      </div>
      <div class="phone">
        <div class="scr">
          <div class="scr-top"><span>9:41</span><span>Capture</span><span>●●●</span></div>
          <div class="scr-body">
            <div class="scr-brand">Quillo<span class="dot">.</span></div>
            <div class="scr-h">Add your records</div>
            <div class="scr-sub">Quillo reads &amp; segments each line.</div>
            <div class="drop">
              <div class="di"><svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="#0c3f26" stroke-width="1.6"><path d="M9 12V3M5.5 6.5L9 3l3.5 3.5M3 13.5h12"/></svg></div>
              <div class="dk">Drop receipts &amp; statements</div>
              <div class="ds">Snap, forward, or link your bank</div>
            </div>
            <div class="seg-row"><span class="sg-ic">B</span><span><div class="sg-nm">Bunnings</div><div class="sg-tag">Rental · Repairs</div></span><span class="sg-amt">$248.50</span></div>
            <div class="seg-row"><span class="sg-ic">O</span><span><div class="sg-nm">Officeworks</div><div class="sg-tag">Company · Supplies</div></span><span class="sg-amt">$89.95</span></div>
            <div class="seg-row"><span class="sg-ic">CB</span><span><div class="sg-nm">CommBank PDF</div><div class="sg-tag">32 lines segmented</div></span><span class="sg-amt">→</span></div>
            <div class="seg-prog">
              <div class="seg-bar"><i></i></div>
              <div class="seg-lbl"><span>Segmenting statements…</span><span>23 / 32</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- STEP 3 — get ready to claim (compliant: no predicted refund, no "lodge") -->
    <div class="step reveal d2">
      <div class="step-tag">
        <span class="step-no">03</span>
        <span class="step-info"><span class="s-k">Get claim-ready</span><span class="s-s">Categorised &amp; evidence-kept, all year</span></span>
      </div>
      <div class="phone">
        <div class="scr">
          <div class="scr-top"><span>9:41</span><span>Claim</span><span>●●●</span></div>
          <div class="scr-body">
            <div class="scr-brand">Quillo<span class="dot">.</span></div>
            <div class="scr-h">You're claim-ready</div>
            <div class="scr-sub">FY25 · everything's categorised.</div>
            <div class="ready-hero">
              <div class="rk">This financial year</div>
              <div class="rv">Claim-ready</div>
              <div class="rs">Every receipt categorised and the evidence kept for you.</div>
            </div>
            <div class="chk"><span class="ck"><svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="#f4f3dd" stroke-width="2"><path d="M2.5 6.5l2.5 2.5 4.5-5.5"/></svg></span> 882 receipts categorised</div>
            <div class="chk"><span class="ck"><svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="#f4f3dd" stroke-width="2"><path d="M2.5 6.5l2.5 2.5 4.5-5.5"/></svg></span> Depreciation calculated</div>
            <div class="chk todo"><span class="ck"><svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="#0c3f26" stroke-width="2"><path d="M2.5 6.5l2.5 2.5 4.5-5.5"/></svg></span> Review 2 low-confidence</div>
            <div class="scr-cta">Open my summary →</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- ============ JOIN THE TAX MOVEMENT ============ -->
<footer class="movement" id="movement">
  <div class="move-mark" aria-hidden="true">Quillo</div>
  <div class="move-grid">
    <div>
      <h2 class="move-h reveal">Join the<br/>tax<br/>movement<span class="dot">.</span></h2>
      <div class="move-sign reveal d1">
        <div class="ms-k">Get early access &amp; tax tips that actually help.</div>
        <form class="signup" id="signup">
          <input type="email" id="signup-email" placeholder="your@email.com" aria-label="Email address" required />
          <button type="submit" id="signup-btn">Submit
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 8h10M9 4l4 4-4 4"/></svg>
          </button>
        </form>
        <div class="move-note" id="signup-note" role="status"></div>
      </div>
    </div>
    <div class="move-col reveal d1">
      <h4>Explore</h4>
      <ul>
        <li><a href="#claim">How it works</a></li>
        <li><a href="${APP_URL}">Sign in</a></li>
        <li><a href="${APP_URL}">Get started</a></li>
        <li><a href="/privacy">Privacy</a></li>
        <li><a href="/terms">Terms</a></li>
      </ul>
    </div>
    <div class="move-col reveal d2">
      <h4>Follow</h4>
      <ul>
        <li><a href="#">Instagram</a></li>
        <li><a href="#">LinkedIn</a></li>
        <li><a href="#">X / Twitter</a></li>
        <li><a href="#">TikTok</a></li>
      </ul>
    </div>
  </div>

  <div class="move-foot">
    <span class="ff">General information only — not tax advice. Quillo is not a registered tax or BAS agent, does not lodge returns, and never holds or moves your money. Confirm your situation with a registered tax/BAS agent. © 2026 Quillo.</span>
    <span class="ff-links">
      <a href="/privacy">Privacy</a>
      <a href="/terms">Terms</a>
    </span>
  </div>
</footer>

</main>

<script>
  // reveal-on-scroll
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { threshold: 0.15, rootMargin: '0px 0px -8% 0px' });
  document.querySelectorAll('.reveal').forEach((el) => io.observe(el));

  // subtle parallax on the hero photo
  const photo = document.querySelector('.hero-photo');
  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    if (photo && y < window.innerHeight) photo.style.transform = 'rotate(-4deg) translateY(' + (y * 0.12) + 'px)';
  }, { passive: true });

  // waitlist signup → POST /waitlist (existing un-gated endpoint)
  const form = document.getElementById('signup');
  const note = document.getElementById('signup-note');
  const btn = document.getElementById('signup-btn');
  const emailEl = document.getElementById('signup-email');
  const showNote = (msg) => { note.textContent = msg; note.classList.add('show'); };
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const email = (emailEl.value || '').trim();
    if (!email) return;
    btn.disabled = true;
    showNote('Adding you…');
    try {
      const res = await fetch('/waitlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, source: 'landing' }),
      });
      if (res.ok) {
        form.style.display = 'none';
        showNote("You're on the list — we'll be in touch.");
      } else {
        const data = await res.json().catch(() => ({}));
        showNote(data && data.error === 'invalid_email' ? 'That email looks off — try again.' : "Couldn't add you just now — try again shortly.");
        btn.disabled = false;
      }
    } catch {
      showNote("Couldn't add you just now — check your connection.");
      btn.disabled = false;
    }
  });
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
