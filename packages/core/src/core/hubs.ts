/**
 * Engage the hubs.
 *
 * On X, Bluesky or LinkedIn the audience does not gather in a group with a
 * name. It gathers in the replies under a handful of accounts it follows and
 * answers. So: take a campaign's leads, find the accounts they follow and
 * reply to most (OutreachGraph ranks them, `myna outreachgraph hubs`), watch
 * those accounts' newest posts, and draft a reply worth reading under each
 * one that is in our field.
 *
 *   import    the ranked hubs, from OutreachGraph or by hand
 *   scan      read each watched hub's newest posts and draft replies (writer only)
 *   approve   a person says yes: the reply joins the post queue under their
 *             post, and pacing decides when it goes. LinkedIn and X have no
 *             reply myna may send, so there it becomes a hand-off card.
 *
 * Nothing here posts. A reply to a stranger always waits for a person.
 */
import { getJson } from "../util/http.ts";
import { getNetwork } from "../net/registry.ts";
import { listAccounts } from "../store/accounts.ts";
import { enqueue } from "../store/queue.ts";
import { addHandoff } from "../store/handoffs.ts";
import { loadSettings, type HubsSettings } from "../store/settings.ts";
import { findIn } from "../store/asks.ts";
import { hubKey, readHubs, writeHubs, type Hub, type HubDraft, type HubDraftStatus } from "../store/hubs.ts";
import { hubReplyDraft, writerAvailable, type HubReplyRequest } from "../ai/writer.ts";
import type { Account } from "../net/types.ts";

const HOUR_MS = 3_600_000;

/** Networks whose public posts myna reads without an account, and can reply on. */
export const READABLE = new Set(["bluesky", "mastodon"]);

export interface HubInput {
  network: string;
  handle: string;
  displayName?: string;
  url?: string;
  score?: number;
  followedBy?: number;
  repliedBy?: number;
  why?: string;
}

const networkOf = (raw: string): string => {
  const network = raw.trim().toLowerCase();
  if (network === "twitter") return "x";
  if (network === "fediverse") return "mastodon";
  return network;
};

/**
 * Add or refresh hubs. A hub already known keeps when it was added and when
 * it was last read; its score and reasons are replaced by the newer ranking.
 */
export function importHubs(
  inputs: HubInput[],
  options: { source?: Hub["source"]; campaignId?: string; product?: Hub["product"]; replace?: boolean; now?: number } = {},
): { added: number; updated: number; hubs: Hub[] } {
  const file = readHubs();
  const at = new Date(options.now ?? Date.now()).toISOString();
  if (options.replace && options.campaignId) {
    // Hubs that fell out of the ranking go; ones still in it keep their history below.
    const keep = new Set(inputs.map((input) => hubKey(networkOf(input.network), input.handle.trim().replace(/^@/, ""))));
    file.hubs = file.hubs.filter((hub) => hub.campaignId !== options.campaignId || keep.has(hub.id));
  }
  let added = 0;
  let updated = 0;
  for (const input of inputs) {
    const network = networkOf(input.network);
    const handle = input.handle.trim().replace(/^@/, "");
    if (!network || !handle) continue;
    const id = hubKey(network, handle);
    const fresh: Hub = {
      id,
      network,
      handle,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.url ? { url: input.url } : {}),
      score: Number.isFinite(input.score) ? Number(input.score) : 1,
      ...(input.followedBy !== undefined ? { followedBy: input.followedBy } : {}),
      ...(input.repliedBy !== undefined ? { repliedBy: input.repliedBy } : {}),
      ...(input.why ? { why: input.why } : {}),
      source: options.source ?? "manual",
      ...(options.campaignId ? { campaignId: options.campaignId } : {}),
      ...(options.product ? { product: options.product } : {}),
      addedAt: at,
    };
    const existing = file.hubs.find((hub) => hub.id === id);
    if (existing) {
      Object.assign(existing, { ...fresh, addedAt: existing.addedAt, ...(existing.readAt ? { readAt: existing.readAt } : {}) });
      updated += 1;
    } else {
      file.hubs.push(fresh);
      added += 1;
    }
  }
  writeHubs(file);
  return { added, updated, hubs: rankedHubs(file.hubs) };
}

