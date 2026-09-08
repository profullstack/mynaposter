/**
 * The title a fan-out invents, tested where it is actually made.
 *
 * `postOne` fills in a title for every `needsTitle` network before any adapter
 * runs, so an adapter-level fix never fired on the `--to all` path. That is the
 * bug these tests exist to keep fixed.
 */
import { test, expect, describe } from "bun:test";
import { deriveTitle, bodyUnderTitle } from "../src/util/text.ts";
import { NETWORKS } from "../src/net/registry.ts";

describe("deriveTitle", () => {
  test("the social blast that reached a real board as a half sentence", () => {
    const text =
      "myna 0.15.1: a forum post fanned out with --to all now gets a real title. It takes whole " +
      "sentences instead of slicing the first line mid-clause, drops a trailing URL, and leaves " +
      "version numbers alone. https://github.com/profullstack/mynaposter/releases/tag/v0.15.2";
    // What bbs.hqtui.com actually showed: "…drops a trailin".
    expect(deriveTitle(text)).toBe("myna 0.15.1: a forum post fanned out with --to all now gets a real title");
  });

  test("a version number is not a sentence end", () => {
    expect(deriveTitle("Shipping myna 0.15.2 today for everyone on Linux.")).toBe(
      "Shipping myna 0.15.2 today for everyone on Linux",
    );
  });

  test("a markdown heading wins, and is not repeated in the body", () => {
    const text = "# myna 0.15.2: skip a forum the board refuses\n\nThe rotation reached news.";
    expect(deriveTitle(text)).toBe("myna 0.15.2: skip a forum the board refuses");
    expect(bodyUnderTitle(text, deriveTitle(text))).toBe("The rotation reached news.");
  });

  test("body is untouched when the title did not come from a heading", () => {
    const text = "myna 0.15.2 is out. It skips a forum the board refuses.";
    expect(bodyUnderTitle(text, deriveTitle(text))).toBe(text);
  });

  test("a first sentence too short to be a title takes the next one too", () => {
    expect(deriveTitle("Shipped. The queue drains on its own now, at last.")).toBe(
      "Shipped. The queue drains on its own now, at last",
    );
  });

  test("one very long sentence is cut at a word boundary", () => {
    const text =
      "This release rewrites the way the scheduler decides which account goes next and why it " +
      "waits as long as it does between them.";
    const title = deriveTitle(text);
    expect(title.length).toBeLessThanOrEqual(91);
    const kept = title.slice(0, -1);
    expect(title.endsWith("…")).toBe(true);
    expect(text.startsWith(kept)).toBe(true);
    expect(text[kept.length]).toBe(" ");
  });

  test("a trailing URL never becomes part of the title", () => {
    expect(deriveTitle("readm3 0.3.0 edits now https://readm3.com")).toBe("readm3 0.3.0 edits now");
    expect(deriveTitle("https://readm3.com")).toBe("https://readm3.com");
  });

  test("leading blank lines and stray whitespace do not shift the title", () => {
    expect(deriveTitle("\n\n   myna 0.15.2 is   out today.  \n\nmore")).toBe("myna 0.15.2 is out today");
  });

  test("every derived title fits the tightest limit a needsTitle network imposes", () => {
    // Reddit takes 300, boards commonly cut at 160. The cap has to clear the
    // smallest of those, or the network truncates and we are back where we began.
    const long = "word ".repeat(200).trim();
    expect(deriveTitle(long).length).toBeLessThanOrEqual(120);
    expect(NETWORKS.some((network) => network.caps.needsTitle)).toBe(true);
  });
});
