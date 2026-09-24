/**
 * `myna mail provider`: the doors mail goes out through.
 *
 *   myna mail provider add <id> --type resend|mailgun|mandrill|sendgrid|postmark|ses|brevo|sparkpost|mailjet|smtp2go|smtp|myna-cloud
 *        [--from "Name <a@b>"] [--domain d] [--region r] [--stream s] [--key-id k] [--server url]
 *        [--key <secret>]          or the secret on stdin, or asked for
 *   myna mail provider list | rm <id> | default [<id>] | test <id> --to addr
 *
 * The key or secret goes in the vault (plugin secrets "mail"), never in
 * outreach.json. `smtp` is `myna smtp add` under another name, and every
 * SMTP server is a provider already. `myna-cloud` needs no key: it sends
 * through myna cloud as the account `myna cloud login` signed in.
 */
import { readFileSync } from "node:fs";
import {
  MAIL_PROVIDER_TYPES,
  defaultProviderId,
  listMailProviders,
  loadSettings,
  readOutreach,
  removeMailProvider,
  removeSmtpServer,
  resolveSender,
  saveMailProvider,
  saveSettings,
  saveSmtpServer,
  cloud,
  type MailProviderConfig,
  type MailProviderType,
  type SmtpSecurity,
} from "@profullstack/myna-core";
import { out } from "./io.ts";
import { askSecret } from "./prompt.ts";

type Flags = Record<string, unknown>;

const str = (flags: Flags, key: string): string | undefined => (typeof flags[key] === "string" ? (flags[key] as string) : undefined);

const USAGE =
  "Usage: myna mail provider add <id> --type " +
  MAIL_PROVIDER_TYPES.join("|") +
  ' [--from "Name <a@b>"] [--domain d] [--region r] [--stream s] [--key-id k] [--key <secret> | < secret]';

/** What each type needs, said once, for the prompt and the help. */
const SECRET_NAME: Record<Exclude<MailProviderType, "smtp" | "myna-cloud">, string> = {
  resend: "Resend API key",
  mailgun: "Mailgun API key",
  mandrill: "Mailchimp Transactional (Mandrill) API key",
  sendgrid: "SendGrid API key",
  postmark: "Postmark server token",
  ses: "AWS secret access key",
  brevo: "Brevo API key",
  sparkpost: "SparkPost API key",
  mailjet: "Mailjet secret key",
  smtp2go: "SMTP2GO API key",
};

/** The secret from a flag, then stdin when it is piped, then a masked prompt. */
async function readSecret(flags: Flags, label: string): Promise<string> {
  const flagged = str(flags, "key") ?? str(flags, "apiKey") ?? str(flags, "secret") ?? str(flags, "pass");
  if (flagged) return flagged.trim();
  if (!process.stdin.isTTY) return readFileSync(0, "utf8").trim();
  return (await askSecret(label)).trim();
}

async function add(id: string | undefined, flags: Flags): Promise<number> {
  const type = str(flags, "type") as MailProviderType | undefined;
  if (!id || !type) throw new Error(USAGE);
  if (!(MAIL_PROVIDER_TYPES as readonly string[]).includes(type)) throw new Error(`--type is one of ${MAIL_PROVIDER_TYPES.join(", ")}.`);
  if (!/^[a-z0-9][a-z0-9._-]{0,40}$/i.test(id)) throw new Error("A provider id is letters, digits, dot, dash or underscore.");
  const from = str(flags, "from");

  if (type === "smtp") {
    const host = str(flags, "host");
    if (!host || !from) throw new Error('Usage: myna mail provider add <id> --type smtp --host <host> [--port 587] --user <user> --from "Name <addr>" [--secure starttls|tls|none]');
    const secure = (str(flags, "secure") ?? "starttls") as SmtpSecurity;
    if (!["starttls", "tls", "none"].includes(secure)) throw new Error("--secure is starttls, tls or none.");
    const user = str(flags, "user") ?? "";
    const port = Number(str(flags, "port") ?? (secure === "tls" ? 465 : 587));
    const pass = user ? await readSecret(flags, `Password for ${user}`) : "";
    saveSmtpServer({ id, host, port, secure, user, from }, pass);
    out(`Saved ${id}: SMTP ${host}:${port} (${secure}) as ${from}. The password is in the vault.`);
    out(`Try it:  myna mail provider test ${id} --to you@example.com`);
    return 0;
  }

  const config: MailProviderConfig = { id, type };
  if (from) config.from = from;
  for (const key of ["domain", "region", "stream", "keyId", "server"] as const) {
    const value = str(flags, key);
    if (value) config[key] = value;
  }
  if ((type === "mailgun" || type === "sendgrid" || type === "sparkpost") && config.region && !["us", "eu"].includes(config.region.toLowerCase()))
    throw new Error(`--region for ${type} is us or eu.`);
  if (type === "smtp2go" && config.region && !["us", "eu", "au"].includes(config.region.toLowerCase())) throw new Error("--region for smtp2go is us, eu or au.");
  if (type === "ses") {
    config.region ??= "us-east-1";
    if (!config.keyId) throw new Error("SES needs --key-id <access key id>; the secret access key goes on stdin.");
  }
  if (type === "mailjet" && !config.keyId) throw new Error("Mailjet needs --key-id <API key>; the secret key goes on stdin.");
  if (readOutreach().smtp.some((server) => server.id === id)) throw new Error(`${id} is already an SMTP server. Pick another id, or myna smtp rm ${id} first.`);

  if (type === "myna-cloud") {
    saveMailProvider(config, "");
    const current = cloud.session();
    out(`Saved ${id}: myna cloud sends for you through Profullstack's Resend account, capped per day.`);
    out(current ? `Signed in as ${current.email}; replies go to you.` : "Not signed in yet: myna cloud login first.");
    out(`Try it:  myna mail provider test ${id} --to you@example.com`);
    return 0;
  }

  const secret = await readSecret(flags, SECRET_NAME[type]);
  if (!secret) throw new Error(`No ${SECRET_NAME[type]}. Pass --key, pipe it in, or type it at the prompt.`);
  saveMailProvider(config, secret);
  const detail = [config.domain && `domain ${config.domain}`, config.region && `region ${config.region}`, config.stream && `stream ${config.stream}`].filter(Boolean).join(", ");
  out(`Saved ${id}: ${type}${detail ? ` (${detail})` : ""}${config.from ? ` as ${config.from}` : ""}. The key is in the vault.`);
  if (!config.from) out(`No --from: every send has to name its sender. Add one with myna mail provider add ${id} --type ${type} --from "Name <you@example.com>" ...`);
  out(`Try it:  myna mail provider test ${id} --to you@example.com`);
  return 0;
}

