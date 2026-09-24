/**
 * Every mail provider myna can send through, over its own HTTP API.
 *
 * Each one is a small function from (config, secret) to a MailSender. They
 * share one rule for failures: a 429 or a 5xx, a timeout or a dropped
 * connection is `retryable`; anything else the provider refused is not.
 * Where an API answers 200 with a failure inside (Mandrill, Mailjet,
 * SMTP2GO, Postmark's ErrorCode, SparkPost's rejected count), the failure
 * inside wins.
 *
 * Every provider passes the message's own headers through, so a newsletter's
 * List-Unsubscribe and List-Unsubscribe-Post (RFC 8058) reach the mailbox
 * whichever door it left by. Where each API puts them:
 *   Resend      headers {}                  Mailgun    h:<Name> form fields
 *   Mandrill    message.headers {}          SendGrid   headers {}
 *   Postmark    Headers [{Name, Value}]     SES v2     Content.Simple.Headers [{Name, Value}] (max 15)
 *   Brevo       headers {}                  SparkPost  content.headers {}
 *   Mailjet     Headers {}                  SMTP2GO    custom_headers [{header, value}]
 */
import { randomBytes } from "node:crypto";
import { addressOf, sendSmtp, SmtpError, type SmtpOptions, type SmtpServer } from "../smtp.ts";
import { signV4 } from "./sigv4.ts";
import type { Fetch, MailKind, MailMessage, MailProviderConfig, MailResult, MailSender, MailSendOptions, ProviderDeps } from "./types.ts";

// ---------------------------------------------------------------- shared

/** `Name <a@b>` split into its parts; a bare address has no name. */
export function parseAddress(value: string): { email: string; name?: string } {
  const email = addressOf(value);
  const name = value.includes("<") ? value.slice(0, value.indexOf("<")).trim().replace(/^"|"$/g, "") : "";
  return name ? { email, name } : { email };
}

const recipients = (to: string | string[]): string[] => (Array.isArray(to) ? to : [to]).map((entry) => entry.trim()).filter(Boolean);

/** 429 and every 5xx are worth another go later; 408 too (the request timed out on their side). */
export function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

interface HttpAnswer {
  status: number;
  ok: boolean;
  body: unknown;
  text: string;
  headers: Headers;
}

