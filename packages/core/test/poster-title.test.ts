/**
 * The title a `needsTitle` network receives from a fan-out.
 *
 * This is the layer the bug lived in. `postOne` fills `input.title` before any
 * adapter runs, so a fix in an adapter never fired for `myna post --to all`,
 * which is exactly how the bad title reached a live board. The assertion here
 * is on what the adapter is *handed*, not on what any one adapter does with it.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postToAll } from "../src/core/poster.ts";
import { registerNetwork, unregisterNetwork } from "../src/net/registry.ts";
import { NO_CAPS, type Account, type Network, type PostInput } from "../src/net/types.ts";

const seen: PostInput[] = [];

/** A stand-in for any titled network: a board, a blog, a link aggregator. */
const titled: Network = {
  id: "titled-test",
  name: "Titled test network",
  category: "forum",
  blurb: "Test double.",
  auth: { kind: "token", fields: [] },
  caps: { ...NO_CAPS, needsTitle: true },
  async login() {
    throw new Error("not used");
  },
  async post(_account, input) {
    seen.push(input);
    return { id: "1", url: "https://example.com/t/1" };
  },
};

const account: Account = {
  id: "titled-test:member",
  network: "titled-test",
  handle: "member",
  addedAt: new Date().toISOString(),
  creds: { token: "t" },
  meta: {},
};

// The poster writes history, so keep it out of the real config dir.
let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-poster-title-"));
  process.env.MYNA_HOME = dir;
});
afterEach(() => {
  seen.length = 0;
  unregisterNetwork("titled-test");
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
});

test("a fan-out hands a titled network whole sentences, not a sliced line", async () => {
  registerNetwork(titled);
  const text =
    "myna 0.15.1: a forum post fanned out with --to all now gets a real title. It takes whole " +
    "sentences instead of slicing the first line mid-clause, drops a trailing URL, and leaves " +
    "version numbers alone. https://github.com/profullstack/mynaposter/releases/tag/v0.15.2";

  const results = await postToAll([account], { text });

  expect(results[0]?.ok).toBe(true);
  expect(seen).toHaveLength(1);
  expect(seen[0].title).toBe("myna 0.15.1: a forum post fanned out with --to all now gets a real title");
  // The body still carries everything, including the URL the title dropped.
  expect(seen[0].text).toContain("https://github.com/profullstack/mynaposter");
});

test("an explicit title is never second-guessed", async () => {
  registerNetwork(titled);
  await postToAll([account], { text: "Body text here.", title: "A title I chose myself" });
  expect(seen[0].title).toBe("A title I chose myself");
});

test("a markdown heading becomes the title", async () => {
  registerNetwork(titled);
  await postToAll([account], { text: "# Release 0.15.2\n\nIt skips a forum the board refuses." });
  expect(seen[0].title).toBe("Release 0.15.2");
});
