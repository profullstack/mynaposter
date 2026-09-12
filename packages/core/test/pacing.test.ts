/**
 * Pacing: nothing goes to several accounts at once, a network keeps its gap,
 * the same text does not go to the same account twice inside the repost gap,
 * and --now only lifts the gates, never the duplicate rule.
 */
import { test, expect } from "bun:test";
import { planTargets, pacingRules, nextSlotFor, nextUnderCap, bookingsPerAccount, lastPerNetwork, bookingsPerNetwork, recentDuplicate, pastBookings, reflowQueue, DEFAULT_PACING, DAY_MS } from "../src/core/pacing.ts";
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

/**
 * Front of line. The queue reached 30 deep on X and a launch post landed five
 * days out, which is not pacing, it is a backlog. --front measures the gap
 * from what has already gone out and pushes back whatever it displaced. It
 * never opens a gate: that is --now's job, and the two are not the same.
 */

const queued = (account: Account, at: number, id: string, status: QueuedPost["status"] = "pending"): QueuedPost => ({
  id,
  createdAt: "",
  scheduledFor: new Date(at).toISOString(),
  targets: [account.id],
  text: `queued ${id}`,
  status,
});

/** The real shape of the problem: 30 X entries, one every 4h. */
const saturatedX = Array.from({ length: 30 }, (_, i) => queued(x1, NOW + (i + 1) * 4 * H, `q${i}`));

test("--front takes the next legal slot instead of queueing behind 30 entries", () => {
  const plain = planTargets({ accounts: [x2], text: "launch", now: NOW, history: [], queue: saturatedX, rules, accountNetwork, order: stable });
  expect(plain.later[0].at).toBe(NOW + 124 * H);

  const front = planTargets({ accounts: [x2], text: "launch", now: NOW, history: [], queue: saturatedX, rules, accountNetwork, order: stable, front: true });
  expect(front.now).toEqual([x2]);
  expect(front.later).toEqual([]);
});

test("--front still waits out the gap of a post that actually went out", () => {
  const history = [sent(x1, "an hour ago", 1 * H)];
  const front = planTargets({ accounts: [x2], text: "launch", now: NOW, history, queue: saturatedX, rules, accountNetwork, order: stable, front: true });
  expect(front.now).toEqual([]);
  expect(front.later[0].at).toBe(NOW + 3 * H);
});

test("--front is not --now: the duplicate rule still refuses", () => {
  const history = [sent(x2, "launch", 2 * H)];
  const front = planTargets({ accounts: [x2], text: "launch", now: NOW, history, queue: [], rules, accountNetwork, order: stable, front: true });
  expect(front.now).toEqual([]);
  expect(front.later).toEqual([]);
  expect(front.skipped[0].account.id).toBe("x:ProfullstackInc");
});

test("--front collapses the drip to one gap, and two accounts on a network keep it", () => {
  const front = planTargets({ accounts: all, text: "launch", now: NOW, history: [], queue: [], rules, accountNetwork, order: stable, front: true });
  expect(front.now.map((a) => a.id)).toEqual(["x:chovy"]);
  // Five accounts over a 4h window: slots at 0, 1h, 2h, 3h, 4h by position.
  // x2 holds position 1 but the network gap pushes it off 1h to 4h, behind
  // x1. The rest keep their positions.
  const at = new Map(front.later.map((t) => [t.account.id, t.at]));
  expect(at.get("bluesky:chovy")).toBe(NOW + 2 * H);
  expect(at.get("mastodon:chovy")).toBe(NOW + 3 * H);
  expect(at.get("linkedin:anthony")).toBe(NOW + 4 * H);
  expect(at.get("x:ProfullstackInc")).toBe(NOW + 4 * H);
  // Everything inside one gap, against 48h for a normal drip.
  expect(Math.max(...at.values()) - NOW).toBe(4 * H);
});

test("reflow pushes back only what the front post displaced, and only far enough", () => {
  const queue = [queued(x1, NOW + 1 * H, "soon"), queued(x1, NOW + 9 * H, "far"), queued(bsky, NOW + 1 * H, "other")];
  const moves = reflowQueue({ taken: [{ network: "x", at: NOW }], queue, accountNetwork, minGapMs: 4 * H });
  expect(moves).toEqual([{ id: "soon", from: NOW + 1 * H, to: NOW + 4 * H }]);
});

