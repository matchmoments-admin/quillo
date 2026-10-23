// Client-side mirror of the Worker's upload ceilings (src/lib/upload-limits.ts, #713). The Worker is the
// enforcement point (it answers 413 with the same message); checking here as well means an oversized file is
// refused at once instead of after a long upload. scripts/check-units.ts fails if these numbers or the
// message wording drift from the server module.

const MB = 1024 * 1024;

export const UPLOAD_LIMITS = {
  receipt: 20 * MB,
  receiptTotal: 40 * MB,
  document: 25 * MB,
  statement: 25 * MB,
  statementCsv: 5 * MB, // a CSV this size is already ~60k rows; a personal year is a few thousand (#746)
  capital: 10 * MB,
} as const;

export type UploadKind = keyof typeof UPLOAD_LIMITS;

const LABEL: Record<UploadKind, string> = {
  receipt: "receipt",
  receiptTotal: "set of receipt images",
  document: "document",
  statement: "statement",
  statementCsv: "CSV statement",
  capital: "import file",
};

export function tooLargeMessage(kind: UploadKind): string {
  const max = `${Math.round(UPLOAD_LIMITS[kind] / MB)} MB`;
  const hint =
    kind === "statement"
      ? " Split it into shorter date ranges, or download it as CSV instead of PDF."
      : kind === "statementCsv"
        ? " A year of personal banking is usually far smaller. Split it into shorter date ranges, one account per file."
      : kind === "receiptTotal"
        ? " Upload fewer images at once."
        : " Try a smaller photo or scan, or split the file.";
  return `That ${LABEL[kind]} is too large (the limit is ${max}).${hint}`;
}

/** Throws the user-facing message when `size` bytes is over the ceiling for `kind`. */
export function assertUploadSize(size: number, kind: UploadKind): void {
  if (size > UPLOAD_LIMITS[kind]) throw new Error(tooLargeMessage(kind));
}
