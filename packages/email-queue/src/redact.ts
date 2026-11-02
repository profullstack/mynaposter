/**
 * Provider error text is stored in Redis job receipts and in the PostgreSQL
 * audit. It routinely echoes recipient addresses, signed URLs, and sometimes
 * the credential that was rejected. Everything persisted goes through here.
 */
const MAX_STORED_ERROR = 300;

const PATTERNS: Array<[RegExp, string | ((match: string, ...groups: string[]) => string)]> = [
  // Authorization headers and bearer tokens.
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 [redacted]"],
  // key=value / key: value secrets.
  [/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|pass|pwd|auth|signature|sig)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&"']+)/gi, "$1$2[redacted]"],
  // URLs: keep scheme, host and path; drop the query string and fragment.
  [/\b(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, "$1?[redacted]"],
  // Email addresses (including inside <...>).
  [/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/g, "[email]"],
  // Provider key prefixes (Resend re_, SendGrid SG., Stripe-style sk_/pk_, GitHub ghp_ etc.).
  [/\b(?:re|sk|pk|rk|whsec|ghp|gho|xox[abpr])_[A-Za-z0-9_-]{8,}/g, "[key]"],
  [/\bSG\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[key]"],
  // JWTs.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "[token]"],
  // Long opaque hex/base64 runs.
  [/\b[A-Fa-f0-9]{32,}\b/g, "[token]"],
  [/(?<![A-Za-z0-9])[A-Za-z0-9+/_-]{40,}={0,2}/g, "[token]"],
];

/** Removes addresses, credentials, and query strings; caps the length. Never throws. */
export function redactError(input: unknown, max = MAX_STORED_ERROR): string {
  let text: string;
  try {
    text = input instanceof Error ? `${input.name}: ${input.message}` : typeof input === "string" ? input : String(input);
  } catch {
    text = "Unprintable error";
  }
  for (const [pattern, replacement] of PATTERNS) {
    text = text.replace(pattern, replacement as string);
  }
  text = text.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
