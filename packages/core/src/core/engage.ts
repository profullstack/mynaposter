/**
 * Follow-ups: what to send the people who engaged with your posts.
 *
 * Two halves, both run by the daemon and both available by hand. A scan reads
 * each account's notifications, keeps the ones that are a conversation (a
 * reply, a mention, a quote, a repost, a new follower), and queues a
 * follow-up for each: a reply the writer drafts from what they said, with the
 * original post as context, and a follow-back. A send works through the queue
 * on a pace, one account at a time, inside the daily cap.
 *
 * The queue is the design. Nothing is sent in the same breath it was noticed:
 * a person can `myna engage` and see every drafted reply before it goes,
 * skip one, or turn the whole thing off. Likes are not conversations and are
 * ignored unless asked. One follow-up per person per account per cooldown,
 * so someone who replies four times gets one answer, not four.
 */
import { getNetwork } from "../net/registry.ts";
import { listAccounts } from "../store/accounts.ts";
import { listHistory } from "../store/history.ts";
import { recordHistory } from "../store/history.ts";
import { loadSettings, type EngageSettings } from "../store/settings.ts";
import { followUpKey, hasSeen, markSeen, readEngage, writeEngage, type FollowUp, type FollowUpKind } from "../store/engage.ts";
import { replyDraft, writerAvailable, type ReplyRequest } from "../ai/writer.ts";
import type { Account, TimelineItem } from "../net/types.ts";

const DAY_MS = 86_400_000;

/** What a notification is, from the fields the adapters fill in. */
export function classify(item: TimelineItem): FollowUpKind | null {
  const kind = item.kind ?? item.text.split(":")[0]?.trim().toLowerCase();
  switch (kind) {
    case "reply":
    case "mention":
    case "quote":
    case "repost":
    case "like":
    case "follow":
      return kind;
    case "reblog":
    case "renote":
      return "repost";
    case "favourite":
    case "reaction":
      return "like";
    default:
      return null;
  }
}

/** Their words, without the `kind:` prefix the adapters put in front. */
export function bodyOf(item: TimelineItem): string {
  const colon = item.text.indexOf(":");
  const head = colon === -1 ? "" : item.text.slice(0, colon).trim().toLowerCase();
  if (colon !== -1 && /^[a-z]+$/.test(head)) return item.text.slice(colon + 1).trim();
  // A bare kind word ("repost", "follow") is the adapter saying they wrote nothing.
  if (/^[a-z]+$/.test(item.text.trim().toLowerCase()) && classify(item)) return "";
  return item.text.trim();
}

/** A handle as a mention on its network. */
export function mention(network: string, handle: string): string {
  const bare = handle.trim().replace(/^@/, "");
  if (!bare) return "";
  return `@${bare}`;
}

/** The post of ours a notification is about, from history, by id or url. */
export function ourPost(accountId: string, subjectId: string | undefined, history = listHistory()): { text: string; id?: string } | null {
  if (!subjectId) return null;
  const needle = subjectId.split("|")[0] ?? subjectId;
  for (const entry of history) {
    if (entry.accountId !== accountId || !entry.ok) continue;
    const id = entry.postId ?? "";
    if (id === needle || id.startsWith(`${needle}|`) || (entry.url && entry.url === subjectId)) {
      return { text: entry.text, id };
    }
  }
  return null;
}

/** The fixed reply used when the writer is not available. Honest and short. */
export function templateReply(kind: FollowUpKind, handle: string, followed: boolean): string {
  const who = handle ? `${handle} ` : "";
  if (kind === "repost") return `Thanks for sharing this, ${who}${followed ? "followed you back." : "appreciated."}`.replace(/ ,/g, ",");
  return `Thanks, ${who}${followed ? "followed you back." : "noted."}`.replace(/ ,/g, ",");
}

/** An id that stays unique across scans. */
const newId = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export type Drafter = (request: ReplyRequest) => Promise<string>;

export interface ScanOptions {
  log?: (line: string) => void;
  settings?: EngageSettings;
  /** The writer, injected so a test can fake it. */
  drafter?: Drafter;
  /** Whether the writer can run at all. */
  writerReady?: boolean;
  accounts?: Account[];
  now?: number;
}

export interface ScanResult {
  /** New follow-ups queued. */
  queued: FollowUp[];
  /** Notifications read, across accounts. */
  read: number;
  /** Accounts skipped and why. */
  skipped: string[];
}

function willing(settings: EngageSettings): Set<string> | null {
  const spec = settings.networks.trim();
  if (!spec || spec === "all") return null;
  return new Set(spec.split(",").map((id) => id.trim().toLowerCase()).filter(Boolean));
}

/**
 * Read notifications and queue follow-ups.
 *
 * Each account is read once. Every notification is marked seen whether or
 * not it became a follow-up, so a like or a stranger's spam is never
 * reconsidered. The same person inside the cooldown is folded into the
 * follow-up they already have.
 */
