/**
 * The pure half of the plugin: which OutreachGraph identities become seeds,
 * how the opportunity score becomes a weight, and reading the session cookie.
 */
import { test, expect } from "bun:test";
import plugin, { cookieFrom, seedsFor } from "../src/index.ts";

const person = { id: "person_1", display_name: "Alice Example", opportunity: 80 };

test("only networks myna can follow on, above the confidence floor, become seeds", () => {
  const seeds = seedsFor(person, [
    { network: "bluesky", handle: "alice.bsky.social", platform_user_id: "did:plc:1", confidence: 0.95 },
    { network: "x", handle: "alice", confidence: 0.9 },
    { network: "x", handle: "alice_low", confidence: 0.3 },
    { network: "linkedin", handle: "alice", confidence: 1 },
    { network: "github", handle: "alice", confidence: 1 },
    { network: "nostr", handle: "", profile_url: "https://njump.me/npub1abc", confidence: 0.9 },
  ]);
  expect(seeds.map((seed) => `${seed.network}:${seed.handle}`)).toEqual([
    "bluesky:alice.bsky.social",
    "x:alice",
    "nostr:https://njump.me/npub1abc",
  ]);
  expect(seeds[0]).toMatchObject({ id: "did:plc:1", displayName: "Alice Example", source: "outreachgraph", weight: 1.8 });
});

test("a Fediverse handle without a host is replaced by the profile URL", () => {
  const seeds = seedsFor(person, [
    { network: "mastodon", handle: "alice", profile_url: "https://hachyderm.io/@alice", confidence: 0.9 },
    { network: "mastodon", handle: "bob@mastodon.social", profile_url: "https://mastodon.social/@bob", confidence: 0.9 },
  ]);
  expect(seeds.map((seed) => seed.handle)).toEqual(["https://hachyderm.io/@alice", "bob@mastodon.social"]);
});

test("the weight runs from 1 for an unscored person to 2 for a perfect score", () => {
  const identity = { network: "x", handle: "a", confidence: 1 };
  expect(seedsFor({ ...person, opportunity: null }, [identity])[0].weight).toBe(1);
  expect(seedsFor({ ...person, opportunity: 100 }, [identity])[0].weight).toBe(2);
  expect(seedsFor({ ...person, opportunity: 250 }, [identity])[0].weight).toBe(2);
});

test("the session cookie is read out of Set-Cookie however it is packed", () => {
  expect(cookieFrom("og_session=abc123; Path=/; HttpOnly; SameSite=Lax")).toBe("abc123");
  expect(cookieFrom("other=1; Path=/, og_session=xyz; Secure")).toBe("xyz");
  expect(cookieFrom("other=1")).toBeUndefined();
  expect(cookieFrom(null)).toBeUndefined();
});

test("the plugin declares what the loader expects", () => {
  expect(plugin.id).toBe("outreachgraph");
  expect(plugin.commands?.map((command) => command.name)).toEqual(["outreachgraph"]);
  expect(plugin.seeds).toHaveLength(1);
});
