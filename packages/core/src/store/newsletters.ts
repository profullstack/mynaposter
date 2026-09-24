/**
 * Newsletters: the issues, who each one reached, and how a subscriber leaves.
 *
 * An issue is a Markdown body and a subject aimed at one contacts list. The
 * subscribers are that list, so `myna contacts` and `myna newsletter` see the
 * same people, and the permanent opt-out in contacts.json is the unsubscribe.
 *
 * The delivery ledger is per issue and per contact. A recipient is marked
 * `pending` before the SMTP conversation starts and `sent` once the server
 * takes it, so a send that dies half way resumes where it stopped, and one
 * that died mid-message leaves a `pending` that is never mailed again without
 * being asked (the server may have taken it; nobody knows).
 *
 * Each subscriber gets one random unsubscribe token, kept here and nowhere
 * else: the server that hosts the one-click link sees the token, never the
 * address behind it.
 */
import { randomBytes } from "node:crypto";
import { readJson, writeJson } from "../util/json.ts";
import { NEWSLETTERS_FILE } from "../util/paths.ts";
import { slugify } from "../util/markdown.ts";

export type NewsletterStatus = "draft" | "scheduled" | "sending" | "sent";

export interface Newsletter {
  id: string;
  subject: string;
  /** Markdown. Sent as text and as HTML. */
  body: string;
  /** The contacts list it goes to. */
  list: string;
  status: NewsletterStatus;
  /** When the daemon sends it. Set means scheduled; a partial send resumes on its own. */
  scheduledFor: string | null;
  /** An SMTP server id; the first one when null. */
  smtp: string | null;
  replyTo: string | null;
  /** Overrides settings.newsletter.address for this issue. */
  address: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
}

export type DeliveryState = "pending" | "sent" | "failed";

export interface Delivery {
  state: DeliveryState;
  at: string;
  to: string;
  messageId?: string;
  error?: string;
}

export interface NewslettersFile {
  newsletters: Newsletter[];
  /** newsletter id → contact id → what happened. */
  deliveries: Record<string, Record<string, Delivery>>;
  /** contact id → unsubscribe token. */
  tokens: Record<string, string>;
  /** The myna cloud inbox the hosted unsubscribe links point at. */
  inbox: { id: string; server: string } | null;
  /** The newest unsubscribe already pulled from myna cloud. */
  unsubscribesSince: string | null;
}

export function readNewsletters(): NewslettersFile {
  const file = readJson<Partial<NewslettersFile>>(NEWSLETTERS_FILE, {});
  return {
    newsletters: Array.isArray(file.newsletters) ? file.newsletters : [],
    deliveries: file.deliveries ?? {},
    tokens: file.tokens ?? {},
    inbox: file.inbox ?? null,
    unsubscribesSince: file.unsubscribesSince ?? null,
  };
}

export function writeNewsletters(file: NewslettersFile): void {
  writeJson(NEWSLETTERS_FILE, file);
}

/** One line: a subject or an address with a newline in it is a header injection. */
const oneLine = (value: string): string => value.replace(/[\r\n]+/g, " ").trim();

export interface NewsletterInput {
  subject: string;
  body: string;
  list: string;
  id?: string;
  scheduledFor?: string | null;
  smtp?: string | null;
  replyTo?: string | null;
  address?: string | null;
}

export function getNewsletter(id: string, file = readNewsletters()): Newsletter | undefined {
  return file.newsletters.find((entry) => entry.id === id) ?? file.newsletters.find((entry) => entry.id.startsWith(id));
}

export function requireNewsletter(id: string, file = readNewsletters()): Newsletter {
  const found = getNewsletter(id, file);
  if (!found) throw new Error(`No newsletter "${id}". myna newsletter list shows them.`);
  return found;
}

