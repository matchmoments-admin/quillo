import type { Progress } from "../types";

// Per-tab "what do I do here?" copy, branched on the live progress snapshot. Kept as a single
// content map (separate from the term-level GLOSSARY) so the page guidance reads as one voice and
// stays easy to edit. The whole spine is oriented around one goal: getting a financial year
// lodge-ready. If a tab can't produce a sensible line for a state, that's a build bug, not copy.

export type TabKey =
  | "inbox"
  | "dashboard"
  | "income"
  | "assets"
  | "documents"
  | "accounts"
  | "reconcile"
  | "reports"
  | "review"
  | "filing"
  | "txn"
  | "quickbooks"
  | "alerts"
  | "settings";

export interface GuideCopy {
  title: string;
  body: string;
}

/** Map a router pathname to a tab key. Returns null for surfaces with no guide (glossary, onboarding). */
export function tabKeyForPath(pathname: string): TabKey | null {
  if (pathname === "/") return "inbox";
  if (pathname.startsWith("/txn/")) return "txn";
  const seg = pathname.split("/").filter(Boolean)[0];
  switch (seg) {
    case "dashboard":
      return "dashboard";
    case "income":
      return "income";
    case "assets":
      return "assets";
    case "documents":
      return "documents";
    case "accounts":
      return "accounts";
    case "reconcile":
      return "reconcile";
    case "reports":
      return "reports";
    case "review":
      return "review";
    case "filing":
      return "filing";
    case "quickbooks":
      return "quickbooks";
    case "notifications":
      return "alerts";
    case "settings":
      return "settings";
    default:
      return null;
  }
}

const items = (n: number) => `${n} ${n === 1 ? "item" : "items"}`;

/** The guide copy for a tab given the current progress (may be undefined while it loads). */
export function tabGuide(tab: TabKey, p?: Progress): GuideCopy {
  const hasData = !!p && p.imported.transactions > 0;
  const needs = p?.needs_review ?? 0;
  const undated = p?.undated ?? 0;

  switch (tab) {
    case "inbox":
      if (!hasData)
        return {
          title: "Your review queue",
          body: "Nothing here yet. Once you import a statement (Accounts), anything Quillo isn't confident about lands here for a quick look. Items only appear when the AI wasn't sure.",
        };
      if (needs > 0)
        return {
          title: `${items(needs)} to review`,
          body: "Quillo wasn't sure on these. Tap one, confirm or change the category, and it's done. This is the main thing left before you can lodge.",
        };
      return {
        title: "All caught up",
        body: "Nothing to review — your numbers are ready in Dashboard, Reports and File. There's no extra 'process' step; categorising happened on import.",
      };

    case "dashboard":
      if (!hasData)
        return {
          title: "Your live tax position",
          body: "Import a statement from Accounts and your position appears here automatically — nothing to 'generate.'",
        };
      return {
        title: "Your live tax position",
        body: "Your FY position across PAYG, company and property, updating as you confirm items. Suggested deductions and your FY checklist live here too — accept or dismiss them, then re-check File.",
      };

    case "income":
      if (!hasData)
        return {
          title: "Record your income",
          body: "Add what you earned this FY — salary, rent, interest, dividends — or upload a payslip/statement in Documents and Quillo fills it in. Income is one half of your position; deductions are the other.",
        };
      return {
        title: "Your income for the year",
        body: "Add any income that isn't already here. If a salary or rent deposit also appears as a bank line, use 'Link (count once)' so it isn't double-counted. Use the arrows to switch financial year.",
      };

    case "assets":
      return {
        title: "Capital assets & depreciation",
        body: "Add assets you depreciate — equipment, a rental's plant, capital works. No assets? Skip this. Quillo computes the decline-in-value deduction every year automatically; click an asset to see its schedule.",
      };

    case "documents":
      return {
        title: "Your document shelf",
        body: "Upload supporting docs — payslips, rental summaries, dividend statements, a depreciation schedule. Quillo reads each, files it, and routes it (a payslip becomes income; a QS schedule becomes assets). Kept for 5 years.",
      };

    case "accounts":
      if (!p || p.imported.statements === 0)
        return {
          title: "Start here",
          body: "Add an account, then upload a CSV or PDF statement — Quillo reads and categorises every line automatically. A QuickBooks-synced account shouldn't get statement uploads (it would double-count).",
        };
      return {
        title: "Your statements are in",
        body: "They're already categorised — green 'balanced' means the import is complete and reconciled. There's no 'process' button; categorising happened on import. Next: clear any flagged items in Inbox.",
      };

    case "reconcile":
      if (!p || p.unreconciled_receipts === 0)
        return {
          title: "Optional: match receipts",
          body: "This matches receipts against bank lines for evidence. If you only import statements, you can skip this entirely. Add receipts (snap or email them) if you want proof attached to a deduction.",
        };
      return {
        title: "Match receipts to bank lines",
        body: "Match each receipt to its bank line so the deduction has evidence. Quillo suggests likely matches — confirm them, or link manually. Anything left here is just optional evidence, not a blocker.",
      };

    case "reports":
      return {
        title: "Export for your tax agent",
        body: `Pick the financial year and download the CSV for your agent — this is the export.${
          undated > 0 ? ` ${items(undated)} are undated; open each and set a date so they're included.` : ""
        }`,
      };

    case "review":
      if (!hasData)
        return {
          title: "Confirm what's deductible",
          body: "Import statements first. This is where you confirm which categories are actually deductible before you lodge — a registered tax agent has the final say.",
        };
      return {
        title: "Confirm what's deductible",
        body: "For each category, tell Quillo: fully deductible, not deductible, or part-business (enter a %). 'Still to review' at the top is your remaining work; clearing it locks in your deductible total.",
      };

    case "filing":
      if (needs > 0 || undated > 0)
        return {
          title: "Nearly lodge-ready",
          body: `A few items to clear first${
            needs > 0 ? ` — ${items(needs)} to review` : ""
          }${undated > 0 ? `${needs > 0 ? "," : " —"} ${items(undated)} to date` : ""}. Sort those, then this page is your year-end position to print or export. Always confirm with a registered tax agent before lodging.`,
        };
      return {
        title: "Your year-end position",
        body: "Everything you've captured, pulled together. Review the findings, print or download the CSV, and hand it to your agent. Quillo never lodges, never moves your money — always confirm with a registered tax agent.",
      };

    case "txn":
      return {
        title: "Confirm one item",
        body: "Check Quillo's category and confirm or change it — your correction teaches it for next time. If the date's missing, set it so the item lands in a financial year. A company expense not on a bank feed can be pushed to QuickBooks.",
      };

    case "quickbooks":
      return {
        title: "Optional: connect QuickBooks",
        body: "Connect read-only to reconcile company expenses against your QuickBooks bank feed. Quillo never posts, lodges, or moves anything — you stay in control, and you can disconnect any time.",
      };

    case "alerts":
      return {
        title: "Things needing attention",
        body: "Quillo flags items here — usually a few to review or date. Clearing these is how you get to 'ready to lodge.'",
      };

    case "settings":
      return {
        title: "Consent, privacy & data",
        body: "Manage your AI-processing consent, privacy and data here — including withdrawing consent or deleting your data.",
      };
  }
}
