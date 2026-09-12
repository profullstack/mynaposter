/**
 * The follow-up queue.
 *
 * `engage.json` holds what came back on this install's posts (a reply, a
 * repost, a new follower), what myna decided to send them (a drafted reply,
 * a follow-back), and what happened. The daemon fills it on a scan and works
 * through it on a pace, and `myna engage` shows it, so nothing is sent that
 * a person could not have seen coming.
 *
 * `seen` remembers which notifications have already been considered, per
 * account, so a scan never queues the same reply twice.
 */
import { readJson, writeJson } from "../util/json.ts";
import { ENGAGE_FILE } from "../util/paths.ts";

export type FollowUpKind = "reply" | "mention" | "quote" | "repost" | "like" | "follow";

export interface FollowUp {
  id: string;
  accountId: string;
  network: string;
  /** What they did. */
  kind: FollowUpKind;
  /** Who, as the network names them. */
  handle: string;
  author: string;
  /** What they wrote, when they wrote something. */
  theirText: string;
  /** Their post, in the form the network's `replyTo` takes. */
  theirPostId?: string;
  theirUrl?: string;
  /** This account's post it concerns, and its text when history had it. */
  ourPostId?: string;
  ourText?: string;
  /** The reply to send, or nothing. */
  reply?: string;
  /** Whether the reply came from the writer or a fixed template. */
  drafted?: "writer" | "template";
  /** Whether to follow them. */
  follow: boolean;
  status: "pending" | "sent" | "skipped" | "failed";
  createdAt: string;
  /** Not before. Spaces follow-ups out so an account does not answer ten people in one minute. */
  dueAt: string;
  sentAt?: string;
  result?: { replyUrl?: string; replyId?: string; followed?: boolean; alreadyFollowed?: boolean };
  error?: string;
}

export interface EngageFile {
  /** Notification ids already considered, newest last, per account. */
  seen: Record<string, string[]>;
  items: FollowUp[];
}

const SEEN_LIMIT = 500;
const ITEM_LIMIT = 2000;

export function readEngage(): EngageFile {
  const file = readJson<Partial<EngageFile>>(ENGAGE_FILE, {});
  return { seen: file.seen ?? {}, items: Array.isArray(file.items) ? file.items : [] };
}

export function writeEngage(file: EngageFile): void {
  for (const key of Object.keys(file.seen)) file.seen[key] = (file.seen[key] ?? []).slice(-SEEN_LIMIT);
  if (file.items.length > ITEM_LIMIT) {
    // Keep every pending item and the newest of the rest.
    const pending = file.items.filter((item) => item.status === "pending");
    const done = file.items.filter((item) => item.status !== "pending").slice(-(ITEM_LIMIT - pending.length));
    file.items = [...done, ...pending].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  writeJson(ENGAGE_FILE, file);
}

export function markSeen(file: EngageFile, accountId: string, ids: string[]): void {
  const list = file.seen[accountId] ?? [];
  const known = new Set(list);
  for (const id of ids) if (!known.has(id)) list.push(id);
  file.seen[accountId] = list;
}

export function hasSeen(file: EngageFile, accountId: string, id: string): boolean {
  return (file.seen[accountId] ?? []).includes(id);
}

export function updateFollowUp(id: string, patch: Partial<FollowUp>): FollowUp | undefined {
  const file = readEngage();
  const item = file.items.find((entry) => entry.id === id);
  if (!item) return undefined;
  Object.assign(item, patch);
  writeEngage(file);
  return item;
}

export function listFollowUps(): FollowUp[] {
  return readEngage().items;
}

export function clearEngage(): void {
  writeEngage({ seen: {}, items: [] });
}

export const followUpKey = (accountId: string, handle: string): string =>
  `${accountId}|${handle.trim().toLowerCase().replace(/^@/, "")}`;
