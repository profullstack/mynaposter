/**
 * Hand-offs: the steps only a person can do.
 *
 * myna posts everywhere it has an account. What is left after a launch is a
 * Reddit comment, a Hacker News submission, a LinkedIn reply: places with no
 * API worth automating, or none at all. A hand-off is that step written down
 * as a card: where, the exact text to paste, the page to open, the steps.
 * It lives here as a plain file and, when this machine is signed in to myna
 * cloud, at mynaposter.com/handoff/<id> too, so it can be done from a phone
 * with a copy button and a "done" that reports back.
 *
 * The cloud id is the whole secret: the page is public to anyone holding
 * the link and to nobody else, which is what a link to a phone needs.
 */
import { randomBytes } from "node:crypto";
import { readJson, writeJson } from "../util/json.ts";
import { HANDOFFS_FILE } from "../util/paths.ts";
import { getJson, postJson, request } from "../util/http.ts";
import { requireSession, session, DEFAULT_SERVER } from "./cloud.ts";

export interface Handoff {
  id: string;
  /** Where it has to be done: `r/ArtificialInteligence`, `Hacker News`, `LinkedIn`. */
  place: string;
  title: string;
  /** Ready to paste, verbatim. */
  text: string;
  /** The page to open: the thread, the submit form, the post. */
  openUrl?: string;
  steps: string[];
  /** Which of your accounts to do it from, when it matters. */
  account?: string;
  createdAt: string;
  doneAt?: string;
  /** Set once the card is published to myna cloud. */
  cloudId?: string;
  cloudUrl?: string;
}

export interface HandoffInput {
  place: string;
  title: string;
  text: string;
  openUrl?: string;
  steps?: string[];
  account?: string;
}

interface HandoffsFile {
  handoffs: Handoff[];
}

const read = (): HandoffsFile => readJson<HandoffsFile>(HANDOFFS_FILE, { handoffs: [] });
const write = (file: HandoffsFile): void => writeJson(HANDOFFS_FILE, file);

/** Keep the file bounded: done cards past this many are dropped, oldest first. */
const KEEP_DONE = 200;

const clean = (value: unknown, limit: number): string => String(value ?? "").trim().slice(0, limit);

/** Check and trim what a card carries. Exported so the server checks the same things. */
export function normaliseHandoff(input: HandoffInput): HandoffInput {
  const place = clean(input.place, 80);
  const title = clean(input.title, 200);
  const text = String(input.text ?? "").replace(/\r\n/g, "\n").trim().slice(0, 20_000);
  if (!place) throw new Error("A hand-off needs a place: where it has to be done.");
  if (!title) throw new Error("A hand-off needs a title.");
  if (!text) throw new Error("A hand-off needs the text to paste.");
  let openUrl: string | undefined;
  if (input.openUrl !== undefined && String(input.openUrl).trim()) {
    const raw = String(input.openUrl).trim().slice(0, 2000);
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`--open is not a URL: ${raw}`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("--open must be an http(s) URL.");
    openUrl = parsed.toString();
  }
  const steps = (input.steps ?? []).map((step) => clean(step, 300)).filter(Boolean).slice(0, 12);
  const account = input.account ? clean(input.account, 120) : undefined;
  return { place, title, text, ...(openUrl ? { openUrl } : {}), steps, ...(account ? { account } : {}) };
}

/** Open cards first, newest first; done cards after, when asked for. */
export function listHandoffs(options: { all?: boolean } = {}): Handoff[] {
  // Newest first; two cards made in the same millisecond keep their order.
  const all = read()
    .handoffs.map((card, index) => ({ card, index }))
    .sort((a, b) => b.card.createdAt.localeCompare(a.card.createdAt) || b.index - a.index)
    .map((entry) => entry.card);
  const open = all.filter((card) => !card.doneAt);
  return options.all ? [...open, ...all.filter((card) => card.doneAt)] : open;
}

/** By local id, or by the cloud id, or by an unambiguous prefix of either. */
export function getHandoff(ref: string): Handoff | undefined {
  const needle = ref.trim();
  if (!needle) return undefined;
  const cards = read().handoffs;
  return (
    cards.find((card) => card.id === needle || card.cloudId === needle) ??
    (() => {
      const matches = cards.filter((card) => card.id.startsWith(needle) || card.cloudId?.startsWith(needle));
      return matches.length === 1 ? matches[0] : undefined;
    })()
  );
}

