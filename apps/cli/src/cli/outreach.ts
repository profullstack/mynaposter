/**
 * `myna smtp`, `myna sms`, `myna contacts`, `myna email`: the people you
 * write to directly, and the doors you write through.
 *
 *   myna smtp add <id> --host h --port 587 --user u --from "Name <a@b>" [--secure starttls|tls|none]
 *   myna smtp list | rm <id> | test <id> <to>
 *   myna sms setup --from +1408... [--api-key k]      Telnyx
 *   myna sms send <to...> "text" | --list L "text" [--dry-run]
 *   myna contacts [--tag t] [--list L] | add <email|phone|net:handle> [--name] [--tags a,b] [--list L]
 *   myna contacts import agenticjobs [--account id] [--tags a,b] [--list L] [--limit N]
 *   myna contacts lists | list-add <L> <id...> | optout <id> | rm <id> | export
 *   myna email --to a@b [--to ...] | --list L --subject "..." [--smtp id] [--reply-to r] [--dry-run] < body.md
 *   myna email log
 *
 * Every send is written down; the daily caps count what went out; an
 * opted-out contact is never on a list's recipients.
 */
import { readFileSync } from "node:fs";
import {
  addToList,
  importFromAgenticjobs,
  listAccounts,
  loadSettings,
  optOut,
  readContacts,
  readOutreach,
  recipients,
  recordSent,
  removeContact,
  removeSmtpServer,
  renderMarkdown,
  saveSms,
  saveSmtpServer,
  sendSms,
  sendSmtp,
  outreachSentToday,
  smsConfig,
  smtpServer,
  upsertContact,
  type Contact,
  type SentRecord,
  type SmtpSecurity,
} from "@profullstack/myna-core";
import { out, table } from "./io.ts";
import { askSecret } from "./prompt.ts";

type Flags = Record<string, unknown>;

const str = (flags: Flags, key: string): string | undefined => (typeof flags[key] === "string" ? (flags[key] as string) : undefined);
const list = (value: string | undefined): string[] => (value ? value.split(",").map((s) => s.trim()).filter(Boolean) : []);

async function readBody(): Promise<string> {
  if (process.stdin.isTTY) throw new Error("Pipe the body in:  myna email --to a@b --subject '...' < body.md");
  return readFileSync(0, "utf8");
}

export async function runSmtp(positional: string[], flags: Flags): Promise<number> {
  const [sub, ...rest] = positional;
  switch (sub ?? "list") {
    case "list": {
      const servers = readOutreach().smtp;
      if (!servers.length) {
        out("No SMTP server yet.  myna smtp add <id> --host smtp.example --port 587 --user you --from \"You <you@example>\"");
        return 0;
      }
      for (const s of servers) out(`${s.id.padEnd(14)} ${s.host}:${s.port} ${s.secure.padEnd(8)} ${s.user.padEnd(28)} ${s.from}`);
      return 0;
    }
    case "add": {
      const id = rest[0];
      const host = str(flags, "host");
      const user = str(flags, "user") ?? "";
      const from = str(flags, "from");
      if (!id || !host || !from) throw new Error('Usage: myna smtp add <id> --host <host> [--port 587] --user <user> --from "Name <addr>" [--secure starttls|tls|none]');
      const secure = (str(flags, "secure") ?? "starttls") as SmtpSecurity;
      if (!["starttls", "tls", "none"].includes(secure)) throw new Error("--secure is starttls, tls or none.");
      const port = Number(str(flags, "port") ?? (secure === "tls" ? 465 : 587));
      const pass = str(flags, "pass") ?? process.env.SMTP_PASS ?? (user ? await askSecret(`Password for ${user}`) : "");
      saveSmtpServer({ id, host, port, secure, user, from }, pass);
      out(`Saved ${id}: ${host}:${port} (${secure}) as ${from}. The password is in the vault.`);
      out(`Try it:  myna smtp test ${id} you@example.com`);
      return 0;
    }
    case "rm":
      if (!rest[0]) throw new Error("Usage: myna smtp rm <id>");
      out(removeSmtpServer(rest[0]) ? `Removed ${rest[0]}.` : `No server ${rest[0]}.`);
      return 0;
    case "test": {
      const [id, to] = rest;
      if (!id || !to) throw new Error("Usage: myna smtp test <id> <to>");
      const server = smtpServer(id);
      const sent = await sendSmtp(server, { to: [to], subject: "myna smtp test", text: `This is myna testing ${server.id} (${server.host}) at ${new Date().toISOString()}.` });
      out(`Delivered to ${to}: ${sent.response.split("\n")[0]}`);
      return 0;
    }
    default:
      throw new Error(`Unknown: myna smtp ${sub}. Try add, list, rm or test.`);
  }
}

