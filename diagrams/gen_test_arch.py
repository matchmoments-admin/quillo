#!/usr/bin/env python3
"""Generate diagrams/quillo-test-arch.excalidraw — the current architecture with a
testing plan (link + guidance) per process. Re-run after changes: python3 diagrams/gen_test_arch.py
Excalidraw hyperlinks: each test card carries a clickable `link` (open in app/repo)."""
import json, hashlib

els = []
def _id(s): return hashlib.md5(s.encode()).hexdigest()[:12]
seq = [0]
def nid():
    seq[0] += 1
    return _id(f"el{seq[0]}")

PALETTE = {
    "cap":  ("#e7f5ff", "#1971c2"),   # capture - blue
    "pipe": ("#fff9db", "#e8590c"),   # worker pipeline - amber
    "store":("#f3f0ff", "#7048e8"),   # stores - violet
    "proc": ("#ebfbee", "#2f9e44"),   # process - green
    "test": ("#ffffff", "#495057"),   # test card - grey
    "bg":   ("#fff0f6", "#c2255c"),   # background jobs - pink
}

def rect(x, y, w, h, kind, link=None):
    bg, st = PALETTE[kind]
    e = {
        "id": nid(), "type": "rectangle", "x": x, "y": y, "width": w, "height": h,
        "angle": 0, "strokeColor": st, "backgroundColor": bg, "fillStyle": "solid",
        "strokeWidth": 2, "strokeStyle": "solid", "roughness": 1, "opacity": 100,
        "groupIds": [], "frameId": None, "roundness": {"type": 3}, "seed": 1,
        "version": 1, "versionNonce": 1, "isDeleted": False, "boundElements": [],
        "updated": 1, "link": link, "locked": False,
    }
    els.append(e)
    return e

def text(x, y, s, size=16, color="#212529", w=None, align="left", bold=False):
    lines = s.split("\n")
    fw = w if w else max(len(l) for l in lines) * size * 0.6
    e = {
        "id": nid(), "type": "text", "x": x, "y": y, "width": fw,
        "height": len(lines) * size * 1.25, "angle": 0, "strokeColor": color,
        "backgroundColor": "transparent", "fillStyle": "solid", "strokeWidth": 1,
        "strokeStyle": "solid", "roughness": 0, "opacity": 100, "groupIds": [],
        "frameId": None, "roundness": None, "seed": 1, "version": 1, "versionNonce": 1,
        "isDeleted": False, "boundElements": [], "updated": 1, "link": None, "locked": False,
        "text": s, "fontSize": size, "fontFamily": 2 if not bold else 3,
        "textAlign": align, "verticalAlign": "top", "containerId": None,
        "originalText": s, "lineHeight": 1.25,
    }
    els.append(e)
    return e

def arrow(x1, y1, x2, y2, color="#868e96", label=None):
    e = {
        "id": nid(), "type": "arrow", "x": x1, "y": y1,
        "width": abs(x2 - x1), "height": abs(y2 - y1), "angle": 0,
        "strokeColor": color, "backgroundColor": "transparent", "fillStyle": "solid",
        "strokeWidth": 2, "strokeStyle": "solid", "roughness": 1, "opacity": 100,
        "groupIds": [], "frameId": None, "roundness": {"type": 2}, "seed": 1,
        "version": 1, "versionNonce": 1, "isDeleted": False, "boundElements": [],
        "updated": 1, "link": None, "locked": False,
        "points": [[0, 0], [x2 - x1, y2 - y1]], "lastCommittedPoint": None,
        "startBinding": None, "endBinding": None, "startArrowhead": None, "endArrowhead": "arrow",
    }
    els.append(e)
    if label:
        text((x1 + x2) / 2 - len(label) * 3, (y1 + y2) / 2 - 18, label, 11, "#868e96")

APP = "https://app.quillo.au"

# ── Title ────────────────────────────────────────────────────────────────────
text(40, -60, "Quillo — architecture + testing plan (per process)", 26, "#212529", bold=True)
text(40, -22, "Live app: app.quillo.au   ·   Public site: quillo.au   ·   Worker: tax-agent.matchmoments.workers.dev   ·   Full guidance: diagrams/TESTING.md",
     13, "#868e96")