/** One HTTP call that never throws: a network failure comes back as status 0. */
async function call(deps: ProviderDeps, url: string, init: RequestInit): Promise<HttpAnswer | { status: 0; error: string }> {
  const fetcher: Fetch = deps.fetch ?? ((input, options) => fetch(input, options));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 30_000);
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal });
    const text = await response.text().catch(() => "");
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: response.status, ok: response.ok, body, text, headers: response.headers };
  } catch (error) {
    const reason = (error as Error).name === "AbortError" ? `no answer in ${(deps.timeoutMs ?? 30_000) / 1000}s` : (error as Error).message;
    return { status: 0, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

/** The provider's own words for a failure, from whatever shape it answered in. */
export function errorWords(body: unknown, text: string): string {
  const pick = (value: unknown): string | undefined => {
    if (typeof value === "string" && value) return value;
    if (Array.isArray(value)) return value.map(pick).filter(Boolean).join("; ") || undefined;
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      for (const key of ["message", "Message", "ErrorMessage", "description", "error", "detail", "name"]) {
        const found = pick(record[key]);
        if (found) return found;
      }
    }
    return undefined;
  };
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    for (const key of ["message", "Message", "error", "errors", "ErrorMessage", "detail"]) {
      const found = pick(record[key]);
      if (found) return found;
    }
  }
  return text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

/** The shared failure for a non-2xx answer or a dropped connection. */
function failure(provider: string, answer: HttpAnswer | { status: 0; error: string }): MailResult {
  if (answer.status === 0) return { ok: false, retryable: true, status: 0, error: `${provider}: ${(answer as { error: string }).error}` };
  const words = errorWords((answer as HttpAnswer).body, (answer as HttpAnswer).text);
  return { ok: false, status: answer.status, retryable: retryableStatus(answer.status), error: `${provider} ${answer.status}${words ? `: ${words}` : ""}` };
}

const isHttp = (answer: HttpAnswer | { status: 0; error: string }): answer is HttpAnswer => answer.status !== 0;

const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
const withHeaders = (init: RequestInit, headers: Record<string, string>): RequestInit => ({ ...init, headers: { ...(init.headers as Record<string, string>), ...headers } });

/** RFC 2047 for a subject with anything outside ASCII (SES wants 7-bit). */
const encodeWord = (value: string): string => (/^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`);

const escapeHtml = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

interface Prepared {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  headers: Record<string, string>;
}

function prepare(message: MailMessage, fallbackFrom: string | undefined, provider: string): Prepared {
  const from = message.from ?? fallbackFrom;
  if (!from) throw new Error(`${provider}: no sender. Give the provider one (--from) or pass from on the message.`);
  const to = recipients(message.to);
  if (!to.length) throw new Error(`${provider}: no recipient.`);
  return {
    from,
    to,
    subject: message.subject,
    text: message.text,
    ...(message.html ? { html: message.html } : {}),
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    headers: { ...(message.headers ?? {}) },
  };
}

/** A send that turns a thrown precondition into a failed result, so callers get one shape. */
function guarded(send: (message: MailMessage, options: MailSendOptions) => Promise<MailResult>) {
  return async (message: MailMessage, options: MailSendOptions = {}): Promise<MailResult> => {
    try {
      return await send(message, options);
    } catch (error) {
      return { ok: false, retryable: false, error: (error as Error).message };
    }
  };
}

function guardedBatch(send: (messages: MailMessage[], options: MailSendOptions) => Promise<MailResult[]>) {
  return async (messages: MailMessage[], options: MailSendOptions = {}): Promise<MailResult[]> => {
    if (!messages.length) return [];
    try {
      return await send(messages, options);
    } catch (error) {
      return messages.map(() => ({ ok: false, retryable: false, error: (error as Error).message }));
    }
  };
}

const requireSecret = (provider: string, secret: string): string => {
  if (!secret) throw new Error(`${provider}: no API key in the vault. myna mail provider add sets it.`);
  return secret;
};

// ---------------------------------------------------------------- Resend

export const RESEND_API = "https://api.resend.com";

/** Resend: POST /emails, and /emails/batch for up to 100 at once. */
export function resendProvider(config: MailProviderConfig, secret: string, deps: ProviderDeps = {}): MailSender {
  const auth = () => ({ authorization: `Bearer ${requireSecret("Resend", secret)}` });
  const shape = (p: Prepared) => ({
    from: p.from,
    to: p.to,
    subject: p.subject,
    text: p.text,
    ...(p.html ? { html: p.html } : {}),
    ...(p.replyTo ? { reply_to: p.replyTo } : {}),
    ...(Object.keys(p.headers).length ? { headers: p.headers } : {}),
  });
  return {
    id: config.id,
    type: "resend",
    from: config.from,
    batchSize: 100,
    send: guarded(async (message) => {
      const answer = await call(deps, `${RESEND_API}/emails`, withHeaders(json(shape(prepare(message, config.from, "Resend"))), auth()));
      if (!isHttp(answer) || !answer.ok) return failure("Resend", answer);
      return { ok: true, status: answer.status, id: (answer.body as { id?: string } | null)?.id };
    }),
    sendBatch: guardedBatch(async (messages) => {
      if (messages.length > 100) throw new Error("Resend takes at most 100 emails per batch.");
      const body = messages.map((message) => shape(prepare(message, config.from, "Resend")));
      const answer = await call(deps, `${RESEND_API}/emails/batch`, withHeaders(json(body), auth()));
      if (!isHttp(answer) || !answer.ok) {
        const failed = failure("Resend", answer);
        return messages.map(() => ({ ...failed }));
      }
      const data = ((answer.body as { data?: { id?: string }[] } | null)?.data ?? []) as { id?: string }[];
      return messages.map((_, index) => {
        const id = data[index]?.id;
        return id ? { ok: true, status: answer.status, id } : { ok: false, retryable: false, status: answer.status, error: "Resend: the batch answer had no id for this message." };
      });
    }),
  };
}

// ---------------------------------------------------------------- Mailgun

export const mailgunBase = (region?: string): string => (region?.toLowerCase() === "eu" ? "https://api.eu.mailgun.net" : "https://api.mailgun.net");

/** Mailgun: form-encoded POST /v3/<domain>/messages with basic auth api:<key>. */
export function mailgunProvider(config: MailProviderConfig, secret: string, deps: ProviderDeps = {}): MailSender {
  return {
    id: config.id,
    type: "mailgun",
    from: config.from,
    batchSize: 1,
    send: guarded(async (message) => {
      const p = prepare(message, config.from, "Mailgun");
      const domain = config.domain ?? addressOf(p.from).split("@")[1];
      if (!domain) throw new Error("Mailgun: no sending domain. myna mail provider add <id> --type mailgun --domain mg.example.com");
      const form = new URLSearchParams();
      form.append("from", p.from);
      for (const to of p.to) form.append("to", to);
      form.append("subject", p.subject);
      form.append("text", p.text);
      if (p.html) form.append("html", p.html);
      if (p.replyTo) form.append("h:Reply-To", p.replyTo);
      for (const [name, value] of Object.entries(p.headers)) form.append(`h:${name}`, value);
      const answer = await call(deps, `${mailgunBase(config.region)}/v3/${encodeURIComponent(domain)}/messages`, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`api:${requireSecret("Mailgun", secret)}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: form.toString(),
      });
      if (!isHttp(answer) || !answer.ok) return failure("Mailgun", answer);
      return { ok: true, status: answer.status, id: (answer.body as { id?: string } | null)?.id };
    }),
  };
}

