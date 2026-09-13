/**
 * The followers side of the graph, and the hook a follow fires.
 *
 * What has to hold: a pasted followers page is recognised and read from the
 * followers list; `graph.expand` decides which list a seed's expansion reads,
 * and a follower of a seed scores `followerWeight` of a follow, so who seeds
 * follow still outranks who follows seeds; every follow that goes out reaches
 * a plugin's `afterFollow` with what is known about the person, the source,
 * and the command's flags, and a hook that throws never undoes the follow.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_CAPS, type Account, type Network, type Profile } from "../src/net/types.ts";
import { registerNetwork, unregisterNetwork } from "../src/net/registry.ts";
import { resetAccountCache, saveAccount } from "../src/store/accounts.ts";
import { loadSettings, saveSettings } from "../src/store/settings.ts";
import { registerPlugin, resetPlugins } from "../src/plugins/loader.ts";
import type { FollowedEvent } from "../src/plugins/types.ts";
import { addSeeds, expandSeeds, followAllFollowing, followNext, followOne, followsListRef, rankCandidates, readGraph } from "../src/core/graph.ts";

let dir = "";
const followed: string[] = [];
const seen: { event: FollowedEvent; flags: Record<string, unknown> }[] = [];

const follows: Record<string, Profile[]> = {
  alice: [{ handle: "x" }, { handle: "y" }],
};
const followers: Record<string, Profile[]> = {
  alice: [{ handle: "y" }, { handle: "f1", displayName: "Fan One", bio: "hi", url: "https://fake/f1", id: "did:f1" }, { handle: "me" }],
};

const fake: Network = {
  id: "fake",
  name: "Fake",
  category: "minor",
  blurb: "test",
  auth: { kind: "token", docsUrl: "https://example.com/tokens", fields: [{ key: "token", label: "Token", secret: true }] },
  caps: { ...NO_CAPS, follow: true },
  async login() {
    throw new Error("unused");
  },
  async post() {
    throw new Error("unused");
  },
  // A real adapter takes a handle or a pasted profile URL; this one takes both too.
  async following(_account, handle) {
    return follows[handle.replace(/^https:\/\/fake\//, "")] ?? [];
  },
  async followers(_account, handle) {
    return followers[handle.replace(/^https:\/\/fake\//, "")] ?? [];
  },
  async follow(_account, handle) {
    if (handle === "blocked") throw new Error("blocked");
    followed.push(handle);
    return {};
  },
};

const account: Account = { id: "fake:me", network: "fake", handle: "me", addedAt: "", creds: { token: "t" }, meta: {} };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-followers-"));
  process.env.MYNA_HOME = dir;
  resetAccountCache();
  resetPlugins();
  followed.length = 0;
  seen.length = 0;
  registerNetwork(fake);
  saveAccount(account);
  registerPlugin({
    id: "spy",
    name: "Spy",
    async afterFollow(event, ctx) {
      seen.push({ event, flags: ctx.flags });
      if (event.handle === "y") throw new Error("spy broke");
      return `saw ${event.handle}`;
    },
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
  resetAccountCache();
  resetPlugins();
  unregisterNetwork("fake");
});

test("a pasted followers page is recognised, and the direction travels with it", () => {
  expect(followsListRef("https://bsky.app/profile/mary.my.id/followers")).toEqual({ profile: "https://bsky.app/profile/mary.my.id", all: true, direction: "followers" });
  expect(followsListRef("https://hachyderm.io/@mary/followers?page=2")).toEqual({ profile: "https://hachyderm.io/@mary", all: true, direction: "followers" });
  expect(followsListRef("https://bsky.app/profile/mary.my.id/follows")).toEqual({ profile: "https://bsky.app/profile/mary.my.id", all: true, direction: "following" });
  expect(followsListRef("mary.my.id")).toEqual({ profile: "mary.my.id", all: false });
});

test("following everyone who follows someone reads the followers list, skips you, and tells the plugins", async () => {
  const result = await followAllFollowing({ account, ref: "https://fake/alice/followers", ignoreBudget: true, hookFlags: { outreachgraph: true } });
  expect(result.read).toBe(3);
  // The adapter is handed the stable id when there is one, the handle otherwise.
  expect(followed).toEqual(["y", "did:f1"]);
  expect(result.skipped).toEqual([{ handle: "me", reason: "that is this account" }]);

  expect(seen.map((entry) => entry.event.handle)).toEqual(["y", "f1"]);
  const f1 = seen[1]!;
  expect(f1.event).toMatchObject({ network: "fake", handle: "f1", id: "did:f1", displayName: "Fan One", bio: "hi", url: "https://fake/f1", source: "list", via: "followers:fake|https://fake/alice" });
  expect(f1.event.account.id).toBe("fake:me");
  expect(f1.flags).toEqual({ outreachgraph: true });
  // The hook threw on y; the follow still went out and was recorded.
  expect(readGraph().follows.filter((record) => record.ok).map((record) => record.handle)).toEqual(["y", "f1"]);
});

test("graph.expand picks the list, and a follower counts followerWeight of a follow", async () => {
  addSeeds([{ network: "fake", handle: "alice" }]);
  const settings = loadSettings();
  settings.graph.expand = "both";
  settings.graph.followerWeight = 0.25;
  settings.graph.followSeeds = false;
  saveSettings(settings);

  const result = await expandSeeds();
  expect(result.expanded).toBe(1);
  // x and y from following, y and f1 from followers; me is never a candidate.
  const ranked = rankCandidates();
  const score = Object.fromEntries(ranked.map((candidate) => [candidate.handle, candidate.score]));
  expect(score).toEqual({ y: 1.25, x: 1, f1: 0.25 });
  expect(ranked.map((candidate) => candidate.handle)).toEqual(["y", "x", "f1"]);
  expect(readGraph().candidates.find((candidate) => candidate.handle === "f1")?.via).toEqual(["followers:fake|alice"]);

  // An explicit direction overrides the setting for one read.
  const again = await expandSeeds({ staleMs: 0, direction: "following" });
  expect(again.expanded).toBe(1);
});

test("the graph's own follows reach the plugins as graph follows, with the seed they came through", async () => {
  addSeeds([{ network: "fake", handle: "alice" }]);
  const settings = loadSettings();
  settings.graph.followSeeds = false;
  saveSettings(settings);
  await expandSeeds();

  const sent = await followNext({ limit: 1, ignoreBudget: true, hookFlags: { outreachgraph: true } });
  expect(sent).toHaveLength(1);
  expect(seen).toHaveLength(1);
  expect(seen[0]!.event).toMatchObject({ source: "graph", via: "fake|alice", handle: sent[0]!.handle });
});

test("a single follow by hand is a manual event, and a failed follow fires nothing", async () => {
  await followOne(account, "someone", "someone", { source: "manual", flags: { dryRun: false } });
  await followOne(account, "blocked");
  expect(seen).toHaveLength(1);
  expect(seen[0]!.event).toMatchObject({ source: "manual", handle: "someone" });
  expect(seen[0]!.event.via).toBeUndefined();
});
