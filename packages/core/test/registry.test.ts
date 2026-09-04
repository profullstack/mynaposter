import { test, expect } from "bun:test";
import { NETWORKS, getNetwork, requireNetwork } from "../src/net/registry.ts";
import { tailor } from "../src/core/poster.ts";

test("every network id is unique", () => {
  const ids = NETWORKS.map((network) => network.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test("every network can be logged into and posted to", () => {
  for (const network of NETWORKS) {
    expect(network.auth.fields.length, `${network.id} asks for nothing`).toBeGreaterThan(0);
    expect(typeof network.login).toBe("function");
    expect(typeof network.post).toBe("function");
    expect(network.blurb.length, `${network.id} has no blurb`).toBeGreaterThan(0);
  }
});

test("a network that declares a capability implements it", () => {
  for (const network of NETWORKS) {
    if (network.caps.delete) expect(network.remove, `${network.id} claims delete`).toBeDefined();
    if (network.caps.timeline) expect(network.timeline, `${network.id} claims timeline`).toBeDefined();
    if (network.caps.notifications) expect(network.notifications, `${network.id} claims notifications`).toBeDefined();
    if (network.caps.stats) expect(network.stats, `${network.id} claims stats`).toBeDefined();
    if (network.caps.repost) expect(network.repost, `${network.id} claims repost`).toBeDefined();
  }
});

test("secret fields are marked so the UI masks them", () => {
  for (const network of NETWORKS) {
    for (const field of network.auth.fields) {
      // Client and consumer "keys" are public app identifiers, not secrets;
      // the paired "secret" is the thing that must be masked.
      if (/^(client|consumer)(Id|Key)$/.test(field.key)) continue;
      if (/password|secret|token|key|nsec/i.test(field.key)) {
        expect(field.secret, `${network.id}.${field.key} is not masked`).toBe(true);
      }
    }
  }
});

test("common aliases resolve", () => {
  expect(getNetwork("twitter")?.id).toBe("x");
  expect(getNetwork("bsky")?.id).toBe("bluesky");
  expect(getNetwork("fb")?.id).toBe("facebook");
  expect(getNetwork("masto")?.id).toBe("mastodon");
  expect(getNetwork("nope")).toBeUndefined();
  expect(() => requireNetwork("nope")).toThrow(/Unknown network/);
});

test("the seven networks asked for are all present", () => {
  for (const id of ["x", "reddit", "facebook", "instagram", "threads", "bluesky", "nostr"]) {
    expect(getNetwork(id), `${id} is missing`).toBeDefined();
  }
});

test("tailoring never exceeds a network's limit", () => {
  const long = "This is a sentence that repeats itself. ".repeat(30);
  for (const network of NETWORKS) {
    if (!network.caps.charLimit) continue;
    for (const part of tailor(network.id, { text: long, thread: true })) {
      expect(part.length, `${network.id} produced an over-limit part`).toBeLessThanOrEqual(network.caps.charLimit);
    }
  }
});

test("threading is used where supported and truncation where it is not", () => {
  const long = "word ".repeat(200).trim();
  expect(tailor("bluesky", { text: long, thread: true }).length).toBeGreaterThan(1);
  // Pinterest has no reply chain, so it truncates instead.
  expect(tailor("pinterest", { text: long, thread: true })).toHaveLength(1);
});

test("hashtags go only where they belong", () => {
  const options = { text: "a short post", hashtags: ["#terminal"], thread: false };
  expect(tailor("mastodon", options)[0]).toContain("#terminal");
  // A Ghost blog post with a hashtag glued on the end would just look wrong.
  expect(tailor("ghost", options)[0]).not.toContain("#terminal");
});