export const rankedHubs = (hubs: Hub[]): Hub[] => [...hubs].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

export function removeHub(ref: string): boolean {
  const file = readHubs();
  const hub = findHub(file.hubs, ref);
  if (!hub) return false;
  file.hubs = file.hubs.filter((entry) => entry.id !== hub.id);
  writeHubs(file);
  return true;
}

/** A hub by `network:handle`, a bare handle, or a unique prefix of either. */
export function findHub(hubs: Hub[], ref: string): Hub | undefined {
  const needle = ref.trim().replace(/^@/, "").toLowerCase();
  return hubs.find((hub) => hub.id === needle) ?? hubs.find((hub) => hub.handle.toLowerCase() === needle) ?? findIn(hubs, needle);
}

// ------------------------------------------------------------------ reading

/** A hub's post, in the form a reply needs. */
export interface HubPost {
  /** What the network's `replyTo` takes: a Bluesky `uri|cid`, a Mastodon status URL. */
  id: string;
  url: string;
  text: string;
  postedAt: string;
}

export type HubFetcher = (url: string) => Promise<unknown>;
const defaultFetch: HubFetcher = (url) => getJson(url, { timeoutMs: 20_000 });

const stripHtml = (html: string): string =>
  html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();

/** The hub's newest top-level posts. Throws on a network that cannot be read without an account. */
export async function readHubPosts(hub: Pick<Hub, "network" | "handle">, settings: HubsSettings, fetchJson: HubFetcher = defaultFetch): Promise<HubPost[]> {
  const limit = Math.max(1, Math.min(50, settings.postsPerHub));
  if (hub.network === "bluesky") {
    const base = settings.bskyBase.replace(/\/+$/, "");
    const reply = (await fetchJson(
      `${base}/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(hub.handle)}&filter=posts_no_replies&limit=${limit}`,
    )) as { feed?: Array<{ post?: { uri?: string; cid?: string; author?: { handle?: string }; record?: { text?: string; createdAt?: string } }; reason?: unknown }> };
    return (reply.feed ?? [])
      .filter((item) => !item.reason && item.post?.uri && item.post.cid)
      .map((item) => {
        const post = item.post!;
        const rkey = post.uri!.split("/").pop() ?? "";
        return {
          id: `${post.uri}|${post.cid}`,
          url: `https://bsky.app/profile/${post.author?.handle ?? hub.handle}/post/${rkey}`,
          text: String(post.record?.text ?? ""),
          postedAt: post.record?.createdAt ?? new Date(0).toISOString(),
        };
      });
  }
  if (hub.network === "mastodon") {
    const [user, host] = hub.handle.replace(/^@/, "").split("@");
    if (!user || !host) throw new Error(`A Mastodon hub needs user@host, not ${hub.handle}.`);
    const account = (await fetchJson(`https://${host}/api/v1/accounts/lookup?acct=${encodeURIComponent(user)}`)) as { id?: string };
    if (!account.id) throw new Error(`${hub.handle} was not found on ${host}.`);
    const statuses = (await fetchJson(
      `https://${host}/api/v1/accounts/${encodeURIComponent(account.id)}/statuses?exclude_replies=true&exclude_reblogs=true&limit=${limit}`,
    )) as Array<{ url?: string; uri?: string; content?: string; created_at?: string; visibility?: string }>;
    return (Array.isArray(statuses) ? statuses : [])
      .filter((status) => (status.url ?? status.uri) && (status.visibility ?? "public") === "public")
      .map((status) => ({
        id: String(status.url ?? status.uri),
        url: String(status.url ?? status.uri),
        text: stripHtml(String(status.content ?? "")),
        postedAt: status.created_at ?? new Date(0).toISOString(),
      }));
  }
  throw new Error(`${hub.network} posts cannot be read without an account; watch ${hub.handle} by hand.`);
}

