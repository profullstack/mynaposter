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
import { splitThread, truncateTo, appendHashtags, countChars } from "../util/text.ts";
import { recordHistory } from "../store/history.ts";

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
}

export interface TargetResult {
  account: Account;
  ok: boolean;
  posts: PostResult[];
  error?: string;
  /** What was actually sent, after per-network tailoring. */
  sent?: string[];
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
      // Blogs and link aggregators reject an untitled post outright.
      options = { ...options, title: options.text.split("\n")[0].replace(/^#+\s*/, "").slice(0, 200) };
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
    return { account, ok: true, posts, sent: parts };
  } catch (error) {
    return { account, ok: false, posts: [], error: (error as Error).message, sent: parts };
  }
}

/** Post to every target at once and return one result per target. */
export async function postToAll(accounts: Account[], options: ComposeOptions): Promise<TargetResult[]> {
  if (!accounts.length) throw new Error("No targets. Run /login <network> first, or check your --to value.");

  const results = await Promise.all(accounts.map((account) => postOne(account, options)));

  recordHistory(
    results.map((result) => ({
      at: new Date().toISOString(),
      accountId: result.account.id,
      network: result.account.network,
      handle: result.account.handle,
      text: result.sent?.[0] ?? options.text,
      ok: result.ok,
      postId: result.posts[0]?.id,
      url: result.posts[0]?.url,
      error: result.error,
    })),
  );

  return results;
}

export function summarize(results: TargetResult[]): string {
  const ok = results.filter((result) => result.ok);
  const failed = results.filter((result) => !result.ok);
  const parts = [`${ok.length}/${results.length} posted`];
  if (failed.length) parts.push(`failed: ${failed.map((result) => result.account.id).join(", ")}`);
  return parts.join(" — ");
}
