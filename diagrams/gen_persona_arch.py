#!/usr/bin/env python3
"""Generate the Quillo persona-journey architecture diagram as Excalidraw JSON.
Layout: shared 6-stop spine (top) -> capability x persona crossover cards -> persona legend -> gaps callout.
Status colour = whole-card fill/stroke (safe=live E2E, warn=partial, danger=gap)."""
import json, itertools

# Quillo green palette + verdict tints
P = dict(bg="#fbfcf5", surface="#f1f4e6", primary="#0c3f26", accent="#15643a",
         muted="#5b6b57", text="#15321f", border="#d7ddc8",
         safe="#1b5e20", safe_bg="#eaf6ec", warn="#9a6712", warn_bg="#fbf2dd",
         danger="#b71c1c", danger_bg="#fbe9e9")

els = []
_sid = itertools.count(1)
def sid(): return next(_sid)

def rect(id, x, y, w, h, fill, stroke, sw=2, dash="solid", round=True):
    els.append({"id": id, "type": "rectangle", "x": x, "y": y, "width": w, "height": h,
        "angle": 0, "strokeColor": stroke, "backgroundColor": fill, "fillStyle": "solid",
        "strokeWidth": sw, "strokeStyle": dash, "roughness": 1, "opacity": 100, "groupIds": [],
        "frameId": None, "roundness": {"type": 3} if round else None, "seed": sid(), "version": 1,
        "versionNonce": sid(), "isDeleted": False, "boundElements": [], "updated": 1, "link": None, "locked": False})

def text(id, x, y, w, h, s, size=16, color=None, align="left", bold_family=1):
    color = color or P["text"]
    els.append({"id": id, "type": "text", "x": x, "y": y, "width": w, "height": h, "angle": 0,
        "strokeColor": color, "backgroundColor": "transparent", "fillStyle": "solid", "strokeWidth": 2,
        "strokeStyle": "solid", "roughness": 1, "opacity": 100, "groupIds": [], "frameId": None,
        "roundness": None, "seed": sid(), "version": 1, "versionNonce": sid(), "isDeleted": False,
        "boundElements": [], "updated": 1, "link": None, "locked": False, "text": s, "originalText": s,
        "fontSize": size, "fontFamily": bold_family, "textAlign": align, "verticalAlign": "top",
        "containerId": None, "lineHeight": 1.25, "baseline": int(size*0.8)})

def arrow(id, x, y, pts, color=None, sw=2, dash="solid", head="arrow"):
    color = color or P["muted"]
    xs=[p[0] for p in pts]; ys=[p[1] for p in pts]
    els.append({"id": id, "type": "arrow", "x": x, "y": y, "width": max(xs)-min(xs), "height": max(ys)-min(ys),
        "angle": 0, "strokeColor": color, "backgroundColor": "transparent", "fillStyle": "solid",
        "strokeWidth": sw, "strokeStyle": dash, "roughness": 1, "opacity": 100, "groupIds": [], "frameId": None,
        "roundness": {"type": 2}, "seed": sid(), "version": 1, "versionNonce": sid(), "isDeleted": False,
        "boundElements": [], "updated": 1, "link": None, "locked": False, "points": pts,
        "lastCommittedPoint": None, "startBinding": None, "endBinding": None, "startArrowhead": None,
        "endArrowhead": head, "elbowed": False})

# ---- Title ----
text("title", 140, 40, 1200, 40, "Quillo — how the 10 personas use the system (shared journey + crossover)", 28, P["primary"])
text("subtitle", 140, 82, 1300, 24, "Every persona walks the same 6-stop spine. Capability cards below show who shares each engine and where the journey breaks.", 16, P["muted"])

# ---- The shared 6-stop spine ----
spine = [("1 · Set up", "entities, people,\nproperties (Settings)"),
         ("2 · Bring in", "add account +\nimport CSV/PDF, receipts"),
         ("3 · Sort", "auto-categorise +\nInbox + apply-to-siblings"),
         ("4 · Check", "Reconcile receipts,\nReview deductibility"),
         ("5 · Position", "Dashboard live position\n+ Transactions browse"),
         ("6 · File", "handoff doc + CSV\n(ATO labels)")]
sx, sy, sw, sh, gap = 140, 140, 196, 84, 16
text("spine-lbl", 140, 118, 600, 20, "THE SHARED SPINE — all 10 personas", 14, P["accent"])
for i,(t,b) in enumerate(spine):
    x = sx + i*(sw+gap)
    rect(f"spine{i}", x, sy, sw, sh, P["surface"], P["primary"], sw=2)
    text(f"spine{i}t", x+12, sy+10, sw-24, 20, t, 16, P["primary"])
    text(f"spine{i}b", x+12, sy+34, sw-24, 40, b, 12, P["muted"])
    if i < len(spine)-1:
        ax = x+sw; arrow(f"sarr{i}", ax, sy+sh/2, [[0,0],[gap,0]], P["accent"], 2)

