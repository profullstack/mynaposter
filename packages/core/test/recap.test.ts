import { test, expect } from "bun:test";
import { buildRecap, recapDue, recapSubject, renderRecapText, DEFAULT_RECAP, RECAP_GUARD_MS } from "../src/core/recap.ts";
import type { HistoryEntry } from "../src/store/history.ts";
import type { QueuedPost } from "../src/store/queue.ts";

const NOW = new Date("2026-09-06T18:00:00Z");
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString();
const hoursAhead = (n: number) => new Date(NOW.getTime() + n * 3_600_000).toISOString();

const entry = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  at: hoursAgo(1),
  accountId: "bluesky:chovy",
  network: "bluesky",
  handle: "chovy",
  text: "hello",
  ok: true,
  ...over,
});

const queued = (over: Partial<QueuedPost> = {}): QueuedPost => ({
  id: "abc123",
  createdAt: hoursAgo(2),
  scheduledFor: hoursAhead(3),
  targets: ["mastodon:chovy"],
  text: "later",
  status: "pending",
  ...over,
});

test("counts only the window, not the whole history file", () => {
  const recap = buildRecap({
    now: NOW,
    history: [entry(), entry({ at: hoursAgo(30) }), entry({ at: hoursAgo(23) })],
    queue: [],
  });
  expect(recap.sent).toBe(2);
});

test("a post dated in the future is not counted as sent", () => {
  // History is appended by the poster, but a clock skew or a hand-edited
  // file must not make tomorrow's post part of today's total.
  const recap = buildRecap({ now: NOW, history: [entry({ at: hoursAhead(2) })], queue: [] });
  expect(recap.sent).toBe(0);
});

test("a history entry with an unparseable date is skipped, not NaN", () => {
  const recap = buildRecap({ now: NOW, history: [entry({ at: "not a date" }), entry()], queue: [] });
  expect(recap.sent).toBe(1);
  expect(recap.accounts).toHaveLength(1);
});

test("accounts are ordered busiest first", () => {
  const recap = buildRecap({
    now: NOW,
    history: [
      entry({ accountId: "x:chovy", network: "x" }),
      entry({ accountId: "bluesky:chovy" }),
      entry({ accountId: "bluesky:chovy" }),
      entry({ accountId: "bluesky:chovy" }),
      entry({ accountId: "mastodon:chovy", network: "mastodon" }),
      entry({ accountId: "mastodon:chovy", network: "mastodon" }),
    ],
    queue: [],
  });
  expect(recap.accounts.map((row) => row.accountId)).toEqual(["bluesky:chovy", "mastodon:chovy", "x:chovy"]);
});

test("a failure is counted on its account and listed with its reason", () => {
  const recap = buildRecap({
    now: NOW,
    history: [entry(), entry({ ok: false, error: "429 rate limited", text: "  spaced   out\ntext " })],
    queue: [],
  });
  expect(recap.sent).toBe(1);
  expect(recap.failed).toBe(1);
  expect(recap.accounts[0]).toMatchObject({ sent: 1, failed: 1 });
  expect(recap.failures[0]?.error).toBe("429 rate limited");
  // Post text is multi-line; a recap line is not.
  expect(recap.failures[0]?.text).toBe("spaced out text");
});

test("a multi-line error becomes one line", () => {
  // A shell-out adapter records whatever the tool printed on failure, and
  // blog-post prints its entire usage screen. That must not be the email.
  const error = `blog-post failed: unknown option: ---\n\nUsage:\n  blog-post new <title> --description <text>\n  blog-post check`;
  const recap = buildRecap({ now: NOW, history: [entry({ ok: false, error })], queue: [] });
  expect(recap.failures[0]?.error).not.toContain("\n");
  expect(recap.failures[0]?.error.length).toBeLessThanOrEqual(100);
  // One failure is two lines of mail — a heading line and the post — no
  // matter how many lines the tool it shelled out to decided to print.
  const body = renderRecapText(recap).split("\n");
  const start = body.findIndex((line) => line === "Failed");
  expect(body.slice(start + 1, start + 3).every((line) => line.startsWith("  "))).toBe(true);
  expect(body[start + 3]).toBe("");
});

test("a long list of failures is capped with a count of the rest", () => {
  const history = Array.from({ length: 20 }, (_, i) => entry({ ok: false, error: `boom ${i}`, at: hoursAgo(i % 20) }));
  const recap = buildRecap({ now: NOW, history, queue: [] });
  expect(recap.failed).toBe(20);
  const text = renderRecapText(recap);
  expect(text).toContain("…and 8 more; see myna history");
});

