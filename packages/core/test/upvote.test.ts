/**
 * The upvoter: a scan finds other people posting about what we post about, a
 * run casts what is due, and every brake holds. Against a fake network and a
 * fake writer.
 *
 * What has to hold: topics come off our own history and nothing else; our own
 * posts are never voted on; a post has to clear the score before it is
 * queued, and a higher one before it may carry a link; one action per author
 * per cooldown; the same post is never queued twice; the gap, the daily cap
 * and the separate link cap all hold; a writer that declines means no link
 * rather than a bare advert; and a manual-only network is queued but never
 * cast until somebody names it.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scanUpvotes, runUpvotes, share, ourHandles, actedToday } from "../src/core/upvote.ts";
import { topicIndex, queriesFor, scoreAgainst, bestLink, termSet } from "../src/core/topics.ts";
import { listUpvotes, readUpvotes, updateUpvote } from "../src/store/upvote.ts";
import { recordHistory, listHistory } from "../src/store/history.ts";
import { resetAccountCache, saveAccount } from "../src/store/accounts.ts";
import { registerNetwork, unregisterNetwork } from "../src/net/registry.ts";
import { registerPlugin, resetPlugins } from "../src/plugins/loader.ts";
import type { DiscoveredEvent } from "../src/plugins/types.ts";
import { DEFAULT_UPVOTE } from "../src/store/settings.ts";
import type { Account, Network, TimelineItem } from "../src/net/types.ts";
import type { LinkDropRequest } from "../src/ai/writer.ts";

let dir = "";
const registered: string[] = [];
const voted: { account: string; ref: string; dir: number }[] = [];
const reposted: { account: string; ref: string }[] = [];
const posted: { account: string; text: string; replyTo?: string }[] = [];
let results: TimelineItem[] = [];
let searches: string[] = [];

function useNetwork(id: string, options: { upvote?: boolean; repost?: boolean; search?: boolean } = {}): void {
  registerNetwork({
    id,
    name: id,
    category: "major",
    blurb: id,
    auth: { kind: "password", fields: [] },
    caps: {
      charLimit: 300,
      mediaLimit: 0,
      threads: true,
      delete: false,
      timeline: false,
      notifications: false,
      stats: false,
      search: options.search ?? true,
      repost: options.repost ?? true,
      upvote: options.upvote ?? true,
    },
    async login() {
      throw new Error("not used");
    },
    async post(account: Account, input: { text: string; replyTo?: string }) {
      posted.push({ account: account.id, text: input.text, replyTo: input.replyTo });
      return { id: `r${posted.length}`, url: `https://${id}/r${posted.length}` };
    },
    async search(_account: Account, query: string) {
      searches.push(query);
      return results;
    },
    ...(options.repost === false
      ? {}
      : {
          async repost(account: Account, ref: string) {
            reposted.push({ account: account.id, ref });
            return { id: `rp${reposted.length}` };
          },
        }),
    ...(options.upvote === false
      ? {}
      : {
          async upvote(account: Account, ref: string, direction = 1) {
            if (ref === "boom") throw new Error("gone");
            voted.push({ account: account.id, ref, dir: direction });
            return { id: `v${voted.length}`, url: `https://${id}/p/${ref}` };
          },
        }),
  } as unknown as Network);
  registered.push(id);
}

const account = (id: string, network: string, handle = "me"): Account => ({
  id,
  network,
  handle,
  addedAt: "",
  creds: {},
  meta: {},
});

const drafts: LinkDropRequest[] = [];
const drafter = async (request: LinkDropRequest): Promise<string> => {
  drafts.push(request);
  // The writer declines on anything that reads like a complaint.
  if (request.theirText.includes("hate")) return "";
  return `On that: ${request.link}`;
};

const found = (over: Partial<TimelineItem> & { id: string }): TimelineItem => ({
  author: "Ada",
  handle: "ada",
  text: "",
  createdAt: "2026-09-12T11:00:00.000Z",
  ...over,
});

const T0 = Date.parse("2026-09-12T12:00:00.000Z");
const settings = { ...DEFAULT_UPVOTE, enabled: true, gapMinutes: 0, manualOnly: "" };

/** Our own posts, all about the same thing, so the topics are predictable. */
function ourHistory(): void {
  recordHistory([
    {
      at: "2026-09-11T10:00:00.000Z",
      accountId: "fake:me",
      network: "fake",
      handle: "me",
      text: "Shipped rust ropes: a rope data structure for terminal editors, with benchmarks.",
      ok: true,
      postId: "p1",
      url: "https://example.com/rust-ropes",
    },
    {
      at: "2026-09-10T10:00:00.000Z",
      accountId: "fake:me",
      network: "fake",
      handle: "me",
      text: "More on rust ropes and terminal editors: why a gap buffer loses on large files.",
      ok: true,
      postId: "p2",
      url: "https://example.com/gap-buffer",
    },
  ]);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-upvote-"));
  process.env.MYNA_HOME = dir;
  voted.length = 0;
  reposted.length = 0;
  posted.length = 0;
  drafts.length = 0;
  searches = [];
  results = [];
  resetAccountCache();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
  while (registered.length) unregisterNetwork(registered.pop() as string);
  resetAccountCache();
});

