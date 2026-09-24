/**
 * Sending mail through whichever provider is configured.
 *
 *   sendMail({from, to, subject, text, html, headers, replyTo}, {via})
 *     -> {ok, id?, error?, retryable?}
 *
 * A provider id names either a `myna mail provider` (an HTTP API, or
 * myna cloud) or an SMTP server from `myna smtp add`; both live in
 * outreach.json with their secrets in the vault. With no id, the default
 * is settings.outreach.mailProvider, then the first SMTP server (what myna
 * always did), then the first mail provider.
 */
import { loadSettings } from "../../store/settings.ts";
import { mailProviderSecret, readOutreach, smtpServer } from "../../store/outreach.ts";
import { DEFAULT_SERVER, session } from "../../store/cloud.ts";
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
      return mynaCloudProvider(config, current?.token ?? "", server, deps);
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
export function resolveSender(via?: string | null, options: ResolveOptions = {}): MailSender {
  const file = readOutreach();
  const id = via?.trim() || defaultProviderId();
  if (id) {
    const provider = file.mail.find((entry) => entry.id === id);
    if (provider) return providerSender(provider, mailProviderSecret(provider.id), options);
    if (file.smtp.some((server) => server.id === id)) return smtpProvider(smtpServer(id), options.smtp);
    throw new Error(`No mail provider "${id}". myna mail provider list shows them.`);
  }
  if (file.smtp.length) return smtpProvider(smtpServer(), options.smtp);
  const first = file.mail[0];
  if (first) return providerSender(first, mailProviderSecret(first.id), options);
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