test("a deep queue is capped in the mail but counted in full", () => {
  const queue = Array.from({ length: 20 }, (_, i) => queued({ id: `q${i}`, scheduledFor: hoursAhead(i + 1) }));
  const recap = buildRecap({ now: NOW, history: [], queue });
  expect(recap.upcoming).toHaveLength(20);
  const text = renderRecapText(recap);
  expect(text).toContain("Next 24 hours: 20");
  expect(text).toContain("…and 8 more; see myna queue");
});

test("upcoming stops at the window but pending counts the whole queue", () => {
  const recap = buildRecap({
    now: NOW,
    history: [],
    queue: [queued(), queued({ id: "far", scheduledFor: hoursAhead(72) }), queued({ id: "done", status: "sent" })],
  });
  expect(recap.upcoming.map((post) => post.id)).toEqual(["abc123"]);
  expect(recap.pending).toBe(2);
  expect(recap.lastAt).toBe(hoursAhead(72));
});

test("a cancelled or failed entry is not pending work", () => {
  const recap = buildRecap({
    now: NOW,
    history: [],
    queue: [queued({ status: "cancelled" }), queued({ id: "b", status: "failed" })],
  });
  expect(recap.pending).toBe(0);
  expect(recap.nextAt).toBeUndefined();
});

test("a repost shows what it shares rather than an empty line", () => {
  const recap = buildRecap({
    now: NOW,
    history: [],
    queue: [queued({ text: "", repostOf: "https://example.com/p/1" })],
  });
  expect(recap.upcoming[0]?.text).toBe("repost https://example.com/p/1");
});

test("the text renders an empty day without crashing on an empty column", () => {
  // Math.max of no arguments is -Infinity, and padEnd(-Infinity) throws.
  const text = renderRecapText(buildRecap({ now: NOW, history: [], queue: [] }));
  expect(text).toContain("Nothing went out in the last 24 hours.");
  expect(text).toContain("Queue: empty.");
});

test("the subject carries the numbers so the inbox list is enough", () => {
  const recap = buildRecap({
    now: NOW,
    history: [entry(), entry({ ok: false, error: "nope" })],
    queue: [queued()],
  });
  expect(recapSubject(recap, "UTC")).toBe("myna — Sunday, September 6: 1 sent, 1 failed, 1 coming up");
});

test("a clean day leaves the failure count out of the subject", () => {
  const recap = buildRecap({ now: NOW, history: [entry()], queue: [] });
  expect(recapSubject(recap, "UTC")).toBe("myna — Sunday, September 6: 1 sent, 0 coming up");
});

const on = { ...DEFAULT_RECAP, enabled: true, to: "me@example.com", at: "08:00" };
const local = (iso: string) => new Date(iso);

test("nothing is due before the hour, or while it is off, or with no address", () => {
  const before = local("2026-09-06T07:59:00");
  expect(recapDue(on, before)).toBe(false);
  expect(recapDue({ ...on, enabled: false }, local("2026-09-06T09:00:00"))).toBe(false);
  expect(recapDue({ ...on, to: "" }, local("2026-09-06T09:00:00"))).toBe(false);
});

test("due once the hour has passed and never sent", () => {
  expect(recapDue(on, local("2026-09-06T08:00:00"))).toBe(true);
});

test("a send today blocks another today", () => {
  const now = local("2026-09-06T18:00:00");
  const sentThisMorning = local("2026-09-06T08:00:00").toISOString();
  expect(recapDue(on, now, sentThisMorning)).toBe(false);
});

test("yesterday's send does not unblock tomorrow before the hour", () => {
  // 20h after an 08:00 send is 04:00 the next day, which is a different
  // calendar day but still before the configured time.
  const now = local("2026-09-07T04:30:00");
  expect(recapDue(on, now, local("2026-09-06T08:00:00").toISOString())).toBe(false);
});

test("yesterday's send unblocks today once the hour passes", () => {
  const now = local("2026-09-07T08:05:00");
  expect(recapDue(on, now, local("2026-09-06T08:00:00").toISOString())).toBe(true);
});

test("a late send does not let the next one follow too soon", () => {
  // Sent at 23:00 yesterday; 08:00 today is a new day but only 9h later.
  const now = local("2026-09-07T08:05:00");
  expect(now.getTime() - local("2026-09-06T23:00:00").getTime()).toBeLessThan(RECAP_GUARD_MS);
  expect(recapDue(on, now, local("2026-09-06T23:00:00").toISOString())).toBe(false);
});

test("a corrupt last-sent stamp does not wedge the recap forever", () => {
  expect(recapDue(on, local("2026-09-06T09:00:00"), "whenever")).toBe(true);
});