test("topics come off our own posts, strongest first, and become searches", () => {
  ourHistory();
  const index = topicIndex(listHistory(), { days: 14, now: T0 });
  const terms = index.topics.map((topic) => topic.term);
  expect(terms).toContain("rust ropes");
  expect(terms).toContain("terminal editors");
  // Stopwords and the vocabulary of posting itself never become a topic.
  expect(terms).not.toContain("shipped");
  expect(terms).not.toContain("more");
  expect(terms).not.toContain("the");

  // A two-word phrase is a better query than either word alone, so it leads.
  const queries = queriesFor(index, 4);
  expect(queries[0]).toContain(" ");
  expect(queries.length).toBeLessThanOrEqual(4);
});

test("a post about our subject scores, an unrelated one does not", () => {
  ourHistory();
  const index = topicIndex(listHistory(), { days: 14, now: T0 });
  const near = scoreAgainst("Anyone benchmarked rust ropes against a gap buffer for terminal editors?", index);
  const far = scoreAgainst("My sourdough starter died again, third time this month.", index);
  expect(near.score).toBeGreaterThan(far.score);
  expect(near.score).toBeGreaterThan(DEFAULT_UPVOTE.minScore);
  expect(far.score).toBe(0);
  expect(near.matched.length).toBeGreaterThan(0);
});

test("bestLink picks the post of ours that actually overlaps, and nothing when none does", () => {
  ourHistory();
  const index = topicIndex(listHistory(), { days: 14, now: T0 });
  const link = bestLink("struggling with a gap buffer in my terminal editor, rust ropes any better?", index);
  expect(link?.url).toMatch(/example\.com/);
  expect(bestLink("best sourdough hydration?", index)).toBeUndefined();
});

test("a scan queues other people's matching posts and never our own", async () => {
  useNetwork("fake");
  saveAccount(account("fake:me", "fake", "me"));
  ourHistory();
  results = [
    found({ id: "a1", handle: "ada", text: "rust ropes beat a gap buffer in my terminal editor, benchmarks here" }),
    found({ id: "a2", handle: "me", text: "rust ropes and terminal editors, my own post" }),
    found({ id: "a3", handle: "bob", text: "sourdough starter troubles again" }),
  ];

  const result = await scanUpvotes({ settings, now: T0, drafter, writerReady: true });

  const queued = result.queued;
  expect(queued.length).toBe(1);
  expect(queued[0]?.handle).toBe("ada");
  // Ours was skipped by handle, and the unrelated one by score.
  expect(queued.map((item) => item.handle)).not.toContain("me");
  expect(queued.map((item) => item.handle)).not.toContain("bob");
  expect(searches.length).toBeGreaterThan(0);
});

test("a second scan does not queue the same post twice", async () => {
  useNetwork("fake");
  saveAccount(account("fake:me", "fake", "me"));
  ourHistory();
  results = [found({ id: "a1", handle: "ada", text: "rust ropes in a terminal editor, with benchmarks" })];

  const first = await scanUpvotes({ settings, now: T0, drafter, writerReady: true });
  const second = await scanUpvotes({ settings, now: T0 + 1000, drafter, writerReady: true });
  expect(first.queued.length).toBe(1);
  expect(second.queued.length).toBe(0);
});

test("one author gets one action however many of their posts match", async () => {
  useNetwork("fake");
  saveAccount(account("fake:me", "fake", "me"));
  ourHistory();
  results = [
    found({ id: "a1", handle: "ada", text: "rust ropes in a terminal editor" }),
    found({ id: "a2", handle: "ada", text: "more rust ropes and terminal editors benchmarks" }),
  ];

  const result = await scanUpvotes({ settings, now: T0, drafter, writerReady: true });
  expect(result.queued.length).toBe(1);
});

