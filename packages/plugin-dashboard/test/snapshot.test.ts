/**
 * The dashboard payload: colour follows the network and not its rank, a gated
 * network reports how long it is holding, the queue is ordered by when it goes,
 * and the lead figure is the next thing out.
 */
import { test, expect } from "bun:test";
import { buildSnapshot, slotFor, horizonFor, NETWORK_SLOT_ORDER } from "../src/snapshot.ts";
import { handle } from "../src/index.ts";
import { DEFAULT_SETTINGS, type Account, type HistoryEntry, type QueuedPost, type Settings } from "@profullstack/myna-core";

const H = 3_600_000;
const NOW = Date.parse("2026-09-06T12:00:00.000Z");

const account = (network: string, handleName: string): Account => ({
  id: `${network}:${handleName}`,
  network,
  handle: handleName,
  addedAt: "",
  creds: {},
  meta: {},
});

const sent = (acct: Account, text: string, agoMs: number, ok = true): HistoryEntry => ({
  at: new Date(NOW - agoMs).toISOString(),
  accountId: acct.id,
  network: acct.network,
  handle: acct.handle,
  text,
  ok,
  ...(ok ? { postId: `p${agoMs}`, url: `https://example.test/${agoMs}` } : { error: "rejected" }),
});

const queued = (acct: Account, inMs: number, text = "later", extra?: Record<string, string>): QueuedPost => ({
  id: `q${inMs}`,
  createdAt: new Date(NOW).toISOString(),
  scheduledFor: new Date(NOW + inMs).toISOString(),
  targets: [acct.id],
  text,
  status: "pending",
  ...(extra ? { extra } : {}),
});

const settings = (): Settings => structuredClone(DEFAULT_SETTINGS);

const x = account("x", "chovy");
const bsky = account("bluesky", "chovy");
const masto = account("mastodon", "chovy");

const base = {
  now: NOW,
  history: [] as HistoryEntry[],
  queue: [] as QueuedPost[],
  accounts: [x, bsky, masto],
  engagement: [],
  settings: settings(),
};

test("a network keeps its colour slot however many others are connected", () => {
  // Colour follows the entity, never its rank: bluesky is slot 2 whether or
  // not X is in the picture.
  expect(slotFor("bluesky")).toBe(2);
  const alone = buildSnapshot({ ...base, accounts: [bsky] });
  expect(alone.networks.find((n) => n.network === "bluesky")?.slot).toBe(2);
  const crowded = buildSnapshot({ ...base, accounts: [x, bsky, masto] });
  expect(crowded.networks.find((n) => n.network === "bluesky")?.slot).toBe(2);
  // Anything past the eight named slots falls to the muted slot rather than a
  // ninth generated hue.
  expect(NETWORK_SLOT_ORDER).toHaveLength(8);
  expect(slotFor("nostr")).toBe(0);
});

test("a network posted to recently reports how long it is holding", () => {
  const snap = buildSnapshot({ ...base, history: [sent(x, "earlier", 1 * H)] });
  const lane = snap.networks.find((n) => n.network === "x");
  expect(lane?.gatedForMs).toBe(3 * H);
  expect(lane?.freeAt).toBe(NOW + 3 * H);
  expect(snap.gatedCount).toBe(1);
  // A network nobody has posted to is free now.
  expect(snap.networks.find((n) => n.network === "bluesky")?.gatedForMs).toBe(0);
});

test("the lead figure is the next post out, and the queue is in send order", () => {
  const snap = buildSnapshot({
    ...base,
    queue: [queued(masto, 12 * H, "third"), queued(bsky, 2 * H, "first"), queued(x, 6 * H, "second")],
  });
  expect(snap.next?.accountId).toBe("bluesky:chovy");
  expect(snap.next?.inMs).toBe(2 * H);
  expect(snap.queue.map((row) => row.text)).toEqual(["first", "second", "third"]);
  expect(snap.queuedCount).toBe(3);
});

test("nothing queued is said plainly rather than shown as zero time", () => {
  const snap = buildSnapshot(base);
  expect(snap.next).toBeUndefined();
  expect(snap.queuedCount).toBe(0);
});

test("the 30-day figure has the previous 30 beside it for the delta", () => {
  const snap = buildSnapshot({
    ...base,
    history: [sent(x, "a", 2 * 24 * H), sent(bsky, "b", 10 * 24 * H), sent(masto, "c", 40 * 24 * H)],
  });
  expect(snap.sent30).toBe(2);
  expect(snap.sentPrev30).toBe(1);
});

test("a failed post counts against the rate but is not a delivered post", () => {
  const snap = buildSnapshot({ ...base, history: [sent(x, "ok", 5 * H), sent(bsky, "bad", 6 * H, false)] });
  expect(snap.totals.sent).toBe(1);
  expect(snap.totals.failed).toBe(1);
  expect(snap.totals.rate).toBe(0.5);
  expect(snap.history.find((row) => !row.ok)?.error).toBe("rejected");
});

test("an archive re-post is marked so the queue can say where it came from", () => {
  const snap = buildSnapshot({ ...base, queue: [queued(bsky, H, "From the archive", { evergreen: "true" })] });
  expect(snap.queue[0].evergreen).toBe(true);
});

test("the drip horizon covers the whole drip window, rounded to days", () => {
  expect(horizonFor(48 * H)).toBe(2 * 24 * H);
  expect(horizonFor(72 * H)).toBe(3 * 24 * H);
  // A drip shorter than a day still shows a day, so the chart has an axis.
  expect(horizonFor(2 * H)).toBe(24 * H);
});

test("a disconnected account's history still counts in the totals", () => {
  const gone = account("threads", "old");
  const snap = buildSnapshot({ ...base, history: [sent(gone, "before", 3 * 24 * H)] });
  const lane = snap.networks.find((n) => n.network === "threads");
  expect(lane).toBeDefined();
  expect(lane?.accounts).toEqual([]);
  expect(lane?.sent).toBe(1);
});

test("the server serves the page and the snapshot, and 404s the rest", async () => {
  const html = handle(new Request("http://127.0.0.1/"));
  expect(html.status).toBe(200);
  expect(html.headers.get("content-type")).toContain("text/html");
  expect(await html.text()).toContain("myna dashboard");

  const api = handle(new Request("http://127.0.0.1/api/snapshot"));
  expect(api.headers.get("content-type")).toContain("application/json");
  expect([200, 503]).toContain(api.status);

  expect(handle(new Request("http://127.0.0.1/nope")).status).toBe(404);
});