// ------------------------------------------------------------------ drafting

export type HubDrafter = (request: HubReplyRequest) => Promise<string>;

export interface HubScanOptions {
  settings?: HubsSettings;
  fetchJson?: HubFetcher;
  /** Defaults to the writer when one is configured. Replies to strangers are never templated. */
  drafter?: HubDrafter | null;
  /** Only these hubs (refs), instead of the top `watch`. */
  hubs?: string[];
  campaignId?: string;
  now?: number;
  log?: (line: string) => void;
}

export interface HubScanResult {
  /** Hubs read, and what each gave. */
  read: Array<{ hub: string; posts: number; fresh: number; note?: string }>;
  drafts: HubDraft[];
  /** Posts the writer read and judged not worth a reply. */
  declined: number;
  /** Hubs on networks that need a person (LinkedIn, X), listed so they are not forgotten. */
  manual: string[];
  /** Why drafting did not happen at all, when it did not. */
  note?: string;
}

const newDraftId = (): string => `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Read the watched hubs and draft replies.
 *
 * A post the writer declined is marked seen; one it never got to (the
 * per-scan cap, no writer) is left for the next scan.
 */
export async function scanHubs(options: HubScanOptions = {}): Promise<HubScanResult> {
  const settings = options.settings ?? loadSettings().hubs;
  const fetchJson = options.fetchJson ?? defaultFetch;
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now();
  const at = new Date(now).toISOString();
  const drafter = options.drafter === null ? undefined : (options.drafter ?? (writerAvailable().ok ? hubReplyDraft : undefined));
  const file = readHubs();
  const seen = new Set(file.seen);
  const result: HubScanResult = { read: [], drafts: [], declined: 0, manual: [] };
  if (!drafter) result.note = `No writer configured (${writerAvailable().reason ?? "myna config ai"}); hubs were read but nothing was drafted.`;

  let pool = rankedHubs(file.hubs).filter((hub) => !options.campaignId || hub.campaignId === options.campaignId);
  if (options.hubs?.length) {
    pool = options.hubs.map((ref) => findHub(file.hubs, ref)).filter((hub): hub is Hub => Boolean(hub));
  }
  result.manual = pool.filter((hub) => !READABLE.has(hub.network)).map((hub) => hub.id);
  const watched = pool.filter((hub) => READABLE.has(hub.network)).slice(0, options.hubs?.length ? undefined : settings.watch);
  const oldest = now - settings.maxAgeHours * HOUR_MS;

  for (const hub of watched) {
    let posts: HubPost[];
    try {
      posts = await readHubPosts(hub, settings, fetchJson);
      delete hub.note;
    } catch (error) {
      hub.note = (error as Error).message.slice(0, 200);
      result.read.push({ hub: hub.id, posts: 0, fresh: 0, note: hub.note });
      continue;
    }
    hub.readAt = at;
    const fresh = posts.filter((post) => !seen.has(post.id) && Date.parse(post.postedAt) >= oldest && post.text.trim().length >= 20);
    result.read.push({ hub: hub.id, posts: posts.length, fresh: fresh.length });
    if (!drafter) continue;
    const charLimit = getNetwork(hub.network)?.caps.charLimit || undefined;
    for (const post of fresh) {
      if (result.drafts.length >= settings.draftsPerScan) break;
      let reply = "";
      try {
        reply = await drafter({
          network: hub.network,
          hub: hub.displayName ? `${hub.displayName} (@${hub.handle})` : `@${hub.handle}`,
          post: post.text,
          ...(charLimit ? { charLimit } : {}),
          ...(hub.product ? { product: hub.product } : {}),
        });
      } catch (error) {
        log(`hubs: drafting under ${post.url}: ${(error as Error).message}`);
        continue;
      }
      seen.add(post.id);
      file.seen.push(post.id);
      if (!reply) {
        result.declined += 1;
        continue;
      }
      const draft: HubDraft = {
        id: newDraftId(),
        hubId: hub.id,
        network: hub.network,
        postId: post.id,
        postUrl: post.url,
        postText: post.text.slice(0, 2000),
        postedAt: post.postedAt,
        reply,
        status: "pending",
        createdAt: at,
        ...(hub.campaignId ? { campaignId: hub.campaignId } : {}),
      };
      file.drafts.push(draft);
      result.drafts.push(draft);
      log(`hubs: drafted under ${hub.id} ${post.url}`);
    }
  }
  writeHubs(file);
  return result;
}

// ------------------------------------------------------------------ deciding

export function listHubDrafts(status: HubDraftStatus | "all" = "pending"): HubDraft[] {
  return readHubs()
    .drafts.filter((draft) => status === "all" || draft.status === status)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function takeDraft(ref: string): { file: ReturnType<typeof readHubs>; draft: HubDraft } {
  const file = readHubs();
  const draft = findIn(file.drafts, ref);
  if (!draft) throw new Error(`No hub draft ${ref}. myna hubs drafts lists them.`);
  return { file, draft };
}

export function editHubDraft(ref: string, text: string): HubDraft {
  const { file, draft } = takeDraft(ref);
  if (draft.status !== "pending") throw new Error(`Draft ${draft.id} is ${draft.status}; only a pending draft can be edited.`);
  if (!text.trim()) throw new Error("The reply cannot be empty. Skip it instead.");
  draft.reply = text.trim();
  writeHubs(file);
  return draft;
}

export function skipHubDraft(ref: string): HubDraft {
  const { file, draft } = takeDraft(ref);
  if (draft.status !== "pending") throw new Error(`Draft ${draft.id} is already ${draft.status}.`);
  draft.status = "skipped";
  draft.decidedAt = new Date().toISOString();
  writeHubs(file);
  return draft;
}

/**
 * A person said yes. On Bluesky or Mastodon the reply goes into the post
 * queue under their post, due now, so the scheduler's pacing decides when it
 * actually leaves; anywhere else it becomes a hand-off card.
 */
export function approveHubDraft(
  ref: string,
  options: { account?: string; text?: string; accounts?: Account[]; now?: number } = {},
): HubDraft {
  const { file, draft } = takeDraft(ref);
  if (draft.status !== "pending") throw new Error(`Draft ${draft.id} is already ${draft.status}.`);
  if (options.text?.trim()) draft.reply = options.text.trim();
  const at = new Date(options.now ?? Date.now()).toISOString();
  const hub = file.hubs.find((entry) => entry.id === draft.hubId);
  const accounts = options.accounts ?? (READABLE.has(draft.network) ? listAccounts() : []);
  const account = options.account
    ? accounts.find((entry) => entry.id === options.account)
    : accounts.find((entry) => entry.network === draft.network);
  if (options.account && !account) throw new Error(`No connected account ${options.account}.`);
  if (account && account.network !== draft.network) throw new Error(`${account.id} is not on ${draft.network}.`);

  if (READABLE.has(draft.network) && account) {
    const queued = enqueue({
      scheduledFor: at,
      targets: [account.id],
      text: draft.reply,
      replyTo: draft.postId,
      extra: { hubDraft: draft.id },
    });
    draft.status = "queued";
    draft.account = account.id;
    draft.queueId = queued.id;
  } else {
    const card = addHandoff({
      place: `${draft.network}: ${hub?.handle ?? draft.hubId}`,
      title: `Reply under ${hub?.handle ?? draft.hubId}`,
      text: draft.reply,
      openUrl: draft.postUrl,
      steps: [
        "Open the post and read the newest replies; skip it if someone already said this.",
        "Paste the reply under the post.",
        "Mark done.",
      ],
    });
    draft.status = "handoff";
    draft.handoffId = card.id;
  }
  draft.decidedAt = at;
  writeHubs(file);
  return draft;
}