test("a run votes, respects the daily cap, and records what it did", async () => {
  useNetwork("fake");
  saveAccount(account("fake:me", "fake", "me"));
  ourHistory();
  results = [
    found({ id: "a1", handle: "ada", text: "rust ropes in a terminal editor" }),
    found({ id: "a2", handle: "bea", text: "terminal editors and rust ropes, benchmarks" }),
  ];
  await scanUpvotes({ settings, now: T0, drafter, writerReady: true });

  const run = await runUpvotes({ settings: { ...settings, maxPerDay: 1 }, now: T0 });
  expect(run.done.length).toBe(1);
  expect(voted.length).toBe(1);
  expect(voted[0]?.dir).toBe(1);
  expect(listUpvotes().filter((item) => item.status === "done").length).toBe(1);
  // The second was held by the cap, not lost.
  expect(listUpvotes().filter((item) => item.status === "pending").length).toBe(1);
  expect(run.held.join(" ")).toContain("today already");
});

test("the gap holds between two actions from one account", async () => {
  useNetwork("fake");
  saveAccount(account("fake:me", "fake", "me"));
  ourHistory();
  results = [
    found({ id: "a1", handle: "ada", text: "rust ropes in a terminal editor" }),
    found({ id: "a2", handle: "bea", text: "terminal editors and rust ropes, benchmarks" }),
  ];
  const paced = { ...settings, gapMinutes: 30 };
  await scanUpvotes({ settings: paced, now: T0, drafter, writerReady: true });

  const first = await runUpvotes({ settings: paced, now: T0 });
  expect(first.done.length).toBe(1);
  // The next one is not even due yet, and would be inside the gap regardless.
  const second = await runUpvotes({ settings: paced, now: T0 + 60_000 });
  expect(second.done.length).toBe(0);
  const later = await runUpvotes({ settings: paced, now: T0 + 31 * 60_000 });
  expect(later.done.length).toBe(1);
});

test("a dry run casts nothing", async () => {
  useNetwork("fake");
  saveAccount(account("fake:me", "fake", "me"));
  ourHistory();
  results = [found({ id: "a1", handle: "ada", text: "rust ropes in a terminal editor" })];
  await scanUpvotes({ settings, now: T0, drafter, writerReady: true });

  const run = await runUpvotes({ settings, now: T0, dryRun: true });
  expect(run.done.length).toBe(1);
  expect(voted.length).toBe(0);
  expect(listUpvotes().every((item) => item.status === "pending")).toBe(true);
});

test("a manual-only network is queued but never cast until it is named", async () => {
  useNetwork("gated");
  saveAccount(account("gated:me", "gated", "me"));
  ourHistory();
  results = [found({ id: "a1", handle: "ada", text: "rust ropes in a terminal editor" })];
  const gated = { ...settings, manualOnly: "gated" };
  await scanUpvotes({ settings: gated, now: T0, drafter, writerReady: true });
  expect(listUpvotes().length).toBe(1);

  const blocked = await runUpvotes({ settings: gated, now: T0 });
  expect(blocked.done.length).toBe(0);
  expect(voted.length).toBe(0);
  expect(blocked.held.join(" ")).toContain("manual only");

  const asked = await runUpvotes({ settings: gated, now: T0, networks: ["gated"] });
  expect(asked.done.length).toBe(1);
  expect(voted.length).toBe(1);
});

test("a link drop is drafted, carries the link, and votes as well", async () => {
  useNetwork("fake");
  saveAccount(account("fake:me", "fake", "me"));
  ourHistory();
  results = [found({ id: "a1", handle: "ada", text: "rust ropes in a terminal editor, gap buffer benchmarks?" })];
  // Force the reply: every candidate is allowed to carry a link.
  const loud = { ...settings, linkRatio: 1, linkMinScore: 0, repostRatio: 0 };
  const scan = await scanUpvotes({ settings: loud, now: T0, drafter, writerReady: true });

  expect(scan.queued[0]?.action).toBe("reply");
  expect(scan.queued[0]?.reply).toContain("https://example.com/");
  expect(drafts.length).toBe(1);

  await runUpvotes({ settings: loud, now: T0 });
  expect(posted.length).toBe(1);
  expect(posted[0]?.replyTo).toBe("a1");
  expect(voted.length).toBe(1);
  // The reply is one of our posts now, so history has it.
  expect(listHistory().some((entry) => entry.type === "reply")).toBe(true);
});

