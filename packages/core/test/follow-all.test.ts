/**
 * Follow everyone somebody follows, from a pasted follows page.
 *
 * What has to hold: the suffix is recognised on the URLs people paste and
 * stripped to the profile the adapters know; the list is read from the
 * network; the account itself and anyone already followed cost nothing; the
 * graph's hourly budget and --limit both stop the run and say how many are
 * left; a dry run follows nobody; every follow lands in the ledger.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { followAllFollowing, followsListRef } from "../src/core/graph.ts";
import { readGraph, writeGraph } from "../src/store/graph.ts";
import { registerNetwork, unregisterNetwork } from "../src/net/registry.ts";
import { DEFAULT_SETTINGS } from "../src/store/settings.ts";
import type { Account, Network, Profile } from "../src/net/types.ts";

let dir = "";
const followed: string[] = [];
let people: Profile[] = [];

const network = {
  id: "fakesky",
  name: "Fakesky",
  caps: { charLimit: 300, mediaLimit: 4, threads: false, delete: false, timeline: false, notifications: false, stats: false, follow: true },
  async login() {
    throw new Error("not used");
  },
  async post() {
    return { id: "x" };
  },
  async following(_account: Account, handle: string) {
    // A real adapter takes the handle or the profile URL; this one takes both too.
    expect(handle.replace(/^https:\/\/bsky\.app\/profile\//, "")).toBe("mary.my.id");
    return people;
  },
  async follow(_account: Account, ref: string) {
    if (ref === "did:broken") throw new Error("blocked");
    followed.push(ref);
    return {};
  },
} as unknown as Network;

const account: Account = { id: "fakesky:me.test", network: "fakesky", handle: "me.test", addedAt: "", creds: {}, meta: {} };
const person = (handle: string, id = `did:${handle}`): Profile => ({ handle, id, displayName: handle });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-follow-all-"));
  process.env.MYNA_HOME = dir;
  followed.length = 0;
  people = [person("a"), person("me.test"), person("b"), person("c", "did:broken"), person("d"), person("e")];
  registerNetwork(network);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
  unregisterNetwork("fakesky");
});

test("the pasted page is recognised and reduced to the profile", () => {
  expect(followsListRef("https://bsky.app/profile/mary.my.id/follows")).toEqual({ profile: "https://bsky.app/profile/mary.my.id", all: true, direction: "following" });
  expect(followsListRef("https://hachyderm.io/@mary/following?page=2")).toEqual({ profile: "https://hachyderm.io/@mary", all: true, direction: "following" });
  expect(followsListRef("https://bsky.app/profile/mary.my.id")).toEqual({ profile: "https://bsky.app/profile/mary.my.id", all: false });
  expect(followsListRef("mary.my.id")).toEqual({ profile: "mary.my.id", all: false });
});

test("everyone on the list is followed except the account itself and the already followed, and failures are reported", async () => {
  const graph = readGraph();
  graph.follows.push({ accountId: account.id, network: "fakesky", handle: "d", at: new Date().toISOString(), ok: true });
  writeGraph(graph);

  const result = await followAllFollowing({ account, ref: "https://bsky.app/profile/mary.my.id/follows", settings: DEFAULT_SETTINGS, ignoreBudget: true });

  expect(result.read).toBe(6);
  expect(followed).toEqual(["did:a", "did:b", "did:e"]);
  expect(result.skipped).toEqual([
    { handle: "me.test", reason: "that is this account" },
    { handle: "d", reason: "already followed" },
  ]);
  expect(result.followed.map((record) => [record.handle, record.ok])).toEqual([["a", true], ["b", true], ["c", false], ["e", true]]);
  expect(result.remaining).toBe(0);
  expect(readGraph().follows.filter((record) => record.ok).map((record) => record.handle)).toEqual(["d", "a", "b", "e"]);
});

test("the hourly budget and --limit both stop the run and say what is left; a dry run follows nobody", async () => {
  const tight = { ...DEFAULT_SETTINGS, graph: { ...DEFAULT_SETTINGS.graph, followsPerHour: 2, followsPerDay: 80 } };
  const budgeted = await followAllFollowing({ account, ref: "mary.my.id", settings: tight });
  expect(followed).toEqual(["did:a", "did:b"]);
  expect(budgeted.remaining).toBe(3);

  // --limit 1: c fails and costs nothing, d is the one follow, e is left.
  followed.length = 0;
  const limited = await followAllFollowing({ account, ref: "mary.my.id", settings: DEFAULT_SETTINGS, ignoreBudget: true, limit: 1 });
  expect(followed).toEqual(["did:d"]);
  expect(limited.followed.map((record) => [record.handle, record.ok])).toEqual([["c", false], ["d", true]]);
  expect(limited.remaining).toBe(1);

  followed.length = 0;
  const rehearsal = await followAllFollowing({ account, ref: "mary.my.id", settings: DEFAULT_SETTINGS, ignoreBudget: true, dryRun: true });
  expect(followed).toEqual([]);
  expect(rehearsal.followed.map((record) => record.handle)).toEqual(["c", "e"]);
});
