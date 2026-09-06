/**
 * Pacing: nothing goes to several accounts at once, a network keeps its gap,
 * the same text does not go to the same account twice inside the repost gap,
 * and --now only lifts the gates, never the duplicate rule.
 */
import { test, expect } from "bun:test";
import { planTargets, pacingRules, nextSlotFor, lastPerNetwork, bookingsPerNetwork, recentDuplicate, DEFAULT_PACING } from "../src/core/pacing.ts";
import type { Account } from "../src/net/types.ts";
import type { HistoryEntry } from "../src/store/history.ts";
import type { QueuedPost } from "../src/store/queue.ts";

const H = 3_600_000;
const NOW = Date.parse("2026-09-06T12:00:00.000Z");

const acct = (network: string, handle: string): Account => ({ id: `${network}:${handle}`, network, handle, addedAt: "", creds: {}, meta: {} });
const x1 = acct("x", "chovy");
const x2 = acct("x", "ProfullstackInc");
const bsky = acct("bluesky", "chovy");
const masto = acct("mastodon", "chovy");
const li = acct("linkedin", "anthony");
const all = [x1, x2, bsky, masto, li];
const networks = new Map(all.map((a) => [a.id, a.network]));
const accountNetwork = (id: string) => networks.get(id);

const sent = (account: Account, text: string, agoMs: number, ok = true): HistoryEntry => ({
  at: new Date(NOW - agoMs).toISOString(),
  accountId: account.id,
  network: account.network,
  handle: account.handle,
  text,
  ok,
});

const rules = pacingRules(DEFAULT_PACING);
const stable = (accounts: Account[]) => accounts;

test("defaults read as 4h, 48h, 7d", () => {
  expect(rules).toEqual({ minGapMs: 4 * H, dripMs: 48 * H, repostGapMs: 7 * 24 * H });
  // A bad value falls back rather than turning pacing off.
  expect(pacingRules({ minGap: "soon", drip: "48h", repostGap: "7d" }).minGapMs).toBe(4 * H);
});

test("five accounts, quiet history: one goes now, the rest drip across the window", () => {
  const plan = planTargets({ accounts: all, text: "hello", now: NOW, history: [], queue: [], rules, accountNetwork, order: stable });
  expect(plan.now.map((a) => a.id)).toEqual(["x:chovy"]);
  expect(plan.later).toHaveLength(4);
  const ats = plan.later.map((t) => t.at);
  // Spread over 48h in four steps of 12h, except the second X account, which
  // is pushed past x:chovy by the 4h network gap; 12h already clears it.
  expect(ats).toEqual([NOW + 12 * H, NOW + 24 * H, NOW + 36 * H, NOW + 48 * H]);
  expect(plan.later.map((t) => t.account.id)).toEqual(["x:ProfullstackInc", "bluesky:chovy", "mastodon:chovy", "linkedin:anthony"]);
  expect(plan.skipped).toEqual([]);
});

test("two accounts on one network never land inside the gap of each other", () => {
  const plan = planTargets({ accounts: [x1, x2], text: "hello", now: NOW, history: [], queue: [], rules: { ...rules, dripMs: H }, accountNetwork, order: stable });
  expect(plan.now.map((a) => a.id)).toEqual(["x:chovy"]);
  // The drip alone would put it at +1h; the network gap moves it to +4h.
  expect(plan.later[0]).toMatchObject({ account: x2, at: NOW + 4 * H });
  expect(plan.later[0].reason).toContain("4h gap");
});

test("a network posted to 1h ago waits out the rest of its gap even for the first target", () => {
  const history = [sent(x2, "earlier", 1 * H)];
  const plan = planTargets({ accounts: [x1, bsky], text: "hello", now: NOW, history, queue: [], rules, accountNetwork, order: stable });
  // x:chovy is first in order but X is busy; it goes at +3h. Bluesky is free
  // but sits at its drip position, +48h, because the drip is by position.
  expect(plan.now).toEqual([]);
  expect(plan.later.map((t) => [t.account.id, t.at])).toEqual([
    ["x:chovy", NOW + 3 * H],
    ["bluesky:chovy", NOW + 48 * H],
  ]);
});

