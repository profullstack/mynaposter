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
 * With crawlproof tracking set up (`myna newsletter track set`), every link
 * goes through a signed click URL, the HTML part carries an open pixel, and
 * the unsubscribe link is crawlproof's signed one instead; its unsubscribes
 * are pulled the same way. An issue with a second subject or a CTA set is
 * an A/B test: its variants are the subjects crossed with the calls to
 * action, and which one a person gets is a hash of the issue id and their
 * address, so a resumed send gives nobody a different one.
 *
 * Pacing is the outreach cap: an issue sends what today's
 * `outreach.maxEmailsPerDay` still allows and leaves the rest for the next
 * run, which picks up from the ledger.
 *
 * The door out is any mail provider (core/mail): an SMTP server, an HTTP API,
 * or myna cloud. A provider with a batch endpoint (Resend, Postmark, Mailjet,
 * myna cloud) gets the due recipients in batches, one API call each, with
 * newsletter.paceMs between calls; every recipient is still marked pending
 * before its call and sent or failed after it, one ledger row each. A failure
 * the provider calls retryable (429, 5xx) is tried again on the next run by
 * itself and stops this one; a connection that died leaves the rows pending
 * (uncertain), as a dropped SMTP conversation always has.
 */
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { addressOf, type SmtpMessage, type SmtpOptions, type SmtpServer } from "./smtp.ts";
import { resolveSender, sendEach, smtpProvider, type MailMessage, type MailSender } from "./mail/index.ts";
import { escapeHtml, renderMarkdown } from "../util/markdown.ts";
import { getJson, postJson } from "../util/http.ts";
import { loadSettings, type NewsletterCta } from "../store/settings.ts";
import { addToList, optIn, optOut, readContacts, recipients, upsertContact, removeFromList, contactId, type Contact } from "../store/contacts.ts";
import { outreachSentToday, recordSent } from "../store/outreach.ts";
import { getPluginSecrets } from "../store/accounts.ts";
import { session, DEFAULT_SERVER } from "../store/cloud.ts";
import {
  claimOptChange,
  contactForToken,
  readNewsletters,
  recordDelivery,
  requireNewsletter,
  tokenFor,
  writeNewsletters,
  type Delivery,
  type Newsletter,
} from "../store/newsletters.ts";

// ---------------------------------------------------------------- crawlproof tracking
//
// The contract (crawlproof.com PR #266):
//   base         https://crawlproof.com/t/<trackingId>          trackingId is 24 hex
//   open         <base>/o.png?m=<msgId>&c=<campaign>&v=<variant>
//   click        <base>/c?u=<url>&m=&c=&v=&s=<sig>              sig over u exactly as sent
//   unsubscribe  <base>/u?m=&c=&e=<email>&s=<sig>               sig over lowercase(e); GET page, POST one-click
//   events       GET /api/v1/tracking/<trackingId>/events?since=<iso>&type=   Bearer <secret>
//                -> {events: [{type, m, c, v, url?, email?, machine?, at}], next}
//                   oldest first; next is null on the last page, else an absolute URL to GET
// sig = the first 32 hex characters of HMAC-SHA256(secret, value).

export interface Tracking {
  id: string;
  secret: string;
  /** https://crawlproof.com unless a test says otherwise. */
  host?: string;
}

export interface TrackingEvent {
  type: "open" | "click" | "unsubscribe" | string;
  m?: string | null;
  c?: string | null;
  v?: string | null;
  url?: string | null;
  email?: string | null;
  /** Opens and clicks only: a mail proxy, a scanner, Apple's prefetch. */
  machine?: boolean | null;
  at: string;
}

type Fetch = typeof fetch;

export const TRACKING_SECRETS = "newsletter";
export const TRACKING_ID = /^[0-9a-f]{24}$/i;
const DEFAULT_TRACKING_HOST = "https://crawlproof.com";
const CTA_MARK = "{{cta}}";

/** The tracking set up on this machine: the id from settings, the secret from the vault. */
export function newsletterTracking(): Tracking | undefined {
  const settings = loadSettings().newsletter;
  if (!settings.trackingId) return undefined;
  const secret = getPluginSecrets(TRACKING_SECRETS).trackingSecret ?? "";
  if (!secret) return undefined;
  return { id: settings.trackingId, secret, host: settings.trackingHost };
}

