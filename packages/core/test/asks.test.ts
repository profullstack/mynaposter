/**
 * Asks: people asking for a site that does X, Y and Z, read from the
 * subreddit feeds, grouped into ideas, answered on hand-off cards, and
 * tracked. Against a fake fetcher that plays RSS Amplifier and the archive.
 *
 * What has to hold: the detector keeps asks and drops pitches, hiring and
 * builders polling for ideas; a post is judged once; a sub RSS Amplifier has
 * not read falls back to the archive; the writer's verdict wins, and a post
 * it said nothing about waits rather than slipping through; asks for the
 * same thing land in one idea and different things do not, even when their
 * words overlap; an idea is flagged once enough different people asked; a
 * reply names our product only when one answers the ask, discloses, carries
 * a tagged link, and is a card rather than a post; and stats find our reply
 * and count the answers to it.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyAsk,
  titleWant,
  scanAsks,
  replyToAsk,
  refreshAskStats,
  syncReplies,
  rankIdeas,
  tagLink,
  pacedFetch,
  mergeIdeas,
  type Fetcher,
} from "../src/core/asks.ts";
import { readAsks, saveProduct, writeAsks } from "../src/store/asks.ts";
import { getHandoff, markHandoff } from "../src/store/handoffs.ts";
import { DEFAULT_ASKS, type AsksSettings } from "../src/store/settings.ts";
import { registerPlugin, resetPlugins } from "../src/plugins/loader.ts";
import type { DiscoveredEvent } from "../src/plugins/types.ts";
import type { AskJudgeInput, AskJudgement } from "../src/ai/writer.ts";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-asks-"));
  process.env.MYNA_HOME = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
  resetPlugins();
});

const NOW = Date.parse("2026-10-06T12:00:00Z");
const settings = (patch: Partial<AsksSettings> = {}): AsksSettings => ({
  ...DEFAULT_ASKS,
  subs: "SomebodyMakeThis",
  feedBase: "https://amp.test",
  statsBase: "https://archive.test",
  useWriter: false,
  ...patch,
});

interface Post {
  id: string;
  title: string;
  body?: string;
  author?: string;
  sub?: string;
  hoursAgo?: number;
  score?: number;
  comments?: number;
}

const feedItem = (post: Post) => ({
  id: `t3_${post.id}`,
  title: post.title,
  url: `https://www.reddit.com/r/${post.sub ?? "SomebodyMakeThis"}/comments/${post.id}/x/`,
  summary: (post.body ?? "").slice(0, 300),
  date_published: new Date(NOW - (post.hoursAgo ?? 2) * 3_600_000).toISOString(),
  authors: [{ name: `/u/${post.author ?? `user_${post.id}`}` }],
});

const archiveRecord = (post: Post) => ({
  id: post.id,
  title: post.title,
  selftext: post.body ?? "",
  author: post.author ?? `user_${post.id}`,
  subreddit: post.sub ?? "SomebodyMakeThis",
  created_utc: Math.floor((NOW - (post.hoursAgo ?? 2) * 3_600_000) / 1000),
  permalink: `/r/${post.sub ?? "SomebodyMakeThis"}/comments/${post.id}/x/`,
  score: post.score ?? 1,
  num_comments: post.comments ?? 0,
  upvote_ratio: 1,
});

/** A fetcher that serves `feed` from RSS Amplifier and every post from the archive. */
function fakeWeb(feed: Record<string, Post[] | 404>, extra: { comments?: Record<string, unknown[]>; searched?: string[] } = {}): { fetchJson: Fetcher; urls: string[] } {
  const urls: string[] = [];
  const everything = Object.values(feed).flatMap((posts) => (posts === 404 ? [] : posts));
  const fetchJson: Fetcher = async (url) => {
    urls.push(url);
    const sub = /amp\.test\/r\/([^.]+)\.json/.exec(url)?.[1];
    if (sub !== undefined) {
      const posts = feed[sub];
      if (posts === 404 || posts === undefined) throw Object.assign(new Error("404 not in the directory"), { status: 404 });
      return { items: posts.map(feedItem) };
    }
    if (url.includes("/api/posts/ids")) {
      const ids = new URL(url).searchParams.get("ids")?.split(",") ?? [];
      return { data: everything.filter((post) => ids.includes(post.id)).map(archiveRecord) };
    }
    if (url.includes("/api/posts/search")) {
      const name = new URL(url).searchParams.get("subreddit") ?? "";
      return { data: (extra.searched ?? []).length ? everything.filter((post) => post.sub === name).map(archiveRecord) : [] };
    }
    if (url.includes("/api/comments/search")) {
      const link = new URL(url).searchParams.get("link_id") ?? "";
      return { data: extra.comments?.[link] ?? [] };
    }
    throw new Error(`unexpected ${url}`);
  };
  return { fetchJson, urls };
}

