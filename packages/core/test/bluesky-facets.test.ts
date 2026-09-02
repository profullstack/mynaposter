/**
 * Facets, ported from crawlproof.com along with the edge cases it had already
 * found. myna's first version emitted links then tags unsorted, did no overlap
 * check and validated no tags — all three of which the API rejects or renders
 * wrong.
 */
import { test, expect } from "bun:test";
import { buildFacets, buildPostRecord, graphemeLength, truncateForBluesky, MAX_GRAPHEMES } from "../src/net/adapters/bluesky-facets.ts";

const link = (text: string) => buildFacets(text).filter((f) => f.features[0].$type.endsWith("#link"));
const tags = (text: string) => buildFacets(text).filter((f) => f.features[0].$type.endsWith("#tag"));

test("a URL becomes a link facet", () => {
  const [facet] = link("see https://example.com now");
  expect(facet.index).toEqual({ byteStart: 4, byteEnd: 23 });
  expect(facet.features[0]).toMatchObject({ uri: "https://example.com" });
});

test("offsets are UTF-8 bytes, not UTF-16 units", () => {
  // The emoji is 4 bytes but 2 JS units. Getting this wrong highlights the
  // wrong span, which is the whole reason facets are hard.
  const text = "🚀 https://example.com";
  const [facet] = link(text);
  expect(facet.index.byteStart).toBe(Buffer.byteLength("🚀 ", "utf8"));
  expect(text.indexOf("https")).not.toBe(facet.index.byteStart);
});

test("a full stop after a URL is not part of it", () => {
  expect(link("read https://example.com/a.")[0].features[0]).toMatchObject({ uri: "https://example.com/a" });
});

test("a URL that really ends in a bracket keeps it", () => {
  const [facet] = link("https://en.wikipedia.org/wiki/Foo_(bar)");
  expect(facet.features[0]).toMatchObject({ uri: "https://en.wikipedia.org/wiki/Foo_(bar)" });
});

test("a hashtag becomes a tag facet, without the hash", () => {
  expect(tags("about #terminal things")[0].features[0]).toMatchObject({ tag: "terminal" });
});

test("a fragment inside a URL is not a hashtag", () => {
  // The lookbehind exists for this. Without it the tag facet overlaps the link
  // facet and the API rejects the pair.
  expect(tags("https://example.com/docs#install")).toHaveLength(0);
  expect(link("https://example.com/docs#install")).toHaveLength(1);
});

test("facets come back sorted by start offset", () => {
  // myna previously emitted every link, then every tag, so a post with a tag
  // before a link arrived out of order.
  const facets = buildFacets("#first then https://example.com then #second");
  const starts = facets.map((facet) => facet.index.byteStart);
  expect(starts).toEqual([...starts].sort((a, b) => a - b));
  expect(facets).toHaveLength(3);
});

test("facets never overlap", () => {
  const facets = buildFacets("#tag https://example.com/x#y #other");
  for (let i = 1; i < facets.length; i++) {
    expect(facets[i].index.byteStart).toBeGreaterThanOrEqual(facets[i - 1].index.byteEnd);
  }
});

test("junk tags are dropped", () => {
  expect(tags("ranked #1 today")).toHaveLength(0);
  expect(tags(`#${"a".repeat(65)}`)).toHaveLength(0);
  expect(tags(`#${"a".repeat(64)}`)).toHaveLength(1);
});

test("graphemes are counted the way Bluesky counts them", () => {
  expect("🚀".length).toBe(2);
  expect(graphemeLength("🚀")).toBe(1);
  expect(graphemeLength("👨‍👩‍👧‍👦")).toBe(1);
});

test("truncation cuts on grapheme boundaries, never mid-emoji", () => {
  const text = "🚀".repeat(400);
  const cut = truncateForBluesky(text);
  expect(graphemeLength(cut)).toBe(MAX_GRAPHEMES);
  // A lone surrogate would be invalid UTF-8; a round trip proves there is none.
  expect(Buffer.from(cut, "utf8").toString("utf8")).toBe(cut);
});

test("a short post is left exactly as written", () => {
  expect(truncateForBluesky("hello")).toBe("hello");
});

test("the record omits facets entirely when there are none", () => {
  const record = buildPostRecord("just words", "2026-09-02T12:00:00.000Z");
  expect(record.facets).toBeUndefined();
  expect(record.text).toBe("just words");
  expect(record.$type).toBe("app.bsky.feed.post");
});

test("the record carries facets when there are some", () => {
  const record = buildPostRecord("see https://example.com #myna", "2026-09-02T12:00:00.000Z");
  expect((record.facets as unknown[]).length).toBe(2);
});
