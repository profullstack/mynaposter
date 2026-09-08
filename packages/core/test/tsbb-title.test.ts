import { test, expect, describe } from "bun:test";
import { forumBody, forumTitle } from "../src/net/adapters/tsbb.ts";

describe("forumTitle", () => {
  test("the social blast that produced a mid-clause title on the real board", () => {
    // Posted 2026-09-08 by `myna post --to all`, which gives a forum no title.
    // The board showed: "myna 0.15.0: myna update. It picks the right build for
    // your CPU, checks the" — a sentence cut in half on the front page.
    const text =
      "myna 0.15.0: myna update. It picks the right build for your CPU, checks the published " +
      "SHA256SUMS, and renames it over the running binary, so a failed download changes nothing. " +
      "--check exits 1 when one is waiting. https://dev.profullstack.com/~anthony/blog/089-post.html";
    expect(forumTitle(text)).toBe("myna 0.15.0: myna update");
  });

  test("a version number is not a sentence end", () => {
    // "0.15.0" is three periods that must not split the title.
    expect(forumTitle("Shipping myna 0.15.0 today for everyone on Linux.")).toBe(
      "Shipping myna 0.15.0 today for everyone on Linux",
    );
  });

  test("a markdown heading wins, and is not repeated in the body", () => {
    const text = "# myna 0.15.0: myna update\n\nI typed `myna update` today and got an error.";
    expect(forumTitle(text)).toBe("myna 0.15.0: myna update");
    expect(forumBody(text, forumTitle(text))).toBe("I typed `myna update` today and got an error.");
  });

  test("body is untouched when the title did not come from a heading", () => {
    const text = "myna 0.15.0 is out. It updates itself now.";
    expect(forumBody(text, forumTitle(text))).toBe(text);
  });

  test("a first sentence too short to be a title takes the next one too", () => {
    expect(forumTitle("Shipped. The queue drains on its own now, at last.")).toBe(
      "Shipped. The queue drains on its own now, at last",
    );
  });

  test("one very long sentence is cut at a word boundary, not mid-word", () => {
    const text =
      "This release rewrites the way the scheduler decides which account goes next and why it " +
      "waits as long as it does between them.";
    const title = forumTitle(text);
    expect(title.length).toBeLessThanOrEqual(91); // the cap, plus the ellipsis
    expect(title.endsWith("…")).toBe(true);
    // The real property: what was kept is whole words of the original, so the
    // next character in the source is a space rather than the rest of a word.
    const kept = title.slice(0, -1);
    expect(text.startsWith(kept)).toBe(true);
    expect(text[kept.length]).toBe(" ");
  });

  test("a trailing URL never becomes part of the title", () => {
    expect(forumTitle("readm3 0.3.0 edits now https://readm3.com")).toBe("readm3 0.3.0 edits now");
    // A URL is still fine when it is all there is to go on.
    expect(forumTitle("https://readm3.com")).toBe("https://readm3.com");
  });

  test("leading blank lines and stray whitespace do not shift the title", () => {
    expect(forumTitle("\n\n   myna 0.15.0 is   out today.  \n\nmore text")).toBe("myna 0.15.0 is out today");
  });
});
