/**
 * The reshare network: people and agents who amplify each other's posts.
 *
 * Two halves. Matching is pure and shared with the server: a request (some
 * post URLs, some topics, an offer) against a sharer's OpenProfile.md (their
 * topics, what they refuse, which networks, their rate). Running is local:
 * pull the matches for this install, claim one, share it with one of this
 * install's own accounts through the network's repost API or, where there is
 * none, a post carrying the link, and report how it went.
 *
 * Nothing here is done by the server on anybody's behalf. The server holds
 * profiles and requests and keeps score; every reshare is done by the
 * sharer's own myna, with the sharer's own accounts, under the sharer's own
 * limits.
 */
import { getNetwork } from "../net/registry.ts";
import { listAccounts } from "../store/accounts.ts";
import { recordHistory } from "../store/history.ts";
import { loadSettings, type ReshareSettings } from "../store/settings.ts";
import {
  api as realApi,
  doneToday,
  joined,
  recordDone,
  submit,
  type ReshareApi,
  type ReshareMatch,
  type ResharePost,
} from "../store/reshare.ts";
import { parseTopics, topicsMatch, type OpenProfile } from "./openprofile.ts";
import type { PostedEvent } from "../plugins/types.ts";
import type { Account } from "../net/types.ts";

// --- matching ----------------------------------------------------------------

export interface MatchRequest {
  topics: string[];
  /** Networks the post exists on. */
  networks: string[];
  /** A page any network can quote, so the request matches beyond `networks`. */
  link?: string | null;
  bountyUsd: number;
}

export interface MatchSharer {
  topics: string[];
  not: string[];
  /** Empty means any network the sharer has an account on. */
  networks: string[];
  /** Networks the sharer actually has accounts on. Empty means unknown, treated as any. */
  accounts?: string[];
  rateUsd: number;
}

export interface MatchResult {
  /** 0 to 1. Higher is a closer topic fit. */
  score: number;
  /** Networks the sharer can act on for this request. */
  networks: string[];
}

/** A sharer's terms, from a parsed profile plus what settings say. */
export function sharerFromProfile(profile: OpenProfile): MatchSharer {
  const reshare = profile.reshare;
  return {
    topics: reshare?.topics.length ? reshare.topics : profile.topics,
    not: reshare?.not ?? [],
    networks: reshare?.networks ?? [],
    accounts: profile.accounts.map((account) => account.network),
    rateUsd: reshare?.rateUsd ?? 0,
  };
}

/**
 * Does this request fit this sharer, and how well.
 *
 * Refusals first, in the order a person would state them: a topic they said
 * no to, a network they cannot reach, a rate the author is not offering.
 * Then fit: the share of the request's topics the sharer covers. A sharer
 * with no topics at all takes anything, at a low score, so people with
 * stated interests are matched first.
 */
export function scoreMatch(request: MatchRequest, sharer: MatchSharer): MatchResult | null {
  for (const topic of request.topics) {
    if (sharer.not.some((refused) => topicsMatch(topic, refused))) return null;
  }

  const willing = sharer.networks.length ? new Set(sharer.networks.map((id) => id.toLowerCase())) : null;
  const has = sharer.accounts?.length ? new Set(sharer.accounts.map((id) => id.toLowerCase())) : null;
  const reachable = (id: string): boolean => (!willing || willing.has(id)) && (!has || has.has(id));

  const networks = new Set<string>();
  for (const id of request.networks) if (reachable(id.toLowerCase())) networks.add(id.toLowerCase());
  if (request.link) {
    // A link can be quoted anywhere the sharer is willing and present.
    const candidates = willing ? [...willing] : has ? [...has] : [];
    for (const id of candidates) if (reachable(id)) networks.add(id);
  }
  if (!networks.size) return null;

  if (sharer.rateUsd > request.bountyUsd) return null;

  if (!sharer.topics.length) return { score: 0.1, networks: [...networks] };
  if (!request.topics.length) return { score: 0.2, networks: [...networks] };

  let hits = 0;
  for (const topic of request.topics) if (sharer.topics.some((mine) => topicsMatch(topic, mine))) hits++;
  if (!hits) return null;
  return { score: Math.min(1, 0.3 + (0.7 * hits) / request.topics.length), networks: [...networks] };
}

/** Rank sharers for one request, best first. */
export function rankSharers<T extends { sharer: MatchSharer }>(request: MatchRequest, sharers: T[]): Array<T & MatchResult> {
  const ranked: Array<T & MatchResult> = [];
  for (const entry of sharers) {
    const result = scoreMatch(request, entry.sharer);
    if (result) ranked.push({ ...entry, ...result });
  }
  return ranked.sort((a, b) => b.score - a.score);
}

