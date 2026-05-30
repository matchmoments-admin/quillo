import type { Env } from "../env";
import { type LedgerAdapter, type LedgerExpense, LedgerNotConnectedError } from "./adapter";

/**
 * Xero adapter — STUB. Left intentionally unimplemented per the build plan ("build
 * the QuickBooks implementation first; leave a stub Xero implementation").
 *
 * Note when implementing: Xero meters API access from 2 Mar 2026 (tiered + egress
 * at AUD $2.40/GB) — the same egress-aware rules apply: write once, never poll,
 * cache account/tax-code lookups.
 */
export class XeroAdapter implements LedgerAdapter {
  constructor(private env: Env) {}

  async pushExpense(userId: string, _e: LedgerExpense): Promise<{ ledgerRef: string }> {
    void this.env;
    throw new LedgerNotConnectedError(userId, "Xero adapter not implemented yet");
  }

  async resolveAccount(userId: string, _atoLabel: string): Promise<string> {
    throw new LedgerNotConnectedError(userId, "Xero adapter not implemented yet");
  }
}
