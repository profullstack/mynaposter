/**
 * Matching a request to a sharer: refusals first, then fit.
 *
 * The same function runs on the server and in the CLI, so a sharer sees the
 * same answer either way.
 */
import { test, expect } from "bun:test";
import { hashtagsIn, rankSharers, requestFromPosted, scoreMatch, sharerFromProfile } from "../src/core/reshare.ts";
import { parseOpenProfile } from "../src/core/openprofile.ts";
import { DEFAULT_SETTINGS } from "../src/store/settings.ts";
import type { PostedEvent } from "../src/plugins/types.ts";

const request = { topics: ["rust", "devtools"], networks: ["bluesky", "mastodon"], bountyUsd: 0 };

test("a refused topic wins over every match", () => {
  expect(scoreMatch(request, { topics: ["rust"], not: ["dev-tools"], networks: [], rateUsd: 0 })).toBeNull();
});

test("no reachable network, no match; willing and present both narrow", () => {
  expect(scoreMatch(request, { topics: ["rust"], not: [], networks: ["x"], rateUsd: 0 })).toBeNull();
  expect(scoreMatch(request, { topics: ["rust"], not: [], networks: [], accounts: ["x", "nostr"], rateUsd: 0 })).toBeNull();
  expect(scoreMatch(request, { topics: ["rust"], not: [], networks: ["bluesky", "x"], accounts: ["bluesky", "mastodon"], rateUsd: 0 })?.networks).toEqual(["bluesky"]);
});

test("a link can be quoted anywhere the sharer is willing and present", () => {
  const withLink = { ...request, networks: [], link: "https://blog.example/post" };
  expect(scoreMatch(withLink, { topics: ["rust"], not: [], networks: [], accounts: ["x", "nostr"], rateUsd: 0 })?.networks).toEqual(["x", "nostr"]);
  expect(scoreMatch(withLink, { topics: ["rust"], not: [], networks: [], rateUsd: 0 })).toBeNull();
});

test("a rate the author is not offering is a refusal", () => {
  expect(scoreMatch(request, { topics: ["rust"], not: [], networks: [], rateUsd: 0.05 })).toBeNull();
  expect(scoreMatch({ ...request, bountyUsd: 0.05 }, { topics: ["rust"], not: [], networks: [], rateUsd: 0.05 })).not.toBeNull();
});

test("fit is the share of the request's topics the sharer covers", () => {
  const half = scoreMatch(request, { topics: ["rust"], not: [], networks: [], rateUsd: 0 });
  const all = scoreMatch(request, { topics: ["Rustlang", "Developer-Tools", "devtools"], not: [], networks: [], rateUsd: 0 });
  const none = scoreMatch(request, { topics: ["cooking"], not: [], networks: [], rateUsd: 0 });
  expect(half?.score).toBeCloseTo(0.65);
  expect(all?.score).toBe(1);
  expect(none).toBeNull();
});

test("a sharer with no topics takes anything, below anyone with a stated interest", () => {
  const ranked = rankSharers(request, [
    { id: "open", sharer: { topics: [], not: [], networks: [], rateUsd: 0 } },
    { id: "rusty", sharer: { topics: ["rust"], not: [], networks: [], rateUsd: 0 } },
  ]);
  expect(ranked.map((entry) => entry.id)).toEqual(["rusty", "open"]);
});

test("a request with no topics still reaches sharers, at a low score", () => {
  expect(scoreMatch({ ...request, topics: [] }, { topics: ["rust"], not: [], networks: [], rateUsd: 0 })?.score).toBe(0.2);
});

test("sharerFromProfile prefers the Reshare section's topics over the profile's", () => {
  const profile = parseOpenProfile(`# Ada

## Accounts

- [Bluesky](https://bsky.app/profile/ada)

## Topics

- computing, poetry

## Reshare

- **Topics**: computing
- **Not**: crypto
- **Rate**: $0.02/reshare
`);
  expect(sharerFromProfile(profile)).toEqual({ topics: ["computing"], not: ["crypto"], networks: [], accounts: ["bluesky"], rateUsd: 0.02 });
  const fallback = parseOpenProfile("# Ada\n\n## Topics\n\n- poetry\n\n## Reshare\n\n- **Rate**: free\n");
  expect(sharerFromProfile(fallback).topics).toEqual(["poetry"]);
});

test("hashtags become topics; a blog target becomes the link, a social target a post", () => {
  expect(hashtagsIn("Shipped #Rust tooling for #dev-tools, not a#b")).toEqual(["Rust", "dev-tools"]);
  const settings = { ...DEFAULT_SETTINGS, profile: { ...DEFAULT_SETTINGS.profile, topics: "rust" }, reshare: { ...DEFAULT_SETTINGS.reshare, bountyUsd: 0.05 } };
  const event: PostedEvent = {
    text: "New release #devtools",
    title: "myna 1.0",
    targets: [
      { account: { id: "bluesky:me", network: "bluesky", handle: "me", addedAt: "", creds: {}, meta: {} }, category: "major", ok: true, url: "https://bsky.app/p/1", id: "1" },
      { account: { id: "htmlblog:x", network: "htmlblog", handle: "x", addedAt: "", creds: {}, meta: {} }, category: "blog", ok: true, url: "https://x.y/blog/1.html" },
      { account: { id: "x:me", network: "x", handle: "me", addedAt: "", creds: {}, meta: {} }, category: "major", ok: false, error: "nope" },
    ],
  };
  expect(requestFromPosted(event, settings)).toEqual({
    title: "myna 1.0",
    text: "New release #devtools",
    topics: ["rust", "devtools"],
    posts: [{ network: "bluesky", url: "https://bsky.app/p/1", id: "1" }],
    link: "https://x.y/blog/1.html",
    bountyUsd: 0.05,
    maxSharers: 10,
  });
  expect(requestFromPosted({ text: "x", targets: [event.targets[2]!] }, settings)).toBeNull();
});
