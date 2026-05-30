import PostalMime from "postal-mime";

export interface ParsedAttachment {
  bytes: ArrayBuffer;
  mime: string;
  filename: string | null;
}

export interface ParsedEmail {
  attachments: ParsedAttachment[];
  text: string;       // plaintext body (fallback "receipt" when no attachments)
  localpart: string;  // the part of the recipient before @, e.g. "receipts+me"
}

/**
 * Parse a Cloudflare Email Routing message.
 *
 * Fixes review finding H1: the plan's `iterateAttachments(message)` does not exist
 * on ForwardableEmailMessage. The supported path is PostalMime over `message.raw`.
 */
export async function parseEmail(message: ForwardableEmailMessage): Promise<ParsedEmail> {
  const email = await PostalMime.parse(message.raw);
  const attachments: ParsedAttachment[] = (email.attachments ?? []).map((att) => ({
    bytes: toArrayBuffer(att.content as string | ArrayBuffer | Uint8Array),
    mime: att.mimeType ?? "application/octet-stream",
    filename: att.filename ?? null,
  }));
  return {
    attachments,
    text: (email.text ?? "").trim(),
    localpart: (message.to.split("@")[0] ?? "").toLowerCase(),
  };
}

function toArrayBuffer(content: string | ArrayBuffer | Uint8Array): ArrayBuffer {
  if (typeof content === "string") {
    const u8 = new TextEncoder().encode(content);
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
  }
  if (content instanceof Uint8Array) {
    return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
  }
  return content;
}
