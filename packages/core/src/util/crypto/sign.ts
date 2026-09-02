/** OAuth 1.0a request signing (Tumblr) and HS256 JWTs (Ghost). */
import { createHmac, randomBytes } from "node:crypto";

/** RFC 3986, which differs from encodeURIComponent on !*'() */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
}

/**
 * Build the `Authorization: OAuth …` header for a request.
 * `params` must include every form field when the body is form-encoded — the
 * signature covers them, and leaving one out is the usual cause of a 401.
 */
export function oauth1Header(
  method: string,
  url: string,
  params: Record<string, string>,
  creds: OAuth1Credentials,
): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.token,
    oauth_version: "1.0",
  };

  const target = new URL(url);
  const all: Record<string, string> = { ...oauthParams, ...params };
  for (const [key, value] of target.searchParams) all[key] = value;
  target.search = "";

  const normalized = Object.keys(all)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(all[key])}`)
    .join("&");

  const base = [method.toUpperCase(), percentEncode(target.toString()), percentEncode(normalized)].join("&");
  const signingKey = `${percentEncode(creds.consumerSecret)}&${percentEncode(creds.tokenSecret)}`;
  const signature = createHmac("sha1", signingKey).update(base).digest("base64");

  const header: Record<string, string> = { ...oauthParams, oauth_signature: signature };
  return `OAuth ${Object.keys(header)
    .sort()
    .map((key) => `${percentEncode(key)}="${percentEncode(header[key])}"`)
    .join(", ")}`;
}

const base64url = (input: Buffer | string): string =>
  Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Ghost admin keys are `id:hexSecret` and want a short-lived HS256 token. */
export function ghostToken(adminApiKey: string): string {
  const [id, secret] = adminApiKey.split(":");
  if (!id || !secret) throw new Error("Ghost admin API key must look like `id:secret`");
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT", kid: id }));
  const payload = base64url(JSON.stringify({ iat: now, exp: now + 300, aud: "/admin/" }));
  const signature = createHmac("sha256", Buffer.from(secret, "hex")).update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${base64url(signature)}`;
}
