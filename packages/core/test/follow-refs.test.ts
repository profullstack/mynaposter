/**
 * Who a person means when they name someone to follow: a handle as typed, a
 * profile URL as copied, or the network's own id. Each adapter takes all three.
 */
import { test, expect } from "bun:test";
import { blueskyActor } from "../src/net/adapters/bluesky.ts";
import { fediverseRef } from "../src/net/adapters/mastodon.ts";
import { xUsername } from "../src/net/adapters/x.ts";
import { nostrPubkey, nostrInternals } from "../src/net/adapters/nostr.ts";
import { bech32Encode } from "../src/util/crypto/bech32.ts";
import { hexToBytes } from "../src/util/crypto/schnorr.ts";
import { NETWORKS } from "../src/net/registry.ts";

test("a Bluesky actor from a handle, a DID or a profile link", () => {
  expect(blueskyActor("alice.bsky.social")).toBe("alice.bsky.social");
  expect(blueskyActor("@alice.bsky.social")).toBe("alice.bsky.social");
  expect(blueskyActor("did:plc:abc123")).toBe("did:plc:abc123");
  expect(blueskyActor("https://bsky.app/profile/alice.bsky.social")).toBe("alice.bsky.social");
  expect(blueskyActor("https://bsky.app/profile/did:plc:abc123/")).toBe("did:plc:abc123");
});

test("a Fediverse account from every way people write one", () => {
  const home = "https://mastodon.social";
  expect(fediverseRef("alice", home)).toEqual({ user: "alice", host: "mastodon.social" });
  expect(fediverseRef("@alice", home)).toEqual({ user: "alice", host: "mastodon.social" });
  expect(fediverseRef("alice@hachyderm.io", home)).toEqual({ user: "alice", host: "hachyderm.io" });
  expect(fediverseRef("@alice@Hachyderm.io", home)).toEqual({ user: "alice", host: "hachyderm.io" });
  expect(fediverseRef("https://hachyderm.io/@alice", home)).toEqual({ user: "alice", host: "hachyderm.io" });
  expect(fediverseRef("https://hachyderm.io/users/alice/followers", home)).toEqual({ user: "alice", host: "hachyderm.io" });
  expect(() => fediverseRef("@", home)).toThrow(/Not a Fediverse account/);
});

test("an X username from a handle or a profile link, and nothing that is not one", () => {
  expect(xUsername("@chovy")).toBe("chovy");
  expect(xUsername("chovy")).toBe("chovy");
  expect(xUsername("https://x.com/chovy")).toBe("chovy");
  expect(xUsername("https://twitter.com/chovy?s=21")).toBe("chovy");
  expect(xUsername("https://x.com/chovy/status/123")).toBe("chovy");
  expect(() => xUsername("this is not a handle")).toThrow(/Not an X account/);
  expect(() => xUsername("https://x.com/i/status/123")).toThrow(/Not an X account/);
});

test("a Nostr pubkey from hex, an npub, or a link carrying one", () => {
  const hex = "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d";
  const npub = bech32Encode("npub", hexToBytes(hex));
  expect(nostrPubkey(hex)).toBe(hex);
  expect(nostrPubkey(hex.toUpperCase())).toBe(hex);
  expect(nostrPubkey(npub)).toBe(hex);
  expect(nostrPubkey(`nostr:${npub}`)).toBe(hex);
  expect(nostrPubkey(`https://njump.me/${npub}`)).toBe(hex);
  expect(() => nostrPubkey("alice")).toThrow(/Not a Nostr pubkey/);
});

test("a contact list's p tags become profiles, once each, with the petname kept", () => {
  const a = "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d";
  const b = "82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2";
  const profiles = nostrInternals.contactsOf({
    id: "",
    pubkey: "",
    created_at: 0,
    kind: 3,
    sig: "",
    content: "",
    tags: [
      ["p", a, "wss://relay", "fiatjaf"],
      ["e", "not-a-person"],
      ["p", b],
      ["p", a],
      ["p", "short"],
    ],
  });
  expect(profiles.map((profile) => profile.id)).toEqual([a, b]);
  expect(profiles[0].displayName).toBe("fiatjaf");
  expect(profiles[0].handle.startsWith("npub1")).toBe(true);
});

test("every network that claims follow implements both halves", () => {
  const claimed = NETWORKS.filter((network) => network.caps.follow).map((network) => network.id);
  expect(claimed.sort()).toEqual(["bluesky", "mastodon", "misskey", "nostr", "pixelfed", "x"]);
  for (const network of NETWORKS) {
    if (network.caps.follow) {
      expect(network.follow, `${network.id} claims follow`).toBeDefined();
      expect(network.following, `${network.id} claims follow`).toBeDefined();
    } else {
      expect(network.follow, `${network.id} follows without saying so`).toBeUndefined();
    }
  }
});
