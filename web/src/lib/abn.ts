// Australian Business Number (ABN) validation — the official modulus-89 weighted checksum
// (ATO algorithm). Used for non-blocking inline feedback in onboarding/Settings so a
// mistyped ABN is flagged before it becomes the agent's GST-credit context. We warn, not
// hard-fail: a genuinely odd-but-real ABN should never block a user.

const WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];

/** Strip spaces and any non-digits — ABNs are often entered as "12 345 678 901". */
export function normaliseAbn(input: string): string {
  return input.replace(/\D/g, "");
}

/**
 * True iff `input` is a structurally valid 11-digit ABN per the ATO checksum:
 * subtract 1 from the first digit, apply the position weights, and the weighted
 * sum must be divisible by 89. An empty string is treated as "not yet entered"
 * by callers, but here returns false (it isn't a valid ABN).
 */
export function isValidAbn(input: string): boolean {
  const digits = normaliseAbn(input);
  if (digits.length !== 11) return false;
  const nums = digits.split("").map((d) => Number(d));
  nums[0] -= 1;
  const sum = nums.reduce((acc, n, i) => acc + n * WEIGHTS[i], 0);
  return sum % 89 === 0;
}