export function createNewsletter(input: NewsletterInput, file = readNewsletters()): Newsletter {
  const subject = oneLine(input.subject);
  if (!subject) throw new Error("A newsletter needs a subject.");
  if (!input.body.trim()) throw new Error("A newsletter needs a body.");
  const list = input.list.trim().toLowerCase();
  if (!list) throw new Error("A newsletter needs a list to go to.");
  const base = input.id ? slugify(input.id) : slugify(subject).slice(0, 40).replace(/-+$/, "") || "issue";
  let id = base;
  for (let n = 2; file.newsletters.some((entry) => entry.id === id); n++) id = `${base}-${n}`;
  const now = new Date().toISOString();
  const scheduledFor = input.scheduledFor ?? null;
  const newsletter: Newsletter = {
    id,
    subject,
    body: input.body,
    list,
    status: scheduledFor ? "scheduled" : "draft",
    scheduledFor,
    smtp: input.smtp ?? null,
    replyTo: input.replyTo ? oneLine(input.replyTo) : null,
    address: input.address ?? null,
    createdAt: now,
    updatedAt: now,
    sentAt: null,
  };
  file.newsletters.push(newsletter);
  writeNewsletters(file);
  return newsletter;
}

export type NewsletterPatch = Partial<Omit<NewsletterInput, "id">> & { draft?: boolean };

export function editNewsletter(id: string, patch: NewsletterPatch, file = readNewsletters()): Newsletter {
  const newsletter = requireNewsletter(id, file);
  if (newsletter.status === "sent") throw new Error(`${newsletter.id} has been sent; it cannot change. myna newsletter create makes the next one.`);
  if (patch.subject !== undefined) {
    const subject = oneLine(patch.subject);
    if (!subject) throw new Error("A newsletter needs a subject.");
    newsletter.subject = subject;
  }
  if (patch.body !== undefined) {
    if (!patch.body.trim()) throw new Error("A newsletter needs a body.");
    newsletter.body = patch.body;
  }
  if (patch.list !== undefined) {
    if (newsletter.status === "sending") throw new Error(`${newsletter.id} is part way out to ${newsletter.list}; its list cannot change now.`);
    newsletter.list = patch.list.trim().toLowerCase();
  }
  if (patch.smtp !== undefined) newsletter.smtp = patch.smtp;
  if (patch.replyTo !== undefined) newsletter.replyTo = patch.replyTo ? oneLine(patch.replyTo) : null;
  if (patch.address !== undefined) newsletter.address = patch.address;
  if (patch.scheduledFor !== undefined) newsletter.scheduledFor = patch.scheduledFor;
  if (patch.draft) newsletter.scheduledFor = null;
  if (newsletter.status !== "sending") newsletter.status = newsletter.scheduledFor ? "scheduled" : "draft";
  newsletter.updatedAt = new Date().toISOString();
  writeNewsletters(file);
  return newsletter;
}

/** Remove an issue. Its ledger goes with it, so one that reached anyone needs `force`. */
export function removeNewsletter(id: string, options: { force?: boolean } = {}, file = readNewsletters()): boolean {
  const newsletter = getNewsletter(id, file);
  if (!newsletter) return false;
  const reached = Object.values(file.deliveries[newsletter.id] ?? {}).filter((entry) => entry.state !== "failed").length;
  if (reached && !options.force) throw new Error(`${newsletter.id} reached ${reached} people; removing it forgets who. Add --force to remove it anyway.`);
  file.newsletters = file.newsletters.filter((entry) => entry.id !== newsletter.id);
  delete file.deliveries[newsletter.id];
  writeNewsletters(file);
  return true;
}

/** The subscriber's unsubscribe token, made the first time it is asked for. */
export function tokenFor(contactId: string, file = readNewsletters()): string {
  const existing = file.tokens[contactId];
  if (existing) return existing;
  const token = randomBytes(16).toString("base64url");
  file.tokens[contactId] = token;
  writeNewsletters(file);
  return token;
}

/** The contact a token belongs to. */
export function contactForToken(token: string, file = readNewsletters()): string | undefined {
  return Object.entries(file.tokens).find(([, value]) => value === token)?.[0];
}

export function deliveriesFor(id: string, file = readNewsletters()): Record<string, Delivery> {
  return file.deliveries[id] ?? {};
}

export function recordDelivery(id: string, contactId: string, delivery: Delivery, file = readNewsletters()): void {
  (file.deliveries[id] ??= {})[contactId] = delivery;
  writeNewsletters(file);
}

export function tally(id: string, file = readNewsletters()): Record<DeliveryState, number> {
  const counts: Record<DeliveryState, number> = { pending: 0, sent: 0, failed: 0 };
  for (const entry of Object.values(file.deliveries[id] ?? {})) counts[entry.state]++;
  return counts;
}
