/**
 * The follow graph, end to end against a fake network.
 *
 * The ranking rule is the product: someone two seeds follow outranks someone
 * one seed follows, your own accounts are never candidates, and a follow that
 * went out is never sent again.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_CAPS, type Network, type Profile } from "../src/net/types.ts";
import { registerNetwork } from "../src/net/registry.ts";
import { resetAccountCache, saveAccount } from "../src/store/accounts.ts";
import { loadSettings, saveSettings } from "../src/store/settings.ts";
import {
  addSeeds,
  expandSeeds,
  followBudget,
  followNext,
  graphStatus,
  rankCandidates,
  readGraph,
  removeSeed,
  skipCandidate,
} from "../src/core/graph.ts";

let dir = "";
const followed: string[] = [];
const lists: Record<string, Profile[]> = {
  alice: [{ handle: "x" }, { handle: "y", followers: 10 }, { handle: "z", followers: 5 }],
  bob: [{ handle: "y" }, { handle: "z" }, { handle: "me" }],
  broken: [],
};

const fake: Network = {
  id: "fake",
  name: "Fake",
  category: "minor",
  blurb: "test",
  auth: { kind: "token", fields: [{ key: "token", label: "Token", secret: true }] },
  caps: { ...NO_CAPS, follow: true },
  async login() {
    throw new Error("unused");
  },
  async post() {
    throw new Error("unused");
  },
  async following(_account, handle) {
    if (handle === "broken") throw new Error("rate limited");
    return lists[handle] ?? [];
  },
  async follow(_account, handle) {
    if (handle === "z") throw new Error("blocked");
    followed.push(handle);
    return {};
  },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-graph-"));
  process.env.MYNA_HOME = dir;
  resetAccountCache();
  followed.length = 0;
  registerNetwork(fake);
  saveAccount({ id: "fake:me", network: "fake", handle: "me", addedAt: "", creds: { token: "t" }, meta: {} });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
  resetAccountCache();
});

test("seeds upsert by network and handle", () => {
  expect(addSeeds([{ network: "fake", handle: "alice" }, { network: "fake", handle: "@Alice", weight: 2 }])).toEqual({ added: 1, updated: 1 });
  expect(readGraph().seeds).toHaveLength(1);
  expect(readGraph().seeds[0].weight).toBe(2);
  expect(addSeeds([{ network: "nope", handle: "x" }]).added).toBe(0);
  expect(removeSeed("fake", "alice")).toBe(true);
  expect(removeSeed("fake", "alice")).toBe(false);
});

test("who several seeds follow ranks above who one seed follows, and you are never a candidate", async () => {
  addSeeds([
    { network: "fake", handle: "alice" },
    { network: "fake", handle: "bob" },
  ]);
  const result = await expandSeeds();
  expect(result.expanded).toBe(2);
  expect(result.failed).toHaveLength(0);

  const ranked = rankCandidates();
  const handles = ranked.map((candidate) => candidate.handle);
  expect(handles).not.toContain("me");
  // y and z: two seeds each. y wins the tie on followers.
  expect(handles.slice(0, 2)).toEqual(["y", "z"]);
  expect(ranked[0].score).toBe(2);
  expect(ranked[0].seeds).toBe(2);
  // The seeds themselves are candidates too, at their own weight.
  expect(handles).toContain("alice");
  expect(ranked.find((candidate) => candidate.handle === "x")?.score).toBe(1);
});

test("a heavier seed's opinion counts for more", async () => {
  addSeeds([
    { network: "fake", handle: "alice", weight: 3 },
    { network: "fake", handle: "bob", weight: 1 },
  ]);
  await expandSeeds();
  const ranked = rankCandidates();
  // x is followed only by alice (3); y and z by both (4).
  expect(ranked.map((candidate) => candidate.handle).slice(0, 2).sort()).toEqual(["y", "z"]);
  expect(ranked.find((candidate) => candidate.handle === "x")?.score).toBe(3);
});

test("a seed nobody can read is reported, and a read that fails is not retried every tick", async () => {
  addSeeds([
    { network: "fake", handle: "broken" },
    { network: "bluesky", handle: "nobody.bsky.social" },
  ]);
  const result = await expandSeeds();
  expect(result.failed.map((failure) => failure.seed.handle)).toEqual(["broken"]);
  expect(result.unreadable.map((seed) => seed.handle)).toEqual(["nobody.bsky.social"]);
  expect(readGraph().seeds.find((seed) => seed.handle === "broken")?.error).toBe("rate limited");
  // Read recently, so the next pass leaves it alone.
  expect((await expandSeeds()).failed).toHaveLength(0);
  expect((await expandSeeds({ staleMs: 0 })).failed).toHaveLength(1);
});

test("following goes best first, records the ledger, and never repeats", async () => {
  addSeeds([
    { network: "fake", handle: "alice" },
    { network: "fake", handle: "bob" },
  ]);
  await expandSeeds();

  const sent = await followNext({ limit: 2 });
  expect(sent.map((record) => [record.handle, record.ok])).toEqual([
    ["y", true],
    ["z", false],
  ]);
  expect(sent[1].error).toBe("blocked");
  expect(followed).toEqual(["y"]);

  const graph = readGraph();
  expect(graph.follows).toHaveLength(2);
  expect(graph.candidates.find((candidate) => candidate.handle === "y")?.followedAt).toBeDefined();
  const remaining = rankCandidates().map((candidate) => candidate.handle);
  expect(remaining).not.toContain("y");
  // A failed follow backs off rather than being retried on the next tick.
  expect(remaining).not.toContain("z");
  expect(rankCandidates({ fresh: false }).map((candidate) => candidate.handle)).toContain("z");
  expect(graphStatus()).toMatchObject({ seeds: 2, seedsExpanded: 2, followed: 1, failed: 1 });
});

test("the budget is per account and every attempt counts against it", async () => {
  const settings = loadSettings();
  settings.graph.followsPerHour = 2;
  settings.graph.followsPerDay = 3;
  saveSettings(settings);
  addSeeds([{ network: "fake", handle: "alice" }]);
  await expandSeeds();

  expect(followBudget("fake:me")).toBe(2);
  const sent = await followNext();
  // Two attempts allowed by the hourly ceiling: y went out, z failed.
  expect(sent.map((record) => [record.handle, record.ok])).toEqual([
    ["y", true],
    ["z", false],
  ]);
  expect(followBudget("fake:me")).toBe(0);
  expect(await followNext()).toHaveLength(0);
  // --force ignores the ceiling; z is backing off so alice is next.
  const forced = await followNext({ ignoreBudget: true, limit: 1 });
  expect(forced.map((record) => record.handle)).toEqual(["alice"]);
  expect(followed).toEqual(["y", "alice"]);
});

test("a dry run reports without sending, and a skipped candidate is left alone", async () => {
  addSeeds([{ network: "fake", handle: "alice" }]);
  await expandSeeds();
  expect(skipCandidate("fake", "y")).toBe(true);
  expect(skipCandidate("fake", "unknown")).toBe(false);

  const lines: string[] = [];
  const sent = await followNext({ dryRun: true, limit: 10, log: (line) => lines.push(line) });
  expect(followed).toEqual([]);
  expect(sent.map((record) => record.handle)).not.toContain("y");
  expect(lines[0]).toMatch(/^would follow/);
  expect(readGraph().follows).toHaveLength(0);
});

test("the networks setting restricts where the daemon follows", async () => {
  const settings = loadSettings();
  settings.graph.networks = "bluesky";
  saveSettings(settings);
  addSeeds([{ network: "fake", handle: "alice" }]);
  await expandSeeds();
  expect(await followNext()).toHaveLength(0);
  expect(await followNext({ networks: ["fake"], limit: 1 })).toHaveLength(1);
});
