/**
 * `myna repost <account> <post>` takes whatever a person has to hand: the URL
 * as copied from the network, or the native id. Each adapter turns that into
 * what its API wants. These are the pure halves of that translation.
 */
import { test, expect } from "bun:test";
import { xPostId } from "../src/net/adapters/x.ts";
import { mastodonStatusRef } from "../src/net/adapters/mastodon.ts";
import { blueskyPostRef } from "../src/net/adapters/bluesky.ts";

test("X: a bare id or any status URL", () => {
  expect(xPostId("2095788210764878192")).toBe("2095788210764878192");
  expect(xPostId("https://x.com/ProfullstackInc/status/2095788210764878192")).toBe("2095788210764878192");
  expect(xPostId("https://twitter.com/ProfullstackInc/status/2095788210764878192?s=20")).toBe("2095788210764878192");
  expect(xPostId("https://x.com/i/status/2095788210764878192")).toBe("2095788210764878192");
  expect(xPostId(" https://mobile.twitter.com/a/statuses/1 ")).toBe("1");
  expect(() => xPostId("https://x.com/ProfullstackInc")).toThrow(/Not an X post/);
  expect(() => xPostId("https://bsky.app/profile/a/post/b")).toThrow(/Not an X post/);
});

test("Mastodon: local posts by id, remote posts by URL for the instance to resolve", () => {
  const home = "https://defcon.social";
  expect(mastodonStatusRef("117211664213079760", home)).toEqual({ id: "117211664213079760" });
  expect(mastodonStatusRef("https://defcon.social/@chovy/117211664213079760", home)).toEqual({ id: "117211664213079760" });
  expect(mastodonStatusRef("https://defcon.social/users/chovy/statuses/117211664213079760/", home)).toEqual({ id: "117211664213079760" });
  // Another instance's id means nothing here; the instance must fetch the post.
  expect(mastodonStatusRef("https://mastodon.social/@someone/112000000000000000", home)).toEqual({
    url: "https://mastodon.social/@someone/112000000000000000",
  });
  expect(() => mastodonStatusRef("not a url", home)).toThrow(/Not a Fediverse post/);
});

test("Bluesky: the app URL, an at:// uri, or the uri|cid composite post() returns", () => {
  expect(blueskyPostRef("https://bsky.app/profile/chovyfu.bsky.social/post/3muoj7uwceo2h")).toEqual({
    uri: "",
    actor: "chovyfu.bsky.social",
    rkey: "3muoj7uwceo2h",
  });
  expect(blueskyPostRef("https://bsky.app/profile/did:plc:abc/post/3k?ref=x")).toEqual({
    uri: "at://did:plc:abc/app.bsky.feed.post/3k",
    actor: "did:plc:abc",
    rkey: "3k",
  });
  expect(blueskyPostRef("at://did:plc:abc/app.bsky.feed.post/3k|bafycid")).toEqual({
    uri: "at://did:plc:abc/app.bsky.feed.post/3k",
    cid: "bafycid",
    actor: "did:plc:abc",
    rkey: "3k",
  });
  expect(blueskyPostRef("at://did:plc:abc/app.bsky.feed.post/3k")).toEqual({
    uri: "at://did:plc:abc/app.bsky.feed.post/3k",
    cid: undefined,
    actor: "did:plc:abc",
    rkey: "3k",
  });
  expect(() => blueskyPostRef("at://did:plc:abc/app.bsky.feed.like/3k")).toThrow(/Not a Bluesky post/);
  expect(() => blueskyPostRef("https://bsky.app/profile/chovyfu.bsky.social")).toThrow(/Not a Bluesky post/);
});
