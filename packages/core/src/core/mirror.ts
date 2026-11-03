/**
 * Mirror accounts (`myna account mirror`).
 *
 * A mirror never posts anything of its own. The daemon reads the source
 * account's profile every few minutes and, for each NEW original post (not a
 * reply, not a repost of someone else), reposts and/or likes it from the
 * mirror account, exactly once.
 *
 * Exactly once is the ledger in mirror.json: a post is recorded the moment it
 * is seen (pending, with a due time) and each action is written back the
 * moment it succeeds, so a crash between the repost and the like retries only
 * the like. The network's own viewer flags are a second check: a post this
 * account already reposted or liked is not done again.
 *
 * Pacing: each post goes out 1-10 minutes after it was published, at least a
 * couple of minutes after the previous mirror action, and one per account per
 * daemon turn, so a backlog (the first enable, a daemon that was down) drains
 * slowly instead of bursting.
 *
 * Only networks whose adapter has `authorFeed` can be mirrored; Bluesky is
 * the first.
 */
import { getNetwork } from "../net/registry.ts";
import type { Account, TimelineItem } from "../net/types.ts";
import { getAccount, mirrorAccounts } from "../store/accounts.ts";
import { readJson, writeJson } from "../util/json.ts";

export const MIRROR_FILE = "mirror.json";

/** How often the source profile is read. */
export const MIRROR_POLL_MS = 5 * 60_000;
/** A post goes out this long after it was published, at the earliest… */
const MIN_DELAY_MS = 60_000;
/** …and at the latest (before spacing pushes a backlog further out). */
const MAX_DELAY_MS = 10 * 60_000;
/** The gap between two mirror actions from one account. */
const MIN_SPACING_MS = 2 * 60_000;
const MAX_SPACING_MS = 5 * 60_000;
/** A failing post is retried this many times, then recorded as failed. */
const MAX_ATTEMPTS = 5;
const RETRY_MS = 10 * 60_000;
/** Done entries kept per account; the feed window is far smaller. */
const DONE_LIMIT = 2_000;

export interface MirrorPending {
  /** The post as `repost`/`upvote` take it (Bluesky `uri|cid`). */
  postId: string;
  url?: string;
  text: string;
  createdAt: string;
  dueAt: string;
  attempts?: number;
  lastError?: string;
  /** Set once each action has gone through, so a retry never repeats it. */
  reposted?: string;
  liked?: string;
}

export interface MirrorDone {
  postId: string;
  url?: string;
  createdAt: string;
  at: string;
  reposted?: string;
  liked?: string;
  /** Already reposted/liked on the network before myna got to it. */
  already?: boolean;
  error?: string;
}

export interface MirrorAccountState {
  polledAt?: string;
  lastActionAt?: string;
  pending: MirrorPending[];
  done: MirrorDone[];
}

export interface MirrorFile {
  accounts: Record<string, MirrorAccountState>;
}

export const readMirrorState = (): MirrorFile => {
  const file = readJson<Partial<MirrorFile>>(MIRROR_FILE, {});
  return { accounts: file.accounts ?? {} };
};
const writeMirrorState = (file: MirrorFile): void => writeJson(MIRROR_FILE, file);

const stateFor = (file: MirrorFile, id: string): MirrorAccountState => {
  const state = (file.accounts[id] ??= { pending: [], done: [] });
  state.pending ??= [];
  state.done ??= [];
  return state;
};

/** The URI part of a post id: the same post whatever cid or composite form it was seen in. */
const keyOf = (postId: string): string => postId.split("|")[0];

/** The actor to read: the source account's DID or handle, or the bare handle it was given as. */
export function mirrorActor(from: string): string {
  const source = getAccount(from);
  if (source) return source.meta?.did || source.handle;
  return from.includes(":") && !from.startsWith("did:") ? from.slice(from.indexOf(":") + 1) : from;
}

/**
 * Which feed items a mirror should act on: the source's own original posts,
 * published on or after `since`, not yet seen. Pure, for tests.
 */