test("the queue's promises count as bookings", () => {
  const queue: QueuedPost[] = [
    { id: "q1", createdAt: "", scheduledFor: new Date(NOW + 2 * H).toISOString(), targets: ["mastodon:chovy"], text: "later", status: "pending" },
    { id: "q2", createdAt: "", scheduledFor: new Date(NOW + 2 * H).toISOString(), targets: ["bluesky:chovy"], text: "done", status: "sent" },
  ];
  const booked = bookingsPerNetwork([], queue, accountNetwork);
  expect(booked.get("mastodon")).toEqual([NOW + 2 * H]);
  // A sent entry is history's business, not a future booking.
  expect(booked.has("bluesky")).toBe(false);
  // Ours would land 2h before the booked one, inside its gap, so it goes 4h after it.
  expect(nextSlotFor("mastodon", booked, NOW, 4 * H)).toBe(NOW + 6 * H);
  expect(nextSlotFor("linkedin", booked, NOW, 4 * H)).toBe(NOW);
});

test("a booking months away does not hold a network today", () => {
  // The bug this test exists for: an April Fools post queued seven months
  // out made every network look busy, and a release announcement was
  // scheduled behind it, in April.
  const APRIL = NOW + 208 * 24 * H;
  const queue: QueuedPost[] = [
    { id: "q1", createdAt: "", scheduledFor: new Date(APRIL).toISOString(), targets: ["x:chovy"], text: "april fools", status: "pending" },
  ];
  const booked = bookingsPerNetwork([], queue, accountNetwork);
  expect(nextSlotFor("x", booked, NOW, 4 * H)).toBe(NOW);

  const plan = planTargets({ accounts: [x1], text: "0.10.1 is out", now: NOW, history: [], queue, rules, accountNetwork, order: stable });
  expect(plan.now).toEqual([x1]);
  expect(plan.later).toEqual([]);
});

test("last posted ignores the future, so a dashboard never says a booking was the last post", () => {
  const queue: QueuedPost[] = [
    { id: "q1", createdAt: "", scheduledFor: new Date(NOW + 30 * 24 * H).toISOString(), targets: ["x:chovy"], text: "later", status: "pending" },
  ];
  const last = lastPerNetwork([sent(x1, "earlier", 3 * H)], queue, accountNetwork, NOW);
  expect(last.get("x")).toBe(NOW - 3 * H);
});

test("the same text to the same account inside the repost gap is refused, even with --now", () => {
  const history = [sent(bsky, "Read this:  https://a.b/1", 2 * 24 * H)];
  const dup = recentDuplicate("read this: https://a.b/1", bsky.id, history, NOW, rules.repostGapMs);
  expect(dup).toBeDefined();
  const plan = planTargets({ accounts: [bsky, masto], text: "Read this: https://a.b/1", now: NOW, history, queue: [], rules, accountNetwork, order: stable, force: true });
  expect(plan.skipped.map((s) => s.account.id)).toEqual(["bluesky:chovy"]);
  expect(plan.skipped[0].reason).toContain("2d ago");
  expect(plan.now.map((a) => a.id)).toEqual(["mastodon:chovy"]);
});

test("after the repost gap the same text is allowed again", () => {
  const history = [sent(bsky, "evergreen", 8 * 24 * H)];
  const plan = planTargets({ accounts: [bsky], text: "evergreen", now: NOW, history, queue: [], rules, accountNetwork, order: stable });
  expect(plan.now).toEqual([bsky]);
});

test("--now sends everything at once, gates or not", () => {
  const history = [sent(x1, "earlier", 10 * 60_000)];
  const plan = planTargets({ accounts: all, text: "urgent", now: NOW, history, queue: [], rules, accountNetwork, order: stable, force: true });
  expect(plan.now).toHaveLength(5);
  expect(plan.later).toEqual([]);
});

test("a failed attempt still counts against the network's gap", () => {
  const history = [sent(x1, "boom", 30 * 60_000, false)];
  const plan = planTargets({ accounts: [x2], text: "again", now: NOW, history, queue: [], rules, accountNetwork, order: stable });
  expect(plan.now).toEqual([]);
  expect(plan.later[0].at).toBe(NOW + 3.5 * H);
});

test("a scheduled post drips from its own time, not from now", () => {
  const from = NOW + 24 * H;
  const plan = planTargets({ accounts: [bsky, masto, li], text: "tomorrow", now: NOW, history: [], queue: [], rules, accountNetwork, order: stable, from });
  expect(plan.now).toEqual([]);
  expect(plan.later.map((t) => t.at)).toEqual([from, from + 24 * H, from + 48 * H]);
});
