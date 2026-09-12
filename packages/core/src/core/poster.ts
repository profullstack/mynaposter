/**
 * Fan-out posting.
 *
 * One piece of text goes to many networks, each with its own character limit,
 * hashtag etiquette and idea of what a "post" is. Networks are posted to in
 * parallel, and one network failing never stops the others — a half-delivered
 * post that tells you exactly which half is far more useful than an
 * all-or-nothing error.
 */
import type { Account, MediaItem, PostInput, PostResult } from "../net/types.ts";
import { requireNetwork } from "../net/registry.ts";
import { splitThread, truncateTo, appendHashtags, countChars, deriveTitle } from "../util/text.ts";
import { recordHistory, listHistory } from "../store/history.ts";
import { postedEvent, runAfterPost, runAfterSchedule, type HookOutcome } from "../plugins/hooks.ts";
import { enqueue, listQueue, updateQueued, type QueuedPost } from "../store/queue.ts";
import { getAccount } from "../store/accounts.ts";
import { loadSettings } from "../store/settings.ts";
import { pacingRules, planTargets, reflowQueue, type Plan, type Reflow } from "./pacing.ts";
import { duplicateTitle, planLimitsFor, takeSkill, titleOf } from "./skills.ts";
import { bookingsForType, defaultTypeFor, isMirrorOfSent, refuseTypeMismatch, typeCapFor } from "./post-types.ts";

export interface ComposeOptions {
  text: string;
  title?: string;
  media?: MediaItem[];
  /** Split over-limit text into a reply chain where the network supports it. */
  thread?: boolean;
  /** Added per network, only where they belong and only if they fit. */
  hashtags?: string[];
  extra?: Record<string, string>;
  signature?: string;
  /**
   * Publish to a blog even though a post with this title is already in its
   * history. Off by default: a re-sent announcement is the spam this exists
   * to stop.
   */
  allowDuplicate?: boolean;
  /**
   * The post type (skills/types/<type>/skill.md). Decides which kinds of
   * target may carry it and adds the type's own daily cap. Filled in from
   * the targets when absent: a launch-announcement for a blog, a
   * social-update otherwise.
   */
  type?: string;
}

export interface TargetResult {
  account: Account;
  ok: boolean;
  posts: PostResult[];
  error?: string;
  /** What was actually sent, after per-network tailoring. */
  sent?: string[];
  /** The title the network received, where one was given or derived. */
  title?: string;
  /** Which of the account's skills this post used. */
  skill?: string;
}

/** X bills every URL at 23 characters no matter how long it is. */
const URL_WEIGHT: Record<string, number> = { x: 23 };

/** Networks where hashtags are idiomatic. Adding them elsewhere just looks odd. */
const HASHTAG_NETWORKS = new Set([
  "x",
  "instagram",
  "threads",
  "mastodon",
  "misskey",
  "pixelfed",
  "bluesky",
  "nostr",
  "tiktok",
  "tumblr",
  "linkedin",
  "facebook",
]);

/**
 * Characters this network will bill you for. Exported so the compose screen's
 * counter and the poster's limit check can never disagree.
 */
export function charsFor(networkId: string, text: string): number {
  return countChars(text, { urlWeight: URL_WEIGHT[requireNetwork(networkId).id] });
}

/** Shape one piece of text for one network. */
export function tailor(networkId: string, options: ComposeOptions): string[] {
  const network = requireNetwork(networkId);
  const weight = URL_WEIGHT[network.id];

  let text = options.text.trim();
  if (options.signature) text = `${text}\n\n${options.signature}`;
  if (options.hashtags?.length && HASHTAG_NETWORKS.has(network.id)) {
    text = appendHashtags(text, options.hashtags, network.caps.charLimit, weight);
  }

  const limit = network.caps.charLimit;
  if (!limit || countChars(text, { urlWeight: weight }) <= limit) return [text];
  if (options.thread && network.caps.threads) return splitThread(text, limit);
  return [truncateTo(text, limit, weight)];
}