export async function runSms(positional: string[], flags: Flags): Promise<number> {
  const [sub, ...rest] = positional;
  const settings = loadSettings();
  switch (sub ?? "status") {
    case "setup": {
      const from = str(flags, "from");
      if (!from) throw new Error("Usage: myna sms setup --from +14085550100 [--api-key <telnyx key>]");
      const apiKey = str(flags, "apiKey") ?? process.env.TELNYX_API_KEY ?? (await askSecret("Telnyx API key"));
      saveSms({ provider: "telnyx", from }, apiKey);
      out(`Texts go out from ${from} through Telnyx. The key is in the vault.`);
      return 0;
    }
    case "status": {
      const file = readOutreach();
      if (!file.sms) out("No SMS setup.  myna sms setup --from +1... --api-key <telnyx key>");
      else out(`Telnyx, from ${file.sms.from}. ${outreachSentToday("sms")} sent today of ${settings.outreach.maxSmsPerDay}.`);
      return 0;
    }
    case "send": {
      const listName = str(flags, "list");
      const tag = str(flags, "tag");
      const text = rest[rest.length - 1];
      const numbers = rest.slice(0, -1);
      if (!text || (!numbers.length && !listName && !tag)) throw new Error('Usage: myna sms send <to...> "text"   or   myna sms send --list <L> "text"');
      const targets: { to: string; who: string }[] = numbers.map((n) => ({ to: n, who: n }));
      if (listName || tag) {
        for (const contact of recipients({ list: listName, tag })) if (contact.phone) targets.push({ to: contact.phone, who: contact.name ?? contact.id });
      }
      if (!targets.length) throw new Error("Nobody on that list has a phone number.");
      const cap = settings.outreach.maxSmsPerDay - outreachSentToday("sms");
      if (targets.length > cap) throw new Error(`${targets.length} texts would pass today's cap (${settings.outreach.maxSmsPerDay}; ${cap} left). myna config outreach.maxSmsPerDay raises it.`);
      if (flags.dryRun) {
        for (const target of targets) out(`would text ${target.who} <${target.to}>: ${text}`);
        return 0;
      }
      const config = smsConfig();
      const sent: SentRecord[] = [];
      for (const target of targets) {
        try {
          const result = await sendSms(config, target.to, text);
          sent.push({ at: new Date().toISOString(), kind: "sms", to: target.to, via: "telnyx", ok: true, id: result.id });
          out(`texted ${target.who} <${result.to}>${result.parts && result.parts > 1 ? ` (${result.parts} parts)` : ""}`);
        } catch (error) {
          sent.push({ at: new Date().toISOString(), kind: "sms", to: target.to, via: "telnyx", ok: false, error: (error as Error).message });
          out(`could not text ${target.who}: ${(error as Error).message}`);
        }
      }
      recordSent(sent);
      return sent.every((entry) => entry.ok) ? 0 : 1;
    }
    default:
      throw new Error(`Unknown: myna sms ${sub}. Try setup, status or send.`);
  }
}

export async function runContacts(positional: string[], flags: Flags): Promise<number> {
  const [sub, ...rest] = positional;
  const file = readContacts();
  const show = (contacts: Contact[]): void => {
    if (!contacts.length) {
      out("No contacts.  myna contacts add a@b --name \"Ada\"   or   myna contacts import agenticjobs");
      return;
    }
    table(
      contacts.map((c) => ({ id: c.id, name: c.name ?? "", email: c.email ?? "", phone: c.phone ?? "", tags: c.tags.join(","), source: c.source, out: c.optedOut ? "opted out" : "" })),
      [
        { key: "id", title: "Id" },
        { key: "name", title: "Name" },
        { key: "email", title: "Email" },
        { key: "phone", title: "Phone" },
        { key: "tags", title: "Tags" },
        { key: "source", title: "Source" },
        { key: "out", title: "" },
      ],
    );
  };
  switch (sub ?? "list") {
    case "list": {
      const listName = str(flags, "list");
      const tag = str(flags, "tag");
      const chosen = listName || tag ? recipients({ list: listName, tag }, file) : file.contacts;
      if (flags.json) out(JSON.stringify(chosen, null, 2));
      else show(chosen);
      return 0;
    }
    case "add": {
      const target = rest[0];
      if (!target) throw new Error('Usage: myna contacts add <email|phone|network:handle> [--name "..."] [--tags a,b] [--list L]');
      const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target) ? target : null;
      const phone = !email && /^\+?[\d\s().-]{7,}$/.test(target) ? target.replace(/[^\d+]/g, "") : null;
      const handles = !email && !phone ? [target] : [];
      const contact = upsertContact({ name: str(flags, "name") ?? null, email, phone, handles, openprofile: str(flags, "openprofile") ?? null, source: "manual", tags: list(str(flags, "tags")) }, file);
      if (str(flags, "list")) addToList(str(flags, "list") as string, [contact.id], readContacts());
      out(`Saved ${contact.id}${contact.name ? ` (${contact.name})` : ""}.`);
      return 0;
    }
    case "import": {
      if (rest[0] !== "agenticjobs") throw new Error("Usage: myna contacts import agenticjobs [--account id] [--tags a,b] [--list L] [--limit N]");
      const accounts = listAccounts().filter((account) => account.network === "agenticjobs");
      const account = str(flags, "account") ? accounts.find((entry) => entry.id === str(flags, "account")) : accounts[0];
      if (!account) throw new Error("No agenticjobs account. Log in first: myna login agenticjobs agenticjobs.work");
      const result = await importFromAgenticjobs(account, { tags: list(str(flags, "tags")), list: str(flags, "list"), limit: str(flags, "limit") ? Number(str(flags, "limit")) : undefined, log: (line) => out(`  ${line}`) });
      out(`Read ${result.read} candidates, imported ${result.imported.length}, skipped ${result.skipped.length}.`);
      for (const line of result.skipped.slice(0, 10)) out(`  skipped ${line}`);
      return 0;
    }
    case "lists": {
      const names = Object.keys(file.lists);
      if (!names.length) out("No lists.  myna contacts list-add <name> <id...>");
      for (const name of names) out(`${name.padEnd(20)} ${file.lists[name]?.length ?? 0} contacts`);
      return 0;
    }
    case "list-add": {
      const [name, ...ids] = rest;
      if (!name || !ids.length) throw new Error("Usage: myna contacts list-add <list> <id...>");
      out(`Added ${addToList(name, ids, file)} to ${name}.`);
      return 0;
    }
    case "optout":
      if (!rest[0]) throw new Error("Usage: myna contacts optout <id>");
      out(optOut(rest[0], file) ? `${rest[0]} will never be on a list's recipients again.` : `No contact ${rest[0]}.`);
      return 0;
    case "rm":
      if (!rest[0]) throw new Error("Usage: myna contacts rm <id>");
      out(removeContact(rest[0], file) ? `Removed ${rest[0]}.` : `No contact ${rest[0]}.`);
      return 0;
    case "export":
      out(JSON.stringify(file, null, 2));
      return 0;
    default:
      throw new Error(`Unknown: myna contacts ${sub}. Try list, add, import, lists, list-add, optout, rm or export.`);
  }
}