export function selectOriginals(
  items: TimelineItem[],
  options: { actor: string; since: string; seen: Set<string> },
): TimelineItem[] {
  const since = Date.parse(options.since);
  const actor = options.actor.toLowerCase();
  const out: TimelineItem[] = [];
  const picked = new Set<string>();
  for (const item of items) {
    if (item.isRepost || item.isReply) continue;
    // Only their own posts: an author feed should hold nothing else once
    // reposts are dropped, but the author check costs nothing.
    const by = [item.authorId, item.handle].filter(Boolean).map((value) => String(value).toLowerCase());
    if (by.length && !by.includes(actor)) continue;
    const created = Date.parse(item.createdAt);
    if (!Number.isFinite(created) || created < since) continue;
    const key = keyOf(item.id);
    if (options.seen.has(key) || picked.has(key)) continue;
    picked.add(key);
    out.push(item);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export interface MirrorTurnOptions {
  now?: number;
  log?: (line: string) => void;
  /** 0..1, for tests. */
  random?: () => number;
  /** Read the feed even if the last read was under MIRROR_POLL_MS ago. */
  forcePoll?: boolean;
  /** Ignore due times and act on every pending post now (still one at a time). For `myna account mirror --run`. */
  ignoreDue?: boolean;
  /** Only this mirror account. */
  only?: string;
}

export interface MirrorAction {
  account: string;
  postId: string;
  url?: string;
  reposted?: string;
  liked?: string;
  already?: boolean;
  error?: string;
}

export interface MirrorTurn {
  queued: number;
  actions: MirrorAction[];
  errors: string[];
}

/** One daemon turn over every mirror account. */
export async function runMirrors(options: MirrorTurnOptions = {}): Promise<MirrorTurn> {
  const now = options.now ?? Date.now();
  const random = options.random ?? Math.random;
  const turn: MirrorTurn = { queued: 0, actions: [], errors: [] };
  const mirrors = mirrorAccounts().filter((account) => !options.only || account.id === options.only);
  if (!mirrors.length) return turn;

  for (const account of mirrors) {
    try {
      await mirrorOne(account, { ...options, now, random }, turn);
    } catch (error) {
      turn.errors.push(`${account.id}: ${(error as Error).message}`);
    }
  }
  return turn;
}

async function mirrorOne(
  account: Account,
  options: MirrorTurnOptions & { now: number; random: () => number },
  turn: MirrorTurn,
): Promise<void> {
  const cfg = account.mirror!;
  const network = getNetwork(account.network);
  if (!network) throw new Error(`unknown network ${account.network}`);
  if (!network.authorFeed) throw new Error(`${network.name} cannot be mirrored yet (no author feed)`);
  const { now, random } = options;

  // 1. Read the source's profile and ledger every new original post.
  let file = readMirrorState();
  let state = stateFor(file, account.id);
  const polledAt = state.polledAt ? Date.parse(state.polledAt) : 0;
  if (options.forcePoll || now - polledAt >= MIRROR_POLL_MS) {
    const actor = mirrorActor(cfg.from);
    const items = await network.authorFeed(account, actor, 30);
    // Re-read: the network call took time, and nothing else may be lost.
    file = readMirrorState();
    state = stateFor(file, account.id);
    const seen = new Set([...state.pending.map((p) => keyOf(p.postId)), ...state.done.map((d) => keyOf(d.postId))]);
    const fresh = selectOriginals(items, { actor, since: cfg.since, seen });
    let last = Math.max(
      state.lastActionAt ? Date.parse(state.lastActionAt) : 0,
      ...state.pending.map((p) => Date.parse(p.dueAt)),
    );
    for (const item of fresh) {
      const covered = (!cfg.repost || item.viewerReposted) && (!cfg.like || item.viewerLiked);
      if (covered) {
        state.done.push({ postId: item.id, url: item.url, createdAt: item.createdAt, at: new Date(now).toISOString(), already: true });
        continue;
      }
      const delay = MIN_DELAY_MS + random() * (MAX_DELAY_MS - MIN_DELAY_MS);
      const spacing = MIN_SPACING_MS + random() * (MAX_SPACING_MS - MIN_SPACING_MS);
      const due = Math.max(Date.parse(item.createdAt) + delay, last ? last + spacing : 0, now);
      last = due;
      state.pending.push({
        postId: item.id,
        url: item.url,
        text: item.text.replace(/\s+/g, " ").slice(0, 120),
        createdAt: item.createdAt,
        dueAt: new Date(due).toISOString(),
        // A flag the network already reports is an action not to repeat.
        ...(item.viewerReposted ? { reposted: "already" } : {}),
        ...(item.viewerLiked ? { liked: "already" } : {}),
      });
      turn.queued++;
    }
    state.polledAt = new Date(now).toISOString();
    if (state.done.length > DONE_LIMIT) state.done = state.done.slice(-DONE_LIMIT);
    writeMirrorState(file);
  }

  // 2. Act on at most one due post: no bursts.
  state.pending.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const next = state.pending.find((p) => options.ignoreDue || Date.parse(p.dueAt) <= now);
  if (!next) return;

  const action: MirrorAction = { account: account.id, postId: next.postId, url: next.url };
  const save = (mutate: (entry: MirrorPending, state: MirrorAccountState) => void) => {
    const fresh = readMirrorState();
    const s = stateFor(fresh, account.id);
    const entry = s.pending.find((p) => p.postId === next.postId);
    if (entry) mutate(entry, s);
    writeMirrorState(fresh);
  };

  try {
    if (cfg.repost && !next.reposted) {
      if (!network.repost) throw new Error(`${network.name} cannot repost`);
      const result = await network.repost(account, next.postId);
      next.reposted = result.id;
      action.reposted = result.id;
      save((entry, s) => {
        entry.reposted = result.id;
        s.lastActionAt = new Date(now).toISOString();
      });
    }
    if (cfg.like && !next.liked) {
      if (!network.upvote) throw new Error(`${network.name} cannot like`);
      const result = await network.upvote(account, next.postId, 1);
      next.liked = result.id ?? (result.already ? "already" : "ok");
      action.liked = next.liked;
      if (result.already) action.already = true;
      save((entry, s) => {
        entry.liked = next.liked;
        s.lastActionAt = new Date(now).toISOString();
      });
    }
    save((entry, s) => {
      s.pending = s.pending.filter((p) => p.postId !== entry.postId);
      s.done.push({
        postId: entry.postId,
        url: entry.url,
        createdAt: entry.createdAt,
        at: new Date(now).toISOString(),
        ...(entry.reposted ? { reposted: entry.reposted } : {}),
        ...(entry.liked ? { liked: entry.liked } : {}),
      });
      if (s.done.length > DONE_LIMIT) s.done = s.done.slice(-DONE_LIMIT);
    });
  } catch (error) {
    const message = (error as Error).message;
    action.error = message;
    save((entry, s) => {
      entry.attempts = (entry.attempts ?? 0) + 1;
      entry.lastError = message;
      if (entry.attempts >= MAX_ATTEMPTS) {
        s.pending = s.pending.filter((p) => p.postId !== entry.postId);
        s.done.push({
          postId: entry.postId,
          url: entry.url,
          createdAt: entry.createdAt,
          at: new Date(now).toISOString(),
          ...(entry.reposted ? { reposted: entry.reposted } : {}),
          ...(entry.liked ? { liked: entry.liked } : {}),
          error: message,
        });
      } else {
        entry.dueAt = new Date(now + RETRY_MS).toISOString();
      }
    });
  }
  turn.actions.push(action);
}

/** One line per action for the daemon log. */
export function describeMirrorTurn(turn: MirrorTurn): string | undefined {
  const parts: string[] = [];
  if (turn.queued) parts.push(`${turn.queued} new post${turn.queued === 1 ? "" : "s"} queued`);
  for (const action of turn.actions) {
    const did = [action.reposted ? "reposted" : "", action.liked ? "liked" : ""].filter(Boolean).join("+") || "nothing";
    parts.push(action.error ? `${action.account} failed on ${action.url ?? action.postId}: ${action.error}` : `${action.account} ${did} ${action.url ?? action.postId}`);
  }
  for (const error of turn.errors) parts.push(`error ${error}`);
  return parts.length ? parts.join("; ") : undefined;
}
