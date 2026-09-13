/**
 * The promotion writer's pure parts: an app's network names resolve to
 * myna's, the model's answer parses whether it is JSON or prose, and the
 * brief block says only what it was given.
 */
import { test, expect } from "bun:test";
import { resolveNetwork, parseVariations, briefBlock, NETWORK_ALIASES } from "../src/ai/promote.ts";

test("an app's name for a network resolves to myna's, with its limit; an unknown one is null", () => {
  expect(resolveNetwork("twitter")).toMatchObject({ id: "x", charLimit: 280 });
  expect(resolveNetwork("X")).toMatchObject({ id: "x" });
  expect(resolveNetwork("primal")?.id).toBe("nostr");
  expect(resolveNetwork("reddit")).toMatchObject({ id: "reddit", needsTitle: true });
  expect(resolveNetwork("stacker")?.id).toBe(NETWORK_ALIASES.stacker);
  expect(resolveNetwork("myspace")).toBeNull();
  expect(resolveNetwork(undefined)).toBeNull();
  expect(resolveNetwork("")).toBeNull();
});

test("JSON with a title and variations parses, capped at count", () => {
  const raw = `Here you go:\n\`\`\`json\n{"title": "A title", "variations": ["one is long enough", "two is long enough", "three is long enough"]}\n\`\`\``;
  expect(parseVariations(raw, 2)).toEqual({ title: "A title", variations: ["one is long enough", "two is long enough"] });
  expect(parseVariations('["a bare array entry", {"text": "an object entry"}]', 5)).toEqual({ title: null, variations: ["a bare array entry", "an object entry"] });
});

test("prose falls back to paragraphs, a TITLE: line is lifted out, and something always comes back", () => {
  const raw = "TITLE: The headline\n\nFirst variation, long enough to keep.\n\nSecond variation, also long enough.\n\nx";
  expect(parseVariations(raw, 5)).toEqual({ title: "The headline", variations: ["First variation, long enough to keep.", "Second variation, also long enough."] });
  expect(parseVariations("1. Numbered one is long enough\n2. Numbered two is long enough", 5).variations).toHaveLength(2);
  expect(parseVariations("short", 3)).toEqual({ title: null, variations: ["short"] });
});

test("the brief block names only what it was given", () => {
  expect(briefBlock({ name: "myna", description: "posts from the terminal" })).toBe("Product: myna\nDescription: posts from the terminal");
  expect(briefBlock({ name: "myna", description: "d", audience: "devs", features: ["a", "b"], tone: "casual", url: "https://mynaposter.com" })).toBe(
    "Product: myna\nDescription: d\nAudience: devs\nFeatures: a; b\nTone: casual\nLink: https://mynaposter.com",
  );
});