# ── Architecture strip (top) ──────────────────────────────────────────────────
strip_y = 30
text(40, strip_y, "ARCHITECTURE — money flows through ONE pipe per account (no double-count)", 14, "#495057", bold=True)
ay = strip_y + 30
flow = [
    ("Capture\nphoto · email · CSV/PDF · QBO", "cap"),
    ("Clerk auth\nsingle-user lockdown", "pipe"),
    ("Ingest → R2\nstore raw", "pipe"),
    ("Extract (Claude)\nmerchant·amt·GST·fx", "pipe"),
    ("Categorise\nrules(KV)+Claude", "pipe"),
    ("Reconcile/Match\nbalance + receipt↔line", "pipe"),
    ("Store → D1\n+ audit chain", "store"),
]
fx = 40
for i, (lbl, kind) in enumerate(flow):
    rect(fx, ay, 150, 64, kind)
    text(fx + 10, ay + 12, lbl, 12)
    if i < len(flow) - 1:
        arrow(fx + 150, ay + 32, fx + 168, ay + 32)
    fx += 168
# stores callout
rect(fx, ay, 150, 64, "store")
text(fx + 10, ay + 12, "D1 · R2 · KV\nReview UI + Reports", 12)

# ── Process → Test-plan rows ──────────────────────────────────────────────────
ROWS = [
    ("Auth — single-user lockdown", "proc",
     "Clerk JWT (jose/JWKS); only CLERK_ALLOWED_USERS reach /api/*. Public apex stays open.",
     APP, [
        "curl -s -o /dev/null -w '%{http_code}' https://tax-agent.matchmoments.workers.dev/api/usage  → 401",
        "Sign in at app.quillo.au with your Clerk user → /api/* works.",
        "Open quillo.au in a private window → public, no auth.",
     ]),
    ("Receipt capture + extract", "proc",
     "Photo → R2 → Claude vision → merchant·amount·GST·date·bucket. Confidence gates auto-file vs review.",
     APP, [
        "On phone: app.quillo.au → '+ Add receipt' → snap. Expect merchant/amount/GST within ~5s.",
        "Bulk/offline: node scripts/feed-expenses.mjs <folder|file>.",
        "Verify in Inbox → tap row → fields + receipt image + confidence.",
     ]),
    ("Edge cases — multi-shot · USD · duplicates", "proc",
     "Multiple screenshots = one receipt; foreign currency → amount_aud_cents via fx; re-upload de-duped.",
     APP, [
        "Share 2-3 screenshots together → one transaction, not three.",
        "Upload a USD receipt (e.g. Anthropic) → currency=USD + AUD amount shown.",
        "Re-upload the same file → marked duplicate, not double-counted.",
     ]),
    ("Categorise + correction learning", "proc",
     "Deterministic rule pack (KV) first, Claude fallback. A correction writes a per-user rule.",
     APP + "/settings", [
        "Inbox → correct a bucket/ATO label → corrections + audit_log row.",
        "Upload a similar merchant again → now auto-categorised (rule learned).",
        "Settings → Per-user rules: confirm the new rule; edit/delete works.",
     ]),
    ("Statement import + reconciliation", "proc",
     "CSV/PDF → parsed lines → opening+Σsigned==closing proof. ✓ balances or ⚠ off-by-$X w/ first bad line.",
     APP + "/accounts", [
        "Accounts → add account → 'Upload statement (CSV/PDF)'.",
        "Expect a green ✓ 'Balances' OR a red ⚠ with the exact diff + bad line.",
        "Offline harness: npm run eval:statements (westpac ✓, mismatch ✗).",
     ]),
    ("Receipt ↔ bank-line matching", "proc",
     "Unmatched receipts vs unmatched bank lines; link hides the receipt from counting (no double-count).",
     APP + "/reconcile", [
        "Reconcile page: pick a receipt + its bank line → Link.",
        "Linked receipt disappears from 'needs review'; Unlink restores it.",
        "Dashboard total unchanged after linking (counted once).",
     ]),
    ("QBO feed sync — no double-count", "proc",
     "Sync registers QBO bank/card accounts as source=qbo_feed; those refuse statement uploads + are excluded from reconcile.",
     APP + "/accounts", [
        "Connect QuickBooks (Settings/QuickBooks), then Accounts → 'Sync accounts from QuickBooks'.",
        "A qbo_feed account shows no 'Upload statement' button (guard active).",
        "QuickBooks reconcile lists only receipt expenses, never bank lines.",
     ]),
    ("Async batch categorisation + failure handling", "proc",
     "Large statements (>60 lines) → Message Batches API (50% off). Zombie-proof: all-errored→failed, >24h→failed+notify.",
     APP + "/accounts", [
        "Import a big statement → account shows 'categorising…', then 'imported (n)'.",
        "Status polls every 5s while categorising; failure → red 'failed' + alert.",
        "Unit guard: npm run test:units (batchStatementStatus / isStaleBatch).",
     ]),
    ("Cost / budget meter", "proc",
     "Per-call usage + $ logged; MAX_DAILY_COST_CENTS caps spend; Batch API halves async cost.",
     APP + "/settings", [
        "GET /api/usage → today/month cents + by-feature breakdown.",
        "1 receipt ≈ $0.0028; 300-row statement ≈ 2.9¢ (verified).",
        "Set MAX_DAILY_COST_CENTS low to confirm the cap blocks further calls.",
     ]),
    ("Offline regression net", "proc",
     "No worker/Claude needed — deterministic guards on the invariants we keep re-learning.",
     "https://github.com/consulting-brendan", [
        "npm test  → 25 unit assertions + 2 statement cases, exit 0.",
        "npm run test:units → reconcile, transfer-conservatism, fingerprint, batch.",
        "npm run eval:statements → line accuracy + reconcile pass-rate.",
     ]),
    ("Dashboard + Reports", "proc",
     "Aggregates by bucket/property; FY report + CSV export for your tax/BAS agent.",
     APP + "/reports", [
        "Dashboard → totals by bucket match the ledger.",
        "Reports → pick FY → company quarters, rental schedule, GST credits.",
        "Export CSV → hand to your registered agent (Quillo never lodges).",
     ]),
]