// ---------------------------------------------------------------- Mailchimp Transactional (Mandrill)

export const MANDRILL_API = "https://mandrillapp.com/api/1.0";

/** Mandrill's error names that no retry will fix; it answers them with a 500. */
const MANDRILL_FINAL = new Set(["Invalid_Key", "ValidationError", "PaymentRequired", "Unknown_Subaccount", "Unknown_Template", "Invalid_Template", "Unknown_Sender"]);

/** Mailchimp Transactional (Mandrill): POST /messages/send with the key in the body. */
export function mandrillProvider(config: MailProviderConfig, secret: string, deps: ProviderDeps = {}): MailSender {
  return {
    id: config.id,
    type: "mandrill",
    from: config.from,
    batchSize: 1,
    send: guarded(async (message) => {
      const p = prepare(message, config.from, "Mandrill");
      const sender = parseAddress(p.from);
      const headers: Record<string, string> = { ...p.headers, ...(p.replyTo ? { "Reply-To": p.replyTo } : {}) };
      const answer = await call(
        deps,
        `${MANDRILL_API}/messages/send`,
        json({
          key: requireSecret("Mandrill", secret),
          message: {
            from_email: sender.email,
            ...(sender.name ? { from_name: sender.name } : {}),
            to: p.to.map((to) => ({ ...parseAddress(to), type: "to" })),
            subject: p.subject,
            text: p.text,
            ...(p.html ? { html: p.html } : {}),
            ...(Object.keys(headers).length ? { headers } : {}),
          },
        }),
      );
      if (!isHttp(answer)) return failure("Mandrill", answer);
      const body = answer.body as { status?: string; name?: string; message?: string } | { status?: string; _id?: string; reject_reason?: string | null; email?: string }[] | null;
      if (!answer.ok || (body && !Array.isArray(body) && body.status === "error")) {
        const error = (body && !Array.isArray(body) ? body : {}) as { name?: string; message?: string };
        const retryable = error.name ? !MANDRILL_FINAL.has(error.name) && retryableStatus(answer.status) : retryableStatus(answer.status);
        return { ok: false, status: answer.status, retryable, error: `Mandrill ${answer.status}: ${[error.name, error.message].filter(Boolean).join(": ") || errorWords(answer.body, answer.text)}` };
      }
      const rows = Array.isArray(body) ? body : [];
      const refused = rows.filter((row) => row.status === "rejected" || row.status === "invalid");
      if (!rows.length) return { ok: false, retryable: true, status: answer.status, error: "Mandrill: an empty answer." };
      if (refused.length)
        return { ok: false, retryable: false, status: answer.status, error: `Mandrill ${refused.map((row) => `${row.status} ${row.email ?? ""}${row.reject_reason ? ` (${row.reject_reason})` : ""}`.trim()).join("; ")}` };
      return { ok: true, status: answer.status, id: rows[0]?._id };
    }),
  };
}