async function postOne(account: Account, options: ComposeOptions): Promise<TargetResult> {
  const network = requireNetwork(account.network);
  const parts = tailor(account.network, options);

  try {
    if (network.caps.needsTitle && !options.title && !options.extra?.title) {
      // Blogs, boards and link aggregators reject an untitled post outright, so
      // text written for the networks that never asked for one still needs a
      // headline. `deriveTitle` takes whole sentences: slicing the first line at
      // a character count used to publish half a clause as the title.
      options = { ...options, title: deriveTitle(options.text) };
    }

    const posts: PostResult[] = [];
    let replyTo: string | undefined;
    for (const part of parts) {
      const input: PostInput = {
        text: part,
        title: options.title,
        // Attachments ride on the first part only; a thread should not repeat them.
        media: posts.length === 0 ? options.media?.slice(0, network.caps.mediaLimit) : undefined,
        replyTo,
        extra: options.extra,
      };
      const result = await network.post(account, input);
      posts.push(result);
      replyTo = result.id;
    }
    return { account, ok: true, posts, sent: parts, title: options.title };
  } catch (error) {
    return { account, ok: false, posts: [], error: (error as Error).message, sent: parts, title: options.title };
  }
}

/** The skill slug an account is on, or the default when the skill tree cannot be read. A skill must never stop a send. */
function safeTakeSkill(account: Account, settings: ReturnType<typeof loadSettings>): string {
  try {
    return takeSkill(account, settings).slug;
  } catch {
    return "skill";
  }
}

/**
 * Refuse a blog post whose title the blog has already carried. This is an
 * error, not a queue entry: the person asked for something that must not
 * happen, and the answer is to say so before anything is written.
 */
export function refuseDuplicateTitles(accounts: Account[], options: Pick<ComposeOptions, "text" | "title" | "allowDuplicate">, history = listHistory()): void {
  if (options.allowDuplicate) return;
  for (const account of accounts) {
    const earlier = duplicateTitle(account, options.text, options.title, history);
    if (!earlier) continue;
    const when = earlier.at.slice(0, 10);
    throw new Error(
      `${account.id} already has a post titled "${titleOf(options.text, options.title)}" (${when}${earlier.url ? `, ${earlier.url}` : ""}). ` +
        "A blog carries each announcement once. Pass --allow-duplicate if this really is a new post.",
    );
  }
}

/**
 * One result per target, plus what every plugin's `afterPost` hook said.
 * Still an array, so a caller that only reads the results sees no change.
 */
export type PostOutcome = TargetResult[] & { hooks: HookOutcome[] };

/** Post to every target at once and return one result per target. */
export async function postToAll(accounts: Account[], options: ComposeOptions): Promise<PostOutcome> {
  if (!accounts.length) throw new Error("No targets. Run /login <network> first, or check your --to value.");

  // Which skill each account is on. Taking it moves a rotating account's
  // cursor, so it happens once per send and is written into the history.
  const settings = loadSettings();
  const skills = new Map(accounts.map((account) => [account.id, safeTakeSkill(account, settings)]));

  const results = await Promise.all(accounts.map((account) => postOne(account, options)));
  for (const result of results) result.skill = skills.get(result.account.id);

  recordHistory(
    results.map((result) => ({
      at: new Date().toISOString(),
      accountId: result.account.id,
      network: result.account.network,
      handle: result.account.handle,
      text: result.sent?.[0] ?? options.text,
      ok: result.ok,
      title: result.title,
      skill: result.skill,
      type: options.type,
      postId: result.posts[0]?.id,
      url: result.posts[0]?.url,
      canonicalUrl: options.extra?.canonicalUrl || undefined,
      error: result.error,
    })),
  );

  // Hooks run after the history is written: a hook that reads it sees this post.
  const hooks = await runAfterPost(postedEvent(results, options));
  return Object.assign(results, { hooks });
}

export interface PacedOptions {
  /** Ignore the gates: everything that is not a duplicate goes now. */
  force?: boolean;
  /**
   * Jump the queue without opening the gates: the gap is measured from what
   * has already gone out, and whatever this displaces is pushed back.
   */
  front?: boolean;
  /** Spread from this moment instead of now: a scheduled post. Epoch ms. */
  from?: number;
  now?: number;
  /** Media paths, so the queued part can reload them when its turn comes. */
  mediaPaths?: string[];
}

