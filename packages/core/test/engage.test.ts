/**
 * Follow-ups: a scan queues, a send works through what is due, and the
 * limits hold. Against a fake network and a fake writer.
 *
 * What has to hold: a reply is drafted from what they said with our post as
 * context and goes under their post; a repost gets a thank-you under our
 * post; a like is ignored unless asked; the same person inside the cooldown
 * gets one follow-up, not two; nothing is sent twice; the gap and the daily
 * cap hold; the writer failing falls back to the template rather than to
 * silence.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classify, bodyOf, scanEngagement, sendFollowUps, templateReply } from "../src/core/engage.ts";
import { listFollowUps, readEngage } from "../src/store/engage.ts";
import { listHistory, recordHistory } from "../src/store/history.ts";
import { resetAccountCache, saveAccount } from "../src/store/accounts.ts";
import { registerNetwork, unregisterNetwork } from "../src/net/registry.ts";
import { DEFAULT_ENGAGE } from "../src/store/settings.ts";
import type { Account, Network, TimelineItem } from "../src/net/types.ts";
import type { ReplyRequest } from "../src/ai/writer.ts";

let dir = "";
const registered: string[] = [];
const posted: { account: string; text: string; replyTo?: string }[] = [];
const followed: { account: string; handle: string }[] = [];
let notifications: TimelineItem[] = [];

function useNetwork(id: string, options: { follow?: boolean; charLimit?: number } = {}): void {
  registerNetwork({
    id,
    name: id,
    caps: { charLimit: options.charLimit ?? 300, mediaLimit: 4, threads: false, delete: false, timeline: false, notifications: true, stats: false, follow: options.follow ?? true },
    async login() {
      throw new Error("not used");
    },
    async post(account: Account, input: { text: string; replyTo?: string }) {
      if (input.replyTo === "boom") throw new Error("gone");
      posted.push({ account: account.id, text: input.text, replyTo: input.replyTo });
      return { id: `r${posted.length}`, url: `https://${id}/r${posted.length}` };
    },
    async notifications() {
      return notifications;
    },
    ...(options.follow === false
      ? {}
      : {
          async follow(account: Account, handle: string) {
            followed.push({ account: account.id, handle });
            return { already: handle === "@old" };
          },
        }),
  } as unknown as Network);
  registered.push(id);
}

const account = (id: string, network: string): Account => ({ id, network, handle: "me", addedAt: "", creds: {}, meta: {} });

const drafts: ReplyRequest[] = [];
const drafter = async (request: ReplyRequest): Promise<string> => {
  drafts.push(request);
  if (request.theirText.includes("explode")) throw new Error("model down");
  return `Re ${request.handle}: about "${request.theirText.slice(0, 20)}"${request.ourText ? " (had context)" : ""}`;
};

const note = (over: Partial<TimelineItem> & { id: string }): TimelineItem => ({
  author: "Ada",
  handle: "ada",
  text: "",
  createdAt: "2026-09-12T10:00:00.000Z",
  ...over,
});

const settings = { ...DEFAULT_ENGAGE, enabled: true, gapMinutes: 0 };
const T0 = Date.parse("2026-09-12T12:00:00.000Z");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-engage-"));
  process.env.MYNA_HOME = dir;
  posted.length = 0;
  followed.length = 0;
  drafts.length = 0;
  notifications = [];
  resetAccountCache();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
  while (registered.length) unregisterNetwork(registered.pop() as string);
  resetAccountCache();
});

test("classify reads the adapters' kinds and the older text prefixes", () => {
  expect(classify(note({ id: "1", kind: "reply" }))).toBe("reply");
  expect(classify(note({ id: "2", text: "reblog: hi" }))).toBe("repost");
  expect(classify(note({ id: "3", text: "favourite" }))).toBe("like");
  expect(classify(note({ id: "4", text: "something else" }))).toBeNull();
  expect(bodyOf(note({ id: "5", text: "mention: hello there: friend" }))).toBe("hello there: friend");
  expect(bodyOf(note({ id: "6", text: "just words" }))).toBe("just words");
});

test("a reply is drafted from what they said, with our post as context, and goes under their post", async () => {
  useNetwork("net");
  saveAccount(account("net:me", "net"));
  recordHistory([{ at: "2026-09-12T09:00:00.000Z", accountId: "net:me", network: "net", handle: "me", text: "We shipped a thing", ok: true, postId: "our1|cid1", url: "https://net/our1" }]);
  notifications = [note({ id: "n1", kind: "reply", text: "reply: Does it work on Windows?", postId: "root|c|their1|c2", subjectId: "our1" })];

  const scan = await scanEngagement({ settings, drafter, writerReady: true, now: T0 });

  expect(scan.queued).toHaveLength(1);
  const item = scan.queued[0]!;
  expect(item).toMatchObject({ kind: "reply", handle: "ada", theirText: "Does it work on Windows?", theirPostId: "root|c|their1|c2", ourText: "We shipped a thing", follow: true, status: "pending" });
  expect(item.reply).toBe('Re @ada: about "Does it work on Wind" (had context)');
  expect(item.drafted).toBe("writer");
  expect(drafts[0]).toMatchObject({ kind: "reply", handle: "@ada", ourText: "We shipped a thing", network: "net", followed: true });

  const send = await sendFollowUps({ settings, now: T0 });
  expect(send.sent).toHaveLength(1);
  expect(followed).toEqual([{ account: "net:me", handle: "ada" }]);
  expect(posted).toEqual([{ account: "net:me", text: 'Re @ada: about "Does it work on Wind" (had context)', replyTo: "root|c|their1|c2" }]);
  const stored = listFollowUps()[0]!;
  expect(stored.status).toBe("sent");
  expect(stored.result).toMatchObject({ replyUrl: "https://net/r1", followed: true });
  expect(listHistory()[0]).toMatchObject({ type: "reply", text: stored.reply, url: "https://net/r1" });
});

test("a repost gets a thank-you under our post; a like is ignored unless asked; a follow is a follow only", async () => {
  useNetwork("net");
  saveAccount(account("net:me", "net"));
  recordHistory([{ at: "2026-09-12T09:00:00.000Z", accountId: "net:me", network: "net", handle: "me", text: "We shipped a thing", ok: true, postId: "our1|cid1" }]);
  notifications = [
    note({ id: "r1", kind: "repost", text: "repost", handle: "bob", subjectId: "our1" }),
    note({ id: "l1", kind: "like", text: "like", handle: "carol", subjectId: "our1" }),
    note({ id: "f1", kind: "follow", text: "follow", handle: "dan" }),
  ];

  const scan = await scanEngagement({ settings, drafter, writerReady: true, now: T0 });
  expect(scan.queued.map((item) => [item.kind, item.handle, Boolean(item.reply), item.follow])).toEqual([
    ["repost", "bob", true, true],
    ["follow", "dan", false, true],
  ]);
  expect(scan.queued[0]?.theirPostId).toBe("our1|cid1");
  expect(drafts[0]).toMatchObject({ kind: "repost", theirText: "" });

  await sendFollowUps({ settings, now: T0 });
  expect(posted).toHaveLength(1);
  expect(posted[0]?.replyTo).toBe("our1|cid1");
  expect(followed.map((entry) => entry.handle)).toEqual(["bob", "dan"]);

  // Asked to follow likers, the like becomes a follow-up too, once.
  notifications = [note({ id: "l2", kind: "like", text: "like", handle: "carol", subjectId: "our1" })];
  const again = await scanEngagement({ settings: { ...settings, followLikers: true }, drafter, writerReady: true, now: T0 });
  expect(again.queued.map((item) => [item.kind, item.handle, item.follow, item.reply])).toEqual([["like", "carol", true, undefined]]);
});

test("the same person inside the cooldown gets one follow-up, and nothing is reconsidered", async () => {
  useNetwork("net");
  saveAccount(account("net:me", "net"));
  notifications = [
    note({ id: "a1", kind: "reply", text: "reply: first", postId: "p1", createdAt: "2026-09-12T10:00:00.000Z" }),
    note({ id: "a2", kind: "reply", text: "reply: second, later", postId: "p2", createdAt: "2026-09-12T10:05:00.000Z" }),
  ];
  const first = await scanEngagement({ settings, drafter, writerReady: true, now: T0 });
  expect(first.queued).toHaveLength(1);
  // The pending follow-up answers what they said last, re-drafted.
  expect(readEngage().items[0]).toMatchObject({ theirText: "second, later", theirPostId: "p2", reply: 'Re @ada: about "second, later"', drafted: "writer" });
  expect(drafts).toHaveLength(2);

  const second = await scanEngagement({ settings, drafter, writerReady: true, now: T0 + 1000 });
  expect(second.queued).toHaveLength(0);
  expect(second.read).toBe(2);

  // After the cooldown, a new reply from them is a new follow-up.
  notifications = [note({ id: "a3", kind: "reply", text: "reply: weeks later", postId: "p3", createdAt: "2026-09-30T10:00:00.000Z" })];
  const later = await scanEngagement({ settings, drafter, writerReady: true, now: T0 + 20 * 86_400_000 });
  expect(later.queued).toHaveLength(1);
});

test("the writer failing falls back to the template, and no writer at all uses it outright", async () => {
  useNetwork("net");
  saveAccount(account("net:me", "net"));
  notifications = [
    note({ id: "e1", kind: "reply", text: "reply: please explode", postId: "p1", handle: "eve" }),
    note({ id: "e2", kind: "repost", text: "repost", handle: "frank", subjectId: "none" }),
  ];
  const scan = await scanEngagement({ settings, drafter, writerReady: true, now: T0 });
  expect(scan.queued[0]).toMatchObject({ handle: "eve", drafted: "template", reply: templateReply("reply", "@eve", true) });
  // A repost of a post history does not know: nothing to reply under, so it is a follow only.
  expect(scan.queued[1]).toMatchObject({ handle: "frank", follow: true });
  expect(scan.queued[1]?.reply).toBeUndefined();

  notifications = [note({ id: "e3", kind: "mention", text: "mention: hi", postId: "p9", handle: "gil" })];
  const off = await scanEngagement({ settings, drafter, writerReady: false, now: T0 + 1 });
  expect(off.queued[0]).toMatchObject({ drafted: "template", reply: "Thanks, @gil followed you back." });
});

test("the gap and the daily cap hold, a failed reply is recorded once, and a dry run sends nothing", async () => {
  useNetwork("net");
  saveAccount(account("net:me", "net"));
  notifications = [
    note({ id: "g1", kind: "reply", text: "reply: one", postId: "p1", handle: "h1", createdAt: "2026-09-12T10:00:00.000Z" }),
    note({ id: "g2", kind: "reply", text: "reply: two", postId: "boom", handle: "h2", createdAt: "2026-09-12T10:01:00.000Z" }),
    note({ id: "g3", kind: "reply", text: "reply: three", postId: "p3", handle: "h3", createdAt: "2026-09-12T10:02:00.000Z" }),
  ];
  const paced = { ...settings, gapMinutes: 10, maxPerDay: 2 };
  const scan = await scanEngagement({ settings: paced, drafter, writerReady: true, now: T0 });
  expect(scan.queued.map((item) => item.dueAt)).toEqual([
    new Date(T0).toISOString(),
    new Date(T0 + 10 * 60_000).toISOString(),
    new Date(T0 + 20 * 60_000).toISOString(),
  ]);

  const dry = await sendFollowUps({ settings: paced, now: T0 + 30 * 60_000, dryRun: true });
  expect(dry.sent).toHaveLength(1);
  expect(posted).toHaveLength(0);
  expect(listFollowUps().every((item) => item.status === "pending")).toBe(true);

  const one = await sendFollowUps({ settings: paced, now: T0 + 30 * 60_000 });
  expect(one.sent.map((item) => item.handle)).toEqual(["h1"]);
  expect(one.held).toEqual(["net:me: inside the 10 minute gap", "net:me: inside the 10 minute gap"]);

  const two = await sendFollowUps({ settings: paced, now: T0 + 41 * 60_000 });
  expect(two.sent.map((item) => [item.handle, item.status])).toEqual([["h2", "sent"]]);
  expect(two.sent[0]?.error).toContain("reply: gone");
  expect(two.sent[0]?.result?.followed).toBe(true);

  const three = await sendFollowUps({ settings: paced, now: T0 + 52 * 60_000 });
  expect(three.sent).toHaveLength(0);
  expect(three.held).toEqual(["net:me: 2 today already"]);
  expect(posted.map((entry) => entry.replyTo)).toEqual(["p1"]);
});

test("networks setting narrows, and an account's own handle is never engaged", async () => {
  useNetwork("net");
  useNetwork("other");
  saveAccount(account("net:me", "net"));
  saveAccount(account("other:me", "other"));
  notifications = [note({ id: "s1", kind: "reply", text: "reply: hi", postId: "p1", handle: "me" }), note({ id: "s2", kind: "reply", text: "reply: hi", postId: "p2", handle: "zed" })];
  const scan = await scanEngagement({ settings: { ...settings, networks: "net" }, drafter, writerReady: true, now: T0 });
  expect(scan.queued.map((item) => [item.accountId, item.handle])).toEqual([["net:me", "zed"]]);
});
