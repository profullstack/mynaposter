/**
 * Hubs: the handful of accounts a campaign's buyers follow and reply to.
 *
 * On a conversational network there is no subreddit to post in. The room is
 * the replies under a few accounts everybody in the audience reads, so the
 * work is to know who those accounts are, watch what they post, and answer
 * there. `hubs.json` holds the ranked hubs (from an OutreachGraph campaign or
 * added by hand), the posts already read, and the reply drafts waiting on a
 * person.
 *
 * A draft never sends itself. Approving one puts it in the post queue as a
 * reply, where pacing decides when it goes; on a network myna cannot post to
 * (LinkedIn, X) approving makes a hand-off card instead.
 */
import { readJson, writeJson } from "../util/json.ts";
import { HUBS_FILE } from "../util/paths.ts";

export interface Hub {
  /** `network:handle`, the key. */
  id: string;
  network: string;
  handle: string;
  displayName?: string;
  url?: string;
  /** How central it is to the campaign's leads, higher first. */
  score: number;
  /** Leads that follow it, and leads that replied to it, where the source could tell. */
  followedBy?: number;
  repliedBy?: number;
  /** One line on why it is a hub: "followed by 6 of 9 leads". */
  why?: string;
  source: "outreachgraph" | "manual";
  campaignId?: string;
  /** The product a reply may mention, from the campaign. */
  product?: { name: string; url: string; about?: string };
  addedAt: string;
  readAt?: string;
  /** Why the last read failed, or that this network cannot be read without an account. */
  note?: string;
}

/**
 * Where a draft stands.
 *
 *   pending    written, waiting on a person
 *   queued     approved, in the post queue as a reply (paced there)
 *   handoff    approved on a network myna cannot post to: a card to paste
 *   skipped    dropped by a person
 */
export type HubDraftStatus = "pending" | "queued" | "handoff" | "skipped";

export interface HubDraft {
  id: string;
  hubId: string;
  network: string;
  /** Their post: what to reply under, in the network's `replyTo` form, and where a person opens it. */
  postId: string;
  postUrl: string;
  postText: string;
  postedAt: string;
  reply: string;
  status: HubDraftStatus;
  createdAt: string;
  /** Set on approval. */
  account?: string;
  queueId?: string;
  handoffId?: string;
  decidedAt?: string;
  campaignId?: string;
}

export interface HubsFile {
  hubs: Hub[];
  drafts: HubDraft[];
  /** Post ids already read, so a post is drafted for at most once. */
  seen: string[];
}

const SEEN_LIMIT = 10_000;
const DRAFT_LIMIT = 2_000;

export function readHubs(): HubsFile {
  const file = readJson<Partial<HubsFile>>(HUBS_FILE, {});
  return {
    hubs: Array.isArray(file.hubs) ? file.hubs : [],
    drafts: Array.isArray(file.drafts) ? file.drafts : [],
    seen: Array.isArray(file.seen) ? file.seen : [],
  };
}

export function writeHubs(file: HubsFile): void {
  file.seen = file.seen.slice(-SEEN_LIMIT);
  if (file.drafts.length > DRAFT_LIMIT) {
    // The decided ones go first: a pending draft is work a person has not seen.
    const decided = file.drafts.filter((draft) => draft.status !== "pending");
    const drop = new Set(decided.slice(0, file.drafts.length - DRAFT_LIMIT).map((draft) => draft.id));
    file.drafts = file.drafts.filter((draft) => !drop.has(draft.id));
  }
  writeJson(HUBS_FILE, file);
}

export const hubKey = (network: string, handle: string): string => `${network.toLowerCase()}:${handle.trim().replace(/^@/, "").toLowerCase()}`;