export function trackingBase(tracking: Pick<Tracking, "id" | "host">): string {
  return `${(tracking.host || DEFAULT_TRACKING_HOST).replace(/\/+$/, "")}/t/${encodeURIComponent(tracking.id)}`;
}

/** The first 32 hex characters of HMAC-SHA256(secret, value). */
export function signTracking(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value, "utf8").digest("hex").slice(0, 32);
}

const q = encodeURIComponent;

export interface TrackingIds {
  m: string;
  c: string;
  v: string;
}

export function openPixelUrl(tracking: Tracking, ids: TrackingIds): string {
  return `${trackingBase(tracking)}/o.png?m=${q(ids.m)}&c=${q(ids.c)}&v=${q(ids.v)}`;
}

export function clickUrl(tracking: Tracking, url: string, ids: TrackingIds): string {
  return `${trackingBase(tracking)}/c?u=${q(url)}&m=${q(ids.m)}&c=${q(ids.c)}&v=${q(ids.v)}&s=${signTracking(tracking.secret, url)}`;
}

export function trackedUnsubscribeUrl(tracking: Tracking, ids: { m: string; c: string; email: string }): string {
  const email = ids.email.trim().toLowerCase();
  return `${trackingBase(tracking)}/u?m=${q(ids.m)}&c=${q(ids.c)}&e=${q(email)}&s=${signTracking(tracking.secret, email)}`;
}

/** A fresh msgId: what crawlproof ties opens, clicks and unsubscribes to. */
export function newMsgId(): string {
  return randomBytes(8).toString("hex");
}

/** Every event since `since`, following `next` (an absolute URL) until it is null. */
export async function fetchTrackingEvents(tracking: Tracking, options: { since?: string | null; type?: string; fetcher?: Fetch } = {}): Promise<TrackingEvent[]> {
  const fetcher = options.fetcher ?? fetch;
  const host = (tracking.host || DEFAULT_TRACKING_HOST).replace(/\/+$/, "");
  const since = options.since ?? "1970-01-01T00:00:00.000Z";
  let url: string | null =
    `${host}/api/v1/tracking/${q(tracking.id)}/events?since=${q(since)}${options.type ? `&type=${q(options.type)}` : ""}`;
  const events: TrackingEvent[] = [];
  const seen = new Set<string>();
  while (url && !seen.has(url) && seen.size < 1000) {
    seen.add(url);
    const response: Response = await fetcher(url, { headers: { authorization: `Bearer ${tracking.secret}`, accept: "application/json" } });
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).trim();
      throw new Error(`crawlproof events: ${response.status}${body && !body.startsWith("<") ? ` ${body.slice(0, 200)}` : ""}`);
    }
    const payload = (await response.json()) as { events?: TrackingEvent[]; next?: string | null };
    events.push(...(Array.isArray(payload.events) ? payload.events : []));
    url = typeof payload.next === "string" && /^https?:\/\//.test(payload.next) ? payload.next : null;
  }
  return events;
}

export interface TrackingSyncResult {
  pulled: number;
  optedOut: string[];
}

/**
 * Pull unsubscribes from crawlproof and opt each address out for good. One
 * that is not a contact yet (a test copy's address, say) is added opted
 * out, so no later list picks it up.
 */
