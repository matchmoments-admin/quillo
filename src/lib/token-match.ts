// Word-boundary (token) matching for rule-pack pattern lists — PURE, no I/O.
//
// Rule-pack lists (claimability `merchant_hint`, payg_deductibility `match` / `unless`) are
// comma-separated PATTERNS matched case-insensitively against a merchant string (or
// `${ato_label} ${merchant}`). They used to be raw substrings, which misfired badly (#551,
// docs/first-timer/relevance-scan.md D1/D2): 'ama' matched AMAZON, 'tal' matched TOTAL TOOLS /
// hospital / digital, 'pub' matched PUBLIC TRANSPORT VICTORIA, 'bar' matched BARBEQUES GALORE.
//
// Semantics of one pattern:
//  - It must start and end on a word boundary. A word character is a LETTER; digits, spaces and
//    punctuation are boundaries, so bank descriptors like 'WOOLWORTHS1234' or 'SQ *CAFE' still hit.
//  - Multi-word / punctuated patterns work as phrases ('mitre 10', 'h&r block', 'health:allied',
//    'income-protection'); runs of whitespace are collapsed on both sides before matching.
//  - A simple plural is tolerated at the end ('restaurant' hits 'RESTAURANTS', 'bar' hits 'BARS').
//  - A trailing '*' makes it an explicit PREFIX/stem ('physiotherap*' hits 'PHYSIOTHERAPY'), so a
//    stem is visible and deliberate in the rule pack rather than an accident of substring matching.

const LETTER = /\p{L}/u;
const isWordChar = (c: string | undefined): boolean => !!c && LETTER.test(c);

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ");

/** Does one pattern (already lower-cased / trimmed) hit the normalised haystack on word boundaries? */
export function patternHits(pattern: string, haystack: string): boolean {
  let p = norm(pattern).trim();
  const prefix = p.endsWith("*");
  if (prefix) p = p.slice(0, -1).trimEnd();
  if (!p) return false;
  const needLeft = isWordChar(p[0]);
  const needRight = !prefix && isWordChar(p[p.length - 1]);
  for (let i = haystack.indexOf(p); i !== -1; i = haystack.indexOf(p, i + 1)) {
    if (needLeft && isWordChar(haystack[i - 1])) continue;
    if (!needRight) return true;
    const end = i + p.length;
    if (!isWordChar(haystack[end])) return true;
    // tolerated plural: pattern + 's' / 'es', then a boundary
    if (haystack[end] === "s" && !isWordChar(haystack[end + 1])) return true;
    if (haystack.startsWith("es", end) && !isWordChar(haystack[end + 2])) return true;
  }
  return false;
}

/** True when ANY comma-separated pattern in `list` hits `haystack` on word boundaries. */
export function anyPatternHits(list: string | null | undefined, haystack: string | null | undefined): boolean {
  if (!list || !haystack) return false;
  const h = norm(haystack);
  return list.split(",").some((p) => patternHits(p, h));
}
