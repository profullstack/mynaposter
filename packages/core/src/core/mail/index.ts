/**
 * Sending mail through whichever provider is configured.
 *
 *   sendMail({from, to, subject, text, html, headers, replyTo}, {via})
 *     -> {ok, id?, error?, retryable?}
 *
 * A provider id names either a `myna mail provider` (an HTTP API, or
 * myna cloud) or an SMTP server from `myna smtp add`; both live in
 * outreach.json with their secrets in the vault. With no id, the default is
 * settings.outreach.mailProvider, then the first API provider, then the first
 * non-Google SMTP server. Google SMTP requires an explicit `--via` selection.
 */
import { loadSettings } from "../../store/settings.ts";
import { queuedDelivery, isGoogleSender } from "@profullstack/email-queue";
import { mailProviderSecret, readOutreach, smtpServer } from "../../store/outreach.ts";
import { cloudFetch, DEFAULT_SERVER, session } from "../../store/cloud.ts";
import type { SmtpOptions } from "../smtp.ts";
import {
  brevoProvider,
  mailgunProvider,
  mailjetProvider,
  mandrillProvider,
  mynaCloudProvider,
  postmarkProvider,
  resendProvider,
  sendgridProvider,
  sesProvider,
  smtp2goProvider,
  smtpProvider,
  sparkpostProvider,
} from "./providers.ts";
import type { MailKind, MailMessage, MailProviderConfig, MailResult, MailSender, ProviderDeps } from "./types.ts";

export * from "./types.ts";
export * from "./providers.ts";
export { signV4, signingKey, amzDates, type SigV4Credentials, type SigV4Request } from "./sigv4.ts";

/** A sender for a provider's config and secret. `smtp` goes through resolveSender, which knows the server. */
export function providerSender(config: MailProviderConfig, secret: string, deps: ProviderDeps = {}): MailSender {
  switch (config.type) {
    case "resend":
      return resendProvider(config, secret, deps);
    case "mailgun":
      return mailgunProvider(config, secret, deps);
    case "mandrill":
      return mandrillProvider(config, secret, deps);
    case "sendgrid":
      return sendgridProvider(config, secret, deps);
    case "postmark":
      return postmarkProvider(config, secret, deps);
    case "ses":
      return sesProvider(config, secret, deps);
    case "brevo":
      return brevoProvider(config, secret, deps);
    case "sparkpost":
      return sparkpostProvider(config, secret, deps);
    case "mailjet":
      return mailjetProvider(config, secret, deps);
    case "smtp2go":
      return smtp2goProvider(config, secret, deps);
    case "myna-cloud": {
      const current = session();
      const server = config.server ?? current?.server ?? process.env.MYNA_SERVER ?? DEFAULT_SERVER;
      return mynaCloudProvider(config, current?.token ?? "", server, { ...deps, fetch: deps.fetch ?? cloudFetch });
    }
    case "smtp":
      throw new Error(`${config.id} is an SMTP server: myna smtp list shows it.`);
    default:
      throw new Error(`Unknown mail provider type "${(config as MailProviderConfig).type}".`);
  }
}

/** The provider id a send uses when none is named, or undefined for "the first there is". */
export function defaultProviderId(): string | undefined {
  return loadSettings().outreach.mailProvider?.trim() || undefined;
}

/** The provider resolveSender() chooses when no usable default is configured. */
export function implicitDefaultProviderId(file = readOutreach()): string | undefined {
  const api = file.mail[0];
  if (api) return api.id;
  return file.smtp.find((server) => !isGoogleSender({ type: "smtp", from: server.from }, server.host))?.id;
}

/** The sender list should show the same effective choice as resolveSender(). */
export function selectedDefaultProviderId(file = readOutreach()): string | undefined {
  const configured = defaultProviderId();
  if (!configured) return implicitDefaultProviderId(file);
  if (file.mail.some((provider) => provider.id === configured)) return configured;
  const smtp = file.smtp.find((server) => server.id === configured);
  if (smtp && isGoogleSender({ type: "smtp", from: smtp.from }, smtp.host)) return implicitDefaultProviderId(file);
  return configured;
}

/** Every provider there is: the HTTP ones and the SMTP servers, as {id, type, from}. */
export function listMailProviders(): { id: string; type: string; from?: string; detail: string }[] {
  const file = readOutreach();
  return [
    ...file.mail.map((entry) => ({
      id: entry.id,
      type: entry.type,
      from: entry.from,
      detail: [entry.domain && `domain ${entry.domain}`, entry.region && `region ${entry.region}`, entry.stream && `stream ${entry.stream}`, entry.server && entry.server]
        .filter(Boolean)
        .join(", "),
    })),
    ...file.smtp.map((server) => ({ id: server.id, type: "smtp", from: server.from, detail: `${server.host}:${server.port} ${server.secure}` })),
  ];
}

export interface ResolveOptions extends ProviderDeps {
  smtp?: SmtpOptions;
}