// ---------------------------------------------------------------- SendGrid

export const sendgridBase = (region?: string): string => (region?.toLowerCase() === "eu" ? "https://api.eu.sendgrid.com" : "https://api.sendgrid.com");

/** SendGrid: POST /v3/mail/send; a 202 with the id in X-Message-Id. */
export function sendgridProvider(config: MailProviderConfig, secret: string, deps: ProviderDeps = {}): MailSender {
  return {
    id: config.id,
    type: "sendgrid",
    from: config.from,
    batchSize: 1,
    send: guarded(async (message) => {
      const p = prepare(message, config.from, "SendGrid");
      const content = [{ type: "text/plain", value: p.text }, ...(p.html ? [{ type: "text/html", value: p.html }] : [])];
      const answer = await call(
        deps,
        `${sendgridBase(config.region)}/v3/mail/send`,
        withHeaders(
          json({
            personalizations: [{ to: p.to.map(parseAddress) }],
            from: parseAddress(p.from),
            ...(p.replyTo ? { reply_to: parseAddress(p.replyTo) } : {}),
            subject: p.subject,
            content,
            ...(Object.keys(p.headers).length ? { headers: p.headers } : {}),
          }),
          { authorization: `Bearer ${requireSecret("SendGrid", secret)}` },
        ),
      );
      if (!isHttp(answer) || !answer.ok) return failure("SendGrid", answer);
      return { ok: true, status: answer.status, id: answer.headers.get("x-message-id") ?? undefined };
    }),
  };
}

// ---------------------------------------------------------------- Postmark

export const POSTMARK_API = "https://api.postmarkapp.com";

/** Postmark's stream for a send: the configured one, else broadcast for a newsletter and outbound otherwise. */
export const postmarkStream = (config: MailProviderConfig, kind: MailKind | undefined): string => config.stream ?? (kind === "bulk" ? "broadcast" : "outbound");

/** Postmark ErrorCodes worth retrying: 405 is "not allowed to send" (account paused / over limit), 429 rate. */
const POSTMARK_RETRY = new Set([405, 429]);

/** Postmark: POST /email, and /email/batch for up to 500. */
export function postmarkProvider(config: MailProviderConfig, secret: string, deps: ProviderDeps = {}): MailSender {
  const auth = () => ({ "x-postmark-server-token": requireSecret("Postmark", secret) });
  const shape = (p: Prepared, kind: MailKind | undefined) => ({
    From: p.from,
    To: p.to.join(", "),
    Subject: p.subject,
    TextBody: p.text,
    ...(p.html ? { HtmlBody: p.html } : {}),
    ...(p.replyTo ? { ReplyTo: p.replyTo } : {}),
    ...(Object.keys(p.headers).length ? { Headers: Object.entries(p.headers).map(([Name, Value]) => ({ Name, Value })) } : {}),
    MessageStream: postmarkStream(config, kind),
  });
  type Row = { ErrorCode?: number; Message?: string; MessageID?: string };
  const fromRow = (row: Row | undefined, status: number): MailResult =>
    row && (row.ErrorCode ?? 0) === 0 && row.MessageID
      ? { ok: true, status, id: row.MessageID }
      : { ok: false, status, retryable: POSTMARK_RETRY.has(row?.ErrorCode ?? 0), error: `Postmark ${row?.ErrorCode ?? status}: ${row?.Message ?? "no answer for this message"}` };
  return {
    id: config.id,
    type: "postmark",
    from: config.from,
    batchSize: 500,
    send: guarded(async (message, options) => {
      const answer = await call(deps, `${POSTMARK_API}/email`, withHeaders(json(shape(prepare(message, config.from, "Postmark"), options.kind)), auth()));
      if (!isHttp(answer)) return failure("Postmark", answer);
      if (!answer.ok) {
        const row = answer.body as Row | null;
        if (row?.ErrorCode) return { ok: false, status: answer.status, retryable: retryableStatus(answer.status) || POSTMARK_RETRY.has(row.ErrorCode), error: `Postmark ${row.ErrorCode}: ${row.Message ?? ""}`.trim() };
        return failure("Postmark", answer);
      }
      return fromRow(answer.body as Row, answer.status);
    }),
    sendBatch: guardedBatch(async (messages, options) => {
      if (messages.length > 500) throw new Error("Postmark takes at most 500 emails per batch.");
      const body = messages.map((message) => shape(prepare(message, config.from, "Postmark"), options.kind));
      const answer = await call(deps, `${POSTMARK_API}/email/batch`, withHeaders(json(body), auth()));
      if (!isHttp(answer) || !answer.ok) {
        const failed = failure("Postmark", answer);
        return messages.map(() => ({ ...failed }));
      }
      const rows = (Array.isArray(answer.body) ? answer.body : []) as Row[];
      return messages.map((_, index) => fromRow(rows[index], answer.status));
    }),
  };
}

