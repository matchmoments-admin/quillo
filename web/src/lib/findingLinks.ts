import { toJourneyHref } from "./legacyRoutes";

// Where a readiness finding's "fix it" link goes (spec A8: moved out of Filing.tsx so the Check step and
// the Filing page share one mapping). Keyed on the kind of the finding's first evidence ref.
//
// `journey` (ft_journey ON) repoints the link at the journey routes through the ONE legacy → journey table
// (lib/legacyRoutes.ts), and sends missing evidence to Review's documents — where records are added. OFF it
// returns exactly what Filing.tsx always rendered.

export interface FixLink {
  to: string;
  label: string;
}

export function findingFixLinkForKind(kind: string | null | undefined, opts: { journey?: boolean } = {}): FixLink {
  let link: FixLink;
  switch (kind) {
    case "asset": link = { to: "/assets", label: "Review assets" }; break;
    case "income": link = { to: "/income", label: "Review income" }; break;
    // Property records live in Settings → Properties (Income has none — #552 D3).
    case "property": link = { to: "/settings", label: "Review property records" }; break;
    case "document": link = { to: "/inbox", label: "Add evidence" }; break;
    case "transaction":
    default: link = { to: "/inbox", label: "Sort it out" };
  }
  if (!opts.journey) return link;
  if (kind === "document") return { to: "/review#documents", label: link.label };
  return { to: toJourneyHref(link.to), label: link.label };
}

/** The Filing page's form: a full readiness finding. */
export function findingFixLink(f: { evidence_refs: { kind: string }[] }, opts: { journey?: boolean } = {}): FixLink {
  return findingFixLinkForKind(f.evidence_refs[0]?.kind, opts);
}
