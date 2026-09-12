/**
 * Skills at the point of sending.
 *
 * A blog post whose title is already in the blog's history is refused with
 * an error and never queued; the history records which skill each post used
 * and the title it went out under; a rotating account moves on with every
 * send; and the daemon holds a fifth blog post of the day at send time.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postPaced, postToAll, refuseDuplicateTitles } from "../src/core/poster.ts";
import { runDuePosts } from "../src/core/scheduler.ts";
import { registerNetwork, unregisterNetwork } from "../src/net/registry.ts";
import { NO_CAPS, type Account, type Network, type PostInput } from "../src/net/types.ts";
import { listHistory, recordHistory } from "../src/store/history.ts";
import { enqueue, listQueue } from "../src/store/queue.ts";
import { saveAccount, resetAccountCache } from "../src/store/accounts.ts";
import { loadSettings, saveSettings } from "../src/store/settings.ts";
import { addAccountSkill, ensureAccountSkill, setRotation } from "../src/core/skills.ts";
import { resetPlugins } from "../src/plugins/loader.ts";

const seen: Array<{ account: string; input: PostInput }> = [];

/** A stand-in for gitblog, registered under its id so the blog kind (4 a day, no duplicate titles) applies. */
const fakeBlog: Network = {
  id: "gitblog",
  name: "Fake git blog",
  category: "blog",
  blurb: "Test double for the blog kind.",
  auth: { kind: "local", fields: [] },
  caps: { ...NO_CAPS, needsTitle: true, explicitTarget: true },
  async login() {
    throw new Error("not used");
  },
  async post(account, input) {
    seen.push({ account: account.id, input });
    return { id: `${seen.length}`, url: `https://blog.test/${seen.length}` };
  },
};

const blog: Account = {
  id: "gitblog:test/blog",
  network: "gitblog",
  handle: "test/blog",
  addedAt: "2026-09-01T00:00:00.000Z",
  creds: {},
  meta: {},
};

let dir = "";
let realGitblog: Network | undefined;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myna-poster-skills-"));
  process.env.MYNA_HOME = dir;
  resetPlugins();
  resetAccountCache();
  const registry = await import("../src/net/registry.ts");
  realGitblog = registry.getNetwork("gitblog");
  registerNetwork(fakeBlog);
  saveAccount(blog);
});
afterEach(() => {
  seen.length = 0;
  unregisterNetwork("gitblog");
  if (realGitblog) registerNetwork(realGitblog);
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
  resetAccountCache();
  resetPlugins();
});

const NOW = Date.parse("2026-09-12T12:00:00.000Z");

test("the history records the title and the skill, and a rotating account moves on each send", async () => {
  ensureAccountSkill(blog);
  addAccountSkill(blog, "launch-week", "Three features, one post.");
  setRotation(blog, true);

  const first = await postToAll([blog], { text: "# First post\n\nBody." });
  expect(first[0].ok).toBe(true);
  expect(first[0].skill).toBe("skill");
  expect(first[0].title).toBe("First post");

  const second = await postToAll([blog], { text: "# Second post\n\nBody." });
  expect(second[0].skill).toBe("launch-week");

  const history = listHistory();
  expect(history.map((entry) => [entry.title, entry.skill])).toEqual([
    ["Second post", "launch-week"],
    ["First post", "skill"],
  ]);
  expect(loadSettings().skills.cursor[blog.id]).toBe("launch-week");
});

test("a blog refuses a title it already carries, with an error and no queue entry", async () => {
  recordHistory([
    { at: new Date(NOW - 3_600_000).toISOString(), accountId: blog.id, network: "gitblog", handle: blog.handle, text: "# NicheDB Premium: a dollar a day\n\nold body", ok: true, url: "https://blog.test/1" },
  ]);
  await expect(postPaced([blog], { text: "# NicheDB Premium: a dollar a day\n\nnew body" }, { now: NOW })).rejects.toThrow(/already has a post titled "NicheDB Premium: a dollar a day"/);
  expect(listQueue()).toEqual([]);
  expect(seen).toEqual([]);

  // The same through --title.
  expect(() => refuseDuplicateTitles([blog], { text: "whatever", title: "nichedb premium: a dollar a day" })).toThrow(/--allow-duplicate/);

  // --allow-duplicate lets it through.
  const outcome = await postPaced([blog], { text: "# NicheDB Premium: a dollar a day\n\nnew body", allowDuplicate: true }, { now: NOW, force: true });
  expect(outcome.results[0]?.ok).toBe(true);
});

test("the daemon holds a fifth blog post of the day to the next day, and drops a re-sent title", async () => {
  const H = 3_600_000;
  const now = new Date(NOW);
  recordHistory(
    [20, 14, 8, 2].map((hoursAgo, index) => ({
      at: new Date(NOW - hoursAgo * H).toISOString(),
      accountId: blog.id,
      network: "gitblog",
      handle: blog.handle,
      text: `# Post ${index}\n\nbody`,
      ok: true,
      url: `https://blog.test/${index}`,
    })),
  );
  const settings = loadSettings();
  settings.pacing.minGap = "1h";
  saveSettings(settings);

  // The repeat is due first, so it is dropped before the fifth is planned;
  // a pending entry still in the queue would count against the day.
  const repeat = enqueue({ scheduledFor: new Date(NOW - 90_000).toISOString(), targets: [blog.id], text: "# Post 2\n\nbody again" });
  const fifth = enqueue({ scheduledFor: new Date(NOW - 60_000).toISOString(), targets: [blog.id], text: "# Post five\n\nbody" });

  const results = await runDuePosts(now);
  expect(results).toEqual([]);
  expect(seen).toEqual([]);

  const queue = listQueue();
  const held = queue.find((entry) => entry.id === fifth.id)!;
  expect(held.status).toBe("pending");
  expect(new Date(held.scheduledFor).getTime()).toBe(NOW - 20 * H + 24 * H);
  expect(held.lastError).toContain("4 a day");

  const dropped = queue.find((entry) => entry.id === repeat.id)!;
  expect(dropped.status).toBe("cancelled");
  expect(dropped.lastError).toContain("already carried this title");
});
