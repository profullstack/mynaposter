/**
 * The dashboard's one payload.
 *
 * Everything the page draws comes from `buildSnapshot`, which is pure: give it
 * the clock, the history, the queue, the accounts and the settings, and it
 * answers what is safe, what is queued and when each thing goes. The server
 * reads the stores and calls this; the tests call it with fixtures.
 *
 * The question this dashboard answers is not "how am I doing" but "am I about
 * to get an account banned", so the lead figure is the next send and the first
 * chart is the drip, not a vanity total.
 */
import {
  byNetwork,
  postsPerDay,
  topPosts,
  totals,
  bookingsPerNetwork,
  lastPerNetwork,
  nextSlotFor,
  pacingRules,
  lastEvergreen,
  type Account,
  type DayBucket,
  type EngagementRecord,
  type HistoryEntry,
  type NetworkBreakdown,
  type QueuedPost,
  type RankedPost,
  type Settings,
  type Totals,
} from "@profullstack/myna-core";

/**
 * The fixed hue order networks are assigned from. Colour follows the entity,
 * so a network keeps its slot however many others are connected: the index
 * here is the slot, and nothing re-ranks it. Past eight, a network is drawn in
 * the muted ink rather than a ninth generated hue.
 */
export const NETWORK_SLOT_ORDER = [
  "x",
  "bluesky",
  "mastodon",
  "linkedin",
  "htmlblog",
  "gitblog",
  "facebook",
  "threads",
] as const;

export const SLOT_COUNT = NETWORK_SLOT_ORDER.length;

/** 1-based categorical slot, or 0 for "everything else". */
export function slotFor(network: string): number {
  const index = (NETWORK_SLOT_ORDER as readonly string[]).indexOf(network);
  return index === -1 ? 0 : index + 1;
}

export interface NetworkState {
  network: string;
  slot: number;
  accounts: string[];
  /** Epoch ms of the last post there, sent or booked. */
  lastAt?: number;
  /** Epoch ms this network may next be posted to. */
  freeAt: number;
  /** ms until free; 0 when it is free now. */
  gatedForMs: number;
  sent: number;
  failed: number;
  /** 0..1, or null when nothing was attempted. */
  rate: number | null;
  likes: number;
  reposts: number;
  replies: number;
}

export interface QueueRow {
  id: string;
  at: number;
  /** ms from now; negative when it is already due. */
  inMs: number;
  accountId: string;
  network: string;
  slot: number;
  text: string;
  /** Why it is not going now, when the planner said. */
  reason?: string;
  status: QueuedPost["status"];
  evergreen: boolean;
}

export interface HistoryRow {
  at: number;
  accountId: string;
  network: string;
  slot: number;
  ok: boolean;
  text: string;
  url?: string;
  error?: string;
  /** Which of the account's skills the post used. */
  skill?: string;
}

/** One account's skill, as the page lists it. */
export interface SkillSummary {
  accountId: string;
  network: string;
  slot: number;
  kind: string;
  /** The slug a post would use now. */
  selected: string;
  rotating: boolean;
  /** Every slug the account has, in rotation order. */
  skills: string[];
  maxPerDay?: number;
  minGapMinutes?: number;
  maxChars?: number;
  contentPolicy?: string;
  /** Sent to this account in the last 24h, against maxPerDay. */
  sentToday: number;
  /** The route that serves the selected skill. */
  path: string;
}

export interface EvergreenState {
  enabled: boolean;
  from: string;
  every: string;
  to: string;
  ad: boolean;
  /** Epoch ms of the next rotation, when one is scheduled. */
  nextAt?: number;
}

export interface Snapshot {
  now: number;
  /** The lead figure: the next thing that will go out, if anything. */
  next?: { at: number; inMs: number; accountId: string; network: string; slot: number; text: string };
  totals: Totals;
  /** Sent in the last 30 days, and the 30 before it, for the delta. */
  sent30: number;
  sentPrev30: number;
  queuedCount: number;
  /** Networks that cannot be posted to right now. */
  gatedCount: number;
  pacing: { minGap: string; drip: string; repostGap: string; minGapMs: number; dripMs: number; repostGapMs: number };
  networks: NetworkState[];
  queue: QueueRow[];
  history: HistoryRow[];
  perDay: DayBucket[];
  top: RankedPost[];
  evergreen: EvergreenState;
  accounts: Array<{ id: string; network: string; handle: string; slot: number }>;
  /** Each account's skill and its daily cap. Empty when the reader was not supplied. */
  skills: SkillSummary[];
  /** How far ahead the drip chart looks, in ms. */
  horizonMs: number;
}

export interface SnapshotInput {
  now?: number;
  history: HistoryEntry[];
  queue: QueuedPost[];
  accounts: Account[];
  engagement: EngagementRecord[];
  settings: Settings;
  /** Epoch ms of the last evergreen rotation, if the queue knows one. */
  evergreenLast?: number;
  /**
   * Each account's skill: the slug a post would use now and the merged
   * limits. Read from the skill files by the caller, since the snapshot
   * itself stays pure; `sentToday` and `slot` are filled in here.
   */
  skills?: Array<Omit<SkillSummary, "sentToday" | "slot">>;
}

