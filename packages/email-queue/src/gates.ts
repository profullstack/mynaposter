/**
 * Send-time policy gates shared by queueEmail, queuedDelivery, and the worker.
 * Each returns a machine-readable code so callers can branch without parsing text.
 */

export type EmailKind = "transactional" | "bulk" | "marketing";

export type EmailGateCode =
  | "RECIPIENT_SUPPRESSED"
  | "BULK_LIST_UNSUBSCRIBE_MISSING"
  | "BULK_ONE_CLICK_MISSING"
  | "BULK_POSTAL_ADDRESS_NOT_CONFIGURED"
  | "BULK_POSTAL_ADDRESS_MISSING"
  | "BULK_GMAIL_FORBIDDEN"
  | "SENDER_UNAUTHORIZED"
  | "SENDER_BLOCKED"
  | "SENDER_PAUSED"
  | "QUOTA_EXHAUSTED"
  | "IDEMPOTENCY_KEY_REQUIRED"
  | "CONFIG_INVALID";

/** Thrown by the asynchronous API (`queueEmail`) when a gate refuses a message. */
export class EmailQueueError extends Error {
  constructor(readonly code: EmailGateCode, message: string) {
    super(message);
    this.name = "EmailQueueError";
  }
}

/** Bulk and marketing mail share every compliance requirement. */
export function isBulkKind(kind: string | undefined): boolean {
  return kind === "bulk" || kind === "marketing";
}

/**
 * The provider-agnostic suppression key: the bare address, trimmed and
 * lower-cased. Plus-tags and Gmail dots are deliberately NOT folded; those are
 * different mailboxes as far as the recipient's consent is concerned.
 */
export function normalizeRecipient(value: string): string {
  return (/<([^>]+)>/.exec(value)?.[1] ?? value).trim().toLowerCase();
}

export function recipientDomain(value: string): string {
  const address = normalizeRecipient(value);
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1) : "";
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && typeof value === "string") return value;
  }
  return undefined;
}

const collapse = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

/** True when `body` contains `address`, ignoring case and whitespace/line breaks. */
export function containsPostalAddress(body: string, address: string, html = false): boolean {
  const wanted = collapse(address);
  if (!wanted) return false;
  return collapse(html ? htmlToText(body) : body).includes(wanted);
}

export interface BulkGateMessage {
  text: string;
  html?: string;
  headers?: Record<string, string>;
}

/**
 * RFC 8058 one-click + CAN-SPAM postal address. Returns the first failing gate,
 * or undefined when the message may be sent as bulk/marketing mail.
 */
export function bulkComplianceFailure(
  message: BulkGateMessage,
  postalAddress: string | undefined,
  options: { headersOnly?: boolean } = {},
): { code: EmailGateCode; error: string } | undefined {
  const listUnsubscribe = headerValue(message.headers, "List-Unsubscribe")?.trim();
  if (!listUnsubscribe || !/<\s*https:\/\/[^>\s]+\s*>/i.test(listUnsubscribe)) {
    return {
      code: "BULK_LIST_UNSUBSCRIBE_MISSING",
      error: "Bulk/marketing email requires a List-Unsubscribe header with an https one-click URL (RFC 8058).",
    };
  }
  const post = headerValue(message.headers, "List-Unsubscribe-Post")?.trim();
  if (post !== "List-Unsubscribe=One-Click") {
    return {
      code: "BULK_ONE_CLICK_MISSING",
      error: "Bulk/marketing email requires the header List-Unsubscribe-Post: List-Unsubscribe=One-Click.",
    };
  }
  if (options.headersOnly) return undefined;
  if (!postalAddress?.trim()) {
    return {
      code: "BULK_POSTAL_ADDRESS_NOT_CONFIGURED",
      error: "Bulk/marketing email requires the postalAddress option (the sender's physical postal address).",
    };
  }
  if (!containsPostalAddress(message.text ?? "", postalAddress) || (message.html && !containsPostalAddress(message.html, postalAddress, true))) {
    return {
      code: "BULK_POSTAL_ADDRESS_MISSING",
      error: "Bulk/marketing email must include the configured postal address in both the text and HTML bodies.",
    };
  }
  return undefined;
}

/** Parses an RFC 3463 enhanced status code (e.g. 5.7.1) from provider text. */
export function enhancedStatusOf(text: string | undefined): string | undefined {
  return /\b([245])\.(\d{1,3})\.(\d{1,3})\b/.exec(text ?? "")?.slice(1, 4).join(".");
}

export interface FailureLike {
  ok: boolean;
  status?: number;
  error?: string;
  enhancedStatus?: string;
}

const ACCOUNT_FAILURE = /suspend|account (?:has been |is )?(?:disabled|blocked|banned|locked|restricted|deactivated|closed)|api key is invalid|invalid api key|api key (?:not found|revoked|expired)|unauthori[sz]ed/i;
const DOMAIN_FAILURE = /domain (?:is )?not verified|not (?:a )?verified (?:domain|sender)|unverified (?:domain|sender)|verify (?:a |your )?domain|only send testing emails/i;
const SMTP_AUTH_CODES = new Set([530, 534, 535, 538]);
const SMTP_NO_SUCH_USER = new Set(["5.1.1", "5.1.10", "5.1.2"]);

/**
 * Failures that mean "this sender or account must stop", not "this message failed":
 * any 401/403, account suspended, sending domain unverified, SMTP auth (530/534/535/538),
 * and any SMTP 5.7.x security/policy refusal. The caller pauses; it never reroutes.
 * `scope: "account"` additionally pauses every identity on the same provider credential.
 */
export function classifyProviderFailure(
  result: FailureLike,
  senderType: string,
): { scope: "account" | "sender"; reason: string } | undefined {
  if (result.ok || !result.status) return undefined;
  const text = result.error ?? "";
  const label = senderType === "smtp" ? "SMTP" : senderType === "resend" ? "Resend" : senderType;
  if (ACCOUNT_FAILURE.test(text) || result.status === 401) {
    return { scope: "account", reason: `${label} rejected the account credentials or reported the account suspended (${result.status}); provider paused for administrator review. Do not reroute to another sender.` };
  }
  if (DOMAIN_FAILURE.test(text)) {
    return { scope: "sender", reason: `${label} reported the sending domain or sender unverified (${result.status}); sender paused for administrator review.` };
  }
  if (result.status === 403) {
    return { scope: "sender", reason: `${label} refused the sender (403); sender paused for administrator review. Do not reroute to another sender.` };
  }
  if (senderType === "smtp") {
    const enhanced = result.enhancedStatus ?? enhancedStatusOf(text);
    if (SMTP_AUTH_CODES.has(result.status)) {
      return { scope: "sender", reason: `SMTP authentication failed (${result.status}${enhanced ? ` ${enhanced}` : ""}); mailbox paused for administrator review.` };
    }
    if (enhanced?.startsWith("5.7.")) {
      return { scope: "sender", reason: `SMTP security/policy refusal (${result.status} ${enhanced}); mailbox paused for administrator review. Do not reroute to another sender.` };
    }
  }
  return undefined;
}

/** A permanent per-recipient refusal (no such mailbox) that should suppress the recipient everywhere. */
export function isHardRecipientFailure(result: FailureLike, senderType: string): boolean {
  if (result.ok || senderType !== "smtp") return false;
  if (result.status !== 550 && result.status !== 551 && result.status !== 553) return false;
  const enhanced = result.enhancedStatus ?? enhancedStatusOf(result.error);
  return Boolean(enhanced && SMTP_NO_SUCH_USER.has(enhanced));
}