/** `#tags` in a post's text, as topics. */
export function hashtagsIn(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/(^|\s)#([\p{L}\p{N}_-]{2,40})/gu)) {
    const tag = match[2] ?? "";
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

// --- asking ------------------------------------------------------------------

/** What settings say this install's own posts are about. */
export function ownTopics(settings = loadSettings()): string[] {
  const listed = parseTopics(settings.reshare.topics || settings.profile.topics);
  return listed;
}

/** A request for the network, from a post that just went out. Null when there is nothing shareable. */
export function requestFromPosted(event: PostedEvent, settings = loadSettings()): Parameters<typeof submit>[0] | null {
  const posts: ResharePost[] = [];
  let link: string | null = null;
  for (const target of event.targets) {
    if (!target.ok || !target.url) continue;
    if (target.category === "blog") {
      link = link ?? target.url;
      continue;
    }
    posts.push({ network: target.account.network, url: target.url, ...(target.id ? { id: target.id } : {}) });
  }
  if (!posts.length && !link) return null;

  const topics = [...ownTopics(settings), ...hashtagsIn(event.text)];
  return {
    ...(event.title ? { title: event.title } : {}),
    text: event.text.slice(0, 500),
    topics,
    posts,
    link,
    bountyUsd: settings.reshare.bountyUsd,
    maxSharers: settings.reshare.maxSharers,
  };
}

// --- doing -------------------------------------------------------------------

export interface RunReshareOptions {
  log?: (line: string) => void;
  /** At most this many reshares this turn. The daily limit still applies. */
  limit?: number;
  api?: ReshareApi;
  settings?: ReshareSettings;
  now?: number;
}

export interface ReshareTurn {
  /** Why nothing was done, when nothing was. */
  skipped?: string;
  done: Array<{ requestId: string; network: string; accountId: string; ok: boolean; url?: string; error?: string; how: "repost" | "quote" }>;
}

/** The text of a quote post: the author's own words, then the link. */
export function quoteText(match: ReshareMatch, url: string, charLimit: number): string {
  const words = (match.title ?? match.text ?? "").split("\n")[0]?.trim() ?? "";
  const room = Math.max(0, charLimit - url.length - 2);
  const lead = words.length > room ? `${words.slice(0, Math.max(0, room - 1)).trimEnd()}…` : words;
  return lead ? `${lead}\n${url}` : url;
}

function pickAccount(accounts: Account[], network: string): Account | undefined {
  return accounts.find((account) => account.network === network);
}

/**
 * One turn: pull matches, do as many as the limits allow, report each.
 *
 * Every step that can fail is reported rather than thrown, because a match
 * that cannot be done is the normal case (somebody else claimed it, the
 * account is rate limited, the post was deleted) and must not stop the next.
 */
export async function runReshare(options: RunReshareOptions = {}): Promise<ReshareTurn> {
  const log = options.log ?? (() => {});
  const api = options.api ?? realApi;
  const settings = options.settings ?? loadSettings().reshare;
  const now = options.now ?? Date.now();
  const turn: ReshareTurn = { done: [] };

  if (!joined()) {
    turn.skipped = "not joined (myna reshare join)";
    return turn;
  }

  const already = doneToday(now).length;
  let budget = Math.min(options.limit ?? settings.perDay, Math.max(0, settings.perDay - already));
  if (budget <= 0) {
    turn.skipped = `daily limit of ${settings.perDay} reached`;
    return turn;
  }

  const accounts = listAccounts();
  const willing =
    settings.networks.trim() && settings.networks.trim() !== "all"
      ? new Set(settings.networks.split(",").map((id) => id.trim().toLowerCase()).filter(Boolean))
      : null;

  const found = await api.matches(budget * 3);
  if (!found.length) {
    turn.skipped = "nothing to reshare right now";
    return turn;
  }

  for (const match of found) {
    if (budget <= 0) break;
    for (const networkId of match.networks) {
      if (budget <= 0) break;
      if (willing && !willing.has(networkId)) continue;
      const account = pickAccount(accounts, networkId);
      if (!account) continue;
      const network = getNetwork(networkId);
      if (!network) continue;

      const own = match.posts.find((post) => post.network === networkId);
      const how: "repost" | "quote" = own && network.repost ? "repost" : "quote";
      const url = own?.url ?? match.link ?? match.posts[0]?.url;
      if (!url) continue;
      if (how === "quote" && !settings.quote) continue;

      let claimId: string;
      try {
        claimId = (await api.claim(match.id, networkId)).id;
      } catch (error) {
        log(`reshare ${match.id}: not claimed: ${(error as Error).message}`);
        continue;
      }

      let ok = false;
      let resultUrl: string | undefined;
      let errorText: string | undefined;
      try {
        const result =
          how === "repost" && network.repost
            ? await network.repost(account, url)
            : await network.post(account, { text: quoteText(match, url, network.caps.charLimit || 280) });
        ok = true;
        resultUrl = Array.isArray(result) ? result[0]?.url : result.url;
      } catch (error) {
        errorText = (error as Error).message;
      }

      await api.report(claimId, { ok, ...(resultUrl ? { url: resultUrl } : {}), ...(errorText ? { error: errorText } : {}) }).catch((error: Error) => {
        log(`reshare ${match.id}: reported nothing: ${error.message}`);
      });

      recordDone({
        at: new Date(now).toISOString(),
        requestId: match.id,
        claimId,
        network: networkId,
        accountId: account.id,
        author: match.author,
        ok,
        ...(resultUrl ? { url: resultUrl } : {}),
        ...(errorText ? { error: errorText } : {}),
        bountyUsd: match.bountyUsd,
        how,
      });
      recordHistory([
        {
          at: new Date(now).toISOString(),
          accountId: account.id,
          network: networkId,
          handle: account.handle,
          text: how === "repost" ? `reshare ${url}` : quoteText(match, url, network.caps.charLimit || 280),
          ok,
          type: "reshare",
          ...(resultUrl ? { url: resultUrl } : {}),
          ...(errorText ? { error: errorText } : {}),
        },
      ]);

      turn.done.push({ requestId: match.id, network: networkId, accountId: account.id, ok, ...(resultUrl ? { url: resultUrl } : {}), ...(errorText ? { error: errorText } : {}), how });
      log(`reshare ${match.id} for ${match.author} on ${account.id}: ${ok ? resultUrl ?? "ok" : `failed: ${errorText}`}`);
      if (ok) budget--;
    }
  }

  if (!turn.done.length) turn.skipped = "no match had a network this install can act on";
  return turn;
}