// ------------------------------------------------------------------ detector

test("the shapes people ask in are asks, and the title counts for more", () => {
  for (const title of [
    "Is there an app that tracks my subscriptions and warns before renewal?",
    "Looking for a tool to bulk rename photos by date",
    "Does anyone know of a site that compares grocery prices?",
    "someone should build an app that lets you try clothes on virtually",
    "Any good habit tracker apps for streaks?",
    "Alternatives to Notion for offline notes?",
    "Multi-Business Software Recommendations",
    "How do you keep track of all your recurring software subscriptions and renewals?",
  ]) {
    const verdict = classifyAsk(title);
    expect({ title, ok: verdict.score >= 0.5 }).toEqual({ title, ok: true });
  }
  expect(classifyAsk("Is there an app for this?").score).toBeGreaterThan(classifyAsk("Weekend thoughts", "is there an app for this").score);
});

test("pitches, hiring, advice and builders polling for ideas are not asks", () => {
  for (const [title, body] of [
    ["I built an alternative to Calendly, looking for beta testers", ""],
    ["I got tired of slow dashboards, so I solo-built Oanvo, an alternative to GA4", ""],
    ["[Hiring] looking for a react dev for our app", ""],
    ["How do I find my first customers?", ""],
    ["What kind of app would you actually be willing to pay for?", "Is there an app you wish existed?"],
    ["Free alternative to Fences for Windows - sharing in case anyone needs it", ""],
  ] as const) {
    expect({ title, score: classifyAsk(title, body).score < 0.5 }).toEqual({ title, score: true });
  }
});

test("what they want comes out of the clause after the ask, and out of their bullets", () => {
  const verdict = classifyAsk("Is there an app that tracks prices, alerts me on drops and exports to csv?");
  expect(verdict.kind).toBe("is-there");
  expect(verdict.wants.join("|").toLowerCase()).toContain("tracks prices");
  expect(verdict.wants.join("|").toLowerCase()).toContain("alerts me on drops");
  expect(verdict.wants.join("|").toLowerCase()).toContain("exports to csv");

  const bullets = classifyAsk("Looking for a self-hosted recipe manager", "Must have:\n- import from any URL\n- meal planner\n- shopping list sync");
  expect(bullets.wants).toEqual(expect.arrayContaining(["import from any URL", "meal planner", "shopping list sync"]));
});

test("the title, with the asking taken out, is a want", () => {
  expect(titleWant("Is there a free habit tracker that syncs?")).toBe("free habit tracker that syncs");
  expect(titleWant("Somebody please make a good app for discovering high-protein meals")).toBe("app for discovering high-protein meals");
  expect(titleWant("Any recommendations?")).toBeUndefined();
});

// ------------------------------------------------------------------ scanning

test("a scan keeps the asks, reads their full text from the archive, and judges each post once", async () => {
  const web = fakeWeb({
    SomebodyMakeThis: [
      { id: "a1", title: "Is there an app that tracks subscriptions?", body: "I want it to warn me before renewals and export to csv. ".repeat(10), score: 12, comments: 7 },
      { id: "a2", title: "I built a subscription tracker, feedback?", body: "Launching next week" },
      { id: "a3", title: "Looking for a site that compares flight prices", author: "us_on_reddit" },
      { id: "a4", title: "Is there a tool for old stuff?", hoursAgo: 24 * 90 },
    ],
  });
  const first = await scanAsks({ settings: settings({ redditUser: "us_on_reddit" }), fetchJson: web.fetchJson, handOff: false, archiveGapMs: 0, judge: null, now: NOW });
  expect(first.found.map((ask) => ask.id)).toEqual(["a1"]);
  const ask = first.found[0]!;
  expect(ask.text.length).toBeGreaterThan(300);
  expect(ask.wants.join(" ")).toContain("warn me before renewals");
  expect(ask.stats[0]).toMatchObject({ score: 12, comments: 7 });
  expect(first.sources[0]).toMatchObject({ sub: "SomebodyMakeThis", via: "rssamplifier", posts: 4 });

  const second = await scanAsks({ settings: settings(), fetchJson: web.fetchJson, handOff: false, archiveGapMs: 0, judge: null, now: NOW });
  expect(second.found).toHaveLength(0);
  expect(readAsks().asks).toHaveLength(1);
});

