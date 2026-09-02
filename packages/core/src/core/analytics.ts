/**
 * What happened to the things you posted.
 *
 * Two sources, deliberately kept apart. History is local and free: myna already
 * records every send, so volume, success rate and timing need no network at all
 * and are always available. Engagement is remote and expensive — one API call
 * per post, per network — so it is fetched on request and cached, and the
 * screen renders whatever the cache has.
 *
 * Everything here is a pure function over those two inputs, so the numbers on
 * the screen can be tested without a terminal or a network.
 */
import type { HistoryEntry } from "../store/history.ts";
import type { PostStats } from "../net/types.ts";

export interface EngagementRecord extends PostStats {
  accountId: string;
  postId: string;
  /** When the figures were last fetched. */
  at: string;
}

export interface DayBucket {
  /** YYYY-MM-DD. */
  day: string;
  sent: number;
  failed: number;
}

export interface NetworkBreakdown {
  network: string;
  sent: number;
  failed: number;
  /** 0..1, or null when nothing was attempted. */
  rate: number | null;
  likes: number;
  reposts: number;
  replies: number;
}

export interface Totals {
  posts: number;
  sent: number;
  failed: number;
  rate: number | null;
  networks: number;
  likes: number;
  reposts: number;
  replies: number;
  /** Engagement per successful post, where any figures are known. */
  perPost: number | null;
  measured: number;
}

const dayKey = (iso: string): string => iso.slice(0, 10);

/**
 * One bucket per day for the last `days`, oldest first.
 *
 * Days with nothing are kept rather than skipped: a graph that silently omits
 * the quiet days makes a sporadic week look like a busy one.
 */
export function postsPerDay(entries: HistoryEntry[], days = 30, now = new Date()): DayBucket[] {
  const buckets = new Map<string, DayBucket>();
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const day = date.toISOString().slice(0, 10);
    buckets.set(day, { day, sent: 0, failed: 0 });
  }

  for (const entry of entries) {
    const bucket = buckets.get(dayKey(entry.at));
    if (!bucket) continue;
    if (entry.ok) bucket.sent++;
    else bucket.failed++;
  }
  return [...buckets.values()];
}

/** 24 buckets, local hour of day, counting successful posts only. */
export function postsPerHour(entries: HistoryEntry[]): number[] {
  const hours = new Array<number>(24).fill(0);
  for (const entry of entries) {
    if (!entry.ok) continue;
    const at = new Date(entry.at);
    if (Number.isNaN(at.getTime())) continue;
    hours[at.getHours()]++;
  }
  return hours;
}

export function byNetwork(entries: HistoryEntry[], engagement: EngagementRecord[] = []): NetworkBreakdown[] {
  const rows = new Map<string, NetworkBreakdown>();
  const row = (network: string) => {
    let found = rows.get(network);
    if (!found) {
      found = { network, sent: 0, failed: 0, rate: null, likes: 0, reposts: 0, replies: 0 };
      rows.set(network, found);
    }
    return found;
  };

  for (const entry of entries) {
    const current = row(entry.network);
    if (entry.ok) current.sent++;
    else current.failed++;
  }

  // Engagement is keyed by account; the network is the part before the colon.
  for (const record of engagement) {
    const network = record.accountId.split(":")[0];
    if (!network) continue;
    const current = row(network);
    current.likes += record.likes ?? 0;
    current.reposts += record.reposts ?? 0;
    current.replies += record.replies ?? 0;
  }

  for (const current of rows.values()) {
    const attempted = current.sent + current.failed;
    current.rate = attempted ? current.sent / attempted : null;
  }

  return [...rows.values()].sort((a, b) => b.sent + b.failed - (a.sent + a.failed));
}

export function totals(entries: HistoryEntry[], engagement: EngagementRecord[] = []): Totals {
  const sent = entries.filter((entry) => entry.ok).length;
  const failed = entries.length - sent;
  const likes = engagement.reduce((sum, record) => sum + (record.likes ?? 0), 0);
  const reposts = engagement.reduce((sum, record) => sum + (record.reposts ?? 0), 0);
  const replies = engagement.reduce((sum, record) => sum + (record.replies ?? 0), 0);
  const measured = engagement.length;

  return {
    posts: entries.length,
    sent,
    failed,
    rate: entries.length ? sent / entries.length : null,
    networks: new Set(entries.map((entry) => entry.network)).size,
    likes,
    reposts,
    replies,
    // Averaged over posts actually measured, not over everything ever sent,
    // which would quietly count an unmeasured post as a zero.
    perPost: measured ? (likes + reposts + replies) / measured : null,
    measured,
  };
}

export interface RankedPost {
  accountId: string;
  postId: string;
  text: string;
  at: string;
  url?: string;
  likes: number;
  reposts: number;
  replies: number;
  total: number;
}

/** The posts that did best, by total engagement. */
export function topPosts(entries: HistoryEntry[], engagement: EngagementRecord[], limit = 10): RankedPost[] {
  const byId = new Map(engagement.map((record) => [`${record.accountId}|${record.postId}`, record]));

  return entries
    .filter((entry) => entry.ok && entry.postId)
    .map((entry) => {
      const record = byId.get(`${entry.accountId}|${entry.postId}`);
      const likes = record?.likes ?? 0;
      const reposts = record?.reposts ?? 0;
      const replies = record?.replies ?? 0;
      return {
        accountId: entry.accountId,
        postId: entry.postId!,
        text: entry.text,
        at: entry.at,
        url: entry.url,
        likes,
        reposts,
        replies,
        total: likes + reposts + replies,
      };
    })
    .filter((post) => post.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

/**
 * Which posts are worth asking the networks about.
 *
 * Successful posts with an id, newest first, skipping anything measured in the
 * last `staleAfterMs`. Engagement moves fastest early, so refreshing the newest
 * first is what makes a partial refresh useful.
 */
export function needsRefresh(
  entries: HistoryEntry[],
  engagement: EngagementRecord[],
  { limit = 25, staleAfterMs = 3_600_000, now = Date.now() } = {},
): { accountId: string; postId: string }[] {
  const seen = new Map(engagement.map((record) => [`${record.accountId}|${record.postId}`, record]));

  return entries
    .filter((entry) => entry.ok && entry.postId)
    .filter((entry) => {
      const record = seen.get(`${entry.accountId}|${entry.postId}`);
      if (!record) return true;
      return now - new Date(record.at).getTime() > staleAfterMs;
    })
    .slice(0, limit)
    .map((entry) => ({ accountId: entry.accountId, postId: entry.postId! }));
}