test("a writer that declines means a plain vote, not a bare advert", async () => {
  useNetwork("fake");
  saveAccount(account("fake:me", "fake", "me"));
  ourHistory();
  results = [found({ id: "a1", handle: "ada", text: "I hate rust ropes in a terminal editor" })];
  const loud = { ...settings, linkRatio: 1, linkMinScore: 0, repostRatio: 0 };
  const scan = await scanUpvotes({ settings: loud, now: T0, drafter, writerReady: true });

  expect(drafts.length).toBe(1);
  expect(scan.queued[0]?.action).toBe("vote");
  expect(scan.queued[0]?.reply).toBeUndefined();

  await runUpvotes({ settings: loud, now: T0 });
  expect(posted.length).toBe(0);
  expect(voted.length).toBe(1);
});

test("no link is ever dropped when the writer is not available", async () => {
  useNetwork("fake");
  saveAccount(account("fake:me", "fake", "me"));
  ourHistory();
  results = [found({ id: "a1", handle: "ada", text: "rust ropes in a terminal editor" })];
  const loud = { ...settings, linkRatio: 1, linkMinScore: 0, repostRatio: 0 };
  const scan = await scanUpvotes({ settings: loud, now: T0, drafter, writerReady: false });
  expect(scan.queued[0]?.action).toBe("vote");
  expect(drafts.length).toBe(0);
});

test("the author cooldown stops a second action inside the window", async () => {
  useNetwork("fake");
  saveAccount(account("fake:me", "fake", "me"));
  ourHistory();
  results = [found({ id: "a1", handle: "ada", text: "rust ropes in a terminal editor" })];
  await scanUpvotes({ settings, now: T0, drafter, writerReady: true });
  await runUpvotes({ settings, now: T0 });
  expect(voted.length).toBe(1);

  // A different post by the same person, a day later.
  results = [found({ id: "a2", handle: "ada", text: "more rust ropes and terminal editors" })];
  const second = await scanUpvotes({ settings, now: T0 + 86_400_000, drafter, writerReady: true });
  expect(second.queued.length).toBe(0);
});

test("a stale post is not worth a vote", async () => {
  useNetwork("fake");
  saveAccount(account("fake:me", "fake", "me"));
  ourHistory();
  results = [
    found({
      id: "a1",
      handle: "ada",
      text: "rust ropes in a terminal editor",
      createdAt: new Date(T0 - 10 * 86_400_000).toISOString(),
    }),
  ];
  const result = await scanUpvotes({ settings, now: T0, drafter, writerReady: true });
  expect(result.queued.length).toBe(0);
});

test("nothing is searched for when we have not posted", async () => {
  useNetwork("fake");
  saveAccount(account("fake:me", "fake", "me"));
  const result = await scanUpvotes({ settings, now: T0, drafter, writerReady: true });
  expect(result.queued.length).toBe(0);
  expect(searches.length).toBe(0);
  expect(result.skipped.join(" ")).toContain("follows what you post");
});

test("a failed vote is recorded and not retried", async () => {
  useNetwork("fake");
  saveAccount(account("fake:me", "fake", "me"));
  ourHistory();
  results = [found({ id: "boom", handle: "ada", text: "rust ropes in a terminal editor" })];
  await scanUpvotes({ settings, now: T0, drafter, writerReady: true });

  await runUpvotes({ settings, now: T0 });
  const item = listUpvotes()[0];
  expect(item?.status).toBe("failed");
  expect(item?.error).toContain("gone");

  const again = await runUpvotes({ settings, now: T0 + 86_400_000 });
  expect(again.done.length).toBe(0);
});

test("share rounds toward acting but never past the cap", () => {
  expect(share(10, 0.15)).toBe(2);
  expect(share(10, 0.06, 2)).toBe(1);
  expect(share(30, 0.06, 2)).toBe(2);
  expect(share(3, 0)).toBe(0);
  expect(share(0, 1)).toBe(0);
});

