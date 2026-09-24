/**
 * Sending a newsletter: compose, pace, ledger, and the way out.
 *
 * Every issue carries a one-click unsubscribe three ways: a List-Unsubscribe
 * header with an https link and a mailto, List-Unsubscribe-Post so a mail
 * client may press it for the reader (RFC 8058), and a link in the footer.
 * The footer also carries the sender's postal address, which CAN-SPAM wants
 * on every commercial message; a send without one is refused.
 *
 * The link is hosted by myna cloud (mynaposter.com/api/v1/newsletter/u/…)
 * unless settings.newsletter.unsubscribeUrl names your own. The hosted page
 * records the token and nothing else; `syncUnsubscribes` pulls those tokens
 * back and turns each into the permanent opt-out in contacts.json, before
 * every send and on the daemon's turn.
 *
 * Pacing is the outreach cap: an issue sends what today's
 * `outreach.maxEmailsPerDay` still allows and leaves the rest for the next
 * run, which picks up from the ledger.
 */
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { addressOf, sendSmtp, type SmtpMessage, type SmtpOptions, type SmtpServer } from "./smtp.ts";
import { escapeHtml, renderMarkdown } from "../util/markdown.ts";
import { getJson, postJson } from "../util/http.ts";
import { loadSettings } from "../store/settings.ts";
import { addToList, optOut, readContacts, recipients, upsertContact, removeFromList, contactId, type Contact } from "../store/contacts.ts";
import { outreachSentToday, recordSent, smtpServer } from "../store/outreach.ts";
import { session, DEFAULT_SERVER } from "../store/cloud.ts";
import {
  contactForToken,
  readNewsletters,
  recordDelivery,
  requireNewsletter,
  tokenFor,
  writeNewsletters,
  type Newsletter,
} from "../store/newsletters.ts";

// ---------------------------------------------------------------- composing

export interface NewsletterComposeOptions {
  /** The one-click https link for this subscriber. */
  link: string;
  /** The postal address for the footer. */
  address: string;
  /** The sender, for the mailto fallback and the List-Id domain. */
  from: string;
  token: string;
}

