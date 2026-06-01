import type { Env } from "../env";

// Australian FY is Jul–Jun. Given a start year Y, the FY runs Y-07-01 .. (Y+1)-06-30.
export function currentFyStartYear(now = new Date()): number {
  const y = now.getUTCFullYear();
  return now.getUTCMonth() >= 6 ? y : y - 1; // month 6 = July (0-indexed)
}

function fyBounds(startYear: number): { start: string; end: string } {
  return { start: `${startYear}-07-01`, end: `${startYear + 1}-06-30` };
}

export interface ReportRow {
  bucket: string;
  ato_label: string | null;
  n: number;
  total_cents: number;
  gst_cents: number;
}

export interface Report {
  fy: string;
  start: string;
  end: string;
  by_bucket: ReportRow[];
  by_property: { property_id: string; label: string | null; n: number; total_cents: number }[];
  company_quarters: { quarter: string; total_cents: number; gst_cents: number }[];
  undated: { n: number; total_cents: number };
}

export async function buildReport(env: Env, userId: string, startYear: number): Promise<Report> {
  const { start, end } = fyBounds(startYear);

  // AUD totals (fall back to original when already AUD / pre-migration). Exclude duplicates.
  const byBucket = await env.DB.prepare(
    `SELECT bucket, ato_label, COUNT(*) AS n,
            COALESCE(SUM(COALESCE(amount_aud_cents, amount_cents)),0) AS total_cents,
            COALESCE(SUM(gst_cents),0) AS gst_cents
       FROM transactions
      WHERE user_id = ? AND txn_date >= ? AND txn_date <= ? AND bucket IS NOT NULL AND status != 'duplicate'
      GROUP BY bucket, ato_label ORDER BY bucket, total_cents DESC`,
  )
    .bind(userId, start, end)
    .all<ReportRow>();

  const byProperty = await env.DB.prepare(
    `SELECT t.property_id, p.label, COUNT(*) AS n,
            COALESCE(SUM(COALESCE(t.amount_aud_cents, t.amount_cents)),0) AS total_cents
       FROM transactions t LEFT JOIN properties p ON p.id = t.property_id
      WHERE t.user_id = ? AND t.txn_date >= ? AND t.txn_date <= ? AND t.property_id IS NOT NULL AND t.status != 'duplicate'
      GROUP BY t.property_id`,
  )
    .bind(userId, start, end)
    .all<{ property_id: string; label: string | null; n: number; total_cents: number }>();

  // Receipts with no (or unparseable) date can't be assigned to any FY — surface them
  // explicitly instead of letting the date filter silently drop them from every report.
  const undated = await env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(amount_aud_cents, amount_cents)),0) AS total_cents
       FROM transactions
      WHERE user_id = ? AND status != 'duplicate'
        AND (txn_date IS NULL OR txn_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')`,
  )
    .bind(userId)
    .first<{ n: number; total_cents: number }>();

  // BAS quarters for the company bucket.
  const quarters = [
    { quarter: "Q1 Jul–Sep", s: `${startYear}-07-01`, e: `${startYear}-09-30` },
    { quarter: "Q2 Oct–Dec", s: `${startYear}-10-01`, e: `${startYear}-12-31` },
    { quarter: "Q3 Jan–Mar", s: `${startYear + 1}-01-01`, e: `${startYear + 1}-03-31` },
    { quarter: "Q4 Apr–Jun", s: `${startYear + 1}-04-01`, e: `${startYear + 1}-06-30` },
  ];
  const company_quarters: Report["company_quarters"] = [];
  for (const q of quarters) {
    const row = await env.DB.prepare(
      `SELECT COALESCE(SUM(COALESCE(amount_aud_cents, amount_cents)),0) AS total_cents,
              COALESCE(SUM(gst_cents),0) AS gst_cents
         FROM transactions WHERE user_id = ? AND bucket = 'company' AND status != 'duplicate'
           AND txn_date >= ? AND txn_date <= ?`,
    )
      .bind(userId, q.s, q.e)
      .first<{ total_cents: number; gst_cents: number }>();
    company_quarters.push({ quarter: q.quarter, total_cents: row?.total_cents ?? 0, gst_cents: row?.gst_cents ?? 0 });
  }

  return {
    fy: `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`,
    start,
    end,
    by_bucket: byBucket.results ?? [],
    by_property: byProperty.results ?? [],
    company_quarters,
    undated: { n: undated?.n ?? 0, total_cents: undated?.total_cents ?? 0 },
  };
}

/** AU financial-year label for a date, e.g. "2025-26". null when the date is missing/unparseable. */
export function fyForDate(txnDate: string | null): string | null {
  if (!txnDate || !/^\d{4}-\d{2}-\d{2}$/.test(txnDate)) return null;
  const y = Number(txnDate.slice(0, 4));
  const mo = Number(txnDate.slice(5, 7));
  const startYear = mo >= 7 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

export function reportToCsv(r: Report): string {
  const lines: string[] = [`Tax Agent summary,FY ${r.fy},${r.start} to ${r.end}`, "", "Bucket,ATO label,Count,Total,GST"];
  for (const b of r.by_bucket) {
    lines.push(`${b.bucket},${b.ato_label ?? ""},${b.n},${(b.total_cents / 100).toFixed(2)},${(b.gst_cents / 100).toFixed(2)}`);
  }
  lines.push("", "Property,Count,Total");
  for (const p of r.by_property) lines.push(`${(p.label ?? p.property_id).replace(/,/g, " ")},${p.n},${(p.total_cents / 100).toFixed(2)}`);
  lines.push("", "Company BAS quarter,Total,GST");
  for (const q of r.company_quarters) lines.push(`${q.quarter},${(q.total_cents / 100).toFixed(2)},${(q.gst_cents / 100).toFixed(2)}`);
  return lines.join("\n") + "\n";
}