test("a sub RSS Amplifier does not have, or has not read, falls back to the archive", async () => {
  const posts: Post[] = [{ id: "b1", sub: "AppIdeas", title: "Is there an app that reminds me to water plants?" }];
  const missing = fakeWeb({ AppIdeas: 404, Empty: [], ...{ _all: posts } }, { searched: ["AppIdeas"] });
  const result = await scanAsks({ settings: settings({ subs: "AppIdeas,Empty" }), fetchJson: missing.fetchJson, handOff: false, archiveGapMs: 0, judge: null, now: NOW });
  expect(result.sources.map((source) => [source.sub, source.via])).toEqual([
    ["AppIdeas", "archive"],
    ["Empty", "archive"],
  ]);
  expect(result.sources[0]!.note).toContain("not in RSS Amplifier");
  expect(result.sources[1]!.note).toContain("has not read it yet");
  expect(result.found.map((ask) => ask.id)).toEqual(["b1"]);

  const off = await scanAsks({ settings: settings({ subs: "Empty", fallback: false }), fetchJson: missing.fetchJson, handOff: false, archiveGapMs: 0, judge: null, now: NOW });
  expect(off.sources[0]).toMatchObject({ via: "none", posts: 0 });
});

test("the writer's verdict wins, and a post it said nothing about waits for the next scan", async () => {
  const web = fakeWeb({
    SomebodyMakeThis: [
      { id: "c1", title: "Is there an app that tracks my reading streak?" },
      { id: "c2", title: "Is there a site to find a technical cofounder?" },
      { id: "c3", title: "Looking for a tool to merge pdfs offline" },
    ],
  });
  const seen: string[] = [];
  const judge = async (posts: AskJudgeInput[]): Promise<AskJudgement[]> => {
    seen.push(...posts.map((post) => post.id));
    return [
      { id: "c1", ask: true, wants: ["track reading streaks"], label: "reading streak tracker" },
      { id: "t3_c2", ask: false, wants: [], label: "" },
    ];
  };
  const result = await scanAsks({ settings: settings(), fetchJson: web.fetchJson, handOff: false, archiveGapMs: 0, judge, now: NOW });
  expect(result.judged).toBe(true);
  expect(result.found.map((ask) => ask.id)).toEqual(["c1"]);
  expect(result.found[0]).toMatchObject({ label: "reading streak tracker", wants: ["track reading streaks"], judged: true });
  expect(result.rejected).toBe(1);
  expect(result.deferred).toBe(1);
  expect(readAsks().seen).not.toContain("c3");

  // Next time the judge gets it again, and says yes.
  const again = await scanAsks({
    settings: settings(),
    fetchJson: web.fetchJson,
    handOff: false,
    archiveGapMs: 0,
    judge: async () => [{ id: "c3", ask: true, wants: ["merge pdfs offline"], label: "offline pdf merger" }],
    now: NOW,
  });
  expect(again.found.map((ask) => ask.id)).toEqual(["c3"]);
});