// ---------------------------------------------------------------- Amazon SES v2

/** SES error types that clear on their own: throttling and the daily/rate quota. */
const SES_RETRY = /TooManyRequests|Throttling|LimitExceeded|ServiceUnavailable|InternalFailure/i;

/** Amazon SES v2: POST /v2/email/outbound-emails, signed with SigV4 (service "ses"). */
export function sesProvider(config: MailProviderConfig, secret: string, deps: ProviderDeps = {}): MailSender {
  const region = config.region ?? "us-east-1";
  const host = `email.${region}.amazonaws.com`;
  return {
    id: config.id,
    type: "ses",
    from: config.from,
    batchSize: 1,
    send: guarded(async (message) => {
      const p = prepare(message, config.from, "SES");
      if (!config.keyId) throw new Error("SES: no access key id. myna mail provider add <id> --type ses --key-id AKIA... --region us-east-1");
      const headers = Object.entries(p.headers).map(([Name, Value]) => ({ Name, Value }));
      if (headers.length > 15) throw new Error("SES takes at most 15 custom headers.");
      const body = JSON.stringify({
        FromEmailAddress: p.from,
        Destination: { ToAddresses: p.to },
        ...(p.replyTo ? { ReplyToAddresses: [p.replyTo] } : {}),
        Content: {
          Simple: {
            Subject: { Data: encodeWord(p.subject), Charset: "UTF-8" },
            Body: { Text: { Data: p.text, Charset: "UTF-8" }, ...(p.html ? { Html: { Data: p.html, Charset: "UTF-8" } } : {}) },
            ...(headers.length ? { Headers: headers } : {}),
          },
        },
      });
      const path = "/v2/email/outbound-emails";
      const signed = signV4(
        { method: "POST", host, path, headers: { "content-type": "application/json" }, body },
        { accessKeyId: config.keyId, secretAccessKey: requireSecret("SES", secret) },
        region,
        "ses",
        (deps.now ?? (() => new Date()))(),
      );
      const { host: _host, ...sendHeaders } = signed;
      const answer = await call(deps, `https://${host}${path}`, { method: "POST", headers: { ...sendHeaders, accept: "application/json" }, body });
      if (!isHttp(answer)) return failure("SES", answer);
      if (!answer.ok) {
        const type = (answer.headers.get("x-amzn-errortype") ?? "").split(":")[0] ?? "";
        const words = errorWords(answer.body, answer.text);
        return { ok: false, status: answer.status, retryable: retryableStatus(answer.status) || SES_RETRY.test(type), error: `SES ${answer.status}${type ? ` ${type}` : ""}${words ? `: ${words}` : ""}` };
      }
      return { ok: true, status: answer.status, id: (answer.body as { MessageId?: string } | null)?.MessageId };
    }),
  };
}

// ---------------------------------------------------------------- Brevo

export const BREVO_API = "https://api.brevo.com/v3";

