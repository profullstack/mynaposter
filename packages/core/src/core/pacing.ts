/**
 * Pacing.
 *
 * Posting the same text to five accounts in the same second is what gets
 * accounts flagged, and posting to one network twice in an hour is not far
 * behind. So nothing goes out at the rate it was asked for. Every send has
 * to clear three gates, all read from settings:
 *
 *   minGap     the least time between two posts on the SAME NETWORK, whatever
 *              the account. 4h by default.
 *   drip       a post aimed at several accounts is spread over this window,
 *              one account at a time, in a shuffled order. 48h by default;
 *              24h to 72h is the sensible range.
 *   repostGap  the same text to the same account again waits this long.
 *              7d by default, for the evergreen re-posts of old pages.
 *
 * The plan is pure: it takes the clock, the history and the queue and says
 * which targets may go now and when each of the rest is due. The poster and
 * the scheduler do the sending; this file never touches a network.
 */
import type { Account } from "../net/types.ts";
import type { HistoryEntry } from "../store/history.ts";
import type { QueuedPost } from "../store/queue.ts";
import { parseDuration } from "../util/when.ts";

export interface PacingSettings {
  /** Least time between two posts on the same network. A duration: "4h". */
  minGap: string;
  /** Window a multi-account post is spread over. "48h". */
  drip: string;
  /** Same text to the same account again waits this long. "7d". */
  repostGap: string;
}

export const DEFAULT_PACING: PacingSettings = { minGap: "4h", drip: "48h", repostGap: "7d" };

export interface PacingRules {
  minGapMs: number;
  dripMs: number;
  repostGapMs: number;
}

export function pacingRules(settings: PacingSettings): PacingRules {
  const read = (value: string, fallback: string): number => parseDuration(value) ?? (parseDuration(fallback) as number);
  return {
    minGapMs: read(settings.minGap, DEFAULT_PACING.minGap),
    dripMs: read(settings.drip, DEFAULT_PACING.drip),
    repostGapMs: read(settings.repostGap, DEFAULT_PACING.repostGap),
  };
}

/** Whitespace-insensitive identity for "the same text". */
export function textKey(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The last moment each network was posted to, or is booked to be: history
 * (what actually went out, failures included, since a failed attempt still
 * counted against the network's rate) and the queue (what is promised).
 */
export function lastPerNetwork(history: HistoryEntry[], queue: QueuedPost[], accountNetwork: (id: string) => string | undefined): Map<string, number> {
  const last = new Map<string, number>();
  const note = (network: string | undefined, iso: string) => {
    if (!network) return;
    const at = new Date(iso).getTime();
    if (Number.isNaN(at)) return;
    if ((last.get(network) ?? -Infinity) < at) last.set(network, at);
  };
  for (const entry of history) note(entry.network, entry.at);
  for (const post of queue) {
    if (post.status !== "pending" && post.status !== "sending") continue;
    for (const id of post.targets) note(accountNetwork(id), post.scheduledFor);
  }
  return last;
}

/** The earliest time `network` may be posted to, given when it was last used. */
export function nextSlotFor(network: string, last: Map<string, number>, now: number, minGapMs: number): number {
  const seen = last.get(network);
  if (seen === undefined) return now;
  return Math.max(now, seen + minGapMs);
}

/**
 * Has this exact text gone to this account inside the repost gap? A repost
 * of an old page is fine once a week; twice in an afternoon is spam.
 */
export function recentDuplicate(text: string, accountId: string, history: HistoryEntry[], now: number, repostGapMs: number): HistoryEntry | undefined {
  const key = textKey(text);
  return history.find((entry) => entry.accountId === accountId && entry.ok && textKey(entry.text) === key && now - new Date(entry.at).getTime() < repostGapMs);
}

export interface PlannedTarget {
  account: Account;
  /** Epoch ms. `now` itself means send in this call. */
  at: number;
  /** Why it is not going now, for the person watching. */
  reason?: string;
}

export interface Plan {
  now: Account[];
  later: PlannedTarget[];
  /** Targets refused outright: the same text went to that account too recently. */
  skipped: Array<{ account: Account; reason: string }>;
}

export interface PlanInput {
  accounts: Account[];
  text: string;
  now?: number;
  history: HistoryEntry[];
  queue: QueuedPost[];
  rules: PacingRules;
  /** Resolve a queued target id to its network, for the queue's bookings. */
  accountNetwork: (id: string) => string | undefined;
  /** Spread the later ones from this moment rather than from `now`. */
  from?: number;
  /** Deterministic order for tests. Defaults to a shuffle, which is the point. */
  order?: (accounts: Account[]) => Account[];
  /** Ignore the gates: the person said --now. Duplicates are still refused. */
  force?: boolean;
}

/**
 * Decide, for one piece of text and a set of accounts, who gets it now and
 * who gets it when.
 *
 * Order is shuffled so the same account is not always first. The first
 * target whose network is free goes now (or at `from`); the rest are laid
 * along the drip window, each also pushed past its network's own gap. Two
 * accounts on one network never land inside `minGap` of each other, which
 * is what makes "two X accounts" safe.
 */
export function planTargets(input: PlanInput): Plan {
  const now = input.now ?? Date.now();
  const from = input.from ?? now;
  const order = input.order ?? shuffle;
  const last = lastPerNetwork(input.history, input.queue, input.accountNetwork);

  const plan: Plan = { now: [], later: [], skipped: [] };
  const candidates: Account[] = [];
  for (const account of order(input.accounts)) {
    const dup = recentDuplicate(input.text, account.id, input.history, now, input.rules.repostGapMs);
    if (dup) {
      plan.skipped.push({ account, reason: `the same text went there ${describeAgo(now - new Date(dup.at).getTime())} ago` });
      continue;
    }
    candidates.push(account);
  }
  if (!candidates.length) return plan;

  if (input.force) {
    for (const account of candidates) {
      if (from <= now) plan.now.push(account);
      else plan.later.push({ account, at: from, reason: "scheduled" });
    }
    return plan;
  }

  // Ideal positions along the drip: 0, 1/(n-1), ... of the window from `from`.
  const n = candidates.length;
  const step = n > 1 ? Math.floor(input.rules.dripMs / (n - 1)) : 0;

  candidates.forEach((account, index) => {
    const ideal = from + index * step;
    const gate = nextSlotFor(account.network, last, now, input.rules.minGapMs);
    const at = Math.max(ideal, gate);
    // Book it so the next account on the same network is pushed past it.
    last.set(account.network, at);

    if (at <= now) {
      plan.now.push(account);
      return;
    }
    const reason =
      gate > ideal
        ? `${account.network} keeps a ${describeMs(input.rules.minGapMs)} gap`
        : index === 0
          ? "scheduled"
          : `dripped, ${index + 1} of ${n}`;
    plan.later.push({ account, at, reason });
  });

  plan.later.sort((a, b) => a.at - b.at);
  return plan;
}

/** Fisher-Yates. */
export function shuffle<T>(items: T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function describeMs(ms: number): string {
  if (ms >= 86_400_000 && ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}

function describeAgo(ms: number): string {
  if (ms < 60_000) return "moments";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}