export async function scanEngagement(options: ScanOptions = {}): Promise<ScanResult> {
  const log = options.log ?? (() => {});
  const settings = options.settings ?? loadSettings().engage;
  const now = options.now ?? Date.now();
  const ready = options.writerReady ?? writerAvailable().ok;
  const draft = options.drafter ?? replyDraft;
  const accounts = options.accounts ?? listAccounts();
  const only = willing(settings);
  const file = readEngage();
  const history = listHistory();
  const ownHandles = new Set(accounts.map((account) => account.handle.toLowerCase().replace(/^@/, "")));
  const result: ScanResult = { queued: [], read: 0, skipped: [] };

  // The people this install already has a follow-up for, inside the cooldown.
  const recent = new Map<string, FollowUp>();
  for (const item of file.items) {
    if (now - Date.parse(item.createdAt) > settings.cooldownDays * DAY_MS) continue;
    if (item.status === "skipped" || item.status === "failed") continue;
    recent.set(followUpKey(item.accountId, item.handle), item);
  }

  for (const account of accounts) {
    if (only && !only.has(account.network)) continue;
    const network = getNetwork(account.network);
    if (!network?.notifications) continue;

    let items: TimelineItem[];
    try {
      items = await network.notifications(account, settings.scanLimit);
    } catch (error) {
      result.skipped.push(`${account.id}: ${(error as Error).message}`);
      continue;
    }
    result.read += items.length;

    // Oldest first, so a person's first reply is the one answered and a
    // queue read top to bottom is in the order things happened.
    const fresh = items.filter((item) => item.id && !hasSeen(file, account.id, item.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    markSeen(file, account.id, fresh.map((item) => item.id));

    for (const item of fresh) {
      const kind = classify(item);
      if (!kind) continue;
      const bare = item.handle.toLowerCase().replace(/^@/, "");
      if (!bare || ownHandles.has(bare)) continue;
      if (kind === "like" && !settings.followLikers) continue;

      const wantsReply =
        (kind === "reply" || kind === "mention" || kind === "quote") ? settings.replyToMentions : kind === "repost" ? settings.thankReposts : false;
      const follow = settings.followBack && Boolean(network.follow);
      if (!wantsReply && !follow) continue;

      const key = followUpKey(account.id, item.handle);
      const existing = recent.get(key);
      if (existing) {
        // Same person again inside the cooldown: keep their newest words on
        // the pending follow-up so the reply answers what they said last,
        // and never open a second one.
        if (existing.status === "pending" && bodyOf(item) && (kind === "reply" || kind === "mention" || kind === "quote")) {
          existing.theirText = bodyOf(item);
          existing.theirPostId = item.postId ?? existing.theirPostId;
          existing.kind = kind;
          if (existing.reply) {
            try {
              existing.reply = ready
                ? await draft({ kind, handle: mention(account.network, item.handle), theirText: existing.theirText, ...(existing.ourText ? { ourText: existing.ourText } : {}), network: account.network, followed: existing.follow })
                : templateReply(kind, mention(account.network, item.handle), existing.follow);
              existing.drafted = ready ? "writer" : "template";
            } catch (error) {
              log(`engage ${account.id} ${item.handle}: writer failed on a repeat (${(error as Error).message}); keeping the earlier reply`);
            }
          }
        }
        continue;
      }

      const ours = ourPost(account.id, item.subjectId, history);
      const followUp: FollowUp = {
        id: newId(),
        accountId: account.id,
        network: account.network,
        kind,
        handle: item.handle,
        author: item.author,
        theirText: bodyOf(item),
        ...(item.postId ? { theirPostId: item.postId } : {}),
        ...(item.url ? { theirUrl: item.url } : {}),
        ...(ours ? { ourText: ours.text, ...(ours.id ? { ourPostId: ours.id } : {}) } : {}),
        follow,
        status: "pending",
        createdAt: new Date(now).toISOString(),
        dueAt: new Date(now).toISOString(),
      };

      // A thank-you for a repost goes under the post they shared, so it needs
      // that post's id in the form the network replies to; a reply to their
      // words goes under their post. Without either there is nothing to reply
      // under, and the follow-up is a follow only.
      const target = kind === "repost" ? ours?.id : item.postId;
      if (wantsReply && target) {
        if (kind === "repost") followUp.theirPostId = target;
        try {
          if (ready) {
            followUp.reply = await draft({
              kind,
              handle: mention(account.network, item.handle),
              theirText: followUp.theirText,
              ...(ours ? { ourText: ours.text } : {}),
              network: account.network,
              followed: follow,
            });
            followUp.drafted = "writer";
          } else {
            followUp.reply = templateReply(kind, mention(account.network, item.handle), follow);
            followUp.drafted = "template";
          }
        } catch (error) {
          log(`engage ${account.id} ${item.handle}: writer failed (${(error as Error).message}); using the template`);
          followUp.reply = templateReply(kind, mention(account.network, item.handle), follow);
          followUp.drafted = "template";
        }
      }

      if (!followUp.reply && !followUp.follow) continue;
      file.items.push(followUp);
      recent.set(key, followUp);
      result.queued.push(followUp);
      log(`engage ${account.id}: ${kind} from ${item.handle}${followUp.reply ? ` → "${followUp.reply.slice(0, 60)}"` : ""}${followUp.follow ? " + follow" : ""}`);
    }
  }

  // Space the new ones out per account, after whatever is already due.
  const gap = settings.gapMinutes * 60_000;
  const lastDue = new Map<string, number>();
  for (const item of file.items) {
    if (item.status !== "pending" || result.queued.includes(item)) continue;
    lastDue.set(item.accountId, Math.max(lastDue.get(item.accountId) ?? 0, Date.parse(item.dueAt)));
  }
  for (const item of result.queued) {
    const due = Math.max(now, (lastDue.get(item.accountId) ?? 0) + gap);
    item.dueAt = new Date(due).toISOString();
    lastDue.set(item.accountId, due);
  }

  writeEngage(file);
  return result;
}

export interface SendOptions {
  log?: (line: string) => void;
  settings?: EngageSettings;
  /** At most this many this turn, across accounts. */
  limit?: number;
  accounts?: Account[];
  now?: number;
  /** Show what would be sent and send nothing. */
  dryRun?: boolean;
}

export interface SendResult {
  sent: FollowUp[];
  /** Why nothing, or less, was sent. */
  held: string[];
}

/** Follow-ups sent by an account in the last rolling day. */
export function sentToday(items: FollowUp[], accountId: string, now = Date.now()): number {
  return items.filter((item) => item.accountId === accountId && item.status === "sent" && item.sentAt && now - Date.parse(item.sentAt) < DAY_MS).length;
}

/**
 * Send what is due.
 *
 * Per account: never inside the gap of the last one sent, never past the
 * daily cap. A follow that fails does not stop the reply, and a reply that
 * fails is recorded with its reason and not retried, because the second
 * attempt at a reply is how someone gets two.
 */
export async function sendFollowUps(options: SendOptions = {}): Promise<SendResult> {
  const log = options.log ?? (() => {});
  const settings = options.settings ?? loadSettings().engage;
  const now = options.now ?? Date.now();
  const accounts = options.accounts ?? listAccounts();
  const file = readEngage();
  const result: SendResult = { sent: [], held: [] };
  let budget = options.limit ?? Number.POSITIVE_INFINITY;

  const lastSent = new Map<string, number>();
  for (const item of file.items) {
    if (item.status !== "sent" || !item.sentAt) continue;
    lastSent.set(item.accountId, Math.max(lastSent.get(item.accountId) ?? 0, Date.parse(item.sentAt)));
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
      item.error = "account is gone";
      continue;
    }
    if (sentToday(file.items, account.id, now) >= settings.maxPerDay) {
      result.held.push(`${account.id}: ${settings.maxPerDay} today already`);
      continue;
    }
    const last = lastSent.get(account.id) ?? 0;
    if (now - last < settings.gapMinutes * 60_000) {
      result.held.push(`${account.id}: inside the ${settings.gapMinutes} minute gap`);
      continue;
    }

    if (options.dryRun) {
      log(`would send ${account.id} → ${item.handle}: ${item.reply ?? "(follow only)"}${item.follow ? " + follow" : ""}`);
      result.sent.push(item);
      // The gap holds in a rehearsal too, or the rehearsal lies about the pace.
      lastSent.set(account.id, now);
      budget--;
      continue;
    }

    item.result = {};
    const errors: string[] = [];

    if (item.follow && network.follow) {
      try {
        const followed = await network.follow(account, item.handle);
        item.result.followed = !followed.already;
        item.result.alreadyFollowed = Boolean(followed.already);
      } catch (error) {
        errors.push(`follow: ${(error as Error).message}`);
      }
    }

    if (item.reply && item.theirPostId) {
      try {
        const posted = await network.post(account, { text: item.reply, replyTo: item.theirPostId });
        item.result.replyId = posted.id;
        item.result.replyUrl = posted.url;
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

    const anything = item.result.replyId || item.result.followed || item.result.alreadyFollowed;
    item.status = errors.length && !anything ? "failed" : "sent";
    item.sentAt = new Date(now).toISOString();
    if (errors.length) item.error = errors.join("; ");
    lastSent.set(account.id, now);
    result.sent.push(item);
    budget--;
    log(
      `engage ${account.id} → ${item.handle}: ${item.result.replyUrl ?? (item.result.replyId ? "replied" : "no reply")}` +
        `${item.result.followed ? ", followed" : item.result.alreadyFollowed ? ", already following" : ""}${errors.length ? `; ${errors.join("; ")}` : ""}`,
    );
  }

  writeEngage(file);
  return result;
}