test("reflow cascades, and an entry only ever moves later", () => {
  const queue = [queued(x1, NOW + 1 * H, "a"), queued(x1, NOW + 5 * H, "b"), queued(x1, NOW + 30 * H, "c")];
  const moves = reflowQueue({ taken: [{ network: "x", at: NOW }], queue, accountNetwork, minGapMs: 4 * H });
  expect(moves).toEqual([
    { id: "a", from: NOW + 1 * H, to: NOW + 4 * H },
    { id: "b", from: NOW + 5 * H, to: NOW + 8 * H },
  ]);
  for (const move of moves) expect(move.to).toBeGreaterThan(move.from);
});

test("reflow leaves sent and cancelled entries alone", () => {
  const queue = [queued(x1, NOW + 1 * H, "done", "sent"), queued(x1, NOW + 1 * H, "gone", "cancelled")];
  expect(reflowQueue({ taken: [{ network: "x", at: NOW }], queue, accountNetwork, minGapMs: 4 * H })).toEqual([]);
});

test("a front post into a saturated lane lands now and drops nothing", () => {
  const front = planTargets({ accounts: [x1], text: "launch", now: NOW, history: [], queue: saturatedX, rules, accountNetwork, order: stable, front: true });
  expect(front.now).toEqual([x1]);
  const moves = reflowQueue({ taken: front.taken, queue: saturatedX, accountNetwork, minGapMs: 4 * H });
  expect(moves).toEqual([]);
  expect(saturatedX).toHaveLength(30);
});

test("a front post one minute into the gap does displace the head of the queue", () => {
  const history = [sent(x2, "just now", 1 * 60_000)];
  const front = planTargets({ accounts: [x1], text: "launch", now: NOW, history, queue: saturatedX, rules, accountNetwork, order: stable, front: true });
  const ours = front.later[0].at;
  expect(ours).toBe(NOW + 4 * H - 60_000);
  const moves = reflowQueue({ taken: front.taken, queue: saturatedX, accountNetwork, minGapMs: 4 * H });
  expect(moves[0]).toEqual({ id: "q0", from: NOW + 4 * H, to: ours + 4 * H });
});

test("pastBookings ignores the future, which is the whole trick", () => {
  const past = pastBookings([sent(x1, "earlier", 3 * H)], saturatedX, accountNetwork, NOW);
  expect(past.get("x")).toEqual([NOW - 3 * H]);
});

/* ------------------------------------------------- the skill's daily cap */

const blog = acct("htmlblog", "dev.profullstack.com/~anthony/blog");
const blogNetwork = (id: string) => (id === blog.id ? "htmlblog" : networks.get(id));
const blogRules = { ...rules, minGapMs: H };
const cap4 = (account: Account) => (account.id === blog.id ? { maxPerDay: 4 } : undefined);

test("nextUnderCap: the day is full, so the answer is when its oldest post drops out of the window", () => {
  const bookings = [NOW - 20 * H, NOW - 10 * H, NOW - 5 * H, NOW - 1 * H];
  expect(nextUnderCap(NOW, bookings, 4)).toBe(NOW - 20 * H + DAY_MS);
  expect(nextUnderCap(NOW, bookings, 5)).toBe(NOW);
  expect(nextUnderCap(NOW, [], 1)).toBe(NOW);
  // Full days in a row: the walk steps from one window to the next until one
  // has room. (-20h,+4h] holds -10h and +3h; (-10h,+14h] holds +3h and +5h;
  // (+3h,+27h] holds only +5h, so +27h is the answer.
  const twoDays = [NOW - 30 * H, NOW - 28 * H, NOW - 20 * H, NOW - 10 * H, NOW + 3 * H, NOW + 5 * H];
  expect(nextUnderCap(NOW, twoDays, 2)).toBe(NOW + 3 * H + DAY_MS);
});

test("bookingsPerAccount counts what landed and what is promised, never a failure", () => {
  const history = [sent(blog, "a", 2 * H), sent(blog, "b", 3 * H, false)];
  const queue = [queued(blog, NOW + 2 * H, "later"), queued(blog, NOW + 3 * H, "gone", "cancelled")];
  expect(bookingsPerAccount(history, queue).get(blog.id)).toEqual([NOW - 2 * H, NOW + 2 * H]);
});

