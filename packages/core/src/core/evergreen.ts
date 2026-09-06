/**
 * Evergreen: old pages, re-posted on a slow cadence.
 *
 * A blog post is read for a day and then never again unless somebody points
 * at it. This job points at it: every `every` (a week by default) it takes
 * the page that has gone longest without a mention, writes a one-line post
 * with its title and URL, and hands it to the paced poster, which spreads it
 * over the accounts in `to` and asks CrawlProof for an ad on the page. The
 * repost gap in pacing is what stops the same page going to the same account
 * twice in a week; this job's own rotation is what stops the same page being
 * chosen twice in a row.
 */
import { getAccount } from "../store/accounts.ts";
import { requireNetwork } from "../net/registry.ts";
import { listQueue, type QueuedPost } from "../store/queue.ts";
import { listHistory } from "../store/history.ts";
import { loadSettings } from "../store/settings.ts";
import { resolveTargets } from "../store/accounts.ts";
import { parseDuration } from "../util/when.ts";
import { postPaced, type PacedOutcome } from "./poster.ts";

export interface EvergreenSettings {
  /** Off until somebody turns it on. Re-posting is not a thing to do by accident. */
  enabled: boolean;
  /** The blog account whose pages are re-posted: "htmlblog:…" or "gitblog:…". */
  from: string;
  /** One page per this long. "7d". */
  every: string;
  /** Where the re-posts go. "all" or a comma list, as `--to`. */
  to: string;
  /** Ask the CrawlProof plugin for an ad on every re-posted page. */
  ad: boolean;
  /** Never pick a page mentioned on any account more recently than this. "30d". */
  cooldown: string;
}

export const DEFAULT_EVERGREEN: EvergreenSettings = { enabled: false, from: "", every: "7d", to: "all", ad: true, cooldown: "30d" };

export const EVERGREEN_MARK = "evergreen";

export interface EvergreenPick {
  id: string;
  title: string;
  url: string;
  createdAt: string;
  /** When any account last mentioned it, if ever. */
  lastMentioned?: number;
}

/** The last evergreen re-post the queue knows about, sent or booked. */
export function lastEvergreen(queue: QueuedPost[] = listQueue()): number | undefined {
  let last: number | undefined;
  for (const post of queue) {
    if (post.extra?.[EVERGREEN_MARK] !== "true") continue;
    if (post.status === "cancelled" || post.status === "failed") continue;
    const at = new Date(post.scheduledFor).getTime();
    if (last === undefined || at > last) last = at;
  }
  return last;
}

/**
 * The page to re-post next: the one mentioned longest ago, never-mentioned
 * pages first, oldest of those first. Pages inside the cooldown are skipped.
 */
export function pickEvergreen(pages: EvergreenPick[], history: { text: string; at: string }[], now: number, cooldownMs: number): EvergreenPick | undefined {
  const mentioned = new Map<string, number>();
  for (const entry of history) {
    for (const page of pages) {
      if (entry.text.includes(page.url)) {
        const at = new Date(entry.at).getTime();
        if ((mentioned.get(page.url) ?? -Infinity) < at) mentioned.set(page.url, at);
      }
    }
  }
  const candidates = pages
    .map((page) => ({ ...page, lastMentioned: mentioned.get(page.url) }))
    .filter((page) => page.lastMentioned === undefined || now - page.lastMentioned >= cooldownMs)
    .sort((a, b) => {
      if (a.lastMentioned === undefined && b.lastMentioned !== undefined) return -1;
      if (a.lastMentioned !== undefined && b.lastMentioned === undefined) return 1;
      if (a.lastMentioned !== undefined && b.lastMentioned !== undefined && a.lastMentioned !== b.lastMentioned) return a.lastMentioned - b.lastMentioned;
      return a.createdAt.localeCompare(b.createdAt);
    });
  return candidates[0];
}

/** The one-line post for a page. The title is the hook; the URL is the point. */
export function evergreenText(page: EvergreenPick): string {
  const title = page.title.trim().replace(/\s+/g, " ");
  return `From the archive: ${title}\n${page.url}`;
}

export interface EvergreenRun {
  /** Nothing to do, and why. */
  idle?: string;
  page?: EvergreenPick;
  outcome?: PacedOutcome;
}

/**
 * One turn of the job. Reads the blog's own timeline for its pages, decides
 * whether one is due, and if so hands it to the paced poster. Safe to call
 * every tick: it does nothing until `every` has passed since the last one.
 */
export async function runEvergreen(options: { now?: number; log?: (line: string) => void } = {}): Promise<EvergreenRun> {
  const now = options.now ?? Date.now();
  const settings = loadSettings();
  const cfg = settings.evergreen;
  if (!cfg.enabled) return { idle: "evergreen is off" };
  if (!cfg.from) return { idle: "no blog account set; run: myna evergreen <blog account>" };

  const account = getAccount(cfg.from);
  if (!account) return { idle: `${cfg.from} is not a connected account` };
  const network = requireNetwork(account.network);
  if (!network.timeline) return { idle: `${account.network} cannot list its own pages` };

  const everyMs = parseDuration(cfg.every) ?? (parseDuration(DEFAULT_EVERGREEN.every) as number);
  const last = lastEvergreen();
  if (last !== undefined && now - last < everyMs) {
    return { idle: `next one after ${new Date(last + everyMs).toLocaleString()}` };
  }

  const items = await network.timeline(account, 200);
  const pages: EvergreenPick[] = items
    .filter((item) => item.url)
    .map((item) => ({ id: item.id, title: item.text.split("\n")[0].replace(/^#+\s*/, ""), url: item.url as string, createdAt: item.createdAt }));
  if (!pages.length) return { idle: `${account.id} has no pages yet` };

  const cooldownMs = parseDuration(cfg.cooldown) ?? (parseDuration(DEFAULT_EVERGREEN.cooldown) as number);
  const page = pickEvergreen(pages, listHistory(), now, cooldownMs);
  if (!page) return { idle: "every page was mentioned inside the cooldown" };

  const targets = resolveTargets(cfg.to);
  if (!targets.length) return { idle: `no accounts match "${cfg.to}"` };

  const outcome = await postPaced(targets, {
    text: evergreenText(page),
    thread: false,
    signature: settings.signature || undefined,
    extra: { [EVERGREEN_MARK]: "true", ...(cfg.ad ? { ad: "true" } : {}) },
  });
  options.log?.(`re-posting ${page.url}: ${outcome.results.length} now, ${outcome.queued.length} queued, ${outcome.skipped.length} skipped`);
  return { page, outcome };
}