export function addHandoff(input: HandoffInput): Handoff {
  const normal = normaliseHandoff(input);
  const card: Handoff = { id: randomBytes(4).toString("hex"), ...normal, steps: normal.steps ?? [], createdAt: new Date().toISOString() };
  const file = read();
  file.handoffs.push(card);
  const done = file.handoffs.filter((entry) => entry.doneAt).sort((a, b) => a.doneAt!.localeCompare(b.doneAt!));
  if (done.length > KEEP_DONE) {
    const drop = new Set(done.slice(0, done.length - KEEP_DONE).map((entry) => entry.id));
    file.handoffs = file.handoffs.filter((entry) => !drop.has(entry.id));
  }
  write(file);
  return card;
}

export function markHandoff(ref: string, done = true): Handoff | undefined {
  const file = read();
  const found = getHandoff(ref);
  const card = found && file.handoffs.find((entry) => entry.id === found.id);
  if (!card) return undefined;
  card.doneAt = done ? new Date().toISOString() : undefined;
  write(file);
  return card;
}

export function attachCloud(id: string, cloudId: string, cloudUrl: string): Handoff | undefined {
  const file = read();
  const card = file.handoffs.find((entry) => entry.id === id);
  if (!card) return undefined;
  card.cloudId = cloudId;
  card.cloudUrl = cloudUrl;
  write(file);
  return card;
}

export function removeHandoff(ref: string): boolean {
  const file = read();
  const found = getHandoff(ref);
  if (!found) return false;
  file.handoffs = file.handoffs.filter((entry) => entry.id !== found.id);
  write(file);
  return true;
}

// ---------------------------------------------------------------- the cloud half

/** A card as mynaposter.com serves it. */
export interface CloudHandoff {
  id: string;
  place: string;
  title: string;
  text: string;
  openUrl: string | null;
  steps: string[];
  account: string | null;
  createdAt: string;
  doneAt: string | null;
  /** The page a person opens. */
  url: string;
}

type Reply<T> = ({ ok: true } & T) | { ok: false; error?: string };

const base = (): string => (session()?.server ?? process.env.MYNA_SERVER ?? DEFAULT_SERVER).replace(/\/+$/, "");
const auth = (): Record<string, string> => ({ authorization: `Bearer ${requireSession().token}` });

/** `https://mynaposter.com/api` serves the site at `https://mynaposter.com`. */
export const siteUrl = (): string => base().replace(/\/api$/, "");
export const handoffUrl = (cloudId: string): string => `${siteUrl()}/handoff/${encodeURIComponent(cloudId)}`;

function unwrap<T>(reply: Reply<T>, fallback: string): T {
  if (!reply.ok) throw new Error(reply.error ?? fallback);
  return reply;
}

/** Is this machine signed in to myna cloud? Publishing needs it; nothing else does. */
export const cloudSignedIn = (): boolean => Boolean(session()?.token);

export async function publishHandoff(card: Handoff): Promise<CloudHandoff> {
  const body = { place: card.place, title: card.title, text: card.text, openUrl: card.openUrl, steps: card.steps, account: card.account };
  return unwrap(await postJson<Reply<{ handoff: CloudHandoff }>>(`${base()}/v1/handoff`, body, { headers: auth() }), "myna cloud refused the card.").handoff;
}

export async function readCloudHandoff(cloudId: string): Promise<CloudHandoff> {
  return unwrap(await getJson<Reply<{ handoff: CloudHandoff }>>(`${base()}/v1/handoff/${encodeURIComponent(cloudId)}`), "No such hand-off.").handoff;
}

export async function finishCloudHandoff(cloudId: string, done = true): Promise<CloudHandoff> {
  return unwrap(await postJson<Reply<{ handoff: CloudHandoff }>>(`${base()}/v1/handoff/${encodeURIComponent(cloudId)}/done`, { done }), "Could not mark it.").handoff;
}

export async function listCloudHandoffs(options: { all?: boolean } = {}): Promise<CloudHandoff[]> {
  return unwrap(await getJson<Reply<{ handoffs: CloudHandoff[] }>>(`${base()}/v1/handoff${options.all ? "?all=1" : ""}`, { headers: auth() }), "Could not list hand-offs.").handoffs;
}

export async function removeCloudHandoff(cloudId: string): Promise<boolean> {
  const reply = await request(`${base()}/v1/handoff/${encodeURIComponent(cloudId)}`, { method: "DELETE", headers: auth() });
  return ((await reply.json()) as { ok: boolean }).ok;
}