export async function runEmail(positional: string[], flags: Flags): Promise<number> {
  const settings = loadSettings();
  if (positional[0] === "log") {
    const rows = readOutreach().sent.filter((entry) => entry.kind === "email").slice(-30).reverse();
    if (!rows.length) out("Nothing sent yet.");
    for (const row of rows) out(`${row.at.slice(0, 16).replace("T", " ")}  ${row.ok ? "ok    " : "failed"}  ${row.to.padEnd(32)}  ${row.subject ?? ""}${row.error ? `  ${row.error}` : ""}`);
    return 0;
  }
  const subject = str(flags, "subject");
  const to = Array.isArray(flags.to) ? (flags.to as string[]) : str(flags, "to") ? [str(flags, "to") as string] : [];
  const listName = str(flags, "list");
  const tag = str(flags, "tag");
  if (!subject || (!to.length && !listName && !tag)) throw new Error('Usage: myna email --to <addr> [--to ...] | --list <L> --subject "..." [--smtp id] [--reply-to r] [--dry-run] < body.md');
  const body = await readBody();
  const html = renderMarkdown(body);
  const targets: { to: string; who: string }[] = to.map((addr) => ({ to: addr, who: addr }));
  if (listName || tag) for (const contact of recipients({ list: listName, tag })) if (contact.email) targets.push({ to: contact.email, who: contact.name ?? contact.email });
  if (!targets.length) throw new Error("Nobody on that list has an email address.");
  const cap = settings.outreach.maxEmailsPerDay - outreachSentToday("email");
  if (targets.length > cap) throw new Error(`${targets.length} emails would pass today's cap (${settings.outreach.maxEmailsPerDay}; ${cap} left).`);
  if (flags.dryRun) {
    for (const target of targets) out(`would email ${target.who} <${target.to}>: ${subject}`);
    out(`--- body (${body.length} chars of Markdown, sent as text and HTML) ---`);
    out(body.slice(0, 400));
    return 0;
  }
  const server = smtpServer(str(flags, "smtp"));
  const sent: SentRecord[] = [];
  for (const target of targets) {
    try {
      const result = await sendSmtp(server, { to: [target.to], subject, text: body, html, ...(str(flags, "replyTo") ? { replyTo: str(flags, "replyTo") as string } : {}) });
      sent.push({ at: new Date().toISOString(), kind: "email", to: target.to, via: server.id, subject, ok: true, id: result.messageId });
      out(`sent to ${target.who} <${target.to}>`);
    } catch (error) {
      sent.push({ at: new Date().toISOString(), kind: "email", to: target.to, via: server.id, subject, ok: false, error: (error as Error).message });
      out(`could not send to ${target.who}: ${(error as Error).message}`);
    }
  }
  recordSent(sent);
  return sent.every((entry) => entry.ok) ? 0 : 1;
}
