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
export function bookingsPerNetwork(
  history: HistoryEntry[],
  queue: QueuedPost[],
  accountNetwork: (id: string) => string | undefined,
): Map<string, number[]> {
  const times = new Map<string, number[]>();
  const note = (network: string | undefined, iso: string) => {
    if (!network) return;
    const at = new Date(iso).getTime();
    if (Number.isNaN(at)) return;
    const list = times.get(network);
    if (list) list.push(at);
    else times.set(network, [at]);
  };
  // A failed attempt still counted against the network's rate, so history is
  // taken whole; the queue is what has been promised but not yet sent.
  for (const entry of history) note(entry.network, entry.at);
  for (const post of queue) {
    if (post.status !== "pending" && post.status !== "sending") continue;
    for (const id of post.targets) note(accountNetwork(id), post.scheduledFor);
  }
  for (const list of times.values()) list.sort((a, b) => a - b);
  return times;
}

/**
 * The last time a network was posted to, ignoring anything still in the
 * future. This is the "3h ago" a dashboard shows, not the gate.
 */
export function lastPerNetwork(
  history: HistoryEntry[],
  queue: QueuedPost[],
  accountNetwork: (id: string) => string | undefined,
  now = Date.now(),
): Map<string, number> {
  const last = new Map<string, number>();
  for (const [network, times] of bookingsPerNetwork(history, queue, accountNetwork)) {
    const past = times.filter((at) => at <= now);
    if (past.length) last.set(network, past[past.length - 1]);
  }
  return last;
}

/** The earliest time `network` may be posted to, given when it was last used. */
export function nextSlotFor(network: string, bookings: Map<string, number[]>, now: number, minGapMs: number): number {
  const times = bookings.get(network);
  if (!times?.length || minGapMs <= 0) return now;

  // Walk forward from now, stepping past any booking this would land within
  // the gap of. Only bookings NEAR the candidate matter: one seven months out
  // says nothing about whether the network is free this minute, and treating
  // the newest booking as "the last post" is what pushed a release
  // announcement into next April behind an April Fools post.
  let at = now;
  for (const booked of times) {
    if (at >= booked - minGapMs && at < booked + minGapMs) at = booked + minGapMs;
  }
  return at;
}

/**
 * Bookings that have already happened: history, plus queue entries whose time
 * has passed. This is what `--front` measures its gap against, and the reason
 * a 30-deep queue cannot push a launch into next week.
 */
export function pastBookings(
  history: HistoryEntry[],
  queue: QueuedPost[],
  accountNetwork: (id: string) => string | undefined,
  now: number,
): Map<string, number[]> {
  const past = new Map<string, number[]>();
  for (const [network, times] of bookingsPerNetwork(history, queue, accountNetwork)) {
    const before = times.filter((at) => at <= now);
    if (before.length) past.set(network, before);
  }
  return past;
}

/** One queued entry that a front-of-line post pushed back. */
export interface Reflow {
  id: string;
  from: number;
  to: number;
}

/**
 * Make room. Given the slots a front-of-line post just took, walk each
 * affected network in time order and push any pending entry that would now
 * sit inside the gap. Nothing is dropped and nothing is sent early: an entry
 * only ever moves later, and only far enough to clear the gap.
 */
export function reflowQueue(input: {
  taken: Array<{ network: string; at: number }>;
  queue: QueuedPost[];
  accountNetwork: (id: string) => string | undefined;
  minGapMs: number;
}): Reflow[] {
  const { minGapMs } = input;
  if (minGapMs <= 0 || !input.taken.length) return [];

  const takenByNetwork = new Map<string, number[]>();
  for (const slot of input.taken) {
    const list = takenByNetwork.get(slot.network);
    if (list) list.push(slot.at);
    else takenByNetwork.set(slot.network, [slot.at]);
  }

  // An entry can touch more than one network, so collect every proposal and
  // give it the latest, rather than letting one network undo another's.
  const proposals = new Map<string, { from: number; to: number }>();

  for (const [network, slots] of takenByNetwork) {
    slots.sort((a, b) => a - b);
    const earliest = slots[0];

    const onNetwork = input.queue
      .filter((post) => post.status === "pending" || post.status === "sending")
      .filter((post) => post.targets.some((id) => input.accountNetwork(id) === network))
      .map((post) => ({ post, at: new Date(post.scheduledFor).getTime() }))
      .filter((row) => !Number.isNaN(row.at) && row.at >= earliest)
      .sort((a, b) => a.at - b.at);

    // A slot we took that sits between two entries still has to gate the
    // later one, so walk the taken list alongside the entries rather than
    // measuring everything from the last slot.
    const ahead = slots.slice();
    let prev = ahead.shift() as number;
    for (const row of onNetwork) {
      while (ahead.length && ahead[0] <= row.at) prev = Math.max(prev, ahead.shift() as number);
      const at = row.at < prev + minGapMs ? prev + minGapMs : row.at;
      if (at !== row.at) {
        const seen = proposals.get(row.post.id);
        if (!seen || at > seen.to) proposals.set(row.post.id, { from: row.at, to: at });
      }
      prev = at;
    }
  }

  return [...proposals].map(([id, move]) => ({ id, from: move.from, to: move.to })).sort((a, b) => a.to - b.to);
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
  /**
   * Every slot this plan claimed, now and later alike. A front-of-line plan
   * hands these to `reflowQueue` so what it jumped ahead of gets pushed back
   * rather than landing inside its gap.
   */
  taken: Array<{ network: string; at: number }>;
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
  /**
   * Front of line: the person said --front.
   *
   * The gap is measured from what has already GONE OUT, so a saturated queue
   * stops holding the door. Two differences from a normal plan and no third:
   * future queue entries do not gate, and the drip collapses to the minGap
   * window, because the point of jumping the line is that every account
   * carries the thing while it is still news.
   *
   * `minGap` and `repostGap` are enforced exactly as usual. This reorders the
   * queue, it does not open the gates. That is what separates it from `force`.
   */
  front?: boolean;
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
  // Front of line measures the gap from what has already gone out. Everything
  // still sitting in the queue is what we are jumping, so it cannot also be
  // what holds us back.
  const booked = input.front
    ? pastBookings(input.history, input.queue, input.accountNetwork, now)
    : bookingsPerNetwork(input.history, input.queue, input.accountNetwork);

  const plan: Plan = { now: [], later: [], skipped: [], taken: [] };
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
      plan.taken.push({ network: account.network, at: Math.max(from, now) });
    }
    return plan;
  }

  // Ideal positions along the drip: 0, 1/(n-1), ... of the window from `from`.
  // Front of line spreads over minGap instead of the full drip, so the whole
  // set lands inside one gap rather than over two days.
  const n = candidates.length;
  const window = input.front ? input.rules.minGapMs : input.rules.dripMs;
  const step = n > 1 ? Math.floor(window / (n - 1)) : 0;

  candidates.forEach((account, index) => {
    const ideal = from + index * step;
    const gate = nextSlotFor(account.network, booked, now, input.rules.minGapMs);
    // The ideal slot may itself sit inside another booking's gap, so resolve
    // from whichever is later rather than taking the gate alone.
    const at = nextSlotFor(account.network, booked, Math.max(ideal, gate), input.rules.minGapMs);
    // Book it so the next account on the same network is pushed past it.
    const list = booked.get(account.network);
    if (list) {
      list.push(at);
      list.sort((a, b) => a - b);
    } else booked.set(account.network, [at]);
    plan.taken.push({ network: account.network, at });

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
