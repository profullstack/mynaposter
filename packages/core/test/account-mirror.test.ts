/**
 * Mirror accounts.
 *
 * A mirror never posts its own: it is shut out of every original-posting path
 * exactly like an archived account. The daemon's mirror job reads the
 * source's profile and reposts + likes each new original post exactly once,
 * ignoring replies and reposts, and only as far back as 24 hours on first
 * enable.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postPaced, postToAll } from "../src/core/poster.ts";
import { runDuePosts } from "../src/core/scheduler.ts";
import { pickRotation } from "../src/core/rotate.ts";
import { runMirrors, readMirrorState, selectOriginals, MIRROR_POLL_MS } from "../src/core/mirror.ts";
import { publishNewsletter } from "../src/core/newsletter-publish.ts";
import { registerNetwork, unregisterNetwork } from "../src/net/registry.ts";
import { NO_CAPS, type Account, type Network, type PostInput, type TimelineItem } from "../src/net/types.ts";
import { enqueue, listQueue } from "../src/store/queue.ts";
import {
  ArchivedAccountError,
  accountStatus,
  archiveAccount,
  clearMirror,
  getAccount,
  listAccounts,
  mirrorAccounts,
  resetAccountCache,
  resolveTargets,
  saveAccount,
  setMirror,
} from "../src/store/accounts.ts";
import { resetPlugins } from "../src/plugins/loader.ts";

const sent: Array<{ account: string; input: PostInput }> = [];
const reposts: Array<{ account: string; ref: string }> = [];
const likes: Array<{ account: string; ref: string }> = [];
let feed: TimelineItem[] = [];
let feedReads = 0;
let failRepost = false;

const fake: Network = {
  id: "mirrortest",
  name: "Mirror test network",
  category: "minor",
  blurb: "Test double.",
  auth: { kind: "local", fields: [] },
  caps: { ...NO_CAPS, repost: true, upvote: true },
  async login() {
    throw new Error("not used");
  },
  async post(account, input) {
    sent.push({ account: account.id, input });
    return { id: `${sent.length}`, url: `https://mirrortest.example/${sent.length}` };
  },
  async repost(account, ref) {
    if (failRepost) throw new Error("network down");
    reposts.push({ account: account.id, ref });
    return { id: `repost-${reposts.length}` };
  },
  async upvote(account, ref) {
    likes.push({ account: account.id, ref });
    return { id: `like-${likes.length}` };
  },
  async authorFeed(_account, _actor, _limit) {
    feedReads++;
    return feed;
  },
};

const account = (handle: string): Account => ({
  id: `mirrortest:${handle}`,
  network: "mirrortest",
  handle,
  addedAt: "2026-10-01T00:00:00.000Z",
  creds: { token: `secret-${handle}` },
  meta: { did: `did:test:${handle}` },
});

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const item = (rkey: string, createdAt: string, extra: Partial<TimelineItem> = {}): TimelineItem => ({
  id: `at://did:test:source/post/${rkey}|cid-${rkey}`,
  author: "Source",
  handle: "source",
  authorId: "did:test:source",
  text: `post ${rkey}`,
  createdAt,
  url: `https://mirrortest.example/source/${rkey}`,
  ...extra,
});

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-mirror-"));
  process.env.MYNA_HOME = dir;
  resetPlugins();
  resetAccountCache();
  registerNetwork(fake);
  saveAccount(account("source"));
  saveAccount(account("live"));
  saveAccount(account("echo"));
  setMirror("mirrortest:echo", { from: "mirrortest:source", at: new Date(NOW).toISOString() });
  feed = [];
  feedReads = 0;
  failRepost = false;
});
afterEach(() => {
  sent.length = 0;
  reposts.length = 0;
  likes.length = 0;
  unregisterNetwork("mirrortest");
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
  resetAccountCache();
  resetPlugins();
});

// ---- exclusion from original posting ----

test("a mirror is recorded on the account, outside creds, and shows as `mirror of <source>`", () => {
  const stored = getAccount("mirrortest:echo")!;
  expect(stored.creds.token).toBe("secret-echo");
  expect(stored.mirror).toMatchObject({ from: "mirrortest:source", like: true, repost: true, since: hoursAgo(24) });
  expect(accountStatus(stored)).toBe("mirror of mirrortest:source");
  expect(listAccounts().map((a) => a.id)).toEqual(["mirrortest:live", "mirrortest:source"]);
  expect(mirrorAccounts().map((a) => a.id)).toEqual(["mirrortest:echo"]);
});

test("`all` and a network name leave the mirror out; naming it is refused with how to turn it off", () => {
  expect(resolveTargets("all").map((a) => a.id)).not.toContain("mirrortest:echo");
  expect(resolveTargets("mirrortest").map((a) => a.id)).toEqual(["mirrortest:live", "mirrortest:source"]);
  expect(() => resolveTargets("mirrortest:echo")).toThrow(ArchivedAccountError);
  expect(() => resolveTargets("mirrortest:echo")).toThrow("mirror of mirrortest:source");
  expect(() => resolveTargets("echo")).toThrow("--off");
});

test("postPaced (drip, --front) and postToAll refuse a mirror and send nothing", async () => {
  const echo = getAccount("mirrortest:echo")!;
  await expect(postPaced([echo], { text: "hello" })).rejects.toThrow(ArchivedAccountError);
  await expect(postPaced([echo], { text: "hello" }, { front: true } as never)).rejects.toThrow(ArchivedAccountError);
  await expect(postToAll([echo], { text: "hello" })).rejects.toThrow(ArchivedAccountError);
  expect(sent).toHaveLength(0);
  expect(listQueue()).toHaveLength(0);
});

test("rotation never picks a mirror", () => {
  const accounts = listAccounts({ includeArchived: true });
  for (let i = 0; i < 5; i++) {
    const pick = pickRotation({ accounts, mode: "random", state: { cursor: {}, picks: [] }, now: 0, slot: () => 0, random: () => 0 });
    expect(pick.account.id).not.toBe("mirrortest:echo");
  }
});

test("the scheduler cancels a queued original post for a mirror", async () => {
  const solo = enqueue({ scheduledFor: "2026-11-01T00:00:00.000Z", targets: ["mirrortest:echo"], text: "should never go" });
  await runDuePosts(new Date(NOW));
  const after = listQueue().find((e) => e.id === solo.id)!;
  expect(after.status).toBe("cancelled");
  expect(after.lastError).toContain("mirror of mirrortest:source");
  expect(sent).toHaveLength(0);
});

test("a newsletter web copy is refused for a mirror", async () => {
  const { writeNewsletters } = await import("../src/store/newsletters.ts");
  writeNewsletters({ newsletters: [{ id: "n1", subject: "Hi", body: "Body", list: "main", status: "sent", sentAt: hoursAgo(1), createdAt: hoursAgo(2) } as never], deliveries: {} } as never);
  const result = await publishNewsletter("n1", { to: ["mirrortest:echo"] } as never).catch((error: Error) => ({ error: error.message }));
  expect(JSON.stringify(result)).toContain("mirror of mirrortest:source");
  expect(sent).toHaveLength(0);
});

test("re-saving the account (token refresh) keeps the mirror", () => {
  saveAccount({ ...account("echo"), creds: { token: "refreshed" } });
  expect(getAccount("mirrortest:echo")?.mirror?.from).toBe("mirrortest:source");
});

test("an archived account needs --restore; with it the archive goes and the mirror lands in one write", () => {
  archiveAccount("mirrortest:live", { note: "paused" });
  expect(() => setMirror("mirrortest:live", { from: "mirrortest:source" })).toThrow("--restore");
  expect(getAccount("mirrortest:live")?.archived).toBeDefined();
  const done = setMirror("mirrortest:live", { from: "mirrortest:source", restore: true });
  expect(done.archived).toBeUndefined();
  expect(done.mirror?.from).toBe("mirrortest:source");
  // Never a plain target at any point after.
  expect(() => resolveTargets("mirrortest:live")).toThrow(ArchivedAccountError);
});

test("a mirror cannot mirror itself", () => {
  expect(() => setMirror("mirrortest:echo", { from: "mirrortest:echo" })).toThrow("itself");
});

test("--off makes it a normal account again and the mirror job leaves it alone", async () => {
  expect(clearMirror("mirrortest:echo")?.id).toBe("mirrortest:echo");
  expect(getAccount("mirrortest:echo")?.mirror).toBeUndefined();
  expect(resolveTargets("mirrortest:echo").map((a) => a.id)).toEqual(["mirrortest:echo"]);
  expect(clearMirror("mirrortest:echo")).toBeUndefined();
  feed = [item("a", hoursAgo(1))];
  const turn = await runMirrors({ now: NOW, forcePoll: true, ignoreDue: true });
  expect(turn.actions).toHaveLength(0);
  expect(feedReads).toBe(0);
  expect(reposts).toHaveLength(0);
});

// ---- the mirror job ----

test("selectOriginals keeps only the source's own originals, in the window, unseen", () => {
  const items = [
    item("old", hoursAgo(30)),
    item("reply", hoursAgo(2), { isReply: true }),
    item("boost", hoursAgo(2), { isRepost: true, authorId: "did:test:other", handle: "other" }),
    item("other", hoursAgo(2), { authorId: "did:test:other", handle: "other" }),
    item("seen", hoursAgo(3)),
    item("b", hoursAgo(1)),
    item("a", hoursAgo(5)),
  ];
  const picked = selectOriginals(items, { actor: "did:test:source", since: hoursAgo(24), seen: new Set(["at://did:test:source/post/seen"]) });
  expect(picked.map((p) => p.text)).toEqual(["post a", "post b"]);
});

test("the job reposts and likes each new original exactly once, one per turn, ignoring replies, reposts and old posts", async () => {
  feed = [
    item("new1", hoursAgo(2)),
    item("new2", hoursAgo(1)),
    item("reply", hoursAgo(1), { isReply: true }),
    item("boost", hoursAgo(1), { isRepost: true, authorId: "did:test:other", handle: "other" }),
    item("ancient", hoursAgo(48)),
  ];
  const first = await runMirrors({ now: NOW, random: () => 0 });
  expect(first.queued).toBe(2);
  expect(first.actions).toHaveLength(1);
  expect(reposts.map((r) => r.ref)).toEqual(["at://did:test:source/post/new1|cid-new1"]);
  expect(likes.map((r) => r.ref)).toEqual(["at://did:test:source/post/new1|cid-new1"]);
  expect(reposts[0].account).toBe("mirrortest:echo");

  // The next post is spaced out: not due on the same minute.
  const same = await runMirrors({ now: NOW + 30_000, random: () => 0 });
  expect(same.actions).toHaveLength(0);

  const later = await runMirrors({ now: NOW + MIRROR_POLL_MS + 60_000, random: () => 0 });
  expect(later.actions).toHaveLength(1);
  expect(reposts.map((r) => r.ref.split("|")[0].split("/").pop())).toEqual(["new1", "new2"]);

  // More turns, more polls of the same feed: nothing is done twice.
  for (let i = 2; i < 6; i++) await runMirrors({ now: NOW + i * MIRROR_POLL_MS + 60_000, random: () => 0 });
  expect(reposts).toHaveLength(2);
  expect(likes).toHaveLength(2);
  const state = readMirrorState().accounts["mirrortest:echo"];
  expect(state.pending).toHaveLength(0);
  expect(state.done.map((d) => d.postId.split("|")[0].split("/").pop())).toEqual(["new1", "new2"]);
  expect(sent).toHaveLength(0);
});

test("a fresh post waits 1-10 minutes after it was published", async () => {
  feed = [item("fresh", new Date(NOW - 10_000).toISOString())];
  const turn = await runMirrors({ now: NOW, random: () => 0 });
  expect(turn.queued).toBe(1);
  expect(turn.actions).toHaveLength(0);
  const due = Date.parse(readMirrorState().accounts["mirrortest:echo"].pending[0].dueAt);
  expect(due - (NOW - 10_000)).toBeGreaterThanOrEqual(60_000);
  expect(due - (NOW - 10_000)).toBeLessThanOrEqual(10 * 60_000);
  await runMirrors({ now: due, random: () => 0 });
  expect(reposts).toHaveLength(1);
});

test("first enable only reaches back 24 hours", async () => {
  feed = [item("yesterday-ish", hoursAgo(23)), item("too-old", hoursAgo(25))];
  for (let i = 0; i < 4; i++) await runMirrors({ now: NOW + i * MIRROR_POLL_MS, random: () => 0 });
  expect(reposts.map((r) => r.ref)).toEqual(["at://did:test:source/post/yesterday-ish|cid-yesterday-ish"]);
});

test("--like only likes; a post the network says is already reposted+liked is not touched", async () => {
  setMirror("mirrortest:echo", { from: "mirrortest:source", like: true, repost: false, at: new Date(NOW).toISOString() });
  feed = [item("x", hoursAgo(1)), item("done-before", hoursAgo(2), { viewerLiked: true })];
  for (let i = 0; i < 3; i++) await runMirrors({ now: NOW + i * MIRROR_POLL_MS, random: () => 0 });
  expect(reposts).toHaveLength(0);
  expect(likes.map((l) => l.ref)).toEqual(["at://did:test:source/post/x|cid-x"]);
  const done = readMirrorState().accounts["mirrortest:echo"].done;
  expect(done.find((d) => d.postId.includes("done-before"))?.already).toBe(true);
});

test("a failed action is retried later, and a repost that went through is never repeated", async () => {
  feed = [item("flaky", hoursAgo(1))];
  failRepost = true;
  const first = await runMirrors({ now: NOW, random: () => 0 });
  expect(first.actions[0].error).toContain("network down");
  expect(readMirrorState().accounts["mirrortest:echo"].pending[0].attempts).toBe(1);
  failRepost = false;
  await runMirrors({ now: NOW + 11 * 60_000, random: () => 0 });
  await runMirrors({ now: NOW + 30 * 60_000, random: () => 0 });
  expect(reposts).toHaveLength(1);
  expect(likes).toHaveLength(1);
});

test("an archived mirror does nothing", async () => {
  archiveAccount("mirrortest:echo", { note: "paused" });
  feed = [item("a", hoursAgo(1))];
  await runMirrors({ now: NOW, forcePoll: true, ignoreDue: true });
  expect(reposts).toHaveLength(0);
  expect(accountStatus(getAccount("mirrortest:echo")!)).toMatch(/^archived/);
});
