import { test, expect } from "bun:test";
import { countChars, splitThread, appendHashtags, toHashtag, extractHashtags, truncateTo } from "../src/util/text.ts";

test("counts graphemes, not code units", () => {
  expect(countChars("hello")).toBe(5);
  // A family emoji is one grapheme but many code units.
  expect(countChars("👨‍👩‍👧‍👦")).toBe(1);
  expect("👨‍👩‍👧‍👦".length).toBeGreaterThan(1);
});

test("bills a URL at the weight the network uses", () => {
  const text = "see https://example.com/a/very/long/path/that/keeps/going/and/going";
  expect(countChars(text)).toBe(text.length);
  // X counts any URL as 23 characters.
  expect(countChars(text, { urlWeight: 23 })).toBe("see ".length + 23);
});

test("short text is left alone", () => {
  expect(splitThread("hello", 300)).toEqual(["hello"]);
});

test("splits on paragraph boundaries and numbers the parts", () => {
  const text = `${"a".repeat(200)}\n\n${"b".repeat(200)}`;
  const parts = splitThread(text, 280);
  expect(parts.length).toBe(2);
  expect(parts[0]).toContain("(1/2)");
  expect(parts[1]).toContain("(2/2)");
});

test("every part fits the limit, numbering included", () => {
  const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} with some padding to make it long.`).join(" ");
  for (const part of splitThread(text, 280)) {
    expect(countChars(part)).toBeLessThanOrEqual(280);
  }
});

test("never splits a word in half", () => {
  const parts = splitThread("supercalifragilistic ".repeat(40).trim(), 100);
  for (const part of parts) {
    expect(part.replace(/ \(\d+\/\d+\)$/, "")).not.toMatch(/supercalifragilisti$/);
  }
});

test("adds hashtags only while they fit", () => {
  // 295 + "\n\n" + "#terminal" is 306, over the limit, so nothing is added.
  const base = "a".repeat(295);
  expect(appendHashtags(base, ["#terminal"], 300)).toBe(base);
  // 290 + "\n\n#tui" is 296 and fits; adding " #terminal" would reach 306.
  const roomForOne = "a".repeat(290);
  expect(appendHashtags(roomForOne, ["#tui", "#terminal"], 300)).toBe(`${roomForOne}\n\n#tui`);
  const short = "a short post";
  expect(appendHashtags(short, ["#terminal", "#tui"], 300)).toBe(`${short}\n\n#terminal #tui`);
});

test("does not repeat a hashtag already in the text", () => {
  expect(appendHashtags("about #terminal things", ["#terminal"], 300)).toBe("about #terminal things");
});

test("turns a phrase into a usable hashtag", () => {
  expect(toHashtag("Terminal UI")).toBe("#terminalUI");
  expect(toHashtag("open source!")).toBe("#openSource");
  expect(toHashtag("!!!")).toBe("");
});

test("finds hashtags including non-Latin scripts", () => {
  expect(extractHashtags("#one and #two and #one")).toEqual(["#one", "#two"]);
  expect(extractHashtags("#日本語")).toEqual(["#日本語"]);
});

test("truncation lands under the limit with the ellipsis counted", () => {
  const result = truncateTo("a".repeat(400), 300);
  expect(countChars(result)).toBeLessThanOrEqual(300);
  expect(result.endsWith("…")).toBe(true);
});
