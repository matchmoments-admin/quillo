// Codemod: <env>.DB.prepare(SQL).bind(...args) → tenantDb(<env>, T).prepare(SQL).bind(...args minus tenant)
// Converts ONLY when the tenant positions are provable statically. Usage: node codemod.mjs <repo> [--write] [--spans] [files…]
import fs from "node:fs"; import path from "node:path"; import { createRequire } from "node:module";
const repo = process.argv[2]; const WRITE = process.argv.includes("--write"); const SPANS = process.argv.includes("--spans");
const only = process.argv.slice(3).filter((a) => !a.startsWith("--"));
const require = createRequire(path.join(repo, "package.json")); const ts = require("typescript");
const TD = await import(path.join(repo, "src/lib/tenant-db.ts"));
const tenantPlanSrc = (sql) => ({ ...TD.tenantPlan(sql), offsets: TD.placeholderOffsets(sql) });
const TENANT = /^(userId|uid|u\.user_id|this\.userId|tenantId|ownerId|user\.userId|ctx\.userId|deps\.userId|opts\.userId|p\.userId|U)$/;
// Interpolations proven to contain no `?` placeholder (a column-to-column user_id comparison is fine: the
// planner only fires on `user_id = ?`). Reviewed per entry; see --spans.
const SAFE = new Set((process.env.SAFE_SPANS ?? "").split("\n").map((s) => s.trim()).filter(Boolean));
const files = [];
(function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (p.endsWith(".ts") && !p.endsWith("tenant-db.ts")) files.push(p); } })(path.join(repo, "src"));
const spanCount = new Map(); const stats = { seen: 0, converted: 0, skip: {} };
const skip = (r) => { stats.skip[r] = (stats.skip[r] ?? 0) + 1; };
for (const file of files) {
  const rel = path.relative(repo, file);
  if (only.length && !only.includes(rel)) continue;
  const src = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const edits = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "prepare"
      && ts.isPropertyAccessExpression(node.expression.expression) && node.expression.expression.name.text === "DB") {
      stats.seen++;
      const envExpr = node.expression.expression.expression.getText(sf);
      const sqlNode = node.arguments[0];
      const parent = node.parent;
      if (!(ts.isPropertyAccessExpression(parent) && parent.name.text === "bind" && ts.isCallExpression(parent.parent))) { skip("no-bind"); return ts.forEachChild(node, visit); }
      const bindCall = parent.parent;
      let text = null; const spans = [];
      if (ts.isStringLiteral(sqlNode) || ts.isNoSubstitutionTemplateLiteral(sqlNode)) text = sqlNode.text;
      else if (ts.isTemplateExpression(sqlNode)) {
        text = sqlNode.head.text;
        for (const sp of sqlNode.templateSpans) { const e = sp.expression.getText(sf); spans.push({ e, at: text.length }); spanCount.set(e, (spanCount.get(e) ?? 0) + 1); text += " " + sp.literal.text; }
      } else { skip("sql-not-literal"); return ts.forEachChild(node, visit); }
      const plan = tenantPlanSrc(text);
      if (!plan.tenant.length) { skip("no-tenant-placeholder"); return ts.forEachChild(node, visit); }
      // Unknown spans may hide `?`s: allowed only if SAFE, or if they sit after the last static placeholder.
      // STRICT: every interpolation must be a reviewed fragment with no ? and no user_id (SAFE). Anything
      // else could hide a placeholder or a tenant predicate and shift the binds, so the call is left raw.
      const unsafe = spans.filter((s) => !SAFE.has(s.e));
      if (unsafe.length) { skip("unreviewed-span"); return ts.forEachChild(node, visit); }
      const trailingUnknown = false;
      const args = bindCall.arguments;
      const spreadIdx = args.findIndex((a) => ts.isSpreadElement(a));
      const fixed = spreadIdx < 0 ? args.length : spreadIdx;
      if (plan.tenant.some((t) => t >= fixed)) { skip("tenant-after-spread"); return ts.forEachChild(node, visit); }
      if (spreadIdx < 0 && !trailingUnknown && args.length !== plan.total) { skip("arg-count-mismatch"); return ts.forEachChild(node, visit); }
      const tExprs = plan.tenant.map((t) => args[t].getText(sf));
      if (!tExprs.every((e) => e === tExprs[0]) || !TENANT.test(tExprs[0])) { skip("tenant-arg-not-userId"); return ts.forEachChild(node, visit); }
      // Edit 1: the receiver.  Edit 2: drop the tenant args from bind (keep the rest verbatim).
      edits.push({ start: node.expression.expression.getStart(sf), end: node.expression.expression.getEnd(), text: `tenantDb(${envExpr}, ${tExprs[0]})` });
      const kept = args.filter((_, i) => !plan.tenant.includes(i)).map((a) => a.getText(sf));
      edits.push({ start: args.pos, end: args.end, text: kept.join(", ") });
      stats.converted++;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (WRITE && edits.length) {
    let out = src;
    for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
    if (!/from "\.\/(lib\/)?tenant-db"|from "\.\.?\/.*tenant-db"/.test(out)) {
      const imp = rel.startsWith("src/lib/") ? "./tenant-db" : rel.startsWith("src/lib/") ? "./tenant-db" : (rel.split("/").length === 2 ? "./lib/tenant-db" : "../tenant-db");
      const spec = path.relative(path.dirname(file), path.join(repo, "src/lib/tenant-db")).replace(/^(?!\.)/, "./");
      const lines = out.split("\n"); let last = -1; lines.forEach((l, i) => { if (/^import .* from ".*";$/.test(l)) last = i; });
      lines.splice(last + 1, 0, `import { tenantDb } from "${spec}";`); out = lines.join("\n");
    }
    fs.writeFileSync(file, out);
  }
}
console.log(JSON.stringify(stats));
if (SPANS) console.log([...spanCount.entries()].sort((a, b) => b[1] - a[1]).map(([e, n]) => `${n}\t${e}`).join("\n"));