test("asks for the same thing make one idea, flagged once enough different people asked", async () => {
  const web = fakeWeb({
    SomebodyMakeThis: [
      { id: "d1", title: "Is there a habit tracker with streaks and reminders?" },
      { id: "d2", title: "Looking for a habit tracker app with streaks" },
      { id: "d3", title: "Any good habit tracker with reminders and streaks?" },
      { id: "d4", title: "Is there an app that converts recipes to shopping lists?" },
    ],
  });
  const result = await scanAsks({ settings: settings({ buildAt: 3 }), fetchJson: web.fetchJson, handOff: false, archiveGapMs: 0, judge: null, now: NOW });
  const file = readAsks();
  const habit = file.asks.filter((ask) => ["d1", "d2", "d3"].includes(ask.id)).map((ask) => ask.ideaId);
  expect(new Set(habit).size).toBe(1);
  expect(file.asks.find((ask) => ask.id === "d4")!.ideaId).not.toBe(habit[0]);
  expect(result.flagged.map((idea) => idea.id)).toEqual([habit[0]!]);
  const ranked = rankIdeas(file, settings({ buildAt: 3 }), NOW);
  expect(ranked[0]).toMatchObject({ askers: 3, idea: { status: "build" } });
});

test("named ideas only merge when their names share a word, whatever their wants share", async () => {
  const web = fakeWeb({
    SomebodyMakeThis: [
      { id: "e1", title: "Is there software to play a playlist of videos on a signage screen?" },
      { id: "e2", title: "Is there an app to download a playlist of videos?" },
    ],
  });
  await scanAsks({
    settings: settings(),
    fetchJson: web.fetchJson,
    handOff: false,
    archiveGapMs: 0,
    judge: async (posts) =>
      posts.map((post) =>
        post.id === "e1"
          ? { id: "e1", ask: true, wants: ["play playlist of videos", "signage screen"], label: "digital signage software" }
          : { id: "e2", ask: true, wants: ["download playlist of videos"], label: "playlist video downloader" },
      ),
    now: NOW,
  });
  const file = readAsks();
  expect(file.ideas).toHaveLength(2);
  const merged = mergeIdeas(file.ideas[0]!.id, file.ideas[1]!.id);
  expect(merged?.askIds.sort()).toEqual(["e1", "e2"]);
  expect(readAsks().ideas).toHaveLength(1);
});

test("each asker goes to the plugins that collect people, as a reddit lead with the idea as how they came in", async () => {
  const events: DiscoveredEvent[] = [];
  registerPlugin({ id: "crm", name: "crm", async afterDiscover(event) { events.push(event); } }, "test");
  const web = fakeWeb({ SomebodyMakeThis: [{ id: "f1", title: "Is there an app that splits rent fairly?", author: "renter42" }] });
  await scanAsks({ settings: settings(), fetchJson: web.fetchJson, archiveGapMs: 0, judge: null, now: NOW });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ source: "asks", network: "reddit", handle: "renter42", action: "ask" });
  expect(events[0]!.account).toBeUndefined();
  expect(events[0]!.via).toStartWith("ask:");

  events.length = 0;
  const quiet = fakeWeb({ SomebodyMakeThis: [{ id: "f2", title: "Is there an app that splits bills?" }] });
  await scanAsks({ settings: settings({ leads: false }), fetchJson: quiet.fetchJson, archiveGapMs: 0, judge: null, now: NOW });
  expect(events).toHaveLength(0);
});

// ------------------------------------------------------------------ replying

test("an ask one of ours answers gets a disclosed, tagged reply on a card, not a post", async () => {
  saveProduct({ name: "PairUX", url: "https://pairux.com", keywords: ["screen sharing", "remote control"], about: "Screen sharing with remote control" });
  const web = fakeWeb({ SomebodyMakeThis: [{ id: "g1", title: "Is there an app for screen sharing with remote control that is free?" }] });
  await scanAsks({ settings: settings(), fetchJson: web.fetchJson, handOff: false, archiveGapMs: 0, judge: null, now: NOW });
  const ask = readAsks().asks[0]!;
  expect(ask.product?.name).toBe("PairUX");

  const result = await replyToAsk("g1", { settings: settings(), publish: false });
  expect(result.drafted).toBe("template");
  expect(result.card.text).toContain("I work on it");
  expect(result.card.text).toContain("utm_source=reddit");
  expect(result.card.text).toContain(`utm_campaign=asks-${ask.ideaId}`);
  expect(result.card.text).not.toContain("—");
  expect(result.card).toMatchObject({ place: "r/SomebodyMakeThis", openUrl: ask.url });
  expect(readAsks().asks[0]).toMatchObject({ status: "drafted", handoffId: result.card.id });

  // Asking again returns the card that is waiting rather than a second one.
  expect((await replyToAsk("g1", { settings: settings(), publish: false })).card.id).toBe(result.card.id);

  // Marking the card done is what makes it "replied".
  markHandoff(result.card.id);
  const file = readAsks();
  expect(syncReplies(file)).toBe(1);
  writeAsks(file);
  expect(readAsks().asks[0]!.status).toBe("replied");
});