/** The message for one subscriber: body, footer, and the unsubscribe headers. */
export function composeNewsletter(newsletter: Pick<Newsletter, "subject" | "body" | "list" | "replyTo">, options: NewsletterComposeOptions): Omit<SmtpMessage, "to"> {
  const sender = addressOf(options.from);
  const domain = sender.split("@")[1] ?? "myna.local";
  const listToken = newsletter.list.replace(/[^a-z0-9-]/gi, "-").toLowerCase() || "newsletter";
  const reason = `You are getting this because you subscribed to ${newsletter.list}.`;
  const text =
    `${newsletter.body.trimEnd()}\n\n-- \n${reason}\nUnsubscribe with one click: ${options.link}\n\n${options.address.trim()}\n`;
  const small = 'style="font-size:12px;color:#666;line-height:1.5"';
  const html =
    `${renderMarkdown(newsletter.body)}\n<hr>\n` +
    `<p ${small}>${escapeHtml(reason)} <a href="${escapeHtml(options.link)}">Unsubscribe</a>.</p>\n` +
    `<p ${small}>${escapeHtml(options.address.trim()).replace(/\r?\n/g, "<br>")}</p>\n`;
  return {
    subject: newsletter.subject,
    text,
    html,
    ...(newsletter.replyTo ? { replyTo: newsletter.replyTo } : {}),
    headers: {
      "List-Unsubscribe": `<${options.link}>, <mailto:${sender}?subject=unsubscribe%20${encodeURIComponent(options.token)}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      "List-Id": `${listToken} <${listToken}.${domain}>`,
      Precedence: "bulk",
    },
  };
}

// ---------------------------------------------------------------- the hosted link

type Reply<T> = ({ ok: true } & T) | { ok: false; error?: string };

const cloudBase = (): string => (session()?.server ?? process.env.MYNA_SERVER ?? DEFAULT_SERVER).replace(/\/+$/, "");
const cloudAuth = (): Record<string, string> => {
  const token = session()?.token;
  if (!token) throw new Error("No unsubscribe link: sign in with `myna cloud login` so mynaposter.com hosts it, or set your own with `myna config newsletter.unsubscribeUrl https://…/{token}`.");
  return { authorization: `Bearer ${token}` };
};

/** The myna cloud inbox the links point at, made once and kept. */
export async function ensureInbox(): Promise<string> {
  const file = readNewsletters();
  const server = cloudBase();
  if (file.inbox && file.inbox.server === server) return file.inbox.id;
  const reply = await postJson<Reply<{ inbox: string }>>(`${server}/v1/newsletter/inbox`, {}, { headers: cloudAuth() });
  if (!reply.ok) throw new Error(reply.error ?? "myna cloud would not open an unsubscribe inbox.");
  const fresh = readNewsletters();
  fresh.inbox = { id: reply.inbox, server };
  writeNewsletters(fresh);
  return reply.inbox;
}

/** Turn a token into the link, given how this install hosts it. */
export async function linkMaker(): Promise<(token: string) => string> {
  const custom = loadSettings().newsletter.unsubscribeUrl.trim();
  if (custom) {
    if (!custom.includes("{token}")) throw new Error("newsletter.unsubscribeUrl needs {token} where the subscriber's token goes.");
    if (!/^https:\/\//.test(custom)) throw new Error("newsletter.unsubscribeUrl must be https: mail clients only press one-click links over https.");
    return (token) => custom.replace("{token}", encodeURIComponent(token));
  }
  const inbox = await ensureInbox();
  const site = cloudBase();
  return (token) => `${site}/v1/newsletter/u/${inbox}/${token}`;
}

export interface SyncResult {
  pulled: number;
  optedOut: string[];
  unknown: number;
}

/**
 * Pull the one-click unsubscribes myna cloud recorded, and opt each one out
 * for good. Quiet when this install does not use the hosted link.
 */
export async function syncUnsubscribes(): Promise<SyncResult> {
  const file = readNewsletters();
  const result: SyncResult = { pulled: 0, optedOut: [], unknown: 0 };
  if (!file.inbox || !session()?.token) return result;
  const since = file.unsubscribesSince ? `?since=${encodeURIComponent(file.unsubscribesSince)}` : "";
  const reply = await getJson<Reply<{ unsubscribes: { token: string; at: string }[] }>>(`${file.inbox.server}/v1/newsletter/unsubscribes${since}`, { headers: cloudAuth() });
  if (!reply.ok) throw new Error(reply.error ?? "Could not read unsubscribes from myna cloud.");
  const contacts = readContacts();
  let newest = file.unsubscribesSince;
  for (const entry of reply.unsubscribes) {
    result.pulled++;
    if (!newest || entry.at > newest) newest = entry.at;
    const id = contactForToken(entry.token, file);
    if (!id) {
      result.unknown++;
      continue;
    }
    const contact = contacts.contacts.find((c) => c.id === id);
    if (contact && !contact.optedOut && optOut(id, contacts)) result.optedOut.push(id);
  }
  const fresh = readNewsletters();
  fresh.unsubscribesSince = newest;
  writeNewsletters(fresh);
  return result;
}

// ---------------------------------------------------------------- subscribers

export interface SubscriberInput {
  email: string;
  name?: string | null;
  tags?: string[];
}

export interface SubscribeResult {
  added: string[];
  already: string[];
  optedOut: string[];
  invalid: string[];
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** Put people on a list, as contacts. An opted-out contact stays out. */
export function subscribe(list: string, people: SubscriberInput[], source = "newsletter"): SubscribeResult {
  const result: SubscribeResult = { added: [], already: [], optedOut: [], invalid: [] };
  const name = list.trim().toLowerCase();
  if (!name) throw new Error("Which list? --list <name>");
  for (const person of people) {
    const email = person.email.trim();
    if (!EMAIL.test(email)) {
      result.invalid.push(person.email);
      continue;
    }
    const file = readContacts();
    const contact = upsertContact({ name: person.name ?? null, email, phone: null, handles: [], openprofile: null, source, tags: person.tags ?? [] }, file);
    if (contact.optedOut) {
      result.optedOut.push(contact.id);
      continue;
    }
    if ((file.lists[name] ?? []).includes(contact.id)) result.already.push(contact.id);
    else {
      addToList(name, [contact.id], file);
      result.added.push(contact.id);
    }
  }
  return result;
}

/**
 * Take someone off. With a list, only that list; without one, the permanent
 * opt-out, which no list and no import can undo. Takes an email, a contact
 * id or an unsubscribe token.
 */
export function unsubscribe(who: string, options: { list?: string } = {}): { id: string; permanent: boolean } | null {
  const id = contactForToken(who) ?? contactId({ email: who.includes("@") ? who : null, handles: who.includes("@") ? [] : [who] });
  if (!id) return null;
  const file = readContacts();
  if (!file.contacts.some((contact) => contact.id === id)) return null;
  if (options.list) {
    removeFromList(options.list, [id], file);
    return { id, permanent: false };
  }
  optOut(id, file);
  return { id, permanent: true };
}

/** Everyone on a list, opted out or not, with whether they would be mailed. */
export function subscribers(list: string): { contact: Contact; active: boolean }[] {
  const file = readContacts();
  const byId = new Map(file.contacts.map((contact) => [contact.id, contact]));
  return (file.lists[list.trim().toLowerCase()] ?? [])
    .map((id) => byId.get(id))
    .filter((c): c is Contact => Boolean(c))
    .map((contact) => ({ contact, active: !contact.optedOut && Boolean(contact.email) }));
}

/** One CSV line into fields, with quotes. */
function csvFields(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      fields.push(field);
      field = "";
    } else field += ch;
  }
  fields.push(field);
  return fields.map((f) => f.trim());
}

const tagList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(/[;|,]/).map((s) => s.trim()).filter(Boolean) : [];

/**
 * Subscribers out of a CSV or JSON file. CSV with a header row uses its
 * `email`, `name` and `tags` columns (tags split on `;`); without one, the
 * first column is the email and the second the name. JSON is an array of
 * addresses or of `{email, name, tags}`, or an object holding one under
 * `subscribers` or `contacts` (what `myna contacts export` writes).
 */
export function parseSubscribers(text: string, format: "csv" | "json"): SubscriberInput[] {
  if (format === "json") {
    const data = JSON.parse(text) as unknown;
    const rows = Array.isArray(data) ? data : ((data as Record<string, unknown>).subscribers ?? (data as Record<string, unknown>).contacts);
    if (!Array.isArray(rows)) throw new Error("JSON needs an array of subscribers, or {subscribers: [...]}.");
    return rows
      .map((row): SubscriberInput | null => {
        if (typeof row === "string") return { email: row };
        const record = row as Record<string, unknown>;
        if (typeof record.email !== "string" || (record as { optedOut?: boolean }).optedOut) return null;
        return { email: record.email, name: typeof record.name === "string" ? record.name : null, tags: tagList(record.tags) };
      })
      .filter((row): row is SubscriberInput => Boolean(row));
  }
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const head = csvFields(lines[0] as string).map((h) => h.toLowerCase());
  const hasHeader = head.some((h) => h === "email" || h === "e-mail" || h === "email address");
  const col = (names: string[], fallback: number): number => {
    const found = head.findIndex((h) => names.includes(h));
    return found === -1 ? (hasHeader ? -1 : fallback) : found;
  };
  const emailAt = col(["email", "e-mail", "email address"], 0);
  const nameAt = col(["name", "full name"], 1);
  const tagsAt = col(["tags"], -1);
  return (hasHeader ? lines.slice(1) : lines).map((line) => {
    const fields = csvFields(line);
    return {
      email: fields[emailAt] ?? "",
      name: nameAt >= 0 ? fields[nameAt] || null : null,
      tags: tagsAt >= 0 ? tagList(fields[tagsAt]) : [],
    };
  });
}

/** Read a subscriber file, the format from its extension. */
export function readSubscriberFile(path: string): SubscriberInput[] {
  const format = extname(path).toLowerCase() === ".json" ? "json" : "csv";
  return parseSubscribers(readFileSync(path, "utf8"), format);
}

// ---------------------------------------------------------------- sending

export interface SendNewsletterOptions {
  dryRun?: boolean;
  /** Send one copy here and nothing else: no ledger, no status change. */
  test?: string;
  /** At most this many this run, under the daily cap. */
  limit?: number;
  /** Mail recipients whose last send died mid-message. They may already have it. */
  retryUncertain?: boolean;
  /** Try again the recipients the server refused last time. */
  retryFailed?: boolean;
  log?: (line: string) => void;
  /** Tests hand these in. */
  server?: SmtpServer & { pass: string };
  smtp?: SmtpOptions;
  link?: (token: string) => string;
  now?: Date;
}

export interface SendNewsletterReport {
  id: string;
  subject: string;
  list: string;
  /** Everyone on the list who could be mailed. */
  audience: number;
  alreadySent: number;
  /** Pending from a run that died mid-message: skipped unless retryUncertain. */
  uncertain: number;
  /** Refused on an earlier run: skipped unless retryFailed. */
  previouslyFailed: number;
  sent: string[];
  failed: { to: string; error: string }[];
  /** Would go out now, on a dry run. */
  wouldSend: string[];
  /** Left for a later run by the daily cap or the limit. */
  remaining: number;
  status: Newsletter["status"];
}

/** The postal address for an issue, or an error that says where to set it. */
export function addressFor(newsletter: Newsletter): string {
  const address = (newsletter.address ?? loadSettings().newsletter.address).trim();
  if (!address) throw new Error('No postal address. CAN-SPAM wants one on every issue: myna config newsletter.address "Company, 1 Main St, City, ST 00000, USA"');
  return address;
}

export async function sendNewsletter(id: string, options: SendNewsletterOptions = {}): Promise<SendNewsletterReport> {
  const log = options.log ?? (() => undefined);
  const now = options.now ?? new Date();
  const newsletter = requireNewsletter(id);
  const report: SendNewsletterReport = {
    id: newsletter.id,
    subject: newsletter.subject,
    list: newsletter.list,
    audience: 0,
    alreadySent: 0,
    uncertain: 0,
    previouslyFailed: 0,
    sent: [],
    failed: [],
    wouldSend: [],
    remaining: 0,
    status: newsletter.status,
  };

  // A test copy: one address, a fake token, nothing written but the outreach ledger.
  if (options.test) {
    const address = addressFor(newsletter);
    const server = options.server ?? smtpServer(newsletter.smtp ?? undefined);
    let link: string;
    try {
      link = (options.link ?? (await linkMaker()))("test-copy-not-a-subscriber");
    } catch (error) {
      link = "https://example.invalid/unsubscribe";
      log(`warning: ${(error as Error).message} The test copy carries a placeholder link.`);
    }
    const message = composeNewsletter({ ...newsletter, subject: `[test] ${newsletter.subject}` }, { link, address, from: server.from, token: "test" });
    if (options.dryRun) {
      report.wouldSend.push(options.test);
      return report;
    }
    try {
      const result = await sendSmtp(server, { ...message, to: [options.test] }, options.smtp);
      recordSent([{ at: now.toISOString(), kind: "email", to: options.test, via: server.id, subject: message.subject, ok: true, id: result.messageId }]);
      report.sent.push(options.test);
    } catch (error) {
      recordSent([{ at: now.toISOString(), kind: "email", to: options.test, via: server.id, subject: message.subject, ok: false, error: (error as Error).message }]);
      report.failed.push({ to: options.test, error: (error as Error).message });
    }
    return report;
  }

  if (!options.dryRun) {
    try {
      const synced = await syncUnsubscribes();
      if (synced.optedOut.length) log(`${synced.optedOut.length} unsubscribed since the last send: ${synced.optedOut.join(", ")}`);
    } catch (error) {
      log(`warning: could not read unsubscribes from myna cloud (${(error as Error).message}); sending to the list as it stands.`);
    }
  }

  const ledger = readNewsletters().deliveries[newsletter.id] ?? {};
  const audience = recipients({ list: newsletter.list }).filter((contact) => contact.email);
  report.audience = audience.length;
  if (!audience.length) throw new Error(`Nobody on ${newsletter.list} can be mailed. myna newsletter subscribe <email> --list ${newsletter.list}`);
  const due: Contact[] = [];
  for (const contact of audience) {
    const entry = ledger[contact.id];
    if (entry?.state === "sent") report.alreadySent++;
    else if (entry?.state === "pending" && !options.retryUncertain) report.uncertain++;
    else if (entry?.state === "failed" && !options.retryFailed) report.previouslyFailed++;
    else due.push(contact);
  }

  const settings = loadSettings();
  const capLeft = Math.max(0, settings.outreach.maxEmailsPerDay - outreachSentToday("email", now.getTime()));
  const room = Math.min(capLeft, options.limit ?? Number.POSITIVE_INFINITY);
  const batch = due.slice(0, room);
  report.remaining = due.length - batch.length;

  if (options.dryRun) {
    report.wouldSend = batch.map((contact) => contact.email as string);
    if (report.remaining) log(`${report.remaining} more wait for a later run (daily cap ${settings.outreach.maxEmailsPerDay}, ${capLeft} left today).`);
    try {
      addressFor(newsletter);
    } catch (error) {
      log(`warning: ${(error as Error).message}`);
    }
    return report;
  }

  const address = addressFor(newsletter);
  if (batch.length) {
    const server = options.server ?? smtpServer(newsletter.smtp ?? undefined);
    const link = options.link ?? (await linkMaker());
    for (const contact of batch) {
      const to = contact.email as string;
      const token = tokenFor(contact.id);
      const message = composeNewsletter(newsletter, { link: link(token), address, from: server.from, token });
      recordDelivery(newsletter.id, contact.id, { state: "pending", at: new Date().toISOString(), to });
      try {
        const result = await sendSmtp(server, { ...message, to: [to] }, options.smtp);
        const at = new Date().toISOString();
        recordDelivery(newsletter.id, contact.id, { state: "sent", at, to, messageId: result.messageId });
        recordSent([{ at, kind: "email", to, via: server.id, subject: newsletter.subject, ok: true, id: result.messageId }]);
        report.sent.push(to);
        log(`sent to ${contact.name ? `${contact.name} ` : ""}<${to}>`);
      } catch (error) {
        const at = new Date().toISOString();
        const message = (error as Error).message;
        recordDelivery(newsletter.id, contact.id, { state: "failed", at, to, error: message });
        recordSent([{ at, kind: "email", to, via: server.id, subject: newsletter.subject, ok: false, error: message }]);
        report.failed.push({ to, error: message });
        log(`could not send to <${to}>: ${message}`);
      }
    }
  }

  // Sent once everyone on the list has had their turn. A refusal is written
  // down and stays retryable by hand (--retry-failed); the daemon never
  // hammers an address the server said does not exist.
  const file = readNewsletters();
  const current = file.newsletters.find((entry) => entry.id === newsletter.id);
  if (current) {
    const done = report.remaining === 0;
    current.status = done ? "sent" : "sending";
    if (done && !current.sentAt) current.sentAt = new Date().toISOString();
    current.updatedAt = new Date().toISOString();
    writeNewsletters(file);
    report.status = current.status;
  }
  return report;
}

/**
 * The daemon's turn: send every scheduled issue that is due, and carry on
 * with any scheduled one the cap cut short. An issue sent by hand that
 * stopped part way waits for a hand, so a `--limit 5` trial never turns
 * into the whole list overnight.
 */
export async function runDueNewsletters(now = new Date(), options: Omit<SendNewsletterOptions, "now" | "dryRun" | "test"> = {}): Promise<SendNewsletterReport[]> {
  const due = readNewsletters().newsletters.filter(
    (entry) => entry.scheduledFor && Date.parse(entry.scheduledFor) <= now.getTime() && (entry.status === "scheduled" || entry.status === "sending"),
  );
  const reports: SendNewsletterReport[] = [];
  for (const entry of due) {
    const report = await sendNewsletter(entry.id, { ...options, now });
    reports.push(report);
    // Nothing went out and nothing can: the cap is spent for today.
    if (!report.sent.length && report.remaining) break;
  }
  return reports;
}
