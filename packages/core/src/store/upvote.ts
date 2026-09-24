/**
 * The upvote queue.
 *
 * `upvote.json` holds what a scan found worth amplifying — somebody else's
 * post that is about what we are about — what myna decided to do with it (a
 * vote, a share, once in a while a reply carrying one of our links), and what
 * happened. The daemon fills it on a scan and works through it on a pace.
 *
 * The queue is the design, for the same reason `engage.json` is: nothing is
 * acted on in the same breath it was found. A person can run `myna upvote`
 * and see every queued action before it goes, drop one, or turn the whole
 * thing off. `seen` remembers which posts have already been considered, per
 * account, so a scan never queues the same post twice — and `authors`
 * remembers who was last acted on, so one prolific writer who happens to
 * match every topic does not get voted on all day.
 */
import { readJson, writeJson } from "../util/json.ts";
import { UPVOTE_FILE } from "../util/paths.ts";

/**
 * What myna does with a post it found. They escalate: each one includes the
 * one before it, so a `reply` votes as well, and one post is one action
 * against its author however loud that action is.
 *
 * `vote` is the cheap one and the default. `repost` is louder and rarer.
 * `reply` is the only one that writes words, carries a link, and is capped
 * hardest — it is a comment on somebody else's post, and the difference
 * between useful and spam is entirely how seldom it happens.
 */
export type UpvoteAction = "vote" | "repost" | "reply";

export type UpvoteStatus = "pending" | "done" | "skipped" | "failed";

export interface UpvoteItem {
  id: string;
  /** The account that will act, and the network it is on. */
  accountId: string;
  network: string;
  /** What to do. */
  action: UpvoteAction;
  /** Whose post it is, as the network names them. */
  handle: string;
  author: string;
  /** The post: the network's id, the URL, and enough text to judge it by. */
  postId: string;
  /**
   * What `PostInput.replyTo` needs to land a reply under it, where that is not
   * the same string as `postId` — Bluesky wants the thread root alongside the
   * post. Absent when the network's own id is enough.
   */
  replyTo?: string;
  postUrl?: string;
  postText: string;
  postedAt?: string;
  /** 0-1, how well it matched our topics. Kept so a person can see why. */
  score: number;
  /** The terms it matched on, which is the honest answer to "why this one". */
  matched: string[];
  /** For a reply: the words to send, and the link they carry. */
  reply?: string;
  link?: string;
  /** Whether the reply came from the writer or a fixed template. */
  drafted?: "writer" | "template";
  /** The post of ours the link points at, so a log can say what was promoted. */
  ourPostId?: string;
  status: UpvoteStatus;
  createdAt: string;
  /** Not before. Spaces actions out so an account does not vote twenty times in a minute. */
  dueAt: string;
  doneAt?: string;
  result?: { id?: string; url?: string; already?: boolean };
  error?: string;
  /** Why it was skipped, when a person or a rule dropped it. */
  reason?: string;
}

export interface UpvoteFile {
  /** Post ids already considered, newest last, per account. */
  seen: Record<string, string[]>;
  /**
   * When each author was last acted on, per account, as
   * `accountId|handle` -> ISO. What the cooldown reads.
   */
  authors: Record<string, string>;
  items: UpvoteItem[];
}

const SEEN_LIMIT = 2000;
const ITEM_LIMIT = 2000;

export function readUpvotes(): UpvoteFile {
  const file = readJson<Partial<UpvoteFile>>(UPVOTE_FILE, {});
  return {
    seen: file.seen ?? {},
    authors: file.authors ?? {},
    items: Array.isArray(file.items) ? file.items : [],
  };
}

export function writeUpvotes(file: UpvoteFile): void {
  for (const key of Object.keys(file.seen)) file.seen[key] = (file.seen[key] ?? []).slice(-SEEN_LIMIT);
  if (file.items.length > ITEM_LIMIT) {
    // Keep every pending item and the newest of the rest, the same rule the
    // follow-up queue uses: history is nice, but a due action is load-bearing.
    const pending = file.items.filter((item) => item.status === "pending");
    const done = file.items.filter((item) => item.status !== "pending").slice(-(ITEM_LIMIT - pending.length));
    file.items = [...done, ...pending].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  writeJson(UPVOTE_FILE, file);
}

export function markSeenPost(file: UpvoteFile, accountId: string, ids: string[]): void {
  const list = file.seen[accountId] ?? [];
  const known = new Set(list);
  for (const id of ids) if (!known.has(id)) list.push(id);
  file.seen[accountId] = list;
}

export function hasSeenPost(file: UpvoteFile, accountId: string, id: string): boolean {
  return (file.seen[accountId] ?? []).includes(id);
}

/** The key an author cooldown is kept under. Handles differ in case and in `@`. */
export const authorKey = (accountId: string, handle: string): string =>
  `${accountId}|${handle.trim().toLowerCase().replace(/^@/, "")}`;

/**
 * True when this account acted on this author inside the cooldown. A scan
 * asks before queueing and a send asks again before acting, because the
 * queue may have sat for a while.
 */
export function recentlyActed(file: UpvoteFile, accountId: string, handle: string, cooldownDays: number, now = Date.now()): boolean {
  if (cooldownDays <= 0) return false;
  const at = file.authors[authorKey(accountId, handle)];
  if (!at) return false;
  const then = Date.parse(at);
  return Number.isFinite(then) && now - then < cooldownDays * 86_400_000;
}

export function noteAuthor(file: UpvoteFile, accountId: string, handle: string, at = new Date().toISOString()): void {
  file.authors[authorKey(accountId, handle)] = at;
}

export function updateUpvote(id: string, patch: Partial<UpvoteItem>): UpvoteItem | undefined {
  const file = readUpvotes();
  const item = file.items.find((entry) => entry.id === id);
  if (!item) return undefined;
  Object.assign(item, patch);
  writeUpvotes(file);
  return item;
}

export function listUpvotes(): UpvoteItem[] {
  return readUpvotes().items;
}

export function clearUpvotes(): void {
  writeUpvotes({ seen: {}, authors: {}, items: [] });
}
