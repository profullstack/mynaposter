import type { DeliveryResult, DeliveryTransport, QueuedMessage } from "./index.js";
import { enhancedStatusOf, normalizeRecipient } from "./gates.js";
import { redactError } from "./redact.js";

/** The subset of a nodemailer Transporter this adapter uses. */
export interface SmtpTransporterLike {
  sendMail(mail: Record<string, unknown>): Promise<{ messageId?: string; accepted?: unknown[]; rejected?: unknown[]; response?: string }>;
  verify?(): Promise<unknown>;
  close?(): void;
}

export interface SmtpTransportOptions {
  /** Stable, non-secret identifier for this mailbox credential. */
  id: string;
  host: string;
  /** 465 implicit TLS (secure: true) or 587 STARTTLS submission (secure: false, TLS required). */
  port: number;
  secure: boolean;
  /** The authenticated mailbox. The From address is pinned to it. */
  user: string;
  pass: string;
  /** Display name for the From header. The address is always `user`. */
  fromName?: string;
  /**
   * Mailboxes this process may send as. When set, constructing a transport for
   * any other mailbox throws. OutreachGraph: ["cha0spunk@profullstack.com", "knox@profullstack.com"].
   */
  authorizedSenders?: string[];
  timeoutMs?: number;
  /** Tests inject a fake; production lazily loads nodemailer. */
  createTransport?: (config: Record<string, unknown>) => SmtpTransporterLike;
}

/** Headers a caller may never set: they would change who the message claims to be from. */
const RESERVED_HEADERS = new Set(["from", "sender", "return-path", "reply-to", "to", "cc", "bcc", "subject", "message-id", "date"]);

function formatFrom(address: string, name?: string): string {
  const display = name?.replace(/["\\\r\n<>]/g, "").trim();
  return display ? `"${display}" <${address}>` : address;
}

function displayNameOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(value);
  return match?.[1]?.trim() || undefined;
}

function cleanHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!/^[A-Za-z0-9-]+$/.test(key) || RESERVED_HEADERS.has(key.toLowerCase())) continue;
    out[key] = String(value).replace(/[\r\n]+/g, " ");
  }
  return Object.keys(out).length ? out : undefined;
}

/** Maps a nodemailer error to a DeliveryResult the queue's breaker understands. */
export function smtpFailure(error: unknown): DeliveryResult {
  const e = (error ?? {}) as { responseCode?: unknown; code?: unknown; response?: unknown; message?: unknown; command?: unknown };
  const response = typeof e.response === "string" ? e.response : "";
  const message = typeof e.message === "string" ? e.message : String(error);
  const code = typeof e.code === "string" ? e.code : "";
  let status = typeof e.responseCode === "number" ? e.responseCode : 0;
  if (!status && code === "EAUTH") status = 535;
  const enhanced = enhancedStatusOf(response || message);
  // status 0 = socket-level failure: the message may or may not have been accepted.
  return {
    ok: false,
    status,
    retryable: status >= 400 && status < 500,
    ...(enhanced ? { enhancedStatus: enhanced } : {}),
    error: redactError(`SMTP ${status || code || "connection"}: ${response || message}`, 240),
  };
}

/**
 * SMTP DeliveryTransport for a single authenticated mailbox (nodemailer).
 *
 * - The From address is always the authenticated `user`; a message asking for a
 *   different From is refused locally (400 SENDER_UNAUTHORIZED) before any network I/O.
 * - The envelope sender is the mailbox too, and From/Sender/Return-Path/Reply-To
 *   cannot be smuggled in through `headers`.
 * - Errors carry the SMTP reply code and RFC 3463 enhanced status so the queue
 *   pauses the mailbox on 530/534/535/538 and any 5.7.x, and never reroutes.
 */
export function createSmtpTransport(options: SmtpTransportOptions): DeliveryTransport & { verify(): Promise<void>; close(): void } {
  const user = normalizeRecipient(options.user ?? "");
  if (!options.id?.trim() || !options.host?.trim() || !user.includes("@") || !options.pass) {
    throw new Error("SMTP transport requires a stable id, host, mailbox address as user, and password.");
  }
  if (options.authorizedSenders?.length && !options.authorizedSenders.map(normalizeRecipient).includes(user)) {
    throw new Error(`SMTP mailbox ${user} is not in authorizedSenders; refusing to create a transport for it.`);
  }
  const timeout = options.timeoutMs ?? 20_000;
  const config = {
    host: options.host,
    port: options.port,
    secure: options.secure,
    ...(options.secure ? {} : { requireTLS: true }),
    auth: { user: options.user, pass: options.pass },
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: timeout,
  };
  let transporter: SmtpTransporterLike | undefined;
  const get = async (): Promise<SmtpTransporterLike> => {
    if (transporter) return transporter;
    if (options.createTransport) {
      transporter = options.createTransport(config);
    } else {
      const mod = await import("nodemailer") as unknown as { default?: { createTransport(c: unknown): SmtpTransporterLike }; createTransport?(c: unknown): SmtpTransporterLike };
      const factory = mod.default?.createTransport ?? mod.createTransport;
      if (!factory) throw new Error("nodemailer is not available.");
      transporter = factory.call(mod.default ?? mod, config);
    }
    return transporter;
  };
  const from = formatFrom(user, options.fromName);
  return {
    id: options.id,
    type: "smtp",
    from,
    host: options.host,
    async send(message: QueuedMessage): Promise<DeliveryResult> {
      if (message.from && normalizeRecipient(message.from) !== user) {
        return { ok: false, status: 400, retryable: false, code: "SENDER_UNAUTHORIZED", error: "SMTP transport only sends as its authenticated mailbox; the requested From differs." };
      }
      const to = Array.isArray(message.to) ? message.to : [message.to];
      if (to.length !== 1 || !to[0]?.includes("@")) {
        return { ok: false, status: 400, retryable: false, error: "SMTP transport sends exactly one recipient per message." };
      }
      const headers = cleanHeaders(message.headers);
      try {
        const info = await (await get()).sendMail({
          from: formatFrom(user, displayNameOf(message.from) ?? options.fromName),
          envelope: { from: user, to },
          to,
          subject: message.subject,
          text: message.text,
          ...(message.html ? { html: message.html } : {}),
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
          ...(headers ? { headers } : {}),
        });
        if (Array.isArray(info.rejected) && info.rejected.length) {
          const enhanced = enhancedStatusOf(info.response);
          return { ok: false, status: 550, retryable: false, ...(enhanced ? { enhancedStatus: enhanced } : {}), error: redactError(`SMTP 550: recipient rejected ${info.response ?? ""}`, 240) };
        }
        const id = typeof info.messageId === "string" ? info.messageId : undefined;
        return { ok: true, status: 250, ...(id ? { id, rfcMessageId: id } : {}) };
      } catch (error) {
        return smtpFailure(error);
      }
    },
    async verify() {
      const t = await get();
      try { await t.verify?.(); }
      catch (error) { throw new Error(smtpFailure(error).error); }
    },
    close() { transporter?.close?.(); },
  };
}