/** Brevo (was Sendinblue): POST /v3/smtp/email with an api-key header. */
export function brevoProvider(config: MailProviderConfig, secret: string, deps: ProviderDeps = {}): MailSender {
  return {
    id: config.id,
    type: "brevo",
    from: config.from,
    batchSize: 1,
    send: guarded(async (message) => {
      const p = prepare(message, config.from, "Brevo");
      const answer = await call(
        deps,
        `${BREVO_API}/smtp/email`,
        withHeaders(
          json({
            sender: parseAddress(p.from),
            to: p.to.map(parseAddress),
            subject: p.subject,
            // Brevo wants HTML; a text-only message goes as preformatted text.
            htmlContent: p.html ?? `<pre style="white-space:pre-wrap;font:inherit">${escapeHtml(p.text)}</pre>`,
            textContent: p.text,
            ...(p.replyTo ? { replyTo: parseAddress(p.replyTo) } : {}),
            ...(Object.keys(p.headers).length ? { headers: p.headers } : {}),
          }),
          { "api-key": requireSecret("Brevo", secret) },
        ),
      );
      if (!isHttp(answer) || !answer.ok) return failure("Brevo", answer);
      const body = answer.body as { messageId?: string; messageIds?: string[] } | null;
      return { ok: true, status: answer.status, id: body?.messageId ?? body?.messageIds?.[0] };
    }),
  };
}

// ---------------------------------------------------------------- SparkPost

export const sparkpostBase = (region?: string): string => (region?.toLowerCase() === "eu" ? "https://api.eu.sparkpost.com" : "https://api.sparkpost.com");

/** SparkPost: POST /api/v1/transmissions, the key as the whole Authorization header. */
export function sparkpostProvider(config: MailProviderConfig, secret: string, deps: ProviderDeps = {}): MailSender {
  return {
    id: config.id,
    type: "sparkpost",
    from: config.from,
    batchSize: 1,
    send: guarded(async (message, options) => {
      const p = prepare(message, config.from, "SparkPost");
      const answer = await call(
        deps,
        `${sparkpostBase(config.region)}/api/v1/transmissions`,
        withHeaders(
          json({
            options: { transactional: options.kind !== "bulk" },
            recipients: p.to.map((to) => ({ address: parseAddress(to) })),
            content: {
              from: parseAddress(p.from),
              subject: p.subject,
              text: p.text,
              ...(p.html ? { html: p.html } : {}),
              ...(p.replyTo ? { reply_to: p.replyTo } : {}),
              ...(Object.keys(p.headers).length ? { headers: p.headers } : {}),
            },
          }),
          { authorization: requireSecret("SparkPost", secret) },
        ),
      );
      if (!isHttp(answer) || !answer.ok) return failure("SparkPost", answer);
      const results = (answer.body as { results?: { id?: string; total_accepted_recipients?: number; total_rejected_recipients?: number } } | null)?.results;
      if (results && (results.total_accepted_recipients ?? 0) === 0 && (results.total_rejected_recipients ?? 0) > 0)
        return { ok: false, retryable: false, status: answer.status, error: `SparkPost rejected ${results.total_rejected_recipients} recipient(s).` };
      return { ok: true, status: answer.status, id: results?.id };
    }),
  };
}

// ---------------------------------------------------------------- Mailjet

export const MAILJET_API = "https://api.mailjet.com/v3.1/send";

