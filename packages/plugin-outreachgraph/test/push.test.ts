/**
 * The hand-over half of the plugin: which profiles become OutreachGraph
 * people, how a request is paged, and when `afterFollow` speaks up at all.
 */
import { test, expect } from "bun:test";
import type { PluginContext } from "@profullstack/myna-core";
import plugin, { chunks, personFrom, PUSH_CHUNK } from "../src/index.ts";

test("a profile becomes a person on the network OutreachGraph calls it, ids only when they are stable", () => {
  expect(personFrom({ handle: "@ada.example", id: "did:plc:ada", displayName: "Ada", bio: "Engines.", url: "https://bsky.app/profile/ada.example", followers: 12 }, "bluesky", "followers:bluesky|x")).toEqual({
    network: "bluesky",
    handle: "ada.example",
    profileUrl: "https://bsky.app/profile/ada.example",
    platformUserId: "did:plc:ada",
    displayName: "Ada",
    bio: "Engines.",
    followers: 12,
    via: "followers:bluesky|x",
  });
  // A Mastodon adapter's id is the profile URL, which is not a platform id.
  expect(personFrom({ handle: "ada@hachyderm.io", id: "https://hachyderm.io/@ada", url: "https://hachyderm.io/@ada" }, "mastodon")).toEqual({
    network: "mastodon",
    handle: "ada@hachyderm.io",
    profileUrl: "https://hachyderm.io/@ada",
  });
  // The Fediverse is one network to OutreachGraph.
  expect(personFrom({ handle: "ada@misskey.io" }, "misskey")?.network).toBe("mastodon");
  expect(personFrom({ handle: "npub1abc", id: "npub1abc" }, "nostr")).toMatchObject({ network: "nostr", platformUserId: "npub1abc" });
  // Networks OutreachGraph has no name for are not sent.
  expect(personFrom({ handle: "acme" }, "agenticjobs")).toBeUndefined();
  expect(personFrom({ handle: "  " }, "bluesky")).toBeUndefined();
});

test("a long list is paged to what one request accepts", () => {
  const items = Array.from({ length: PUSH_CHUNK * 2 + 1 }, (_, index) => index);
  const pages = chunks(items);
  expect(pages.map((page) => page.length)).toEqual([PUSH_CHUNK, PUSH_CHUNK, 1]);
  expect(chunks([])).toEqual([]);
});

function context(overrides: { flags?: Record<string, unknown>; outreachgraph?: boolean; secrets?: Record<string, string> }): PluginContext {
  return {
    out() {},
    log() {},
    accounts: () => [],
    settings: () => ({ graph: { outreachgraph: overrides.outreachgraph ?? false } }) as unknown as ReturnType<PluginContext["settings"]>,
    secrets: { get: () => overrides.secrets ?? {}, set() {}, clear() {} },
    graph: { addSeeds: () => ({ added: 0, updated: 0 }), following: async () => [], followers: async () => [] },
    configDir: "/tmp",
    flags: overrides.flags ?? {},
  };
}

const event = { account: { id: "bluesky:me", network: "bluesky", handle: "me", addedAt: "", creds: {}, meta: {} }, network: "bluesky", handle: "ada.example", source: "manual" as const };

test("afterFollow stays quiet unless asked, and says so when asked but not signed in", async () => {
  expect(await plugin.afterFollow!(event, context({}))).toBeUndefined();
  expect(await plugin.afterFollow!(event, context({ flags: { outreachgraph: true } }))).toBe("not signed in to OutreachGraph; run: myna outreachgraph login");
  expect(await plugin.afterFollow!(event, context({ outreachgraph: true }))).toBe("not signed in to OutreachGraph; run: myna outreachgraph login");
  expect(await plugin.afterFollow!({ ...event, network: "agenticjobs" }, context({ flags: { outreachgraph: true }, secrets: { email: "a@b.c", password: "p" } }))).toBe(
    "agenticjobs is not a network OutreachGraph knows; ada.example not handed over",
  );
});

test("the plugin declares the hand-over surface", () => {
  expect(plugin.commands?.[0]?.usage?.some((line) => line.startsWith("outreachgraph push"))).toBe(true);
  expect(typeof plugin.afterFollow).toBe("function");
});