export interface PacedOutcome {
  /** What went out in this call. Empty when everything was queued. */
  results: PostOutcome;
  /** One queued post per account whose turn is later. */
  queued: QueuedPost[];
  skipped: Array<{ account: Account; reason: string }>;
  plan: Plan;
  /** What plugins said about the queued ones (a calendar entry, say). */
  scheduleHooks: HookOutcome[];
  /** Queued entries a --front post pushed back to keep the gap intact. */
  reflowed: Reflow[];
}

/**
 * Post with pacing: the accounts whose turn it is now are posted to at once;
 * the rest are queued one by one along the drip window and past their
 * network's gap, for the daemon to send. The same text to an account that
 * already had it inside the repost gap is refused. See pacing.ts.
 */
export async function postPaced(accounts: Account[], options: ComposeOptions, paced: PacedOptions = {}): Promise<PacedOutcome> {
  if (!accounts.length) throw new Error("No targets. Run /login <network> first, or check your --to value.");
  const settings = loadSettings();
  const rules = pacingRules(settings.pacing);
  const accountNetwork = (id: string) => getAccount(id)?.network;
  const queueBefore = listQueue();
  const history = listHistory();
  // The post type: named, or read off the targets. A type that a target's
  // kind does not carry (a bug-story to the blog) is an error, not a queue
  // entry, and it is checked before anything else so nothing half-happens.
  const type = options.type ?? defaultTypeFor(accounts);
  options = { ...options, type };
  refuseTypeMismatch(type, accounts);
  // A blog does not carry the same title twice, whatever the pacing says.
  refuseDuplicateTitles(accounts, options, history);
  // A canonical mirror of a post this type already sent is not a new one:
  // the original spent the type's budget, so the copy pointing at it passes.
  const typeCap = isMirrorOfSent(type, options.extra?.canonicalUrl, history) ? undefined : typeCapFor(type);
  const plan = planTargets({
    accounts,
    text: options.text,
    now: paced.now,
    from: paced.from,
    force: paced.force,
    front: paced.front,
    history,
    queue: queueBefore,
    rules,
    accountNetwork,
    // The account's skill sets its day's budget and can widen its gap.
    limitsFor: (account) => planLimitsFor(account, settings),
    // And the type has a budget of its own across every account.
    typeLimit: typeCap ? { type, maxPerDay: typeCap, bookings: bookingsForType(type, history, queueBefore) } : undefined,
  });

  // Make room before anything is sent or enqueued, so the entries we jumped
  // are already out of the way when the new ones take their slots.
  const reflowed = paced.front
    ? reflowQueue({ taken: plan.taken, queue: queueBefore, accountNetwork, minGapMs: rules.minGapMs })
    : [];
  for (const move of reflowed) updateQueued(move.id, { scheduledFor: new Date(move.to).toISOString() });

  const results: PostOutcome = plan.now.length ? await postToAll(plan.now, options) : Object.assign([], { hooks: [] });

  const queued: QueuedPost[] = [];
  const scheduleHooks: HookOutcome[] = [];
  for (const target of plan.later) {
    const entry = enqueue({
      scheduledFor: new Date(target.at).toISOString(),
      targets: [target.account.id],
      text: options.text,
      title: options.title,
      mediaPaths: paced.mediaPaths,
      extra: options.extra,
      thread: options.thread,
      type,
    });
    queued.push(entry);
    scheduleHooks.push(...(await runAfterSchedule(entry)));
  }

  return { results, queued, skipped: plan.skipped, plan, scheduleHooks, reflowed };
}

export function summarize(results: TargetResult[]): string {
  const ok = results.filter((result) => result.ok);
  const failed = results.filter((result) => !result.ok);
  const parts = [`${ok.length}/${results.length} posted`];
  if (failed.length) parts.push(`failed: ${failed.map((result) => result.account.id).join(", ")}`);
  return parts.join(" — ");
}
