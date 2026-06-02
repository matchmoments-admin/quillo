import type { Env } from "../env";
import type { LedgerAdapter } from "./adapter";
import { QuickBooksAdapter } from "./qbo";
import { XeroAdapter } from "./xero";

/** Pick the ledger implementation from the tenant's profiles.ledger_provider. */
export function getLedger(env: Env, ledgerProvider: string): LedgerAdapter {
  switch (ledgerProvider) {
    case "qbo":
      return new QuickBooksAdapter(env);
    case "xero":
      return new XeroAdapter(env);
    default:
      throw new Error(`unknown ledger_provider: ${ledgerProvider}`);
  }
}

export { LedgerNotConnectedError, LedgerReauthError } from "./adapter";
export type { LedgerAdapter, LedgerExpense } from "./adapter";
