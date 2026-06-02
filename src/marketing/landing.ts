// Self-contained public marketing page served by the Worker for the apex host
// (quillo.au). No framework, no build step — one HTML string with inline CSS. The
// visual system is the editorial "Quill" design (cream canvas, signature yellow accent,
// Spectral serif display + Hanken Grotesk body) ported from the Claude Design handoff.
//
// Copy discipline (Quillo "stay in your lane" rules): non-custodial, NOT a registered
// tax agent, does NOT lodge. No fabricated user/savings numbers, no invented pricing or
// testimonials. The footer disclaimer is mandatory and kept verbatim-matched to the app
// footer. The design mock's copy claimed the opposite (registered agent, TPB number,
// lodging, $ savings, fake reviews) — all of that is deliberately stripped here.
//
// CTAs ("Log in" / "Get started") point at the gated app. Imagery is hotlinked Unsplash
// with fallback colours so nothing looks broken if a URL hiccups; swap for brand photos
// later. Testimonial tiles are Google-review PLACEHOLDERS, ready for real reviews.

import { cssRootVars } from "../../design/tokens.mjs";

const APP_URL = "https://app.quillo.au";

const HTML = /* html */ `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Quillo — the tax brain that sees your whole picture</title>
<meta name="description" content="Quillo sits above your salary, your side company and your properties, reasoning across all of them against current ATO rules. General information only — not a tax agent, never holds your money." />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700;800&family=Spectral:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500;1,600&display=swap" rel="stylesheet" />
<style>
  /* ============================================================
     Quillo — landing page
     Editorial "Quill" system: warm cream canvas, bright yellow
     accent, classical serif display, clean grotesque body.
     ============================================================ */
  /* :root custom properties are generated from the centralised token source
     (design/tokens.mjs) so the marketing page and the dashboard share one palette. */
  ${cssRootVars()}

  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    background: var(--paper);
    color: var(--ink);
    font-family: var(--sans);
    font-size: 17px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  img { display: block; max-width: 100%; }
  a { color: inherit; text-decoration: none; }
  ::selection { background: var(--yellow); color: var(--ink); }

  .wrap { max-width: var(--maxw); margin: 0 auto; padding: 0 var(--gutter); }

  /* photo backgrounds with safe fallback colour */
  .ph {
    background-size: cover;
    background-position: center;
    background-repeat: no-repeat;
    background-color: var(--fallback, #d8d3c6);
  }

  /* ---- display type ---- */
  .serif { font-family: var(--serif); }
  h1, h2, h3 { margin: 0; font-family: var(--serif); font-weight: 500; letter-spacing: -0.01em; line-height: 1.04; }
  .eyebrow {
    font-family: var(--sans);
    font-size: 12px; font-weight: 700;
    letter-spacing: 0.14em; text-transform: uppercase;
    color: var(--ink-3);
  }

  /* ---- buttons ---- */
  .btn {
    display: inline-flex; align-items: center; gap: 9px;
    font-family: var(--sans); font-weight: 600; font-size: 14.5px;
    padding: 12px 22px; border-radius: 999px;
    border: 1px solid transparent; cursor: pointer;
    transition: transform .15s ease, background .15s ease, color .15s ease;
  }
  .btn:hover { transform: translateY(-1px); }
  .btn-dark   { background: var(--ink); color: var(--paper); }
  .btn-dark:hover { background: #2b2820; }
  .btn-yellow { background: var(--yellow); color: var(--ink); }
  .btn-yellow:hover { background: var(--yellow-d); }
  .btn-light  { background: var(--paper); color: var(--ink); border-color: var(--line); }
  .btn-light:hover { background: #fff; }
  .btn-ghost  { background: transparent; color: var(--ink); border-color: rgba(20,19,15,.22); }
  .btn-ghost:hover { background: var(--ink); color: var(--paper); border-color: var(--ink); }
  .btn-pill-sm { padding: 7px 15px; font-size: 13px; }

  .arrow-btn {
    display: inline-flex; align-items: center; gap: 10px;
    font-weight: 600; font-size: 15px; color: var(--ink);
  }
  .arrow-btn .circ {
    width: 34px; height: 34px; border-radius: 50%;
    display: grid; place-items: center;
    background: var(--ink); color: var(--paper);
    transition: transform .15s ease;
  }
  .arrow-btn:hover .circ { transform: translate(2px,-2px); }

  /* ============================================================ NAV ============================================================ */
  .nav {
    position: sticky; top: 0; z-index: 50;
    background: color-mix(in oklab, var(--paper) 88%, transparent);
    backdrop-filter: blur(10px);
    border-bottom: 1px solid transparent;
  }
  .nav.scrolled { border-bottom-color: var(--line); }
  .nav-in {
    max-width: var(--maxw); margin: 0 auto;
    padding: 16px var(--gutter);
    display: grid; grid-template-columns: 1fr auto 1fr; align-items: center;
  }
  .brand { font-family: var(--serif); font-size: 23px; font-weight: 600; letter-spacing: -0.02em; }
  .brand .star { color: var(--ink); }
  .nav-links { display: flex; gap: 30px; justify-content: center; }
  .nav-links a { font-size: 14.5px; font-weight: 500; color: var(--ink-2); transition: color .15s; }
  .nav-links a:hover { color: var(--ink); }
  .nav-right { display: flex; gap: 12px; justify-content: flex-end; align-items: center; }

  /* ============================================================ HERO ============================================================ */
  .hero {
    position: relative;
    margin: 10px var(--gutter) 0;
    border-radius: 22px;
    overflow: hidden;
    height: clamp(460px, 64vh, 660px);
    --fallback: #2c2a25;
  }
  .hero .ph { position: absolute; inset: 0; }
  .hero::after {
    content: ""; position: absolute; inset: 0;
    background: linear-gradient(180deg, rgba(15,14,11,.45) 0%, rgba(15,14,11,.12) 42%, rgba(15,14,11,.55) 100%);
  }
  .hero-content {
    position: relative; z-index: 2;
    height: 100%;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    text-align: center; color: #fff;
    padding: 40px;
  }
  .hero h1 {
    color: #fff;
    font-size: clamp(44px, 6.6vw, 92px);
    font-weight: 500;
    letter-spacing: -0.02em;
    text-shadow: 0 2px 30px rgba(0,0,0,.25);
  }
  .hero h1 em { font-style: italic; }
  .hero-pill {
    position: absolute; left: 50%; bottom: 34px; transform: translateX(-50%);
    z-index: 3;
  }

  /* ============================================================ TRUST STRIP ============================================================ */
  .trust {
    padding: 30px var(--gutter) 14px;
    max-width: var(--maxw); margin: 0 auto;
  }
  .trust-row {
    display: flex; align-items: center; justify-content: space-between;
    gap: 28px; flex-wrap: wrap;
  }
  .trust-badge { display: flex; align-items: center; gap: 10px; color: var(--ink-2); }
  .trust-badge .seal {
    width: 38px; height: 38px; border-radius: 50%;
    border: 1.5px solid var(--ink); display: grid; place-items: center;
    font-family: var(--serif); font-weight: 600; font-size: 17px; flex: 0 0 auto;
  }
  .trust-badge .tb-k { font-family: var(--serif); font-size: 15px; line-height: 1.15; font-weight: 600; }
  .trust-logo { font-family: var(--serif); font-weight: 600; font-size: 20px; color: var(--ink); opacity: .82; letter-spacing: -0.01em; }
  .trust-logo.grotesk { font-family: var(--sans); font-weight: 800; letter-spacing: -0.02em; }

  /* ============================================================ YELLOW BAND ============================================================ */
  .band {
    background: var(--yellow);
    margin: 26px 0 0;
    padding: 54px var(--gutter);
  }
  .band-in { max-width: 760px; margin: 0 auto; text-align: center; }
  .band h2 { font-size: clamp(30px, 4vw, 46px); font-weight: 500; }
  .band p { color: #3c3914; max-width: 560px; margin: 14px auto 24px; font-size: 16px; }
  .band .star-em { font-style: italic; }

  /* ============================================================ SECTION SHELL ============================================================ */
  .sec { padding: 84px 0; }
  .sec-head { margin-bottom: 40px; }
  .sec-head h2 { font-size: clamp(30px, 4vw, 48px); }
  .sec-head p { color: var(--ink-2); max-width: 540px; margin-top: 14px; }

  /* ---- "in your pocket" cards ---- */
  .pocket-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 30px; }
  .pcard .pcard-img { height: 230px; border-radius: var(--radius); overflow: hidden; }
  .pcard h3 { font-size: 23px; margin: 20px 0 8px; }
  .pcard p { color: var(--ink-2); font-size: 15px; margin: 0 0 16px; }

  /* ============================================================ REAL STORY — Q&A ============================================================ */
  .story-intro { max-width: 540px; }
  .story-intro h2 { font-size: clamp(30px, 4vw, 48px); }
  .story-intro p { color: var(--ink-2); margin-top: 16px; }
  .story-intro .btn { margin-top: 22px; }

  .qa-layout {
    display: grid; grid-template-columns: 0.92fr 1.08fr; gap: 60px;
    margin-top: 56px; align-items: start;
  }
  .qa-sticky { position: sticky; top: 96px; }
  .qa-list { display: flex; flex-direction: column; }
  .qa-item { padding: 40px 0; border-top: 1px solid var(--line); }
  .qa-item:first-child { border-top: none; padding-top: 0; }
  .qa-item q { display: block; quotes: none; }
  .qa-item .qa-q {
    font-family: var(--serif); font-weight: 500;
    font-size: clamp(28px, 3.4vw, 42px); line-height: 1.05; letter-spacing: -0.01em;
  }
  .qa-item .qa-a { color: var(--ink-2); margin-top: 16px; max-width: 440px; font-size: 16px; }

  /* ============================================================ PHONE MOCKUP (built in HTML) ============================================================ */
  .phone {
    width: 300px; margin: 0 auto;
    background: var(--ink); border-radius: 42px; padding: 11px;
    box-shadow: 0 40px 80px -30px rgba(20,19,15,.5), 0 0 0 1px rgba(0,0,0,.06);
    position: relative;
  }
  .phone-screen {
    background: var(--paper); border-radius: 32px; overflow: hidden;
    aspect-ratio: 9 / 19; display: flex; flex-direction: column;
  }
  .phone-notch {
    position: absolute; top: 20px; left: 50%; transform: translateX(-50%);
    width: 96px; height: 24px; background: var(--ink); border-radius: 0 0 14px 14px; z-index: 3;
  }
  .scr-top {
    display: flex; align-items: center; justify-content: space-between;
    padding: 16px 18px 10px; font-size: 11px; font-weight: 600; color: var(--ink-2);
  }
  .scr-body { flex: 1; padding: 6px 16px 18px; overflow: hidden; }
  .scr-brand { font-family: var(--serif); font-weight: 600; font-size: 18px; }
  .scr-h { font-family: var(--serif); font-size: 20px; font-weight: 600; margin: 4px 0 2px; }
  .scr-sub { font-size: 12px; color: var(--ink-2); margin-bottom: 14px; }

  .scr-rcpt {
    background: var(--card); border: 1px solid var(--line); border-radius: 12px;
    padding: 12px; display: flex; gap: 11px; align-items: center; margin-bottom: 10px;
  }
  .scr-rcpt .ic {
    width: 38px; height: 38px; border-radius: 9px; flex: 0 0 auto;
    background: var(--paper-2); display: grid; place-items: center;
    font-family: var(--serif); font-weight: 700; font-size: 15px; color: var(--ink-2);
  }
  .scr-rcpt .rc-name { font-weight: 700; font-size: 13px; }
  .scr-rcpt .rc-cat { font-size: 11px; color: var(--ink-3); margin-top: 1px; }
  .scr-rcpt .rc-amt { margin-left: auto; font-weight: 700; font-size: 13px; }
  .scr-rcpt .rc-flag {
    margin-left: auto; font-size: 10px; font-weight: 700; color: #a8631a;
    background: #f8ecd3; padding: 3px 8px; border-radius: 999px;
  }
  .scr-cta {
    margin-top: 6px; background: var(--yellow); border-radius: 12px;
    padding: 13px 14px; text-align: center; font-weight: 700; font-size: 13px;
  }

  /* ============================================================ WHY PANEL ============================================================ */
  .why { background: var(--paper-2); padding: 84px 0; }
  .why .sec-head h2 { font-size: clamp(30px, 4vw, 48px); }
  .why-stage {
    margin-top: 48px; position: relative;
    display: flex; justify-content: center;
    padding: 20px 0 0;
  }
  .float {
    position: absolute; background: var(--card);
    border: 1px solid var(--line); border-radius: 12px;
    box-shadow: 0 24px 50px -24px rgba(20,19,15,.28);
    padding: 12px 14px;
  }
  .float .fl-k { font-size: 11px; color: var(--ink-3); }
  .float .fl-v { font-family: var(--serif); font-weight: 600; font-size: 16px; }
  .float.f1 { left: 7%;  top: 60px; }
  .float.f2 { right: 6%; top: 130px; }
  .float.f3 { right: 11%; bottom: 60px; }
  .float.seal { display: flex; align-items: center; gap: 11px; max-width: 250px; }
  .float.seal .seal-ic {
    width: 40px; height: 40px; border-radius: 50%; border: 1.5px solid var(--ink);
    display: grid; place-items: center; font-family: var(--serif); font-weight: 700; flex: 0 0 auto;
  }
  .float.seal .seal-tx { font-size: 11px; color: var(--ink-2); line-height: 1.3; }
  .why-stats {
    display: grid; grid-template-columns: repeat(4,1fr);
    border-top: 1px solid var(--line); margin-top: 56px;
  }
  .why-stats .ws { padding: 22px 18px; border-left: 1px solid var(--line); }
  .why-stats .ws:first-child { border-left: none; padding-left: 0; }
  .why-stats .ws-k { font-family: var(--serif); font-weight: 600; font-size: 17px; }
  .why-stats .ws-s { font-size: 13px; color: var(--ink-2); margin-top: 4px; }

  /* ============================================================ PROOF — testimonials ============================================================ */
  .proof-grid {
    display: grid; grid-template-columns: repeat(4, 1fr);
    grid-auto-rows: 200px; gap: 20px; margin-top: 44px;
  }
  .tile { border-radius: var(--radius); overflow: hidden; position: relative; }
  .tile.img { --fallback: #cfc9bb; }
  .tile.span2 { grid-column: span 2; }
  .tile.row2 { grid-row: span 2; }
  .tile.quote {
    background: var(--card); border: 1px solid var(--line);
    padding: 24px; display: flex; flex-direction: column; justify-content: space-between;
  }
  .tile.quote.yellow { background: var(--yellow); border-color: transparent; }
  .tile .q-mark { font-family: var(--serif); font-size: 40px; line-height: .6; color: var(--ink); opacity: .35; }
  .tile .q-text { font-family: var(--serif); font-size: clamp(15px,1.4vw,19px); line-height: 1.32; margin: 12px 0; }
  .tile .q-by { font-size: 12px; }
  .tile .q-by b { display: block; font-weight: 700; }
  .tile .q-by span { color: var(--ink-2); }
  .tile.quote.yellow .q-by span { color: #4a4612; }
  /* Google-review chrome (placeholder tiles) */
  .g-top { display: flex; align-items: center; gap: 8px; }
  .g-mark {
    width: 22px; height: 22px; border-radius: 50%; flex: 0 0 auto;
    display: grid; place-items: center; background: #fff; border: 1px solid var(--line);
    font-family: var(--sans); font-weight: 800; font-size: 13px; color: #4285F4;
  }
  .g-via { font-size: 11px; font-weight: 700; letter-spacing: .04em; color: var(--ink-3); text-transform: uppercase; }
  .g-stars { margin-left: auto; color: #f0b400; font-size: 13px; letter-spacing: 1px; }
  .tile.quote.yellow .g-mark { background: #fff; }

  /* ============================================================ TWIN CTA CARDS ============================================================ */
  .twin { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; padding-bottom: 84px; }
  .twin-card {
    background: var(--yellow); border-radius: 20px; padding: 44px;
    min-height: 280px; display: flex; flex-direction: column; justify-content: space-between;
  }
  .twin-card h2 { font-size: clamp(28px, 3.4vw, 44px); }
  .twin-card p { color: #46420f; margin: 16px 0 0; max-width: 360px; }

  /* ============================================================ FOOTER ============================================================ */
  .footer { background: var(--ink); color: #cfccc2; padding: 64px var(--gutter) 36px; }
  .footer-in { max-width: var(--maxw); margin: 0 auto; }
  .footer-cols { display: grid; grid-template-columns: 1.6fr 1fr 1fr 1fr 1fr; gap: 30px; }
  .footer .brand { color: #fff; }
  .footer .f-tag { color: #908c82; font-size: 14px; margin-top: 14px; max-width: 260px; }
  .footer h4 { font-family: var(--sans); font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: #908c82; margin: 0 0 14px; }
  .footer ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  .footer ul a { color: #cfccc2; font-size: 14px; }
  .footer ul a:hover { color: #fff; }
  .footer-foot {
    margin-top: 48px; padding-top: 26px; border-top: 1px solid #2c2a23;
    display: flex; justify-content: space-between; align-items: center; gap: 20px; flex-wrap: wrap;
  }
  .footer-foot .fine { font-size: 12px; color: #807c72; max-width: 640px; line-height: 1.5; }
  .footer-foot .f-seal { display: flex; gap: 18px; align-items: center; opacity: .8; }
  .footer-foot .f-seal span { font-family: var(--serif); font-size: 15px; color: #cfccc2; }

  /* ============================================================ RESPONSIVE ============================================================ */
  @media (max-width: 980px) {
    .nav-links { display: none; }
    .nav-in { grid-template-columns: 1fr auto; }
    .pocket-grid { grid-template-columns: 1fr; }
    .qa-layout { grid-template-columns: 1fr; gap: 30px; }
    .qa-sticky { position: static; }
    .proof-grid { grid-template-columns: repeat(2, 1fr); }
    .tile.span2 { grid-column: span 2; }
    .twin { grid-template-columns: 1fr; }
    .footer-cols { grid-template-columns: 1fr 1fr; }
    .why-stats { grid-template-columns: 1fr 1fr; }
    .float { display: none; }
  }
  @media (max-width: 560px) {
    :root { --gutter: 20px; }
    .proof-grid { grid-template-columns: 1fr; grid-auto-rows: 180px; }
    .tile.span2 { grid-column: span 1; }
    .trust-row { gap: 16px; justify-content: center; }
  }
</style>
</head>
<body>

<!-- ============ NAV ============ -->
<header class="nav" id="nav">
  <div class="nav-in">
    <a class="brand" href="#top">Quillo<span class="star">*</span></a>
    <nav class="nav-links">
      <a href="#pocket">How it works</a>
      <a href="#story">The real story</a>
      <a href="#why">Why Quillo</a>
      <a href="#proof">Reviews</a>
    </nav>
    <div class="nav-right">
      <a class="btn btn-light btn-pill-sm" href="${APP_URL}">Log in</a>
      <a class="btn btn-dark btn-pill-sm" href="${APP_URL}">Get started</a>
    </div>
  </div>
</header>

<main id="top">

<!-- ============ HERO ============ -->
<section class="hero">
  <div class="ph" style="--fallback:#2c2a25; background-image:url('https://images.unsplash.com/photo-1521737711867-e3b97375f902?auto=format&fit=crop&w=1900&q=80');"></div>
  <div class="hero-content">
    <h1>Tax that sorts<br/>itself. <em>Finally.</em></h1>
  </div>
  <a class="btn btn-yellow hero-pill" href="${APP_URL}">Ask Quillo</a>
</section>

<!-- ============ TRUST STRIP ============ -->
<section class="trust">
  <div class="trust-row">
    <div class="trust-badge">
      <span class="seal">Q</span>
      <span>
        <span class="tb-k">Australian<br/>made</span>
      </span>
    </div>
    <div class="trust-logo">256-bit&nbsp;Secure</div>
    <div class="trust-logo">Xero</div>
    <div class="trust-logo grotesk">QuickBooks</div>
    <div class="trust-logo grotesk">Read-only&nbsp;feeds</div>
    <div class="trust-logo">Private&nbsp;by&nbsp;design</div>
  </div>
</section>

<!-- ============ YELLOW BAND ============ -->
<section class="band" id="band">
  <div class="band-in">
    <h2>The tax help you <span class="star-em">actually</span> asked for</h2>
    <p>Built for working Australians with a complicated income — Quillo sits above your salary, your side company and your properties, capturing every receipt and reasoning across all of them against current ATO rules. All year.</p>
    <a class="btn btn-dark" href="${APP_URL}">Get started</a>
  </div>
</section>

<!-- ============ HOW IT WORKS ============ -->
<section class="sec wrap" id="pocket">
  <div class="sec-head">
    <h2>Quillo in your pocket</h2>
  </div>
  <div class="pocket-grid">
    <article class="pcard">
      <div class="pcard-img ph" style="--fallback:#cdc5b2; background-image:url('https://images.unsplash.com/photo-1554224155-6726b3ff858f?auto=format&fit=crop&w=900&q=80');"></div>
      <h3>Snap it, forget it</h3>
      <p>Photograph a receipt, forward an email, or link a read-only bank feed. Quillo reads it and files it to the right ATO category in seconds.</p>
      <a class="btn btn-light btn-pill-sm" href="#story">How it works</a>
    </article>
    <article class="pcard">
      <div class="pcard-img ph" style="--fallback:#bcae93; background-image:url('https://images.unsplash.com/photo-1512941937669-90a1b58e7e9c?auto=format&fit=crop&w=900&q=80');"></div>
      <h3>Sees your whole picture</h3>
      <p>Most tools look at one entity at a time. Quillo reasons across your PAYG salary, your company and each property together — where the real mistakes hide.</p>
      <a class="btn btn-light btn-pill-sm" href="#why">Why it matters</a>
    </article>
    <article class="pcard">
      <div class="pcard-img ph" style="--fallback:#c7bfae; background-image:url('https://images.unsplash.com/photo-1517502884422-41eaead166d4?auto=format&fit=crop&w=900&q=80');"></div>
      <h3>100% in your corner</h3>
      <p>Every item is checked against current ATO rules. When something's unclear, Quillo flags it for a human — and never guesses on your behalf.</p>
      <a class="btn btn-light btn-pill-sm" href="#why">Our promise</a>
    </article>
  </div>
</section>

<!-- ============ THE REAL STORY (Q&A) ============ -->
<section class="sec wrap" id="story">
  <div class="story-intro">
    <span class="eyebrow">The real story</span>
    <h2 style="margin-top:14px;">Most Australians overpay.</h2>
    <p>Not because they earn too much — because deductions slip through the cracks all year, and tax time is a panicked scramble through a shoebox of receipts. Quillo changes that.</p>
    <a class="btn btn-ghost" href="${APP_URL}">See how →</a>
  </div>

  <div class="qa-layout">
    <div class="qa-sticky">
      <div class="phone">
        <div class="phone-notch"></div>
        <div class="phone-screen">
          <div class="scr-top"><span>9:41</span><span>Quillo</span><span>●●●</span></div>
          <div class="scr-body">
            <div class="scr-brand">Quillo<span style="color:var(--ink)">*</span></div>
            <div class="scr-h">Review</div>
            <div class="scr-sub">3 receipts need a quick look</div>

            <div class="scr-rcpt">
              <span class="ic">B</span>
              <span><span class="rc-name">Bunnings Warehouse</span><span class="rc-cat">Rental · Repairs</span></span>
              <span class="rc-amt">$248.50</span>
            </div>
            <div class="scr-rcpt">
              <span class="ic">A</span>
              <span><span class="rc-name">AGL Energy</span><span class="rc-cat">Which property?</span></span>
              <span class="rc-flag">Check</span>
            </div>
            <div class="scr-rcpt">
              <span class="ic">O</span>
              <span><span class="rc-name">Officeworks</span><span class="rc-cat">Office supplies</span></span>
              <span class="rc-amt">$89.95</span>
            </div>
            <div class="scr-cta">Confirm all &amp; file →</div>
          </div>
        </div>
      </div>
    </div>

    <div class="qa-list">
      <div class="qa-item">
        <q class="qa-q">"I don't know what I can claim."</q>
        <p class="qa-a">That's the whole problem with tax. Quillo learns how you actually earn — PAYG salary, an early Pty Ltd, a rental or two — and surfaces the deductions that apply to <em>you</em>. No guesswork, no generic checklists.</p>
      </div>
      <div class="qa-item">
        <q class="qa-q">"What if I get it wrong?"</q>
        <p class="qa-a">Every transaction shows a confidence score and a plain-English reason. The uncertain ones float to the top for a quick look. You always make the final call — Quillo just does the heavy lifting.</p>
      </div>
      <div class="qa-item">
        <q class="qa-q">"What if I get audited?"</q>
        <p class="qa-a">Quillo keeps a tidy, timestamped record of every receipt and category — exactly the kind of evidence the ATO asks for. Need to show your working? Export the lot in one tap.</p>
      </div>
      <div class="qa-item">
        <q class="qa-q">"Is it actually worth it?"</q>
        <p class="qa-a">When your income spans a payslip, a company and a property, deductions slip through the cracks — un-apportioned property costs, missing logbooks, GST edge cases. Quillo's whole job is to make sure they don't.</p>
      </div>
    </div>
  </div>
</section>

<!-- ============ WHY QUILLO ============ -->
<section class="why" id="why">
  <div class="wrap">
    <div class="sec-head">
      <span class="eyebrow">Why Quillo</span>
      <h2 style="margin-top:14px;">Built to be boringly trustworthy.</h2>
    </div>

    <div class="why-stage">
      <div class="float seal f1">
        <span class="seal-ic">Q</span>
        <span class="seal-tx">Built in Australia for Australian rules. Your data is never sold and never trains anyone else's model.</span>
      </div>
      <div class="float f2">
        <div class="fl-k">Receipts filed</div>
        <div class="fl-v">42 this year</div>
      </div>
      <div class="float f3">
        <div class="fl-k">FY25 status</div>
        <div class="fl-v">On track ✦</div>
      </div>

      <div class="phone">
        <div class="phone-notch"></div>
        <div class="phone-screen">
          <div class="scr-top"><span>9:41</span><span>Quillo</span><span>●●●</span></div>
          <div class="scr-body">
            <div class="scr-brand">Quillo<span style="color:var(--ink)">*</span></div>
            <div class="scr-h">Welcome back, Jo</div>
            <div class="scr-sub">Your FY25 picture is on track</div>
            <div class="scr-rcpt"><span class="ic">✓</span><span><span class="rc-name">42 receipts filed</span><span class="rc-cat">All categorised</span></span></div>
            <div class="scr-rcpt"><span class="ic">≈</span><span><span class="rc-name">3 income types</span><span class="rc-cat">PAYG · company · property</span></span></div>
            <div class="scr-rcpt"><span class="ic">!</span><span><span class="rc-name">2 to review</span><span class="rc-cat">Low confidence</span></span><span class="rc-flag">Review</span></div>
            <div class="scr-cta">Open my picture →</div>
          </div>
        </div>
      </div>
    </div>

    <div class="why-stats">
      <div class="ws"><div class="ws-k">Bank-grade security</div><div class="ws-s">256-bit encryption, read-only bank feeds.</div></div>
      <div class="ws"><div class="ws-k">Shows its working</div><div class="ws-s">Every decision keeps an audit trail you can read.</div></div>
      <div class="ws"><div class="ws-k">Private by design</div><div class="ws-s">Your data is yours. Never sold, never shared.</div></div>
      <div class="ws"><div class="ws-k">Built in Australia</div><div class="ws-s">For Australian rules, by people who get them.</div></div>
    </div>
  </div>
</section>

<!-- ============ PROOF ============ -->
<!--
  PLACEHOLDER testimonials. The quote tiles below are styled as Google-review cards but
  carry generic placeholder copy — they are NOT real customer reviews. Swap in real
  Google reviews (text, reviewer name, role) before relying on this section publicly.
-->
<section class="sec wrap" id="proof">
  <div class="sec-head">
    <h2>What people are saying</h2>
    <p>Real Google reviews will appear here as Quillo's early users share how it's working for them.</p>
  </div>
  <div class="proof-grid">
    <div class="tile img row2 span2 ph" style="--fallback:#bdb6a4; background-image:url('https://images.unsplash.com/photo-1573164713988-8665fc963095?auto=format&fit=crop&w=1100&q=80');"></div>
    <div class="tile quote span2">
      <div class="g-top"><span class="g-mark">G</span><span class="g-via">via Google</span><span class="g-stars">★★★★★</span></div>
      <div class="q-text">Your Google review will appear here — a few honest words from someone who's used Quillo across their salary, company and rentals.</div>
      <div class="q-by"><b>Reviewer name</b><span>Verified Google review · placeholder</span></div>
    </div>
    <div class="tile img ph" style="--fallback:#a89c82; background-image:url('https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?auto=format&fit=crop&w=700&q=80');"></div>
    <div class="tile quote yellow">
      <div class="g-top"><span class="g-mark">G</span><span class="g-via">via Google</span><span class="g-stars">★★★★★</span></div>
      <div class="q-text">A short, punchy review goes here once real ones land.</div>
      <div class="q-by"><b>Reviewer name</b><span>Verified Google review · placeholder</span></div>
    </div>
    <div class="tile img ph" style="--fallback:#9fa4ac; background-image:url('https://images.unsplash.com/photo-1600880292203-757bb62b4baf?auto=format&fit=crop&w=700&q=80');"></div>

    <div class="tile quote span2">
      <div class="g-top"><span class="g-mark">G</span><span class="g-via">via Google</span><span class="g-stars">★★★★★</span></div>
      <div class="q-text">Another verified Google review will sit here — placeholder text until the real one is pulled in.</div>
      <div class="q-by"><b>Reviewer name</b><span>Verified Google review · placeholder</span></div>
    </div>
    <div class="tile img span2 ph" style="--fallback:#c2bba9; background-image:url('https://images.unsplash.com/photo-1521737604893-d14cc237f11d?auto=format&fit=crop&w=1100&q=80');"></div>
  </div>
</section>

<!-- ============ TWIN CTA ============ -->
<section class="wrap twin">
  <div class="twin-card">
    <div>
      <h2>See your whole<br/>picture.</h2>
      <p>One brain over your salary, your company and your properties — reasoning across all of them against current ATO rules.</p>
    </div>
    <a class="arrow-btn" href="${APP_URL}"><span class="circ">→</span> Get started</a>
  </div>
  <div class="twin-card">
    <div>
      <h2>The Quillo Story</h2>
      <p>Or, if you're into reading nerdy tax stuff, here's exactly why we built Quillo — and who's behind it.</p>
    </div>
    <a class="arrow-btn" href="#story"><span class="circ">→</span> Our story</a>
  </div>
</section>

</main>

<!-- ============ FOOTER ============ -->
<footer class="footer">
  <div class="footer-in">
    <div class="footer-cols">
      <div>
        <div class="brand">Quillo<span class="star">*</span></div>
        <p class="f-tag">The tax brain that sees your whole picture. Capture, categorise and reason across it all — in your pocket.</p>
      </div>
      <div>
        <h4>About</h4>
        <ul><li><a href="#story">Purpose</a></li><li><a href="#why">Mission</a></li><li><a href="#why">Values</a></li></ul>
      </div>
      <div>
        <h4>Support</h4>
        <ul><li><a href="#">Contact</a></li><li><a href="#">FAQ</a></li><li><a href="#">Help centre</a></li></ul>
      </div>
      <div>
        <h4>Social</h4>
        <ul><li><a href="#">Instagram</a></li><li><a href="#">LinkedIn</a></li><li><a href="#">X / Twitter</a></li></ul>
      </div>
      <div>
        <h4>Legal</h4>
        <ul><li><a href="/terms">Terms</a></li><li><a href="/privacy">Privacy</a></li></ul>
      </div>
    </div>
    <div class="footer-foot">
      <p class="fine">General information only — not tax advice. Quillo is not a registered tax or BAS agent, does not lodge returns, and never holds or moves your money. Confirm your situation with a registered tax/BAS agent.</p>
      <div class="f-seal">
        <span>256-bit</span><span>AU</span><span>Private</span>
      </div>
    </div>
  </div>
</footer>

<script>
  // nav border on scroll
  const nav = document.getElementById('nav');
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
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