/** The sender for an id (or the default). Throws with the command that fixes it. */
/**
 * A single account-scoped BullMQ path for real Gmail/Resend calls, including
 * newsletters, one-off CLI sends and other callers of resolveSender.
 * Missing Redis fails closed; never silently fall back to direct delivery.
 */
function queueGuard(sender: MailSender, smtpHost = ""): MailSender {
  if (sender.type !== "resend" && !isGoogleSender(sender, smtpHost)) return sender;
  return {
    id: sender.id, type: sender.type, from: sender.from, google: isGoogleSender(sender, smtpHost),
    batchSize: 1,
    send: async (message, context) => {
      const url = process.env.EMAIL_QUEUE_REDIS_URL ?? process.env.REDIS_URL ?? "";
      if (!url) return { ok: false, retryable: true, status: 429, error: "Email queue requires EMAIL_QUEUE_REDIS_URL (Redis); Gmail/Resend direct sending is disabled." };
      try {
        return await queuedDelivery(sender, message, context?.kind ?? "transactional", {
          redisUrl: url,
          smtpHost,
          applicationId: "mynaposter",
          providerId: process.env.EMAIL_QUEUE_PROVIDER_ID || sender.id,
          encryptionKey: process.env.EMAIL_QUEUE_ENCRYPTION_KEY,
          requireEncryption: true,
        });
      } catch (error) {
        return { ok: false, retryable: true, status: 0, error: "Email queue unavailable; no direct send attempted: " + String(error) };
      }
    },
  };
}
export function resolveSender(via?: string | null, options: ResolveOptions = {}): MailSender {
  const file = readOutreach();
  const explicitId = via?.trim();
  const id = explicitId || selectedDefaultProviderId(file);
  if (id) {
    const provider = file.mail.find((entry) => entry.id === id);
    if (provider) return queueGuard(providerSender(provider, mailProviderSecret(provider.id), options));
    if (file.smtp.some((server) => server.id === id)) {
      const conf = smtpServer(id);
      if (explicitId || !isGoogleSender({ type: "smtp", from: conf.from }, conf.host)) {
        return queueGuard(smtpProvider(conf, options.smtp), conf.host);
      }
      // Treat a saved Google SMTP default as stale unless this send opts in
      // with --via. Continue through safer configured fallbacks.
    } else {
      throw new Error(`No mail provider "${id}". myna mail provider list shows them.`);
    }
  }
  const first = file.mail[0];
  if (first) return queueGuard(providerSender(first, mailProviderSecret(first.id), options));
  const smtp = file.smtp.find((server) => !isGoogleSender({ type: "smtp", from: server.from }, server.host));
  if (smtp) return queueGuard(smtpProvider(smtpServer(smtp.id), options.smtp), smtp.host);
  if (file.smtp.length) {
    throw new Error("Google SMTP is not selected automatically. Set an API provider with `myna mail provider default <id>`, or opt in per send with `--via <smtp-id>`.");
  }
  throw new Error("No way to send mail yet. Add one: myna mail provider add <id> --type resend|mailgun|postmark|... or myna smtp add <id> --host ...");
}

/** One message through a provider (the default when `via` is not given). */
export async function sendMail(message: MailMessage, options: ResolveOptions & { via?: string; kind?: MailKind; sender?: MailSender } = {}): Promise<MailResult> {
  const sender = options.sender ?? resolveSender(options.via, options);
  return sender.send(message, { kind: options.kind });
}

/**
 * Many messages, in the provider's batch size where it has a batch endpoint
 * and one at a time where it does not. `before` runs ahead of each call with
 * the messages about to go (the newsletter marks them pending there); `after`
 * gets each result in order. `pause` runs between calls, not after the last.
 * `stop` returning true after a call ends the run there (a rate limit).
 */
export async function sendEach(
  sender: MailSender,
  messages: MailMessage[],
  hooks: {
    kind?: MailKind;
    before?: (indexes: number[]) => void | Promise<void>;
    after?: (index: number, result: MailResult) => void | Promise<void>;
    pause?: () => Promise<void>;
    stop?: () => boolean;
  } = {},
): Promise<MailResult[]> {
  if (hooks.kind === "bulk" && sender.google) {
    throw new Error("Bulk email must use Resend or another bulk provider; Gmail is reserved for one-off correspondence.");
  }
  const size = sender.sendBatch && sender.batchSize > 1 ? sender.batchSize : 1;
  const results: MailResult[] = [];
  for (let start = 0; start < messages.length; start += size) {
    const chunk = messages.slice(start, start + size);
    const indexes = chunk.map((_, offset) => start + offset);
    await hooks.before?.(indexes);
    const answers = size > 1 && sender.sendBatch ? await sender.sendBatch(chunk, { kind: hooks.kind }) : [await sender.send(chunk[0] as MailMessage, { kind: hooks.kind })];
    for (const [offset, result] of answers.entries()) {
      results.push(result);
      await hooks.after?.(start + offset, result);
    }
    if (hooks.stop?.()) break;
    if (start + size < messages.length) await hooks.pause?.();
  }
  return results;
}
