/**
 * Pain phrases: the words people use when the problem hits them.
 *
 * What has to hold: a phrase matches literally and with words in between,
 * but not across sentences; category words never become phrases; searches
 * take turns over every phrase and sub; a complaint found by a phrase is a
 * `pain` ask that skips the ask judge, points at the product, never counts
 * toward an idea to build, and lists before any keyword match; and its reply
 * is drafted as help with the problem, then comment-shared.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanPhrases, draftPainPhrases, editPainPhrases, matchPain, painQueries, templatePhrases } from "../src/core/pain.ts";
import { byRank, replyToAsk, scanAsks, type Fetcher } from "../src/core/asks.ts";
import { readAsks, saveProduct } from "../src/store/asks.ts";
import { getHandoff } from "../src/store/handoffs.ts";
import { DEFAULT_ASKS, type AsksSettings } from "../src/store/settings.ts";
import { resetPlugins } from "../src/plugins/loader.ts";
import type { AskReplyRequest } from "../src/ai/writer.ts";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-pain-"));
  process.env.MYNA_HOME = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
  resetPlugins();
});

const NOW = Date.parse("2026-10-28T12:00:00Z");
const ago = (hours: number): number => Math.floor((NOW - hours * 3_600_000) / 1000);
const settings = (patch: Partial<AsksSettings> = {}): AsksSettings => ({
  ...DEFAULT_ASKS,
  subs: "micro_saas",
  feedBase: "https://amp.test",
  statsBase: "https://archive.test",
  useWriter: false,
  painSearches: 4,
  ...patch,
});

test("a phrase matches literally, with words in between, and with curly apostrophes", () => {
  const phrases = ["can't find communities", "nobody sees my posts"];
  expect(matchPain(phrases, "I cant find enough communities for my launch")).toBe("can't find communities");
  expect(matchPain(phrases, "Honestly nobody sees my posts.")).toBe("nobody sees my posts");
  expect(matchPain(phrases, "I can’t seem to find any active communities")).toBe("can't find communities");
  // Words of the phrase split across sentences are not the complaint.
  expect(matchPain(phrases, "I can't sleep. Find me on the communities page.")).toBeUndefined();
  expect(matchPain(phrases, "We grew our SaaS to 10k MRR")).toBeUndefined();
});

test("category words and the product's own name never become phrases", () => {
  const cleaned = cleanPhrases(["Nobody sees my posts", "best SaaS marketing", "myna is slow", "x", "nobody sees my posts", "got only 2 users"], { name: "myna" });
  expect(cleaned).toEqual(["nobody sees my posts", "got only 2 users"]);
  expect(templatePhrases({ name: "myna", keywords: ["social media scheduling"] })).toContain("can't find social media scheduling");
});

test("the writer drafts phrases; without one the template stands in and says so", async () => {
  const drafted = await draftPainPhrases({ name: "myna", url: "https://mynaposter.com", keywords: ["posting"] }, async (request) => {
    expect(request.name).toBe("myna");
    return ["can't find communities", "no one replies to my posts", "SaaS growth"];
  });
  expect(drafted).toEqual({ phrases: ["can't find communities", "no one replies to my posts"], by: "writer" });
  const fallback = await draftPainPhrases({ name: "myna", url: "https://mynaposter.com", keywords: ["posting"] }, null);
  expect(fallback.by).toBe("template");
});

test("editing phrases: generate merges with what a person kept, remove drops, re-adding the product keeps them", async () => {
  saveProduct({ name: "myna", url: "https://mynaposter.com", keywords: ["social posting"], painPhrases: ["nobody sees my posts"] });
  const { product } = await editPainPhrases("myna", { generate: true, writer: async () => ["can't find communities"] });
  expect(product.painPhrases).toEqual(["nobody sees my posts", "can't find communities"]);
  await editPainPhrases("myna", { remove: ["Nobody sees my posts"] });
  saveProduct({ name: "myna", url: "https://mynaposter.com", keywords: ["social posting"] });
  expect(readAsks().products[0]!.painPhrases).toEqual(["can't find communities"]);
});

test("searches take turns over every product, phrase and sub", () => {
  const products = [
    { id: "a", name: "A", url: "https://a.test", keywords: [], painPhrases: ["p1", "p2"] },
    { id: "b", name: "B", url: "https://b.test", keywords: [], painPhrases: ["p3"], painSubs: ["only"] },
  ];
  const first = painQueries(products, ["s1", "s2"], 0, 3);
  expect(first.queries.map((q) => `${q.phrase}@${q.sub}`)).toEqual(["p1@s1", "p1@s2", "p2@s1"]);
  const second = painQueries(products, ["s1", "s2"], first.next, 3);
  expect(second.queries.map((q) => `${q.phrase}@${q.sub}`)).toEqual(["p2@s2", "p3@only", "p1@s1"]);
  expect(painQueries([], ["s1"], 5, 3)).toEqual({ queries: [], next: 0 });
});

/** RSS Amplifier with one generic ask; the archive answers phrase searches. */
function web() {
  const calls: string[] = [];
  const fetchJson: Fetcher = async (url) => {
    calls.push(url);
    if (url.startsWith("https://amp.test/r/micro_saas.json")) {
      return {
        items: [
          { id: "ask1", title: "Is there a tool that schedules posts to Bluesky and Mastodon?", url: "https://www.reddit.com/r/micro_saas/comments/ask1/x/", content_text: "", date_published: new Date(NOW - 7_200_000).toISOString(), authors: [{ name: "/u/asker" }] },
          { id: "feedpain", title: "Launched last week and nobody sees my posts", url: "https://www.reddit.com/r/micro_saas/comments/feedpain/x/", content_text: "", date_published: new Date(NOW - 3_600_000).toISOString(), authors: [{ name: "/u/sad" }] },
        ],
      };
    }
    if (url.includes("/api/posts/search") && url.includes("query=")) {
      return {
        data: [
          { id: "pain1", title: "İ cant find enough communities", selftext: "launched 2 days ago, got only 2 users", author: "BoysenberryNo5650", subreddit: "micro_saas", created_utc: ago(5), permalink: "/r/micro_saas/comments/pain1/x/", score: 3, num_comments: 6 },
          // The archive matches words anywhere; this one does not carry the phrase.
          { id: "loose", title: "Find communities of painters", selftext: "I can't stop painting", author: "painter", subreddit: "micro_saas", created_utc: ago(5), permalink: "/r/micro_saas/comments/loose/x/" },
        ],
      };
    }
    if (url.includes("/api/posts/ids")) return { data: [] };
    return { data: [] };
  };
  return { calls, fetchJson };
}

