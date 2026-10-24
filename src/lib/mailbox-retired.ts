import type { Env } from "../env";
import { featureOn } from "./features";

// The receipt mailbox (receipts+<tenant>@) is retired (owner decision 2026-10-24, map #692; #711 closed as
// not planned): in-app upload is simpler and most data arrives by bank feed. Flag `mailbox_retired` ON ⇒
// the Worker's email() handler bounces every inbound message before it parses the MIME, resolves a tenant
// or touches R2/D1/the DO. OFF ⇒ the handler runs exactly as before. The ingest code, the tenants'
// email_localpart column and every stored email-sourced row are kept, so the retirement is one flag away
// from undone.

/** The bounce the sender sees. Plain language, says where receipts go instead. */
export const MAILBOX_RETIRED_REJECT =
  "This Quillo address no longer accepts email. Upload receipts and documents in the Quillo app instead.";

/** The narrow surface of ForwardableEmailMessage this guard uses, so it runs under node in the unit suite. */
export interface RejectableMessage {
  readonly rawSize: number;
  setReject(reason: string): void;
}

/**
 * True when the mailbox is retired and the message was refused (the caller returns at once). Logs one
 * line with the byte size only: never the sender, the recipient, the subject or the body.
 */
export function refuseRetiredMailbox(env: Env, message: RejectableMessage): boolean {
  if (!featureOn(env, "mailbox_retired")) return false;
  console.log(`email refused: mailbox retired (bytes=${message.rawSize})`);
  message.setReject(MAILBOX_RETIRED_REJECT);
  return true;
}