/** Mailjet: POST /v3.1/send with basic auth <api key>:<secret key>; up to 50 messages per call. */
export function mailjetProvider(config: MailProviderConfig, secret: string, deps: ProviderDeps = {}): MailSender {
  const auth = () => {
    if (!config.keyId) throw new Error("Mailjet: no API key. myna mail provider add <id> --type mailjet --key-id <api key> (the secret key goes on stdin).");
    return { authorization: `Basic ${Buffer.from(`${config.keyId}:${requireSecret("Mailjet", secret)}`).toString("base64")}` };
  };
  const shape = (p: Prepared) => {
    const from = parseAddress(p.from);
    return {
      From: { Email: from.email, ...(from.name ? { Name: from.name } : {}) },
      To: p.to.map((to) => {
        const parsed = parseAddress(to);
        return { Email: parsed.email, ...(parsed.name ? { Name: parsed.name } : {}) };
      }),
      Subject: p.subject,
      TextPart: p.text,
      ...(p.html ? { HTMLPart: p.html } : {}),
      ...(p.replyTo ? { ReplyTo: { Email: addressOf(p.replyTo) } } : {}),
      ...(Object.keys(p.headers).length ? { Headers: p.headers } : {}),
    };
  };
  type Row = { Status?: string; To?: { MessageUUID?: string; MessageID?: number | string }[]; Errors?: { ErrorMessage?: string; StatusCode?: number }[] };
  const fromRow = (row: Row | undefined, status: number): MailResult => {
    if (row?.Status === "success") {
      const id = row.To?.[0]?.MessageUUID ?? row.To?.[0]?.MessageID;
      return { ok: true, status, ...(id !== undefined ? { id: String(id) } : {}) };
    }
    const errors = row?.Errors ?? [];
    const code = errors[0]?.StatusCode ?? status;
    return { ok: false, status: code, retryable: retryableStatus(code), error: `Mailjet ${code}: ${errors.map((error) => error.ErrorMessage).filter(Boolean).join("; ") || "no answer for this message"}` };
  };
  const post = async (messages: MailMessage[]): Promise<MailResult[]> => {
    const body = { Messages: messages.map((message) => shape(prepare(message, config.from, "Mailjet"))) };
    const answer = await call(deps, MAILJET_API, withHeaders(json(body), auth()));
    if (!isHttp(answer)) {
      const failed = failure("Mailjet", answer);
      return messages.map(() => ({ ...failed }));
    }
    // A 400 with Messages carries a status per message; anything else is the whole call failing.
    const rows = (answer.body as { Messages?: Row[] } | null)?.Messages;
    if (!Array.isArray(rows)) {
      const failed = failure("Mailjet", answer);
      return messages.map(() => ({ ...failed }));
    }
    return messages.map((_, index) => fromRow(rows[index], answer.status));
  };
  return {
    id: config.id,
    type: "mailjet",
    from: config.from,
    batchSize: 50,
    send: guarded(async (message) => (await post([message]))[0] as MailResult),
    sendBatch: guardedBatch(async (messages) => {
      if (messages.length > 50) throw new Error("Mailjet takes at most 50 messages per call.");
      return post(messages);
    }),
  };
}

// ---------------------------------------------------------------- SMTP2GO

export const smtp2goBase = (region?: string): string => {
  const r = region?.toLowerCase();
  return r === "eu" || r === "us" || r === "au" ? `https://${r}-api.smtp2go.com/v3` : "https://api.smtp2go.com/v3";
};

/** SMTP2GO: POST /v3/email/send with X-Smtp2go-Api-Key; a 200 can still carry failures. */
export function smtp2goProvider(config: MailProviderConfig, secret: string, deps: ProviderDeps = {}): MailSender {
  return {
    id: config.id,
    type: "smtp2go",
    from: config.from,
    batchSize: 1,
    send: guarded(async (message) => {
      const p = prepare(message, config.from, "SMTP2GO");
      const custom = { ...p.headers, ...(p.replyTo ? { "Reply-To": p.replyTo } : {}) };
      const answer = await call(
        deps,
        `${smtp2goBase(config.region)}/email/send`,
        withHeaders(
          json({
            sender: p.from,
            to: p.to,
            subject: p.subject,
            text_body: p.text,
            ...(p.html ? { html_body: p.html } : {}),
            ...(Object.keys(custom).length ? { custom_headers: Object.entries(custom).map(([header, value]) => ({ header, value })) } : {}),
          }),
          { "x-smtp2go-api-key": requireSecret("SMTP2GO", secret) },
        ),
      );
      if (!isHttp(answer) || !answer.ok) {
        if (isHttp(answer)) {
          const data = (answer.body as { data?: { error?: string; error_code?: string } } | null)?.data;
          if (data?.error) return { ok: false, status: answer.status, retryable: retryableStatus(answer.status), error: `SMTP2GO ${answer.status}: ${data.error}` };
        }
        return failure("SMTP2GO", answer);
      }
      const data = (answer.body as { data?: { email_id?: string; succeeded?: number; failed?: number; failures?: unknown[] } } | null)?.data;
      if (!data || (data.failed ?? 0) > 0 || (data.succeeded ?? 0) === 0)
        return { ok: false, status: answer.status, retryable: false, error: `SMTP2GO: ${(data?.failures ?? []).map(String).join("; ") || "not accepted"}` };
      return { ok: true, status: answer.status, id: data.email_id };
    }),
  };
}