export async function syncTrackingUnsubscribes(tracking: Tracking, options: { fetcher?: Fetch } = {}): Promise<TrackingSyncResult> {
  const file = readNewsletters();
  const events = await fetchTrackingEvents(tracking, { since: file.trackingSince, type: "unsubscribe", fetcher: options.fetcher });
  const byMsg = new Map<string, string>();
  for (const ledger of Object.values(file.deliveries)) for (const entry of Object.values(ledger)) if (entry.msgId) byMsg.set(entry.msgId, entry.to);
  const result: TrackingSyncResult = { pulled: 0, optedOut: [] };
  let newest = file.trackingSince;
  for (const event of events) {
    if (event.type !== "unsubscribe") continue;
    result.pulled++;
    if (!newest || event.at > newest) newest = event.at;
    const email = (event.email ?? (event.m ? byMsg.get(event.m) : undefined))?.trim().toLowerCase();
    if (!email) continue;
    const contacts = readContacts();
    const id = contactId({ email }) as string;
    const contact = contacts.contacts.find((entry) => entry.id === id || entry.email?.toLowerCase() === email);
    // A myna cloud re-subscribe newer than this unsubscribe wins; see claimOptChange.
    if (!claimOptChange(contact?.id ?? id, { state: "unsubscribed", at: event.at, source: "crawlproof" })) continue;
    if (contact?.optedOut) continue;
    if (contact) optOut(contact.id, contacts);
    else {
      upsertContact({ name: null, email, phone: null, handles: [], openprofile: null, source: "newsletter-unsubscribe", tags: [] }, contacts);
      optOut(id, readContacts());
    }
    result.optedOut.push(email);
  }
  if (newest !== file.trackingSince) {
    const fresh = readNewsletters();
    fresh.trackingSince = newest;
    writeNewsletters(fresh);
  }
  return result;
}

// ---------------------------------------------------------------- variants

export interface Variant {
  /** "A", "B", ...: what crawlproof records as `v`. */
  key: string;
  /** "A" or "B": which subject line. */
  subjectKey: string;
  subject: string;
  cta: NewsletterCta | null;
}

const letter = (index: number): string => (index < 26 ? String.fromCharCode(65 + index) : `V${index + 1}`);

/** Every subject crossed with every call to action: A is the first subject with the first CTA. */
export function buildVariants(subjects: string[], ctas: (NewsletterCta | null)[]): Variant[] {
  if (!subjects.length) throw new Error("A newsletter needs a subject.");
  const list = ctas.length ? ctas : [null];
  const variants: Variant[] = [];
  for (const cta of list) subjects.forEach((subject, s) => variants.push({ key: letter(variants.length), subjectKey: letter(s), subject, cta }));
  return variants;
}

/** Deterministic per person: sha256(campaign:email) mod the number of variants. */
export function variantIndex(campaign: string, email: string, count: number): number {
  const digest = createHash("sha256").update(`${campaign}:${email.trim().toLowerCase()}`).digest();
  return digest.readUInt32BE(0) % count;
}

/** An issue's variants: its subjects crossed with its CTA set. */
export function variantsFor(newsletter: Pick<Newsletter, "subject" | "subjectB" | "ctaSet">): Variant[] {
  let ctas: (NewsletterCta | null)[] = [null];
  if (newsletter.ctaSet) {
    const set = loadSettings().newsletter.ctaSets[newsletter.ctaSet];
    if (!set?.length) throw new Error(`No CTA set "${newsletter.ctaSet}", or it is empty. myna newsletter cta list shows them.`);
    ctas = set;
  }
  return buildVariants([newsletter.subject, ...(newsletter.subjectB ? [newsletter.subjectB] : [])], ctas);
}

// ---------------------------------------------------------------- composing

export interface NewsletterComposeOptions {
  /** The one-click https link for this subscriber. */
  link: string;
  /** The postal address for the footer. */
  address: string;
  /** The sender, for the mailto fallback and the List-Id domain. */
  from: string;
  token: string;
  /** The variant's subject, when it is not the issue's own. */
  subject?: string;
  /** The call to action for this variant: where `{{cta}}` is, else last before the footer. */
  cta?: NewsletterCta | null;
  /** Set, every link goes through a signed click URL and the HTML carries the open pixel. */
  tracking?: { tracking: Tracking; ids: TrackingIds };
}