test("with nothing of ours to offer, the reply asks the builder's question; a writer that declines sends nothing", async () => {
  const web = fakeWeb({ SomebodyMakeThis: [{ id: "h1", title: "Is there an app that tracks prices, alerts me on drops and exports to csv?" }] });
  await scanAsks({ settings: settings(), fetchJson: web.fetchJson, handOff: false, archiveGapMs: 0, judge: null, now: NOW });

  await expect(replyToAsk("h1", { settings: settings({ useWriter: true }), writerReady: true, drafter: async () => "", publish: false })).rejects.toThrow("declined");
  expect(readAsks().asks[0]!.status).toBe("new");

  const result = await replyToAsk("h1", { settings: settings(), publish: false });
  expect(result.card.text).toContain("which would you drop first");
  expect(result.card.text).not.toContain("http");
  expect(getHandoff(result.card.id)?.steps.length).toBe(3);
});

test("tagLink keeps a tag the link already has", () => {
  expect(tagLink("https://x.test/?utm_source=hn", { ideaId: "i1", sub: "a" })).toBe("https://x.test/?utm_source=hn&utm_medium=comment&utm_campaign=asks-i1");
});

// ------------------------------------------------------------------ stats

test("stats re-read the thread, find our reply by username, count its answers, and mark a forgotten card pasted", async () => {
  const web = fakeWeb(
    { SomebodyMakeThis: [{ id: "k1", title: "Is there an app that tracks my plants?", score: 3, comments: 2 }] },
    {
      comments: {
        k1: [
          { id: "c_ours", author: "OurName", parent_id: "t3_k1", score: 9, created_utc: Math.floor(NOW / 1000) - 600, permalink: "/r/SomebodyMakeThis/comments/k1/x/c_ours/" },
          { id: "c_r1", author: "someone", parent_id: "t1_c_ours", score: 2 },
          { id: "c_r2", author: "another", parent_id: "t1_c_ours", score: 1 },
          { id: "c_other", author: "third", parent_id: "t3_k1", score: 1 },
        ],
      },
    },
  );
  const s = settings({ redditUser: "ourname" });
  await scanAsks({ settings: s, fetchJson: web.fetchJson, handOff: false, archiveGapMs: 0, judge: null, now: NOW });
  await replyToAsk("k1", { settings: s, publish: false });

  const result = await refreshAskStats({ settings: s, fetchJson: web.fetchJson, now: NOW + 3_600_000 });
  expect(result.refreshed).toBe(1);
  expect(result.foundOurs.map((ask) => ask.id)).toEqual(["k1"]);
  const ask = readAsks().asks[0]!;
  expect(ask.status).toBe("replied");
  const latest = ask.stats[ask.stats.length - 1]!;
  expect(latest.ours).toMatchObject({ id: "c_ours", score: 9, replies: 2 });
  expect(latest.ours!.url).toBe("https://www.reddit.com/r/SomebodyMakeThis/comments/k1/x/c_ours/");
  expect(latest.comments).toBe(4);

  // A thread past trackDays is left alone.
  const old = await refreshAskStats({ settings: s, fetchJson: web.fetchJson, now: NOW + 40 * 86_400_000 });
  expect(old.refreshed).toBe(0);
});

test("the archive is paced, and one told to slow down is tried once more", async () => {
  let calls = 0;
  const flaky: Fetcher = async (url) => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error("422 Timeout. Maybe slow down a bit"), { status: 422 });
    return { url };
  };
  const paced = pacedFetch(flaky, "https://archive.test", 1);
  expect(await paced("https://archive.test/api/posts/ids?ids=a")).toEqual({ url: "https://archive.test/api/posts/ids?ids=a" });
  expect(calls).toBe(2);

  const broken: Fetcher = async () => {
    throw Object.assign(new Error("500"), { status: 500 });
  };
  await expect(pacedFetch(broken, "https://archive.test", 1)("https://archive.test/x")).rejects.toThrow("500");
});