test("a complaint found by a phrase is a pain ask: product attached, no idea, listed first", async () => {
  saveProduct({ name: "myna", url: "https://mynaposter.com", keywords: ["bluesky", "mastodon", "schedules posts"], painPhrases: ["can't find communities", "nobody sees my posts"] });
  const site = web();
  let judged: string[] = [];
  const result = await scanAsks({
    settings: settings(),
    fetchJson: site.fetchJson,
    handOff: false,
    archiveGapMs: 0,
    now: NOW,
    judge: async (posts) => {
      judged = posts.map((post) => post.id);
      return posts.map((post) => ({ id: post.id, ask: true, wants: ["schedule posts"], label: "post scheduler" }));
    },
  });
  expect(site.calls.filter((url) => url.includes("query=")).length).toBe(2);
  const pains = result.found.filter((ask) => ask.kind === "pain");
  expect(pains.map((ask) => ask.id).sort()).toEqual(["feedpain", "pain1"]);
  expect(result.found.some((ask) => ask.id === "loose")).toBe(false);
  expect(result.pain.found).toBe(2);
  // The judge reads asks, never complaints.
  expect(judged).toEqual(["ask1"]);
  const file = readAsks();
  const pain = file.asks.find((ask) => ask.id === "pain1")!;
  expect(pain.pain).toBe("can't find communities");
  expect(pain.product?.id).toBe("myna");
  expect(pain.ideaId).toBe("");
  expect(file.ideas.every((idea) => !idea.askIds.includes("pain1"))).toBe(true);
  // Even though the generic ask is newer than pain1, complaints list first.
  const ranked = [...file.asks].sort(byRank).map((ask) => ask.kind);
  expect(ranked.slice(0, 2)).toEqual(["pain", "pain"]);
  // Two phrases in one sub: both ran, and the next scan starts over.
  expect(file.painCursor).toBe(0);
});

test("a pain reply is drafted as help with the problem, then comment-shared", async () => {
  saveProduct({ name: "myna", url: "https://mynaposter.com", keywords: ["posting"], painPhrases: ["can't find communities"] });
  const site = web();
  await scanAsks({ settings: settings({ subs: "micro_saas" }), fetchJson: site.fetchJson, handOff: false, archiveGapMs: 0, judge: null, now: NOW });
  let seen: AskReplyRequest | undefined;
  const { card } = await replyToAsk("pain1", {
    settings: settings({ useWriter: true }),
    writerReady: true,
    publish: false,
    drafter: async (request) => {
      seen = request;
      return `Two days is early. I work on myna, which posts to the networks where they are: ${request.product!.url}`;
    },
  });
  expect(seen?.pain).toBe("can't find communities");
  expect(seen?.product?.url).toContain("utm_campaign=asks-micro_saas");
  expect(getHandoff(card.id)?.steps.some((step) => step.includes("r/fleetcoding"))).toBe(true);
});
