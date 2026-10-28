/**
 * Engage the hubs: read the accounts a campaign's buyers follow, draft
 * replies under their posts, and send nothing until a person approves.
 *
 * What has to hold: imports keep a hub's history and replace a campaign's
 * ranking on request; Bluesky and Mastodon are read through their public
 * doors, reposts and old posts are skipped; X and LinkedIn hubs are listed to
 * watch by hand, never read; a declined post is not drafted again, one the
 * cap left over is; approving queues a reply under their post (paced by the
 * scheduler) or, with no account there, makes a hand-off card; and a queued
 * reply goes out with `replyTo`.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { approveHubDraft, importHubs, readHubPosts, scanHubs, skipHubDraft, type HubFetcher } from "../src/core/hubs.ts";
import { readHubs } from "../src/store/hubs.ts";
import { listQueue } from "../src/store/queue.ts";
import { getHandoff } from "../src/store/handoffs.ts";
import { DEFAULT_HUBS, type HubsSettings } from "../src/store/settings.ts";
import { postToAll } from "../src/core/poster.ts";
import { registerNetwork, unregisterNetwork } from "../src/net/registry.ts";
import type { Account, Network, PostInput } from "../src/net/types.ts";
import type { HubReplyRequest } from "../src/ai/writer.ts";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-hubs-"));
  process.env.MYNA_HOME = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
});

const NOW = Date.parse("2026-10-28T12:00:00Z");
const iso = (hoursAgo: number): string => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const settings = (patch: Partial<HubsSettings> = {}): HubsSettings => ({ ...DEFAULT_HUBS, bskyBase: "https://bsky.test", ...patch });

const fetchJson: HubFetcher = async (url) => {
  if (url.startsWith("https://bsky.test/xrpc/app.bsky.feed.getAuthorFeed")) {
    return {
      feed: [
        { post: { uri: "at://did:plc:hub/app.bsky.feed.post/aaa", cid: "c1", author: { handle: "hub.bsky.social" }, record: { text: "What is the one channel that got your first 100 users?", createdAt: iso(2) } } },
        { post: { uri: "at://did:plc:hub/app.bsky.feed.post/bbb", cid: "c2", author: { handle: "hub.bsky.social" }, record: { text: "Happy birthday to my wonderful partner, love you", createdAt: iso(3) } } },
        { post: { uri: "at://did:plc:x/app.bsky.feed.post/rp", cid: "c3", record: { text: "a repost of somebody else, long enough", createdAt: iso(1) } }, reason: { $type: "app.bsky.feed.defs#reasonRepost" } },
        { post: { uri: "at://did:plc:hub/app.bsky.feed.post/old", cid: "c4", record: { text: "An old post from last month about growth", createdAt: iso(24 * 30) } } },
      ],
    };
  }
  if (url === "https://mastodon.test/api/v1/accounts/lookup?acct=maker") return { id: "42" };
  if (url.startsWith("https://mastodon.test/api/v1/accounts/42/statuses")) {
    return [{ url: "https://mastodon.test/@maker/1", content: "<p>Cold email reply rates fell off a cliff this quarter. Anyone else?</p>", created_at: iso(5), visibility: "public" }];
  }
  throw new Error(`unexpected ${url}`);
};

test("Bluesky and Mastodon are read through their public doors; X is not read", async () => {
  const bsky = await readHubPosts({ network: "bluesky", handle: "hub.bsky.social" }, settings(), fetchJson);
  expect(bsky.length).toBe(3);
  expect(bsky[0]).toMatchObject({ id: "at://did:plc:hub/app.bsky.feed.post/aaa|c1", url: "https://bsky.app/profile/hub.bsky.social/post/aaa" });
  const masto = await readHubPosts({ network: "mastodon", handle: "maker@mastodon.test" }, settings(), fetchJson);
  expect(masto[0]).toMatchObject({ id: "https://mastodon.test/@maker/1", text: "Cold email reply rates fell off a cliff this quarter. Anyone else?" });
  await expect(readHubPosts({ network: "x", handle: "dharmesh" }, settings(), fetchJson)).rejects.toThrow("watch dharmesh by hand");
});

test("import keeps a hub's history; replace drops the campaign's old ranking", () => {
  importHubs([{ network: "bluesky", handle: "@hub.bsky.social", score: 3 }, { network: "twitter", handle: "dharmesh", score: 2 }], { campaignId: "cmp_1", now: NOW - 86_400_000 });
  const before = readHubs().hubs.find((hub) => hub.id === "bluesky:hub.bsky.social")!;
  expect(readHubs().hubs.map((hub) => hub.id).sort()).toEqual(["bluesky:hub.bsky.social", "x:dharmesh"]);
  const again = importHubs([{ network: "bluesky", handle: "hub.bsky.social", score: 5, why: "followed by 4 of 9 leads" }], { campaignId: "cmp_1", replace: true, now: NOW });
  expect(again.hubs.map((hub) => hub.id)).toEqual(["bluesky:hub.bsky.social"]);
  expect(again.hubs[0]).toMatchObject({ score: 5, why: "followed by 4 of 9 leads", addedAt: before.addedAt });
});

test("scan drafts only fresh posts worth answering, lists manual hubs, and never re-drafts a decline", async () => {
  importHubs(
    [
      { network: "bluesky", handle: "hub.bsky.social", score: 3 },
      { network: "mastodon", handle: "maker@mastodon.test", score: 2 },
      { network: "linkedin", handle: "kippbodnar", score: 9 },
    ],
    { campaignId: "cmp_1", product: { name: "ugig", url: "https://ugig.net/pay-per-pr" } },
  );
  const asked: HubReplyRequest[] = [];
  const drafter = async (request: HubReplyRequest) => {
    asked.push(request);
    return request.post.includes("birthday") ? "" : `Reply to: ${request.post.slice(0, 20)}`;
  };
  const first = await scanHubs({ settings: settings(), fetchJson, drafter, now: NOW });
  expect(first.manual).toEqual(["linkedin:kippbodnar"]);
  expect(first.drafts.map((draft) => draft.postUrl)).toEqual(["https://bsky.app/profile/hub.bsky.social/post/aaa", "https://mastodon.test/@maker/1"]);
  expect(first.declined).toBe(1);
  expect(asked[0]?.product?.url).toBe("https://ugig.net/pay-per-pr");
  expect(asked[0]?.charLimit).toBe(300);
  expect(first.drafts.every((draft) => draft.status === "pending")).toBe(true);

  asked.length = 0;
  const second = await scanHubs({ settings: settings(), fetchJson, drafter, now: NOW });
  expect(second.drafts.length).toBe(0);
  expect(asked.length).toBe(0);
});

test("the per-scan cap leaves the rest for next time; no writer drafts nothing and marks nothing seen", async () => {
  importHubs([{ network: "bluesky", handle: "hub.bsky.social" }]);
  const none = await scanHubs({ settings: settings(), fetchJson, drafter: null, now: NOW });
  expect(none.drafts.length).toBe(0);
  expect(none.note).toContain("No writer");
  expect(readHubs().seen.length).toBe(0);
  const capped = await scanHubs({ settings: settings({ draftsPerScan: 1 }), fetchJson, drafter: async () => "something useful", now: NOW });
  expect(capped.drafts.length).toBe(1);
  const rest = await scanHubs({ settings: settings({ draftsPerScan: 5 }), fetchJson, drafter: async () => "something useful", now: NOW });
  expect(rest.drafts.length).toBe(1);
});

const account = (network: string, handle: string): Account => ({ id: `${network}:${handle}`, network, handle, addedAt: iso(1000), creds: {}, meta: {} });

test("approving queues a reply under their post; with no account there it is a hand-off card", async () => {
  importHubs([{ network: "bluesky", handle: "hub.bsky.social" }, { network: "mastodon", handle: "maker@mastodon.test" }]);
  const { drafts } = await scanHubs({ settings: settings(), fetchJson, drafter: async (request) => `useful ${request.network}`, now: NOW });
  const bsky = drafts.find((draft) => draft.network === "bluesky")!;
  const masto = drafts.find((draft) => draft.network === "mastodon")!;

  const queued = approveHubDraft(bsky.id, { accounts: [account("bluesky", "riotcoder.social.w3bs.org")], text: "edited reply", now: NOW });
  expect(queued.status).toBe("queued");
  const entry = listQueue().find((post) => post.id === queued.queueId)!;
  expect(entry).toMatchObject({ targets: ["bluesky:riotcoder.social.w3bs.org"], text: "edited reply", replyTo: "at://did:plc:hub/app.bsky.feed.post/aaa|c1", status: "pending" });
  expect(() => approveHubDraft(bsky.id, { accounts: [] })).toThrow("already queued");

  const card = approveHubDraft(masto.id, { accounts: [], now: NOW });
  expect(card.status).toBe("handoff");
  expect(getHandoff(card.handoffId!)?.openUrl).toBe("https://mastodon.test/@maker/1");

  importHubs([{ network: "bluesky", handle: "other.bsky.social" }]);
  expect(() => skipHubDraft("nope")).toThrow("No hub draft");
});

test("a queued reply goes out with replyTo on its first part", async () => {
  const sent: PostInput[] = [];
  const fake: Network = {
    id: "fakenet",
    name: "Fake",
    category: "minor",
    blurb: "test",
    auth: { kind: "token", fields: [] },
    caps: { charLimit: 0, mediaLimit: 0, threads: true, delete: false, timeline: false, notifications: false, stats: false },
    async login() {
      return { handle: "me", creds: {}, meta: {} };
    },
    async post(_account, input) {
      sent.push(input);
      return { id: `id${sent.length}` };
    },
  };
  registerNetwork(fake);
  try {
    await postToAll([account("fakenet", "me")], { text: "a reply", replyTo: "their-post" });
    expect(sent[0]?.replyTo).toBe("their-post");
  } finally {
    unregisterNetwork("fakenet");
  }
});
