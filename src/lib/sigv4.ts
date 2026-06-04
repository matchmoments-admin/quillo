// Minimal AWS Signature V4 signer using WebCrypto — enough to sign a Bedrock InvokeModel POST from
// a Cloudflare Worker WITHOUT pulling @aws-sdk/* (which doesn't bundle into workerd). Implements the
// canonical-request → string-to-sign → signing-key → signature chain from the AWS SigV4 spec.

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * Sign a Bedrock runtime InvokeModel request. `modelId` may be an inference-profile id containing
 * ':' (e.g. `au.anthropic.claude-haiku-4-5-...-v1:0`) — it's percent-encoded into the canonical URI.
 * `now` is injectable for deterministic tests.
 */
export async function signBedrockInvoke(opts: {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  modelId: string;
  body: string;
  now?: Date;
}): Promise<SignedRequest> {
  const { region, accessKeyId, secretAccessKey, modelId, body } = opts;
  const service = "bedrock";
  const host = `bedrock-runtime.${region}.amazonaws.com`;
  // AWS SigV4 convention (matches @smithy/signature-v4): send the LITERAL path on the wire, but sign
  // the URI-ENCODED path in the canonical request. The server re-encodes the received path before
  // verifying, so encoding both would double-encode the model-id colon (%3A → %253A) → 403.
  const wirePath = `/model/${modelId}/invoke`;
  const canonicalPath = `/model/${encodeURIComponent(modelId)}/invoke`; // ':' → %3A, '.' stays
  const url = `https://${host}${wirePath}`;

  const now = opts.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = await sha256Hex(body);
  const canonicalHeaders =
    `content-type:application/json\n` +
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = ["POST", canonicalPath, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");

  const kDate = await hmac(enc.encode(`AWS4${secretAccessKey}`), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = hex(await hmac(kSigning, stringToSign));

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url,
    headers: {
      "content-type": "application/json",
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
      authorization,
    },
    body,
  };
}