test("our own handles are matched loosely enough to never vote on ourselves", () => {
  const mine = ourHandles([account("bluesky:a", "bluesky", "alice.bsky.social"), account("mastodon:b", "mastodon", "@bob@m.social")]);
  expect(mine.has("alice.bsky.social")).toBe(true);
  expect(mine.has("alice")).toBe(true);
  expect(mine.has("bob@m.social")).toBe(true);
  expect(mine.has("bob")).toBe(true);
});

test("termSet keeps phrases and drops the noise", () => {
  const terms = termSet("Check out https://example.com/x @someone #rustlang ropes are great");
  expect(terms.has("rustlang")).toBe(true);
  expect(terms.has("ropes")).toBe(true);
  expect(terms.has("https")).toBe(false);
  expect(terms.has("someone")).toBe(false);
  // "check out" is posting vocabulary, not a subject.
  expect(terms.has("check")).toBe(false);
});

test("actedToday counts only the last rolling day, and only that kind when asked", () => {
  const base = { network: "fake", handle: "ada", author: "Ada", postId: "p", postText: "", score: 1, matched: [], createdAt: "", dueAt: "" };
  const items = [
    { ...base, id: "1", accountId: "a", action: "vote" as const, status: "done" as const, doneAt: new Date(T0 - 1000).toISOString() },
    { ...base, id: "2", accountId: "a", action: "reply" as const, status: "done" as const, doneAt: new Date(T0 - 2000).toISOString() },
    { ...base, id: "3", accountId: "a", action: "vote" as const, status: "done" as const, doneAt: new Date(T0 - 2 * 86_400_000).toISOString() },
  ];
  expect(actedToday(items, "a", T0)).toBe(2);
  expect(actedToday(items, "a", T0, "reply")).toBe(1);
});

test("a reply uses the network's reply ref, not the vote ref, when they differ", async () => {
  useNetwork("fake");
  saveAccount(account("fake:me", "fake", "me"));
  ourHistory();
  // What Bluesky's search does: `id` is the subject a like points at, `postId`
  // is the longer form a reply needs so it lands in the right thread.
  results = [
    found({
      id: "at://ada/post/1|cid1",
      postId: "at://root/post/0|cid0|at://ada/post/1|cid1",
      handle: "ada",
      text: "rust ropes in a terminal editor, gap buffer benchmarks?",
    }),
  ];
  const loud = { ...settings, linkRatio: 1, linkMinScore: 0, repostRatio: 0 };
  await scanUpvotes({ settings: loud, now: T0, drafter, writerReady: true });

  await runUpvotes({ settings: loud, now: T0 });
  // The vote points at the post itself.
  expect(voted[0]?.ref).toBe("at://ada/post/1|cid1");
  // The reply carries the thread root, so it does not detach into its own.
  expect(posted[0]?.replyTo).toBe("at://root/post/0|cid0|at://ada/post/1|cid1");
});

test("a network that cannot reply never has a link dropped on it", async () => {
  // Lemmy and Reddit submit a new thread rather than a comment, so a "reply"
  // there would publish a standalone advert.
  useNetwork("linky", { repost: false });
  const network = { ...settings, linkRatio: 1, linkMinScore: 0, repostRatio: 0 };
  saveAccount(account("linky:me", "linky", "me"));
  ourHistory();
  results = [found({ id: "a1", handle: "ada", text: "rust ropes in a terminal editor" })];

  // Re-register the same id with threads off.
  unregisterNetwork("linky");
  registered.pop();
  registerNetwork({
    id: "linky",
    name: "linky",
    category: "forum",
    blurb: "",
    auth: { kind: "password", fields: [] },
    caps: {
      charLimit: 0,
      mediaLimit: 0,
      threads: false,
      delete: false,
      timeline: false,
      notifications: false,
      stats: false,
      search: true,
      upvote: true,
    },
    async login() {
      throw new Error("not used");
    },
    async post(account: Account, input: { text: string; replyTo?: string }) {
      posted.push({ account: account.id, text: input.text, replyTo: input.replyTo });
      return { id: "new-thread" };
    },
    async search() {
      return results;
    },
    async upvote(account: Account, ref: string) {
      voted.push({ account: account.id, ref, dir: 1 });
      return { id: "v" };
    },
  } as unknown as Network);
  registered.push("linky");

  const scan = await scanUpvotes({ settings: network, now: T0, drafter, writerReady: true });
  // The scan never even drafts one.
  expect(scan.queued[0]?.action).toBe("vote");
  expect(drafts.length).toBe(0);

  await runUpvotes({ settings: network, now: T0 });
  expect(posted.length).toBe(0);
  expect(voted.length).toBe(1);
});