// ---------------------------------------------------------------- SMTP

/** The existing SMTP client as a provider. A 4xx or a dropped connection is retryable; a 5xx is final. */
export function smtpProvider(server: SmtpServer & { pass: string }, options: SmtpOptions = {}): MailSender {
  return {
    id: server.id,
    type: "smtp",
    from: server.from,
    batchSize: 1,
    send: guarded(async (message) => {
      const p = prepare(message, server.from, "SMTP");
      try {
        const result = await sendSmtp(
          { ...server, from: p.from },
          { to: p.to, subject: p.subject, text: p.text, ...(p.html ? { html: p.html } : {}), ...(p.replyTo ? { replyTo: p.replyTo } : {}), headers: p.headers },
          options,
        );
        return { ok: true, id: result.messageId, status: 250 };
      } catch (error) {
        const code = error instanceof SmtpError ? error.code : 0;
        return { ok: false, status: code, retryable: code === 0 || (code >= 400 && code < 500), error: (error as Error).message };
      }
    }),
  };
}

// ---------------------------------------------------------------- myna cloud

/** A random key per batch call, so a retried POST is not sent twice by the server. */
export const idempotencyKey = (): string => randomBytes(16).toString("hex");

/**
 * myna cloud sends for you, through Profullstack's own Resend account.
 * The server decides the From: your display name on its verified sending
 * address, with Reply-To set to you, unless your address is on a domain it
 * has verified. It caps each account per day.
 */
export function mynaCloudProvider(config: MailProviderConfig, token: string, server: string, deps: ProviderDeps = {}): MailSender {
  const base = server.replace(/\/+$/, "");
  const post = async (messages: MailMessage[], kind: MailKind | undefined): Promise<MailResult[]> => {
    if (!token) throw new Error("myna cloud: not signed in. myna cloud login first.");
    const body = {
      kind: kind ?? "transactional",
      messages: messages.map((message) => {
        const p = prepare(message, config.from ?? "myna", "myna cloud");
        return { from: p.from, to: p.to, subject: p.subject, text: p.text, ...(p.html ? { html: p.html } : {}), ...(p.replyTo ? { replyTo: p.replyTo } : {}), headers: p.headers };
      }),
    };
    const answer = await call(deps, `${base}/v1/mail/send`, withHeaders(json(body), { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey() }));
    if (!isHttp(answer)) {
      const failed = failure("myna cloud", answer);
      return messages.map(() => ({ ...failed }));
    }
    const reply = answer.body as { ok?: boolean; error?: string; retryable?: boolean; results?: MailResult[] } | null;
    if (!answer.ok || !reply?.ok || !Array.isArray(reply.results)) {
      const retryable = reply?.retryable ?? retryableStatus(answer.status);
      const error = `myna cloud ${answer.status}: ${reply?.error ?? errorWords(answer.body, answer.text)}`;
      return messages.map(() => ({ ok: false, status: answer.status, retryable, error }));
    }
    return messages.map((_, index) => reply.results?.[index] ?? { ok: false, retryable: false, error: "myna cloud: no answer for this message." });
  };
  return {
    id: config.id,
    type: "myna-cloud",
    from: config.from,
    batchSize: 100,
    send: guarded(async (message, options) => (await post([message], options.kind))[0] as MailResult),
    sendBatch: guardedBatch(async (messages, options) => {
      if (messages.length > 100) throw new Error("myna cloud takes at most 100 messages per call.");
      return post(messages, options.kind);
    }),
  };
}