ry = ay + 110
text(40, ry - 30, "TESTING PLAN — one card per process (cards are clickable → open the relevant screen)", 14, "#495057", bold=True)
ROW_H = 132
for name, kind, desc, link, steps in ROWS:
    # process box (left)
    rect(40, ry, 300, ROW_H - 16, kind)
    text(54, ry + 14, name, 14, "#212529", w=272, bold=True)
    text(54, ry + 44, desc, 11, "#495057", w=272)
    # arrow
    arrow(340, ry + (ROW_H - 16) / 2, 380, ry + (ROW_H - 16) / 2, label="test")
    # test card (right, clickable link)
    rect(384, ry, 780, ROW_H - 16, "test", link=link)
    text(398, ry + 12, "How to test  ·  " + link, 11, "#1971c2", w=752)
    text(398, ry + 36, "\n".join("•  " + s for s in steps), 12, "#212529", w=752)
    ry += ROW_H

# ── Background jobs band ──────────────────────────────────────────────────────
by = ry + 10
text(40, by, "BACKGROUND (cron */10 + Mon 08:00)", 14, "#495057", bold=True)
bg_items = [
    ("Proactive scan\nvacant-property + uncategorised nudges (COUNTABLE-filtered)", "scan: weekly + on /dashboard"),
    ("Batch poll\napply finished categorisations; fail zombies >24h", "cron */10 + opportunistic"),
    ("Budget meter\nrolling $ spend in KV; blocks over cap", "every inference call"),
]
bx = 40
for lbl, when in bg_items:
    rect(bx, by + 28, 360, 70, "bg")
    text(bx + 12, by + 38, lbl, 12)
    text(bx + 12, by + 78, when, 10, "#c2255c")
    bx += 380

# ── Footer ────────────────────────────────────────────────────────────────────
text(40, by + 120,
     "Note: live click-throughs need your Clerk login (single-user lockdown). Offline gates (npm test) run anywhere. "
     "macOS 12.6 can't run workerd locally → deploy is the live test path.",
     11, "#868e96")

doc = {"type": "excalidraw", "version": 2, "source": "quillo", "elements": els,
       "appState": {"gridSize": None, "viewBackgroundColor": "#ffffff"}, "files": {}}
with open("diagrams/quillo-test-arch.excalidraw", "w") as f:
    json.dump(doc, f, indent=2)
print(f"wrote diagrams/quillo-test-arch.excalidraw with {len(els)} elements")
