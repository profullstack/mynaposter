/**
 * The afterPost hook: every plugin hears about a post once it is out, one
 * failing plugin never hides another, and the outcome rides on the results.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerPlugin, resetPlugins } from "../src/plugins/loader.ts";
import { postedEvent, runAfterPost, runAfterSchedule, runAfterCancel } from "../src/plugins/hooks.ts";
import type { CancelledEvent, PostedEvent, ScheduledEvent } from "../src/plugins/types.ts";
import type { QueuedPost } from "../src/store/queue.ts";
import type { TargetResult } from "../src/core/poster.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-hooks-"));
  process.env.MYNA_HOME = dir;
  resetPlugins();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
  resetPlugins();
});

const results: TargetResult[] = [
  {
    account: { id: "htmlblog:x", network: "htmlblog", handle: "x", addedAt: "", creds: {}, meta: {} },
    ok: true,
    posts: [{ id: "043-post.html", url: "https://x.y/blog/043-post.html" }],
  },
  {
    account: { id: "bluesky:me", network: "bluesky", handle: "me", addedAt: "", creds: {}, meta: {} },
    ok: false,
    posts: [],
    error: "nope",
  },
];

test("the event carries each target's category and where it landed", () => {
  const event = postedEvent(results, { text: "Hi", title: "Hi", extra: { ad: "true" } });
  expect(event.targets[0]).toMatchObject({ category: "blog", ok: true, url: "https://x.y/blog/043-post.html" });
  expect(event.targets[1]).toMatchObject({ category: "major", ok: false, error: "nope" });
  expect(event.extra).toEqual({ ad: "true" });
});

test("every plugin's hook runs, in order, and a throwing one is reported not fatal", async () => {
  const seen: string[] = [];
  registerPlugin({ id: "first", name: "First", async afterPost(event: PostedEvent) { seen.push(`first:${event.targets.length}`); return "did a thing"; } });
  registerPlugin({ id: "broken", name: "Broken", async afterPost() { throw new Error("boom"); } });
  registerPlugin({ id: "quiet", name: "Quiet", async afterPost() { seen.push("quiet"); } });
  registerPlugin({ id: "nohook", name: "No hook" });

  const outcomes = await runAfterPost(postedEvent(results, { text: "Hi" }));
  expect(seen).toEqual(["first:2", "quiet"]);
  expect(outcomes).toEqual([
    { plugin: "first", line: "did a thing" },
    { plugin: "broken", error: "boom" },
    { plugin: "quiet", line: undefined },
  ]);
});

test("scheduling and cancelling reach plugins too, with the queue entry", async () => {
  const seen: string[] = [];
  registerPlugin({
    id: "cal",
    name: "Calendar",
    async afterSchedule(event: ScheduledEvent) {
      seen.push(`scheduled ${event.id} for ${event.scheduledFor} to ${event.targets.join(",")}`);
      return "on the calendar";
    },
    async afterCancel(event: CancelledEvent) {
      seen.push(`cancelled ${event.id}`);
    },
  });
  registerPlugin({ id: "broken", name: "Broken", async afterSchedule() { throw new Error("no"); } });

  const post: QueuedPost = {
    id: "abcd1234",
    createdAt: "2026-09-05T00:00:00Z",
    scheduledFor: "2027-04-01T16:00:00.000Z",
    targets: ["bluesky:me", "x:@me"],
    text: "April 1: …",
    status: "pending",
  };
  expect(await runAfterSchedule(post)).toEqual([
    { plugin: "cal", line: "on the calendar" },
    { plugin: "broken", error: "no" },
  ]);
  expect(await runAfterCancel("abcd1234")).toEqual([{ plugin: "cal", line: undefined }]);
  expect(seen).toEqual(["scheduled abcd1234 for 2027-04-01T16:00:00.000Z to bluesky:me,x:@me", "cancelled abcd1234"]);
});