test("a fifth blog post in a day is held to the next day, not the next gap slot", () => {
  // Four sent today, the oldest 20h ago; the network gap alone would let a
  // fifth go in an hour.
  const history = [sent(blog, "one", 20 * H), sent(blog, "two", 14 * H), sent(blog, "three", 8 * H), sent(blog, "four", 2 * H)];
  const plan = planTargets({ accounts: [blog], text: "five", now: NOW, history, queue: [], rules: blogRules, accountNetwork: blogNetwork, order: stable, limitsFor: cap4 });
  expect(plan.now).toEqual([]);
  expect(plan.later).toHaveLength(1);
  expect(plan.later[0].at).toBe(NOW - 20 * H + DAY_MS);
  expect(plan.later[0].reason).toContain("4 a day");
  // Without the cap the same post goes now.
  const free = planTargets({ accounts: [blog], text: "five", now: NOW, history, queue: [], rules: blogRules, accountNetwork: blogNetwork, order: stable });
  expect(free.now).toEqual([blog]);
});

test("pending entries earlier in the day count against the cap too", () => {
  const history = [sent(blog, "one", 6 * H), sent(blog, "two", 4 * H)];
  // Two more promised and already due (the daemon has not ticked yet).
  const queue = [queued(blog, NOW - 3 * H, "three"), queued(blog, NOW - 2 * H, "four")];
  const plan = planTargets({ accounts: [blog], text: "five", now: NOW, history, queue, rules: blogRules, accountNetwork: blogNetwork, order: stable, limitsFor: cap4 });
  expect(plan.now).toEqual([]);
  expect(plan.later[0].at).toBe(NOW - 6 * H + DAY_MS);
});

test("--now and --front open the gates but not the day's budget", () => {
  const history = [sent(blog, "one", 20 * H), sent(blog, "two", 14 * H), sent(blog, "three", 8 * H), sent(blog, "four", 2 * H)];
  const forced = planTargets({ accounts: [blog, bsky], text: "five", now: NOW, history, queue: [], rules: blogRules, accountNetwork: blogNetwork, order: stable, limitsFor: cap4, force: true });
  expect(forced.now).toEqual([bsky]);
  expect(forced.later.map((t) => [t.account.id, t.at])).toEqual([[blog.id, NOW - 20 * H + DAY_MS]]);
  expect(forced.later[0].reason).toContain("4 a day");

  const front = planTargets({ accounts: [blog], text: "five", now: NOW, history, queue: [], rules: blogRules, accountNetwork: blogNetwork, order: stable, limitsFor: cap4, front: true });
  expect(front.now).toEqual([]);
  expect(front.later[0].at).toBe(NOW - 20 * H + DAY_MS);
});

test("three blog posts under the cap go through untouched", () => {
  const history = [sent(blog, "one", 20 * H), sent(blog, "two", 14 * H)];
  const plan = planTargets({ accounts: [blog], text: "three", now: NOW, history, queue: [], rules: blogRules, accountNetwork: blogNetwork, order: stable, limitsFor: cap4 });
  expect(plan.now).toEqual([blog]);
});

test("the pushed slot still clears the network gap, and the network gap does not re-fill the day", () => {
  // The day frees at NOW+4h, but the blog network has a booking at NOW+4h30
  // on another account, so the post lands one gap after that.
  const blog2 = acct("htmlblog", "other");
  const history = [sent(blog, "one", 20 * H), sent(blog, "two", 14 * H), sent(blog, "three", 8 * H), sent(blog, "four", 2 * H)];
  const queue = [queued(blog2, NOW + 4.5 * H, "theirs")];
  const nets = (id: string) => (id === blog.id || id === blog2.id ? "htmlblog" : undefined);
  const plan = planTargets({ accounts: [blog], text: "five", now: NOW, history, queue, rules: blogRules, accountNetwork: nets, order: stable, limitsFor: cap4 });
  expect(plan.later[0].at).toBe(NOW + 5.5 * H);
});

test("a skill's wider gap widens the network gap for that account, and a narrower one is ignored", () => {
  const history = [sent(bsky, "earlier", 1 * H)];
  const wide = planTargets({ accounts: [bsky], text: "hi", now: NOW, history, queue: [], rules, accountNetwork, order: stable, limitsFor: () => ({ minGapMs: 10 * H }) });
  expect(wide.later[0].at).toBe(NOW + 9 * H);
  expect(wide.later[0].reason).toContain("10h gap");
  const narrow = planTargets({ accounts: [bsky], text: "hi", now: NOW, history, queue: [], rules, accountNetwork, order: stable, limitsFor: () => ({ minGapMs: 1 * H }) });
  expect(narrow.later[0].at).toBe(NOW + 3 * H);
});
