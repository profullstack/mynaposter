import { test, expect } from "bun:test";
import { tsbb, forumsOf, nextForum } from "../src/net/adapters/tsbb.ts";
import { getNetwork, authSummary } from "../src/net/registry.ts";
import { tailor } from "../src/core/poster.ts";

test("registered, and reachable by the names people type", () => {
  expect(getNetwork("tsbb")?.id).toBe("tsbb");
  expect(getNetwork("board")?.id).toBe("tsbb");
  expect(getNetwork("forum")?.id).toBe("tsbb");
});

test("a device flow is described as approving a code, not signing in", () => {
  expect(tsbb.auth.kind).toBe("device");
  expect(authSummary(tsbb)).toBe("approve a code");
});

test("asks for a board URL, because it works against any instance", () => {
  const keys = tsbb.auth.fields.map((field) => field.key);
  expect(keys).toContain("instance");
  // Nothing secret is typed in: the token comes back from the approval.
  expect(tsbb.auth.fields.some((field) => field.secret)).toBe(false);
});

test("needs a title, and never truncates a forum post", () => {
  expect(tsbb.caps.needsTitle).toBe(true);
  expect(tsbb.caps.charLimit).toBe(0);

  const long = "word ".repeat(500).trim();
  const parts = tailor("tsbb", { text: long, thread: true });
  expect(parts).toHaveLength(1);
  expect(parts[0]).toBe(long);
});

test("claims only what the API offers", () => {
  // There is no delete endpoint; removing a post is a browser-session thing.
  expect(tsbb.caps.delete).toBe(false);
  expect(tsbb.remove).toBeUndefined();
  expect(tsbb.timeline).toBeDefined();
  expect(tsbb.notifications).toBeDefined();
});

test("a board is a set of forums, and login takes several", () => {
  const field = tsbb.auth.fields.find((entry) => entry.key === "forum");
  expect(field?.optional).toBe(true);
  expect(field?.help).toMatch(/comma/i);
});

test("forums are read off the account, however they were written", () => {
  const account = (forum: string) => ({ meta: { forum } }) as never;
  expect(forumsOf(account("app-showcase"))).toEqual(["app-showcase"]);
  expect(forumsOf(account("app-showcase, announcements ,news"))).toEqual([
    "app-showcase",
    "announcements",
    "news",
  ]);
  // A slug pasted out of the address bar is still a slug.
  expect(forumsOf(account("/f/app-showcase"))).toEqual(["app-showcase"]);
  expect(forumsOf(account(""))).toEqual([]);
});

test("posts cycle through the chosen forums, one per post", () => {
  const forums = ["app-showcase", "announcements", "news"];
  const seen: string[] = [];
  let cursor = 0;
  for (let i = 0; i < 4; i++) {
    const turn = nextForum(forums, cursor);
    seen.push(turn.forum);
    cursor = turn.next;
  }
  expect(seen).toEqual(["app-showcase", "announcements", "news", "app-showcase"]);
});

test("a cursor left behind by a shorter list does not post into nothing", () => {
  // Two forums were dropped after the cursor had already reached the third.
  expect(nextForum(["app-showcase"], 2)).toEqual({ forum: "app-showcase", next: 0 });
  expect(nextForum([], 7)).toEqual({ forum: "", next: 0 });
  expect(nextForum(["a", "b"], Number.NaN)).toEqual({ forum: "a", next: 1 });
});

test("posting without a forum says which flag to pass", async () => {
  const account = {
    id: "tsbb:someone@example.com",
    network: "tsbb",
    handle: "someone@example.com",
    addedAt: new Date().toISOString(),
    creds: { token: "tsbb_x" },
    meta: { instance: "https://example.com", forum: "" },
  };
  await expect(tsbb.post(account as never, { text: "hello", title: "Hello" })).rejects.toThrow(/--forum/);
});