export async function runMailProvider(positional: string[], flags: Flags): Promise<number> {
  const [sub, ...rest] = positional;
  switch (sub ?? "list") {
    case "list":
    case "ls": {
      const providers = listMailProviders();
      if (!providers.length) {
        out("No mail provider yet.  myna mail provider add <id> --type resend --from \"You <you@example.com>\" < key.txt");
        return 0;
      }
      const chosen = defaultProviderId() ?? providers.find((entry) => entry.type === "smtp")?.id ?? providers[0]?.id;
      if (flags.json) {
        out(JSON.stringify(providers.map((entry) => ({ ...entry, default: entry.id === chosen })), null, 2));
        return 0;
      }
      for (const entry of providers) out(`${entry.id === chosen ? "*" : " "} ${entry.id.padEnd(14)} ${entry.type.padEnd(10)} ${(entry.from ?? "").padEnd(34)} ${entry.detail}`);
      out("* is the default (myna mail provider default <id> changes it).");
      return 0;
    }
    case "add":
      return add(rest[0], flags);
    case "rm":
    case "remove": {
      const id = rest[0];
      if (!id) throw new Error("Usage: myna mail provider rm <id>");
      const removed = removeMailProvider(id) || removeSmtpServer(id);
      if (removed && defaultProviderId() === id) {
        const settings = loadSettings();
        settings.outreach.mailProvider = "";
        saveSettings(settings);
      }
      out(removed ? `Removed ${id}; its key is gone from the vault.` : `No provider ${id}.`);
      return removed ? 0 : 1;
    }
    case "default": {
      const settings = loadSettings();
      const id = rest[0];
      if (!id) {
        out(settings.outreach.mailProvider || "(none set: the first SMTP server, then the first mail provider)");
        return 0;
      }
      if (id !== "none" && !listMailProviders().some((entry) => entry.id === id)) throw new Error(`No provider ${id}. myna mail provider list shows them.`);
      settings.outreach.mailProvider = id === "none" ? "" : id;
      saveSettings(settings);
      out(id === "none" ? "No default: the first SMTP server, then the first mail provider." : `Mail goes out through ${id} unless a send says --via.`);
      return 0;
    }
    case "test": {
      const id = rest[0];
      const to = str(flags, "to") ?? rest[1];
      if (!id || !to) throw new Error("Usage: myna mail provider test <id> --to you@example.com");
      const sender = resolveSender(id);
      const result = await sender.send({
        to: [to],
        subject: "myna mail test",
        text: `This is myna testing ${sender.id} (${sender.type}) at ${new Date().toISOString()}.`,
      });
      if (result.ok) out(`Delivered to ${sender.type} for ${to}${result.id ? `: ${result.id}` : "."}`);
      else out(`${sender.id} refused it${result.retryable ? " (worth trying again later)" : ""}: ${result.error}`);
      return result.ok ? 0 : 1;
    }
    default:
      throw new Error(`Unknown: myna mail provider ${sub}. Try add, list, rm, default or test.`);
  }
}
