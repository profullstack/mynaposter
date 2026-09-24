/**
 * The upvoter: finding other people's posts worth amplifying, and amplifying them.
 *
 * Two halves, like follow-ups, and for the same reason. A scan works out what
 * we have been posting about (`topics.ts`), searches every connected network
 * for other people writing about the same thing, scores what comes back, and
 * queues an action against the ones that clear the bar. A run works through
 * that queue on a pace, one account at a time, inside the daily cap.
 *
 * Three things a scan can decide to do, and they escalate — each one includes
 * the one before it:
 *
 *   vote    a like, a favourite, a +1. The default, and almost always all.
 *   repost  vote, and share it onward. Louder, so rarer.
 *   reply   vote, and leave a comment carrying one of our links. Rarest by
 *           a wide margin, gated on a high score, a real topical overlap and
 *           a daily cap, and the writer is asked to decline whenever the link
 *           would not genuinely help the person reading.
 *
 * Nothing is acted on in the same breath it is found. `myna upvote` shows the
 * queue, including the drafted replies, before any of it goes out.
 *
 * On the networks that forbid this: Reddit's API terms prohibit automated
 * voting outright, so `settings.upvote.manualOnly` ships with reddit in it.
 * Those accounts are still scanned and still queued — the finding is useful —
 * but a run refuses to act on them unless a person names the network.
 */
import { getNetwork } from "../net/registry.ts";
import { listAccounts } from "../store/accounts.ts";
import { listHistory, recordHistory, type HistoryEntry } from "../store/history.ts";
import { loadSettings, type UpvoteSettings } from "../store/settings.ts";
import {
  authorKey,
  hasSeenPost,
  markSeenPost,
  noteAuthor,
  readUpvotes,
  recentlyActed,
  writeUpvotes,
  type UpvoteAction,
  type UpvoteItem,
} from "../store/upvote.ts";
import { bestLink, queriesFor, scoreAgainst, topicIndex, type TopicIndex } from "./topics.ts";
import { linkDropDraft, writerAvailable, type LinkDropRequest } from "../ai/writer.ts";
import type { Account, TimelineItem } from "../net/types.ts";

const DAY_MS = 86_400_000;

