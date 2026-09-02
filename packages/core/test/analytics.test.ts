import { test, expect } from "bun:test";
import { postsPerDay, postsPerHour, byNetwork, totals, topPosts, needsRefresh } from "../src/core/analytics.ts";
import type { HistoryEntry } from "../src/store/history.ts";
import type { EngagementRecord } from "../src/core/analytics.ts";

const NOW = new Date("2026-09-02T12:00:00Z");
const at = (daysAgo: number, hour = 12) => {
  const date = new Date(NOW);
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
};

const entry = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  at: at(0),
  accountId: "bluesky:alice",
  network: "bluesky",
  handle: "alice",
  text: "hello",
  ok: true,
  ...over,
});

test("keeps the quiet days instead of skipping them", () => {
  // A graph that omits empty days makes a sporadic week look busy.
  const days = postsPerDay([entry({ at: at(0) }), entry({ at: at(3) })], 7, NOW);
  expect(days).toHaveLength(7);
  expect(days.at(-1)?.sent).toBe(1);
  expect(days.filter((day) => day.sent === 0)).toHaveLength(5);
});

test("separates sent from failed per day", () => {
  const days = postsPerDay([entry(), entry({ ok: false })], 3, NOW);
  expect(days.at(-1)).toMatchObject({ sent: 1, failed: 1 });
});

test("ignores anything older than the window", () => {
  const days = postsPerDay([entry({ at: at(99) })], 7, NOW);
  expect(days.reduce((sum, day) => sum + day.sent, 0)).toBe(0);
});

test("counts hours, successful posts only", () => {
  const hours = postsPerHour([
    entry({ at: at(0, 9) }),
    entry({ at: at(1, 9) }),
    entry({ at: at(0, 17) }),
    entry({ at: at(0, 9), ok: false }),
  ]);
  expect(hours).toHaveLength(24);
  expect(hours[9]).toBe(2);
  expect(hours[17]).toBe(1);
  expect(hours.reduce((a, b) => a + b, 0)).toBe(3);
});

test("a malformed timestamp does not throw or land in a bucket", () => {
  expect(postsPerHour([entry({ at: "not a date" })]).reduce((a, b) => a + b, 0)).toBe(0);
});

test("breaks down by network with a delivery rate", () => {
  const rows = byNetwork([
    entry({ network: "bluesky" }),
    entry({ network: "bluesky", ok: false }),
    entry({ network: "mastodon" }),
  ]);
  const bluesky = rows.find((row) => row.network === "bluesky")!;
  expect(bluesky).toMatchObject({ sent: 1, failed: 1 });
  expect(bluesky.rate).toBeCloseTo(0.5);
  expect(rows.find((row) => row.network === "mastodon")?.rate).toBe(1);
});

test("engagement is attributed to the network in the account id", () => {
  const engagement: EngagementRecord[] = [
    { accountId: "bluesky:alice", postId: "1", likes: 5, reposts: 2, replies: 1, at: at(0) },
  ];
  const rows = byNetwork([entry({ network: "bluesky" })], engagement);
  expect(rows[0]).toMatchObject({ likes: 5, reposts: 2, replies: 1 });
});

test("averages engagement over measured posts, not over everything sent", () => {
  // Averaging over all sends would silently count an unmeasured post as a zero.
  const history = [entry({ postId: "1" }), entry({ postId: "2" }), entry({ postId: "3" })];
  const engagement: EngagementRecord[] = [{ accountId: "bluesky:alice", postId: "1", likes: 9, at: at(0) }];
  const summary = totals(history, engagement);
  expect(summary.measured).toBe(1);
  expect(summary.perPost).toBe(9);
});

test("reports no average at all when nothing has been measured", () => {
  expect(totals([entry()], []).perPost).toBeNull();
  expect(totals([], []).rate).toBeNull();
});

test("ranks posts by total engagement, and omits the unmeasured", () => {
  const history = [
    entry({ postId: "a", text: "quiet" }),
    entry({ postId: "b", text: "loud" }),
    entry({ postId: "c", text: "unmeasured" }),
  ];
  const engagement: EngagementRecord[] = [
    { accountId: "bluesky:alice", postId: "a", likes: 1, at: at(0) },
    { accountId: "bluesky:alice", postId: "b", likes: 10, reposts: 5, at: at(0) },
  ];
  const best = topPosts(history, engagement);
  expect(best.map((post) => post.text)).toEqual(["loud", "quiet"]);
  expect(best[0].total).toBe(15);
});

test("asks about posts never measured, and about stale ones", () => {
  const history = [entry({ postId: "new" }), entry({ postId: "fresh" }), entry({ postId: "stale" })];
  const engagement: EngagementRecord[] = [
    { accountId: "bluesky:alice", postId: "fresh", at: new Date(NOW.getTime() - 60_000).toISOString() },
    { accountId: "bluesky:alice", postId: "stale", at: new Date(NOW.getTime() - 7_200_000).toISOString() },
  ];
  const wanted = needsRefresh(history, engagement, { now: NOW.getTime(), staleAfterMs: 3_600_000 });
  expect(wanted.map((item) => item.postId)).toEqual(["new", "stale"]);
});

test("never asks about a failed post or one with no id", () => {
  const history = [entry({ postId: undefined }), entry({ postId: "x", ok: false })];
  expect(needsRefresh(history, [], { now: NOW.getTime() })).toHaveLength(0);
});