/** `https://...` in plain text; trailing sentence punctuation is left outside the link. */
const TEXT_URL = /https?:\/\/[^\s<>()[\]"']+/g;

/** The message for one subscriber: body, footer, and the unsubscribe headers. */
export function composeNewsletter(
  newsletter: Pick<Newsletter, "subject" | "body" | "list" | "replyTo"> & Partial<Pick<Newsletter, "service">>,
  options: NewsletterComposeOptions,
): Omit<SmtpMessage, "to"> {
  const sender = addressOf(options.from);
  const domain = sender.split("@")[1] ?? "myna.local";
  const listToken = newsletter.list.replace(/[^a-z0-9-]/gi, "-").toLowerCase() || "newsletter";
  const reason = newsletter.service
    ? `You get this because you have an account at ${newsletter.service}; our Terms say we may email news and updates.`
    : `You are getting this because you subscribed to ${newsletter.list}.`;

  const tracked = options.tracking;
  const base = tracked ? trackingBase(tracked.tracking) : "";
  const wrap = (url: string): string => (tracked && !url.startsWith(base) ? clickUrl(tracked.tracking, url, tracked.ids) : url);

  // Where the call to action goes; no CTA, and a stray marker is simply dropped.
  let body = newsletter.body;
  if (options.cta && !body.includes(CTA_MARK)) body = `${body.trimEnd()}\n\n${CTA_MARK}\n`;
  const cta = options.cta;

  let textBody = body.split(CTA_MARK).join(cta ? `${cta.label}: ${cta.url}` : "");
  if (tracked)
    textBody = textBody.replace(TEXT_URL, (match) => {
      const trimmed = match.replace(/[.,;:!?]+$/, "");
      return wrap(trimmed) + match.slice(trimmed.length);
    });
  const text = `${textBody.trimEnd()}\n\n-- \n${reason}\nUnsubscribe with one click: ${options.link}\n\n${options.address.trim()}\n`;

  const button = cta
    ? `<p style="margin:28px 0"><a href="${escapeHtml(cta.url)}" style="display:inline-block;padding:12px 22px;background:#111827;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600">${escapeHtml(cta.label)}</a></p>`
    : "";
  let rendered = renderMarkdown(body);
  rendered = rendered.split(`<p>${CTA_MARK}</p>`).join(button).split(CTA_MARK).join(button);
  if (tracked) rendered = rendered.replace(/href="(https?:\/\/[^"]+)"/g, (_, href: string) => `href="${escapeHtml(wrap(href.replace(/&amp;/g, "&")))}"`);
  const small = 'style="font-size:12px;color:#666;line-height:1.5"';
  const pixel = tracked ? `<img src="${escapeHtml(openPixelUrl(tracked.tracking, tracked.ids))}" width="1" height="1" alt="" style="border:0;width:1px;height:1px">\n` : "";
  const html =
    `${rendered}\n<hr>\n` +
    `<p ${small}>${escapeHtml(reason)} <a href="${escapeHtml(options.link)}">Unsubscribe</a>.</p>\n` +
    `<p ${small}>${escapeHtml(options.address.trim()).replace(/\r?\n/g, "<br>")}</p>\n${pixel}`;
  return {
    subject: options.subject ?? newsletter.subject,
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
  /** Pressed Re-subscribe on the page their unsubscribe link opened. */
  resubscribed: string[];
  unknown: number;
}

/**
 * Pull what the hosted unsubscribe page recorded since the last pull: an
 * unsubscribe opts the person out; a Re-subscribe, pressed by that person on
 * that page, lifts it. Quiet when this install does not use the hosted link.
 */
export async function syncUnsubscribes(): Promise<SyncResult> {
  const file = readNewsletters();
  const result: SyncResult = { pulled: 0, optedOut: [], resubscribed: [], unknown: 0 };
  if (!file.inbox || !session()?.token) return result;
  const since = file.unsubscribesSince ? `?since=${encodeURIComponent(file.unsubscribesSince)}` : "";
  const reply = await getJson<Reply<{ unsubscribes: { token: string; at: string; state?: "unsubscribed" | "resubscribed" }[] }>>(`${file.inbox.server}/v1/newsletter/unsubscribes${since}`, { headers: cloudAuth() });
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
    if (!contact) continue;
    // An older event than the last one applied for this person, from either source, is stale.
    if (!claimOptChange(id, { state: entry.state === "resubscribed" ? "resubscribed" : "unsubscribed", at: entry.at, source: "cloud" })) continue;
    if (entry.state === "resubscribed") {
      if (optIn(id, contacts)) result.resubscribed.push(id);
    } else if (!contact.optedOut && optOut(id, contacts)) result.optedOut.push(id);
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
  /** Send one copy here and nothing else: no ledger, no status change. Variant A. */
  test?: string;
  /** At most this many this run, under the daily cap. */
  limit?: number;
  /** This run's daily cap instead of outreach.maxEmailsPerDay. */
  maxPerDay?: number;
  /** Milliseconds between two messages. The CLI and the daemon pass newsletter.paceMs. */
  paceMs?: number;
  /** Mail recipients whose last send died mid-message. They may already have it. */
  retryUncertain?: boolean;
  /** Try again the recipients the server refused last time. */
  retryFailed?: boolean;
  log?: (line: string) => void;
  /** The mail provider id, over the issue's own and the default. */
  via?: string;
  /** Tests hand these in: a ready sender, or an SMTP server and its socket options. */
  sender?: MailSender;
  server?: SmtpServer & { pass: string };
  smtp?: SmtpOptions;
  link?: (token: string) => string;
  now?: Date;
  /** crawlproof tracking; undefined reads it from settings and the vault, null turns it off. */
  tracking?: Tracking | null;
  fetcher?: Fetch;
  sleep?: (ms: number) => Promise<void>;
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
  /** Left for a later run by the daily cap or the limit, or by a retryable failure that stopped the run. */
  remaining: number;
  /** Refused with a retryable answer on an earlier run (429, 5xx): tried again this run. */
  retrying?: number;
  /** The provider it went out through. */
  via?: string;
  status: Newsletter["status"];
  /** The variants, and how many of those still due get each. */
  variants: Variant[];
  split: Record<string, number>;
  tracked: boolean;
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
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const newsletter = requireNewsletter(id);
  const tracking = options.tracking === undefined ? newsletterTracking() : (options.tracking ?? undefined);
  const variants = variantsFor(newsletter);
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
    variants,
    split: {},
    tracked: Boolean(tracking),
  };

  /** One person's message: their variant, their msgId, their unsubscribe link. */
  const messageFor = (to: string, variant: Variant, token: string, link: (token: string) => string, from: string, subjectPrefix = "") => {
    const msgId = newMsgId();
    const ids = { m: msgId, c: newsletter.id, v: variant.key };
    const unsubscribeLink = tracking ? trackedUnsubscribeUrl(tracking, { m: msgId, c: newsletter.id, email: to }) : link(token);
    const message = composeNewsletter(newsletter, {
      link: unsubscribeLink,
      address: addressFor(newsletter),
      from,
      token,
      subject: `${subjectPrefix}${variant.subject}`,
      cta: variant.cta,
      ...(tracking ? { tracking: { tracking, ids } } : {}),
    });
    return { message, msgId };
  };
  const pickSender = (): MailSender => {
    const sender = options.sender ?? (options.server ? smtpProvider(options.server, options.smtp) : resolveSender(options.via ?? newsletter.smtp, { smtp: options.smtp }));
    report.via = sender.id;
    return sender;
  };
  const senderFrom = (sender: MailSender): string => {
    if (!sender.from) throw new Error(`${sender.id} has no sender address; a newsletter needs one. myna mail provider add ${sender.id} --type ${sender.type} --from "Name <you@example.com>"`);
    return sender.from;
  };
  // Tracking makes crawlproof the unsubscribe host, so myna cloud is only asked when it is not.
  const hostedLink = async (): Promise<(token: string) => string> => options.link ?? (tracking ? () => "" : await linkMaker());

  // A test copy: one address, variant A, nothing written but the outreach ledger.
  if (options.test) {
    const variant = variants[0] as Variant;
    log(`Test copy to ${options.test} as variant ${variant.key} (subject ${variant.subjectKey}${variant.cta ? `, CTA "${variant.cta.label}"` : ""}).`);
    if (!options.dryRun) {
      // One copy to yourself may go out without the pull; a list send may not.
      const synced = await syncAllUnsubscribes({ tracking: tracking ?? null, fetcher: options.fetcher });
      if (synced.errors.length)
        log(`warning: could not read unsubscribes from ${synced.errors.join(" or ")}. The test copy goes out anyway; a list send would stop here until they are applied.`);
    }
    const known = readContacts().contacts.find((c) => c.id === options.test!.trim().toLowerCase());
    if (known?.optedOut) throw new Error(`${options.test} has opted out. It is never written to again.`);
    const sender = pickSender();
    let link: (token: string) => string;
    try {
      link = await hostedLink();
    } catch (error) {
      link = () => "https://example.invalid/unsubscribe";
      log(`warning: ${(error as Error).message} The test copy carries a placeholder link.`);
    }
    const { message, msgId } = messageFor(options.test, variant, "test", link, senderFrom(sender), "[test] ");
    if (options.dryRun) {
      report.wouldSend.push(options.test);
      return report;
    }
    const result = await sender.send({ ...message, to: [options.test] }, { kind: "bulk" });
    if (result.ok) {
      recordSent([{ at: now.toISOString(), kind: "email", to: options.test, via: sender.id, subject: message.subject, ok: true, id: result.id ?? msgId }]);
      report.sent.push(options.test);
    } else {
      const error = result.error ?? "not sent";
      recordSent([{ at: now.toISOString(), kind: "email", to: options.test, via: sender.id, subject: message.subject, ok: false, error }]);
      report.failed.push({ to: options.test, error });
    }
    return report;
  }

  // Fail closed: a list send never goes out while any unsubscribe source that
  // is set up could not be read, so nobody who left is written to again.
  if (!options.dryRun) {
    const synced = await syncAllUnsubscribes({ tracking: tracking ?? null, fetcher: options.fetcher });
    if (synced.errors.length) throw unsubscribePullError(synced.errors);
    if (synced.cloud.optedOut.length) log(`${synced.cloud.optedOut.length} unsubscribed since the last send: ${synced.cloud.optedOut.join(", ")}`);
    if (synced.cloud.resubscribed.length) log(`${synced.cloud.resubscribed.length} re-subscribed: ${synced.cloud.resubscribed.join(", ")}`);
    if (synced.tracking?.optedOut.length) log(`${synced.tracking.optedOut.length} unsubscribed through crawlproof: ${synced.tracking.optedOut.join(", ")}`);
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
    else if (entry?.state === "failed" && entry.retryable && !options.retryFailed) {
      report.retrying = (report.retrying ?? 0) + 1;
      due.push(contact);
    } else if (entry?.state === "failed" && !options.retryFailed) report.previouslyFailed++;
    else due.push(contact);
  }
  const variantOf = (contact: Contact): Variant => variants[variantIndex(newsletter.id, contact.email as string, variants.length)] as Variant;
  for (const contact of due) {
    const key = variantOf(contact).key;
    report.split[key] = (report.split[key] ?? 0) + 1;
  }

  const settings = loadSettings();
  const cap = options.maxPerDay ?? settings.outreach.maxEmailsPerDay;
  const capLeft = Math.max(0, cap - outreachSentToday("email", now.getTime()));
  const room = Math.min(capLeft, options.limit ?? Number.POSITIVE_INFINITY);
  const batch = due.slice(0, room);
  report.remaining = due.length - batch.length;

  if (options.dryRun) {
    report.wouldSend = batch.map((contact) => contact.email as string);
    if (report.remaining) log(`${report.remaining} more wait for a later run (daily cap ${cap}, ${capLeft} left today).`);
    try {
      addressFor(newsletter);
    } catch (error) {
      log(`warning: ${(error as Error).message}`);
    }
    return report;
  }

  addressFor(newsletter);
  if (batch.length) {
    const sender = pickSender();
    const from = senderFrom(sender);
    const link = await hostedLink();
    type Prepared = { contact: Contact; to: string; variant: Variant; msgId: string; message: MailMessage; tag: Pick<Delivery, "msgId" | "variant" | "subjectKey" | "cta"> };
    const prepared: Prepared[] = batch.map((contact) => {
      const to = contact.email as string;
      const variant = variantOf(contact);
      const { message, msgId } = messageFor(to, variant, tokenFor(contact.id), link, from);
      const tag: Prepared["tag"] = { msgId, variant: variant.key, subjectKey: variant.subjectKey, ...(variant.cta ? { cta: variant.cta.label } : {}) };
      return { contact, to, variant, msgId, message: { ...message, to: [to] }, tag };
    });
    let stopped = false;
    let reached = 0;
    await sendEach(
      sender,
      prepared.map((entry) => entry.message),
      {
        kind: "bulk",
        before: (indexes) => {
          for (const index of indexes) {
            const entry = prepared[index] as Prepared;
            recordDelivery(newsletter.id, entry.contact.id, { state: "pending", at: new Date().toISOString(), to: entry.to, via: sender.id, ...entry.tag });
          }
        },
        after: (index, result) => {
          const entry = prepared[index] as Prepared;
          const { contact, to, variant, tag } = entry;
          const at = new Date().toISOString();
          reached = index + 1;
          if (result.ok) {
            recordDelivery(newsletter.id, contact.id, { state: "sent", at, to, via: sender.id, ...(result.id ? { messageId: result.id } : {}), ...tag });
            recordSent([{ at, kind: "email", to, via: sender.id, subject: entry.message.subject, ok: true, ...(result.id ? { id: result.id } : {}) }]);
            report.sent.push(to);
            log(`sent ${variants.length > 1 ? `${variant.key} ` : ""}to ${contact.name ? `${contact.name} ` : ""}<${to}>`);
            return;
          }
          const reason = result.error ?? "not sent";
          recordSent([{ at, kind: "email", to, via: sender.id, subject: entry.message.subject, ok: false, error: reason }]);
          report.failed.push({ to, error: reason });
          log(`could not send to <${to}>: ${reason}`);
          if (result.retryable && result.status === 0) {
            // The connection died: it may have gone out. Left pending, as an SMTP conversation cut off mid-message is.
            stopped = true;
            return;
          }
          recordDelivery(newsletter.id, contact.id, { state: "failed", at, to, via: sender.id, error: reason, ...(result.retryable ? { retryable: true } : {}), ...tag });
          if (result.retryable) stopped = true;
        },
        pause: async () => {
          if (options.paceMs) await sleep(options.paceMs);
        },
        stop: () => stopped,
      },
    );
    if (stopped && reached < prepared.length) {
      report.remaining += prepared.length - reached;
      log(`${sender.id} asked for a pause; ${prepared.length - reached} more wait for a later run.`);
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

// ---------------------------------------------------------------- stats

export interface VariantStats {
  variant: string;
  subjectKey: string;
  cta: string;
  sent: number;
  /** Unique messages opened by a person (machine-flagged opens left out). */
  opens: number;
  /** Unique messages with any open, machines included. */
  opensTotal: number;
  /** Unique messages clicked by a person (machine-flagged clicks left out, so a link scanner cannot pick the leader). */
  clicks: number;
  ctr: number;
  unsubscribes: number;
}

export interface NewsletterStats {
  id: string;
  rows: VariantStats[];
  leader: string | null;
  /** What the leader leads on. */
  basis: "clicks" | "opens" | null;
}

/** Join crawlproof's events to the ledger by msgId, and count per variant. Test copies are not in the ledger. */
export function newsletterStats(id: string, events: TrackingEvent[], deliveries: Record<string, Delivery> = readNewsletters().deliveries[id] ?? {}): NewsletterStats {
  const rows = new Map<string, VariantStats>();
  const variantOf = new Map<string, string>();
  for (const entry of Object.values(deliveries)) {
    if (entry.state !== "sent") continue;
    const variant = entry.variant ?? "A";
    if (entry.msgId) variantOf.set(entry.msgId, variant);
    const row = rows.get(variant) ?? { variant, subjectKey: entry.subjectKey ?? "A", cta: entry.cta ?? "", sent: 0, opens: 0, opensTotal: 0, clicks: 0, ctr: 0, unsubscribes: 0 };
    row.sent++;
    rows.set(variant, row);
  }
  const sets = new Map<string, { open: Set<string>; all: Set<string>; click: Set<string>; unsub: Set<string> }>();
  for (const event of events) {
    const variant = event.m ? variantOf.get(event.m) : undefined;
    if (!variant || !event.m) continue;
    const bucket = sets.get(variant) ?? { open: new Set(), all: new Set(), click: new Set(), unsub: new Set() };
    sets.set(variant, bucket);
    if (event.type === "open") {
      bucket.all.add(event.m);
      if (!event.machine) bucket.open.add(event.m);
    } else if (event.type === "click") {
      if (!event.machine) bucket.click.add(event.m);
    } else if (event.type === "unsubscribe") bucket.unsub.add(event.m);
  }
  for (const [variant, row] of rows) {
    const bucket = sets.get(variant);
    row.opens = bucket?.open.size ?? 0;
    row.opensTotal = bucket?.all.size ?? 0;
    row.clicks = bucket?.click.size ?? 0;
    row.unsubscribes = bucket?.unsub.size ?? 0;
    row.ctr = row.sent ? row.clicks / row.sent : 0;
  }
  const list = [...rows.values()].sort((a, b) => a.variant.localeCompare(b.variant, undefined, { numeric: true }));
  const openRate = (row: VariantStats): number => (row.sent ? row.opens / row.sent : 0);
  let leader: string | null = null;
  let basis: NewsletterStats["basis"] = null;
  if (list.some((row) => row.clicks > 0)) {
    leader = [...list].sort((a, b) => b.ctr - a.ctr || openRate(b) - openRate(a))[0]?.variant ?? null;
    basis = "clicks";
  } else if (list.some((row) => row.opens > 0)) {
    leader = [...list].sort((a, b) => openRate(b) - openRate(a))[0]?.variant ?? null;
    basis = "opens";
  }
  return { id, rows: list, leader, basis };
}

/** Pull the issue's events from crawlproof, from its first send on, and count them. */
export async function fetchNewsletterStats(id: string, tracking: Tracking, options: { fetcher?: Fetch } = {}): Promise<NewsletterStats> {
  const newsletter = requireNewsletter(id);
  const deliveries = readNewsletters().deliveries[newsletter.id] ?? {};
  const since = Object.values(deliveries).map((entry) => entry.at).sort()[0];
  const events = since ? await fetchTrackingEvents(tracking, { since: new Date(Date.parse(since) - 60_000).toISOString(), fetcher: options.fetcher }) : [];
  return newsletterStats(newsletter.id, events.filter((event) => !event.c || event.c === newsletter.id), deliveries);
}

/** An error's message as plain text for a refusal: the HTTP helper's dash becomes a colon. */
const plainError = (error: unknown): string => (error as Error).message.replace(/\s*\u2014\s*/g, ": ");

export interface AllSyncResult {
  cloud: SyncResult;
  tracking: TrackingSyncResult | null;
  /** One line per source that could not be read, e.g. "myna cloud (503)". Empty when every pull worked. */
  errors: string[];
}

/**
 * Every unsubscribe source that is set up: myna cloud's hosted link, and
 * crawlproof tracking. Both are tried; a source that fails is named in
 * `errors` rather than thrown, so the caller decides, and every caller that
 * sends treats any error as a reason not to.
 */
export async function syncAllUnsubscribes(options: { tracking?: Tracking | null; fetcher?: Fetch } = {}): Promise<AllSyncResult> {
  const tracking = options.tracking === undefined ? newsletterTracking() : (options.tracking ?? undefined);
  const result: AllSyncResult = { cloud: { pulled: 0, optedOut: [], resubscribed: [], unknown: 0 }, tracking: null, errors: [] };
  try {
    result.cloud = await syncUnsubscribes();
  } catch (error) {
    result.errors.push(`myna cloud (${plainError(error)})`);
  }
  if (tracking) {
    try {
      result.tracking = await syncTrackingUnsubscribes(tracking, { fetcher: options.fetcher });
    } catch (error) {
      result.errors.push(`crawlproof (${plainError(error)})`);
    }
  }
  return result;
}

/** The refusal a send gives when an unsubscribe source could not be read. */
export function unsubscribePullError(errors: string[]): Error {
  return new Error(`Could not read unsubscribes from ${errors.join(" or ")}; not sending until they are applied.`);
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