test("editing a queued action into a reply cannot publish a new thread", async () => {
  // `myna upvote edit` forces action: "reply" on whatever it is given, so the
  // send path has to re-check that the network can actually reply.
  registerNetwork({
    id: "nothread",
    name: "nothread",
    category: "forum",
    blurb: "",
    auth: { kind: "password", fields: [] },
    caps: {
      charLimit: 0,
      mediaLimit: 0,
      threads: false,
      delete: false,
      timeline: false,
      notifications: false,
      stats: false,
      search: true,
      upvote: true,
    },
    async login() {
      throw new Error("not used");
    },
    async post(account: Account, input: { text: string; replyTo?: string }) {
      posted.push({ account: account.id, text: input.text, replyTo: input.replyTo });
      return { id: "new-thread" };
    },
    async search() {
      return results;
    },
    async upvote(account: Account, ref: string) {
      voted.push({ account: account.id, ref, dir: 1 });
      return { id: "v" };
    },
  } as unknown as Network);
  registered.push("nothread");
  saveAccount(account("nothread:me", "nothread", "me"));
  ourHistory();
  results = [found({ id: "a1", handle: "ada", text: "rust ropes in a terminal editor" })];
  await scanUpvotes({ settings, now: T0, drafter, writerReady: true });

  // A person rewrites it into a link drop by hand.
  const queued = listUpvotes()[0];
  updateUpvote(queued.id, { action: "reply", reply: "here you go https://example.com/rust-ropes" });

  await runUpvotes({ settings, now: T0 });
  expect(posted.length).toBe(0);
  const after = listUpvotes()[0];
  expect(after?.error).toContain("cannot reply");
});

test("everybody found is handed to the plugins that collect people", async () => {
  const seen: DiscoveredEvent[] = [];
  registerPlugin(
    {
      id: "collector",
      name: "collector",
      description: "",
      async afterDiscover(event: DiscoveredEvent) {
        seen.push(event);
        return `took ${event.handle}`;
      },
    } as never,
    "bundled",
  );
  useNetwork("fake");
  saveAccount(account("fake:me", "fake", "me"));
  ourHistory();
  results = [found({ id: "a1", handle: "ada", text: "rust ropes in a terminal editor, gap buffer benchmarks" })];

  await scanUpvotes({ settings, now: T0, drafter, writerReady: true });

  expect(seen.length).toBe(1);
  expect(seen[0]?.handle).toBe("ada");
  expect(seen[0]?.network).toBe("fake");
  expect(seen[0]?.action).toBe("vote");
  // The reason they are a lead travels with them.
  expect(seen[0]?.score).toBeGreaterThan(0);
  expect(seen[0]?.matched.length).toBeGreaterThan(0);
  expect(seen[0]?.postText).toContain("rust ropes");
  resetPlugins();
});

test("a plugin that throws does not cost the queue entry", async () => {
  registerPlugin(
    {
      id: "broken",
      name: "broken",
      description: "",
      async afterDiscover() {
        throw new Error("CRM is down");
      },
    } as never,
    "bundled",
  );
  useNetwork("fake");
  saveAccount(account("fake:me", "fake", "me"));
  ourHistory();
  results = [found({ id: "a1", handle: "ada", text: "rust ropes in a terminal editor" })];

  const result = await scanUpvotes({ settings, now: T0, drafter, writerReady: true });

  // The action is queued regardless, and the failure is reported not swallowed.
  expect(result.queued.length).toBe(1);
  expect(listUpvotes().length).toBe(1);
  expect(result.skipped.join(" ")).toContain("CRM is down");
  resetPlugins();
});

test("handOff false keeps a scan local", async () => {
  const seen: DiscoveredEvent[] = [];
  registerPlugin(
    {
      id: "collector2",
      name: "collector2",
      description: "",
      async afterDiscover(event: DiscoveredEvent) {
        seen.push(event);
      },
    } as never,
    "bundled",
  );
  useNetwork("fake");
  saveAccount(account("fake:me", "fake", "me"));
  ourHistory();
  results = [found({ id: "a1", handle: "ada", text: "rust ropes in a terminal editor" })];

  await scanUpvotes({ settings, now: T0, drafter, writerReady: true, handOff: false });
  expect(seen.length).toBe(0);
  resetPlugins();
});
