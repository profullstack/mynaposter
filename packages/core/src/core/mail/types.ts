/**
 * The shape every way of sending mail shares.
 *
 * A provider is one door out: an SMTP server, an HTTP API (Resend, Mailgun,
 * Postmark and the rest), or myna cloud sending for you. Whatever the door,
 * a send takes one message and answers {ok, id?, error?, retryable?}, so the
 * callers (`myna email`, the newsletter) never care which one it was.
 *
 * `retryable` is the provider saying "try again later": a 429, a 5xx, a
 * timeout, a quota that resets. A refusal (bad key, unverified sender,
 * invalid address) is not retryable, and trying again changes nothing.
 */

export const MAIL_PROVIDER_TYPES = [
  "resend",
  "mailgun",
  "mandrill",
  "sendgrid",
  "postmark",
  "ses",
  "brevo",
  "sparkpost",
  "mailjet",
  "smtp2go",
  "smtp",
  "myna-cloud",
] as const;

export type MailProviderType = (typeof MAIL_PROVIDER_TYPES)[number];

export interface MailMessage {
  /** `Name <address>` or a bare address. The provider's own `from` when omitted. */
  from?: string;
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  /** Extra headers: List-Unsubscribe, List-Unsubscribe-Post, List-Id, Precedence. */
  headers?: Record<string, string>;
}

export interface MailResult {
  ok: boolean;
  /** The provider's message id, when it gave one. */
  id?: string;
  error?: string;
  /** Worth trying again later: rate limited, the provider is down, a timeout. */
  retryable?: boolean;
  /** The HTTP status (or SMTP reply code) behind the answer. */
  status?: number;
}

/**
 * What a send is for. A newsletter is `bulk`: Postmark puts it on the
 * broadcast stream, SparkPost marks it non-transactional (so its own
 * suppression list applies). A one-off `myna email` is `transactional`.
 */
export type MailKind = "transactional" | "bulk";

/** The non-secret half of a provider, kept in outreach.json. */
export interface MailProviderConfig {
  id: string;
  type: MailProviderType;
  /** The default sender for this provider. */
  from?: string;
  /** Mailgun: the sending domain; the from address's domain when unset. */
  domain?: string;
  /** Mailgun/SendGrid/SparkPost: "us" or "eu". SES: an AWS region. SMTP2GO: us, eu or au. */
  region?: string;
  /** Postmark: the message stream; "outbound" for a single email and "broadcast" for a newsletter when unset. */
  stream?: string;
  /** SES: the access key id. Mailjet: the API key (the secret is the secret key). */
  keyId?: string;
  /** myna-cloud: the myna instance; the signed-in cloud server when unset. */
  server?: string;
}

export interface MailSendOptions {
  kind?: MailKind;
}

/** One provider, ready to send. */
export interface MailSender {
  id: string;
  type: MailProviderType;
  /** The sender used when a message names none. */
  from?: string;
  /** How many messages one API call may carry. 1 means no batch endpoint is used. */
  batchSize: number;
  send(message: MailMessage, options?: MailSendOptions): Promise<MailResult>;
  /** One result per message, in order. Present when batchSize > 1. */
  sendBatch?(messages: MailMessage[], options?: MailSendOptions): Promise<MailResult[]>;
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface ProviderDeps {
  fetch?: Fetch;
  timeoutMs?: number;
  /** The clock, for SigV4 signatures. */
  now?: () => Date;
}
