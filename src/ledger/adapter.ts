/**
 * Ledger seam. Agent logic ONLY ever calls these methods — it never touches
 * QuickBooks/Xero directly. Swapping the backing product (QBO today; Xero or a
 * unified API later) is choosing a different implementation, not editing the agent.
 */
export interface LedgerExpense {
  txnId: string;
  amountCents: number;
  gstCents: number | null;
  date: string; // ISO
  merchant: string;
  atoLabel: string; // maps to a ledger account
}

export interface LedgerAdapter {
  /** Idempotent: the same txnId must never create a duplicate posting. */
  pushExpense(userId: string, e: LedgerExpense): Promise<{ ledgerRef: string }>;
  /** Cache-first lookup of the ledger account id for an ATO label (avoid metered reads). */
  resolveAccount(userId: string, atoLabel: string): Promise<string>;
}

/** Raised when a tenant has no usable ledger connection yet (e.g. QBO not OAuth-connected). */
export class LedgerNotConnectedError extends Error {
  constructor(public readonly userId: string, message: string) {
    super(message);
    this.name = "LedgerNotConnectedError";
  }
}

/**
 * Raised when the stored credentials are dead and the user must re-authorise (e.g. the QBO
 * refresh token expired after ~100 days, or the bank returned invalid_grant). Distinct from
 * LedgerNotConnectedError so callers can surface a "Reconnect" prompt specifically.
 */
export class LedgerReauthError extends Error {
  constructor(public readonly userId: string, message: string) {
    super(message);
    this.name = "LedgerReauthError";
  }
}
