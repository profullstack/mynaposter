/**
 * AWS Signature Version 4, by hand, for the one request Amazon SES needs.
 *
 * The aws-sdk is several megabytes to sign a POST; this is the algorithm from
 * the AWS reference, checked in the tests against AWS's own published
 * example (the signing key for 20120215/us-east-1/iam and the get-vanilla
 * request from the SigV4 test suite).
 */
import { createHash, createHmac } from "node:crypto";

export interface SigV4Request {
  method: string;
  host: string;
  /** The path, already URI-encoded as it goes on the wire. */
  path: string;
  /** The query string without `?`, or empty. */
  query?: string;
  headers: Record<string, string>;
  body: string;
}

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const hmac = (key: Buffer | string, value: string): Buffer => createHmac("sha256", key).update(value, "utf8").digest();

/** 20150830T123600Z and 20150830 for a date. */
export function amzDates(date: Date): { amzDate: string; day: string } {
  const amzDate = date.toISOString().replace(/[:-]/g, "").replace(/\.\d{3}/, "");
  return { amzDate, day: amzDate.slice(0, 8) };
}

export function signingKey(secret: string, day: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), service), "aws4_request");
}

function canonicalQuery(query: string): string {
  if (!query) return "";
  return query
    .split("&")
    .filter(Boolean)
    .map((pair) => {
      const [key = "", value = ""] = pair.split("=");
      return [key, value] as const;
    })
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

/**
 * The headers to send: the request's own plus host, x-amz-date and the
 * Authorization header. Every header passed in is signed.
 */
export function signV4(
  request: SigV4Request,
  credentials: SigV4Credentials,
  region: string,
  service: string,
  date: Date,
): Record<string, string> {
  const { amzDate, day } = amzDates(date);
  const headers: Record<string, string> = { ...request.headers, host: request.host, "x-amz-date": amzDate };
  if (credentials.sessionToken) headers["x-amz-security-token"] = credentials.sessionToken;
  const names = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const lower: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) lower[name.toLowerCase()] = String(value).trim().replace(/\s+/g, " ");
  const signedHeaders = names.join(";");
  const canonical = [
    request.method.toUpperCase(),
    request.path || "/",
    canonicalQuery(request.query ?? ""),
    names.map((name) => `${name}:${lower[name]}\n`).join(""),
    signedHeaders,
    sha256(request.body),
  ].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const signature = createHmac("sha256", signingKey(credentials.secretAccessKey, day, region, service)).update(toSign, "utf8").digest("hex");
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