# ---- Capability x persona crossover cards ----
# status: safe (live E2E), warn (partial UI), danger (gap / not built)
caps = [
 # (title, who, status, note)
 ("CGT — shares/crypto/property", "P2 P6 P8 P9 P10", "safe", "parcels + disposals UI (Income)"),
 ("ESS / RSU grants", "P2 P9", "safe", "grants UI (Income)"),
 ("Car logbook (cents/km vs logbook)", "P3 P4 P5 P7", "safe", "logbook UI (Assets)"),
 ("Depreciation Div 40 / Div 43", "P3 P6 P9", "safe", "asset UI + schedule (Assets)"),
 ("Trust distributions / streaming", "P8", "safe", "distribution UI (Settings)"),
 ("Occupation deduction claims", "P3 P7", "safe", "person occupation + Find My Claims"),
 ("Sole-trader activity + attribution", "P3 P4 P5 P8", "warn", "income+attribution only; NO activity-setup form"),
 ("GST / BAS / PAYG instalments", "P4 P5 P8", "danger", "engine only — flag OFF, NO input UI"),
 ("SMSF / pension / ECPI", "P10", "danger", "engine only — flag OFF, NO input UI"),
 ("Accountant hand-off (CSV + PDF)", "all", "safe", "by-category+ATO-label, per-property, BAS qtrs"),
 ("ATO myTax / myGov walkthrough", "(none)", "danger", "NOT built — 'hand to your agent' only"),
 ("Ask-anything tax chat", "(none)", "danger", "NOT built — only per-tab 'Guide Me'"),
]
cx0, cy0, cw, ch, cgx, cgy = 140, 320, 240, 104, 16, 16
text("cap-lbl", 140, 296, 700, 20, "CAPABILITIES — card colour = status · tags = which personas (crossover)", 14, P["accent"])
for i,(t,who,st,note) in enumerate(caps):
    col = i % 4; row = i // 4
    x = cx0 + col*(cw+cgx); y = cy0 + row*(ch+cgy)
    fill = {"safe":P["safe_bg"],"warn":P["warn_bg"],"danger":P["danger_bg"]}[st]
    stroke = {"safe":P["safe"],"warn":P["warn"],"danger":P["danger"]}[st]
    rect(f"cap{i}", x, y, cw, ch, fill, stroke, sw=2)
    text(f"cap{i}t", x+12, y+10, cw-24, 36, t, 14, P["text"])
    text(f"cap{i}w", x+12, y+50, cw-24, 18, who, 14, stroke)
    text(f"cap{i}n", x+12, y+72, cw-24, 26, note, 11, P["muted"])

# ---- Persona legend ----
ly = cy0 + 3*(ch+cgy) + 12
text("leg-lbl", 140, ly-24, 700, 20, "PERSONAS — E2E in-app today:  ✓ complete   ◑ partial   ✗ blocked by a gap", 14, P["accent"])
personas = [
 ("P1 Maya", "PAYG renter · WFH", "safe"),
 ("P2 Daniel", "PAYG + shares/RSU/CGT", "safe"),
 ("P3 Lukas", "tradie · tools/ute/cash", "warn"),
 ("P4 Priya", "rideshare · GST from $1", "danger"),
 ("P5 Tom", "sole trader · GST/PAYG-I", "danger"),
 ("P6 Susan&Greg", "co-owned rentals · CGT", "safe"),
 ("P7 Nadia", "nurse · multi-employer", "safe"),
 ("P8 James", "company + trust · GST", "warn"),
 ("P9 Aisha", "startup · R&D/s40-880/ESS", "warn"),
 ("P10 Margaret", "SMSF + crypto CGT", "danger"),
]
pw, ph, pgx, pgy = 192, 64, 16, 16
mark = {"safe":"✓","warn":"◑","danger":"✗"}
for i,(n,s,st) in enumerate(personas):
    col = i % 5; row = i // 5
    x = cx0 + col*(pw+pgx); y = ly + row*(ph+pgy)
    stroke = {"safe":P["safe"],"warn":P["warn"],"danger":P["danger"]}[st]
    rect(f"p{i}", x, y, pw, ph, P["bg"], stroke, sw=2)
    text(f"p{i}n", x+10, y+9, pw-30, 18, n, 14, P["primary"])
    text(f"p{i}m", x+pw-26, y+9, 20, 18, mark[st], 16, stroke)
    text(f"p{i}s", x+10, y+32, pw-20, 24, s, 11, P["muted"])

# ---- Gaps / recommendations callout ----
gy0 = ly + 2*(ph+pgy) + 24
rect("gapbox", 140, gy0, 1056, 132, P["surface"], P["primary"], sw=2)
text("gapt", 156, gy0+12, 900, 22, "Gaps & opportunities found in this review", 18, P["primary"])
text("gapb", 156, gy0+42, 1024, 86,
     "✗ SMSF (P10) and GST/BAS+PAYG-instalments (P4,P5,P8): engines exist but flags OFF and NO input UI — those personas can't finish in-app.\n"
     "◑ Sole-trader 'business activity' has no setup form (P3 cash job, P4/P5 ABN).   ✗ No ATO/myTax step-through.   ✗ No ask-anything chat (only per-tab Guide Me).\n"
     "⚠ docs/personas.md is STALE — says 'all flags OFF / only P1,3,6,7 complete'; in prod CGT/ESS/logbook/trust are ON so P2,P6 are now complete and P8,P9 nearly.\n"
     "✓ Strength vs the 'dump docs in a Claude project' workflow: Quillo already computes Div 40/43 depreciation schedules and keeps every line + rule it learns.", 13, P["text"])

doc = {"type": "excalidraw", "version": 2, "source": "https://excalidraw.com",
       "elements": els, "appState": {"viewBackgroundColor": P["bg"], "gridSize": None}, "files": {}}
with open("/Users/brendanmilton/Desktop/tax-agent/diagrams/quillo-persona-journeys.excalidraw", "w") as f:
    json.dump(doc, f, indent=1)
print(f"wrote {len(els)} elements")