const DAY = 86_400_000;

/** How far the drip chart looks ahead: the whole drip window, at least 24h. */
export function horizonFor(dripMs: number): number {
  return Math.max(DAY, Math.ceil(dripMs / DAY) * DAY);
}

export function buildSnapshot(input: SnapshotInput): Snapshot {
  const now = input.now ?? Date.now();
  const { history, queue, accounts, engagement, settings } = input;

  const networkOf = new Map(accounts.map((account) => [account.id, account.network]));
  const rules = pacingRules(settings.pacing);
  const booked = bookingsPerNetwork(history, queue, (id) => networkOf.get(id));
  const last = lastPerNetwork(history, queue, (id) => networkOf.get(id), now);
  const breakdown = new Map(byNetwork(history, engagement).map((row: NetworkBreakdown) => [row.network, row]));

  // Every network with an account, plus any the history remembers, so a
  // disconnected account's past does not vanish from the totals.
  const present = new Set<string>([...accounts.map((a) => a.network), ...history.map((entry) => entry.network)]);
  const networks: NetworkState[] = [...present]
    .map((network) => {
      const row = breakdown.get(network);
      const freeAt = nextSlotFor(network, booked, now, rules.minGapMs);
      return {
        network,
        slot: slotFor(network),
        accounts: accounts.filter((account) => account.network === network).map((account) => account.id),
        lastAt: last.get(network),
        freeAt,
        gatedForMs: Math.max(0, freeAt - now),
        sent: row?.sent ?? 0,
        failed: row?.failed ?? 0,
        rate: row?.rate ?? null,
        likes: row?.likes ?? 0,
        reposts: row?.reposts ?? 0,
        replies: row?.replies ?? 0,
      };
    })
    .sort((a, b) => b.gatedForMs - a.gatedForMs || a.network.localeCompare(b.network));

  const pending = queue
    .filter((post) => post.status === "pending" || post.status === "sending")
    .map((post) => {
      const accountId = post.targets[0] ?? "";
      const at = new Date(post.scheduledFor).getTime();
      const network = networkOf.get(accountId) ?? accountId.split(":")[0] ?? "";
      return {
        id: post.id,
        at,
        inMs: at - now,
        accountId,
        network,
        slot: slotFor(network),
        text: post.text,
        reason: post.lastError,
        status: post.status,
        evergreen: post.extra?.evergreen === "true",
      } satisfies QueueRow;
    })
    .filter((row) => Number.isFinite(row.at))
    .sort((a, b) => a.at - b.at);

  const rows: HistoryRow[] = history.slice(0, 40).map((entry) => ({
    at: new Date(entry.at).getTime(),
    accountId: entry.accountId,
    network: entry.network,
    slot: slotFor(entry.network),
    ok: entry.ok,
    text: entry.text,
    url: entry.url,
    error: entry.error,
    skill: entry.skill,
  }));

  const since = (from: number, to: number): number =>
    history.filter((entry) => {
      const at = new Date(entry.at).getTime();
      return entry.ok && at >= from && at < to;
    }).length;

  const first = pending[0];

  return {
    now,
    next: first
      ? { at: first.at, inMs: first.inMs, accountId: first.accountId, network: first.network, slot: first.slot, text: first.text }
      : undefined,
    totals: totals(history, engagement),
    sent30: since(now - 30 * DAY, now),
    sentPrev30: since(now - 60 * DAY, now - 30 * DAY),
    queuedCount: pending.length,
    gatedCount: networks.filter((network) => network.gatedForMs > 0).length,
    pacing: { ...settings.pacing, ...rules },
    networks,
    queue: pending,
    history: rows,
    perDay: postsPerDay(history, 30, new Date(now)),
    top: topPosts(history, engagement, 5),
    evergreen: {
      enabled: settings.evergreen.enabled,
      from: settings.evergreen.from,
      every: settings.evergreen.every,
      to: settings.evergreen.to,
      ad: settings.evergreen.ad,
      nextAt: input.evergreenLast,
    },
    accounts: accounts.map((account) => ({ id: account.id, network: account.network, handle: account.handle, slot: slotFor(account.network) })),
    skills: (input.skills ?? []).map((row) => ({
      ...row,
      slot: slotFor(row.network),
      sentToday: history.filter((entry) => entry.ok && entry.accountId === row.accountId && now - new Date(entry.at).getTime() < DAY).length,
    })),
    horizonMs: horizonFor(rules.dripMs),
  };
}

/** Read the live stores and build the snapshot from them. */
export function readSnapshot(deps: {
  history: () => HistoryEntry[];
  queue: () => QueuedPost[];
  accounts: () => Account[];
  engagement: () => EngagementRecord[];
  settings: () => Settings;
  skills?: (accounts: Account[], settings: Settings) => SnapshotInput["skills"];
  now?: number;
}): Snapshot {
  const queue = deps.queue();
  const accounts = deps.accounts();
  const settings = deps.settings();
  return buildSnapshot({
    now: deps.now,
    history: deps.history(),
    queue,
    accounts,
    engagement: deps.engagement(),
    settings,
    evergreenLast: lastEvergreen(queue),
    skills: deps.skills?.(accounts, settings),
  });
}