/** An id that stays unique across scans. */
const newId = (): string => `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** A comma list setting as a set, or null for "all". */
function listOf(spec: string): Set<string> | null {
  const trimmed = spec.trim();
  if (!trimmed || trimmed === "all") return null;
  return new Set(
    trimmed
      .split(",")
      .map((id) => id.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Networks that are queued but never acted on without a person naming them. */
export function manualOnly(settings: UpvoteSettings): Set<string> {
  return new Set(
    settings.manualOnly
      .split(",")
      .map((id) => id.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Whether this account's network is one we amplify on at all. */
export function willing(settings: UpvoteSettings, network: string): boolean {
  const allowed = listOf(settings.networks);
  return !allowed || allowed.has(network.toLowerCase());
}

/**
 * Every handle that is us, in the form a search result reports.
 *
 * Voting on our own posts is the failure mode that makes the whole thing
 * worthless, so this is matched loosely: with and without the `@`, and with
 * and without the instance suffix.
 */
export function ourHandles(accounts: Account[]): Set<string> {
  const set = new Set<string>();
  for (const account of accounts) {
    const bare = account.handle.trim().toLowerCase().replace(/^@/, "");
    if (!bare) continue;
    set.add(bare);
    set.add(`@${bare}`);
    const head = bare.split("@")[0];
    if (head) set.add(head);
    const host = bare.split(".")[0];
    if (host) set.add(host);
  }
  return set;
}

const isOurs = (item: TimelineItem, mine: Set<string>): boolean => {
  const handle = item.handle.trim().toLowerCase().replace(/^@/, "");
  if (!handle) return false;
  return mine.has(handle) || mine.has(handle.split("@")[0] ?? "");
};

export type LinkDrafter = (request: LinkDropRequest) => Promise<string>;

export interface UpvoteScanOptions {
  log?: (line: string) => void;
  settings?: UpvoteSettings;
  accounts?: Account[];
  /** Our own posts, injected so a test does not need a history file. */
  history?: HistoryEntry[];
  /** The topic index, injected so a test can pin what we are "about". */
  index?: TopicIndex;
  /** The writer, injected so a test can fake it. */
  drafter?: LinkDrafter;
  /** Whether the writer can run at all. When it cannot, no link is ever dropped. */
  writerReady?: boolean;
  now?: number;
}

export interface UpvoteScanResult {
  queued: UpvoteItem[];
  /** Posts read across every account and query. */
  read: number;
  /** Accounts and queries that went nowhere, and why. */
  skipped: string[];
  /** What was searched for, which is the honest answer to "why these posts". */
  queries: string[];
}

/** A candidate, before it is decided what to do about it. */
interface Candidate {
  account: Account;
  item: TimelineItem;
  score: number;
  matched: string[];
}

/**
 * How many of `n` candidates get the louder treatment.
 *
 * Rounds rather than floors, so a ratio of 0.15 over ten candidates is one
 * repost rather than none, but a `cap` always wins. With the shipped defaults
 * a busy day is thirty votes, four or five reposts and at most two replies.
 */
export function share(n: number, ratio: number, cap = Number.POSITIVE_INFINITY): number {
  if (n <= 0 || ratio <= 0) return 0;
  return Math.max(0, Math.min(n, cap, Math.round(n * ratio)));
}

/** Actions taken by an account in the last rolling day, optionally of one kind. */
export function actedToday(items: UpvoteItem[], accountId: string, now = Date.now(), action?: UpvoteAction): number {
  return items.filter(
    (item) =>
      item.accountId === accountId &&
      item.status === "done" &&
      Boolean(item.doneAt) &&
      now - Date.parse(item.doneAt as string) < DAY_MS &&
      (!action || item.action === action),
  ).length;
}

/**
 * Find posts worth amplifying and queue what to do about them.
 *
 * Every post read is marked seen, whether or not it was queued, so a scan
 * never reconsiders the same post — the alternative is re-scoring the whole
 * of every search result set on every pass and queueing things twice when a
 * topic shifts under it.
 */
export async function scanUpvotes(options: UpvoteScanOptions = {}): Promise<UpvoteScanResult> {
  const log = options.log ?? (() => {});
  const settings = options.settings ?? loadSettings().upvote;
  const now = options.now ?? Date.now();
  const accounts = options.accounts ?? listAccounts();
  const history = options.history ?? listHistory();
  const index = options.index ?? topicIndex(history, { days: settings.topicDays, now });
  const result: UpvoteScanResult = { queued: [], read: 0, skipped: [], queries: [] };

  if (!index.topics.length) {
    result.skipped.push("nothing posted recently enough to have a subject — the upvoter follows what you post");
    return result;
  }

  const queries = queriesFor(index, settings.queriesPerScan);
  result.queries = queries;
  if (!queries.length) {
    result.skipped.push("no search terms could be built from recent posts");
    return result;
  }

  const mine = ourHandles(accounts);
  const file = readUpvotes();
  const candidates: Candidate[] = [];
  const oldest = now - settings.maxAgeHours * 3_600_000;

  for (const account of accounts) {
    if (!willing(settings, account.network)) continue;
    const network = getNetwork(account.network);
    if (!network) continue;
    if (!network.search || !network.caps.search) {
      continue;
    }
    if (!network.upvote && !network.repost) {
      result.skipped.push(`${account.id}: nothing to cast — the adapter can search but not vote or share`);
      continue;
    }

    const seenThisPass = new Set<string>();
    for (const query of queries) {
      let found: TimelineItem[];
      try {
        found = await network.search(account, query, settings.searchLimit);
      } catch (error) {
        result.skipped.push(`${account.id} "${query}": ${(error as Error).message}`);
        continue;
      }
      result.read += found.length;

      const ids: string[] = [];
      for (const item of found) {
        if (!item.id || seenThisPass.has(item.id)) continue;
        seenThisPass.add(item.id);
        ids.push(item.id);
        if (hasSeenPost(file, account.id, item.id)) continue;
        if (isOurs(item, mine)) continue;

        const at = Date.parse(item.createdAt ?? "");
        if (Number.isFinite(at) && at < oldest) continue;
        if (recentlyActed(file, account.id, item.handle, settings.cooldownDays, now)) continue;

        const match = scoreAgainst(item.text, index);
        if (match.score < settings.minScore) continue;
        candidates.push({ account, item, score: match.score, matched: match.matched });
      }
      markSeenPost(file, account.id, ids);
    }
  }

  // Strongest matches first, and never more than a day's worth per account:
  // a scan that queues a week of work just means a week of stale votes.
  candidates.sort((a, b) => b.score - a.score);
  const perAccount = new Map<string, number>();
  const taken: Candidate[] = [];
  const claimed = new Set<string>();
  for (const candidate of candidates) {
    const used = perAccount.get(candidate.account.id) ?? 0;
    if (used >= settings.maxPerDay) continue;
    // One action per author per scan, whatever else of theirs matched.
    const key = authorKey(candidate.account.id, candidate.item.handle);
    if (claimed.has(key)) continue;
    claimed.add(key);
    perAccount.set(candidate.account.id, used + 1);
    taken.push(candidate);
  }

  // Decide what each one gets. The strongest matches earn the louder actions.
  const replyCount = share(taken.length, settings.linkRatio, settings.linkPerDay);
  const repostCount = share(taken.length, settings.repostRatio);
  const writerOk = options.writerReady ?? writerAvailable().ok;
  const drafter = options.drafter ?? linkDropDraft;

  let replies = 0;
  let reposts = 0;
  const queued: UpvoteItem[] = [];

  for (const candidate of taken) {
    const { account, item } = candidate;
    const network = getNetwork(account.network);
    let action: UpvoteAction = "vote";
    let reply: string | undefined;
    let link: string | undefined;
    let ourPostId: string | undefined;
    let drafted: "writer" | "template" | undefined;

    const wantsReply =
      replies < replyCount && candidate.score >= settings.linkMinScore && writerOk && Boolean(network?.caps.threads !== false);
    if (wantsReply) {
      const ours = bestLink(item.text, index);
      if (ours) {
        try {
          const text = await drafter({
            handle: item.handle,
            theirText: item.text,
            link: ours.url,
            ourText: ours.text,
            network: account.network,
          });
          // An empty draft is the writer declining, and a refusal is a result.
          if (text) {
            action = "reply";
            reply = text;
            link = ours.url;
            ourPostId = ours.id;
            drafted = "writer";
            replies += 1;
          } else {
            log(`upvote: writer declined a link under ${item.handle} on ${account.network}`);
          }
        } catch (error) {
          result.skipped.push(`${account.id} draft: ${(error as Error).message}`);
        }
      }
    }

    if (action === "vote" && reposts < repostCount && network?.repost) {
      action = "repost";
      reposts += 1;
    }

    queued.push({
      id: newId(),
      accountId: account.id,
      network: account.network,
      action,
      handle: item.handle,
      author: item.author,
      postId: item.id,
      ...(item.url ? { postUrl: item.url } : {}),
      postText: item.text.slice(0, 600),
      ...(item.createdAt ? { postedAt: item.createdAt } : {}),
      score: Number(candidate.score.toFixed(3)),
      matched: candidate.matched.slice(0, 6),
      ...(reply ? { reply } : {}),
      ...(link ? { link } : {}),
      ...(drafted ? { drafted } : {}),
      ...(ourPostId ? { ourPostId } : {}),
      status: "pending",
      createdAt: new Date(now).toISOString(),
      dueAt: new Date(now).toISOString(),
    });
  }

  // Space the new ones out per account, after whatever is already due.
  const gap = settings.gapMinutes * 60_000;
  const lastDue = new Map<string, number>();
  for (const item of file.items) {
    if (item.status !== "pending") continue;
    lastDue.set(item.accountId, Math.max(lastDue.get(item.accountId) ?? 0, Date.parse(item.dueAt)));
  }
  for (const item of queued) {
    const due = Math.max(now, (lastDue.get(item.accountId) ?? 0) + gap);
    item.dueAt = new Date(due).toISOString();
    lastDue.set(item.accountId, due);
  }

  file.items.push(...queued);
  result.queued = queued;
  writeUpvotes(file);
  return result;
}

export interface UpvoteRunOptions {
  log?: (line: string) => void;
  settings?: UpvoteSettings;
  accounts?: Account[];
  /** At most this many this turn, across accounts. */
  limit?: number;
  /**
   * Act on these networks even when they are `manualOnly`. This is a person
   * saying so: `myna upvote send --network reddit`.
   */
  networks?: string[];
  now?: number;
  /** Show what would happen and do nothing. */
  dryRun?: boolean;
}

export interface UpvoteRunResult {
  done: UpvoteItem[];
  /** Why nothing, or less, happened. */
  held: string[];
}

/**
 * Work through what is due.
 *
 * Per account: never inside the gap of the last action, never past the daily
 * cap, never past the separate daily cap on replies carrying a link. A repost
 * that fails does not undo the vote that succeeded, and a failure is recorded
 * with its reason and not retried — a second attempt at a reply is how
 * somebody gets two of them.
 */
export async function runUpvotes(options: UpvoteRunOptions = {}): Promise<UpvoteRunResult> {
  const log = options.log ?? (() => {});
  const settings = options.settings ?? loadSettings().upvote;
  const now = options.now ?? Date.now();
  const accounts = options.accounts ?? listAccounts();
  const file = readUpvotes();
  const result: UpvoteRunResult = { done: [], held: [] };
  let budget = options.limit ?? Number.POSITIVE_INFINITY;

  const manual = manualOnly(settings);
  const asked = new Set((options.networks ?? []).map((id) => id.trim().toLowerCase()).filter(Boolean));

  const lastDone = new Map<string, number>();
  for (const item of file.items) {
    if (item.status !== "done" || !item.doneAt) continue;
    lastDone.set(item.accountId, Math.max(lastDone.get(item.accountId) ?? 0, Date.parse(item.doneAt)));
  }

  const due = file.items
    .filter((item) => item.status === "pending" && Date.parse(item.dueAt) <= now)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));

  for (const item of due) {
    if (budget <= 0) break;
    const account = accounts.find((entry) => entry.id === item.accountId);
    const network = account ? getNetwork(account.network) : undefined;
    if (!account || !network) {
      item.status = "skipped";
      item.reason = "account is gone";
      continue;
    }
    if (manual.has(item.network.toLowerCase()) && !asked.has(item.network.toLowerCase())) {
      result.held.push(`${item.network}: voting there is manual only (myna upvote send --network ${item.network})`);
      continue;
    }
    if (actedToday(file.items, account.id, now) >= settings.maxPerDay) {
      result.held.push(`${account.id}: ${settings.maxPerDay} today already`);
      continue;
    }
    if (item.action === "reply" && actedToday(file.items, account.id, now, "reply") >= settings.linkPerDay) {
      result.held.push(`${account.id}: ${settings.linkPerDay} links today already`);
      continue;
    }
    const last = lastDone.get(account.id) ?? 0;
    if (now - last < settings.gapMinutes * 60_000) {
      result.held.push(`${account.id}: inside the ${settings.gapMinutes} minute gap`);
      continue;
    }
    // The queue may have sat a while; the author may have been acted on since.
    if (recentlyActed(file, account.id, item.handle, settings.cooldownDays, now)) {
      item.status = "skipped";
      item.reason = `already acted on ${item.handle} inside the ${settings.cooldownDays} day cooldown`;
      continue;
    }

    const ref = item.postId || item.postUrl || "";
    if (!ref) {
      item.status = "skipped";
      item.reason = "no post reference to act on";
      continue;
    }

    if (options.dryRun) {
      log(
        `would ${item.action} ${account.id} → ${item.handle} (${item.score}) ${item.postUrl ?? item.postId}` +
          (item.reply ? `\n    reply: ${item.reply}` : ""),
      );
      result.done.push(item);
      // The gap holds in a rehearsal too, or the rehearsal lies about the pace.
      lastDone.set(account.id, now);
      budget -= 1;
      continue;
    }

    item.result = {};
    const errors: string[] = [];
    let anything = false;

    if (network.upvote) {
      try {
        const vote = await network.upvote(account, ref, 1);
        item.result.id = vote.id;
        item.result.url = vote.url ?? item.postUrl;
        item.result.already = vote.already;
        anything = true;
      } catch (error) {
        errors.push(`vote: ${(error as Error).message}`);
      }
    } else if (item.action === "vote") {
      // Nothing else to do and no way to do it.
      item.status = "skipped";
      item.reason = `${item.network} cannot vote`;
      continue;
    }

    if (item.action === "repost" && network.repost) {
      try {
        const shared = await network.repost(account, ref);
        item.result.url = shared.url ?? item.result.url;
        anything = true;
      } catch (error) {
        errors.push(`repost: ${(error as Error).message}`);
      }
    }

    if (item.action === "reply" && item.reply) {
      try {
        const posted = await network.post(account, { text: item.reply, replyTo: ref });
        item.result.url = posted.url ?? item.result.url;
        anything = true;
        recordHistory([
          {
            at: new Date(now).toISOString(),
            accountId: account.id,
            network: account.network,
            handle: account.handle,
            text: item.reply,
            ok: true,
            type: "reply",
            postId: posted.id,
            ...(posted.url ? { url: posted.url } : {}),
          },
        ]);
      } catch (error) {
        errors.push(`reply: ${(error as Error).message}`);
      }
    }

    item.status = errors.length && !anything ? "failed" : "done";
    item.doneAt = new Date(now).toISOString();
    if (errors.length) item.error = errors.join("; ");
    if (item.status === "done") noteAuthor(file, account.id, item.handle, item.doneAt);
    lastDone.set(account.id, now);
    result.done.push(item);
    budget -= 1;
    log(
      `upvote ${account.id} ${item.action} → ${item.handle} (${item.score})` +
        `${item.result.already ? " (already)" : ""}${errors.length ? `; ${errors.join("; ")}` : ""}`,
    );
  }

  writeUpvotes(file);
  return result;
}
