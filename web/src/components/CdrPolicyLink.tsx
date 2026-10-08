// Fiskil's CDR policy link (CDR Rules r7.2(8); r1.10AA(4)(f)). As Fiskil's CDR representative, Quillo
// adopts Fiskil's CDR policy rather than writing its own, and must make it readily available on every
// online surface where it deals with CDR consumers: the Connect page bank section, Settings › Bank
// connections and the app footer. See docs/security/control-matrix.md (row "r7.2(8)").
//
// Everything here sits behind `bank_feed_cdr`, the same flag as the bank UI: flag OFF ⇒ nothing renders.

import { useFeatures } from "../lib/features";

export const FISKIL_CDR_POLICY_URL = "https://www.fiskil.com/legal/cdr-policy";

const LINK_CLASS = "text-ink underline underline-offset-2";

/** The bare link, for places that already gate on `bank_feed_cdr`. */
export function CdrPolicyAnchor() {
  return (
    <a href={FISKIL_CDR_POLICY_URL} target="_blank" rel="noreferrer" className={LINK_CLASS}>
      Fiskil's CDR policy
    </a>
  );
}

/** One explanatory sentence for the bank sections (caller gates on `bank_feed_cdr`). */
export function CdrPolicyNote({ className = "text-xs text-muted" }: { className?: string }) {
  return (
    <p className={className}>
      Bank data comes to Quillo under the Consumer Data Right through Fiskil, an accredited data recipient. How it's
      handled is set out in <CdrPolicyAnchor />.
    </p>
  );
}

/** Footer item: " · CDR policy", rendered only while `bank_feed_cdr` is ON. */
export function CdrPolicyFooterLink() {
  const { has } = useFeatures();
  if (!has("bank_feed_cdr")) return null;
  return (
    <>
      {" · "}
      <a href={FISKIL_CDR_POLICY_URL} target="_blank" rel="noreferrer" className={LINK_CLASS}>
        CDR policy
      </a>
    </>
  );
}
