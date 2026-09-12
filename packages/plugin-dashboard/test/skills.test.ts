/**
 * The skill routes: a network's skill, an account's selected skill, the list
 * of an account's skills and one of them by slug, all served as Markdown,
 * plus the index. Reading never moves a rotation cursor.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle, skillRoute, skillRows } from "../src/index.ts";
import { buildSnapshot } from "../src/snapshot.ts";
import {
  DEFAULT_SETTINGS,
  addAccountSkill,
  ensureAccountSkill,
  setRotation,
  loadSettings,
  accountSkillPath,
  networkSkillPath,
  type Account,
  type Settings,
} from "@profullstack/myna-core";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-dash-skills-"));
  process.env.MYNA_HOME = dir;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
});

const blog: Account = {
  id: "htmlblog:dev.profullstack.com/~anthony/blog",
  network: "htmlblog",
  handle: "dev.profullstack.com/~anthony/blog",
  addedAt: "2026-09-05T00:00:00.000Z",
  creds: {},
  meta: { siteUrl: "https://dev.profullstack.com/~anthony/blog" },
};
const bsky: Account = { id: "bluesky:chovyfu.bsky.social", network: "bluesky", handle: "chovyfu.bsky.social", addedAt: "", creds: {}, meta: {} };

const sources = { targets: () => [blog, bsky], settings: () => loadSettings() };
const get = (path: string) => handle(new Request(`http://127.0.0.1:7777${path}`), sources);

test("the routes are built from the handle as one path segment", () => {
  expect(skillRoute("htmlblog", "dev.profullstack.com/~anthony/blog")).toBe("/htmlblog/dev.profullstack.com-~anthony-blog/skill.md");
  expect(skillRoute("bluesky", "chovyfu.bsky.social", "quiet")).toBe("/bluesky/chovyfu.bsky.social/skills/quiet.md");
});

test("GET /:network/skill.md serves the network skill as Markdown and writes it on first read", async () => {
  expect(existsSync(networkSkillPath("htmlblog"))).toBe(false);
  const response = get("/htmlblog/skill.md");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
  const body = await response.text();
  expect(body).toMatch(/^---\nname: myna-htmlblog\n/);
  expect(body).toContain("maxPerDay: 4");
  expect(body).toContain("contentPolicy: major-features-only");
  expect(body).toContain("major feature announcements and launches only");
  expect(existsSync(networkSkillPath("htmlblog"))).toBe(true);

  expect(get("/nonsense/skill.md").status).toBe(404);
});

test("GET /:network/:account/skill.md serves the selected skill without moving the cursor", async () => {
  const response = get("/htmlblog/dev.profullstack.com-~anthony-blog/skill.md");
  expect(response.status).toBe(200);
  const body = await response.text();
  // Values with a colon are quoted, so YAML reads them back whole.
  expect(body).toContain('account: "htmlblog:dev.profullstack.com/~anthony/blog"');
  expect(body).toContain('profileUrl: "https://dev.profullstack.com/~anthony/blog"');
  expect(existsSync(accountSkillPath("htmlblog", blog.handle))).toBe(true);

  // Rotating: the route shows what the next post would use, and showing it
  // does not advance anything.
  addAccountSkill(blog, "quiet", "Say less.");
  setRotation(blog, true);
  const first = await get("/htmlblog/dev.profullstack.com-~anthony-blog/skill.md").text();
  const second = await get("/htmlblog/dev.profullstack.com-~anthony-blog/skill.md").text();
  expect(first).toBe(second);
  expect(first).toContain("name: myna-htmlblog-dev.profullstack.com-~anthony-blog");
  expect(loadSettings().skills.cursor[blog.id]).toBeUndefined();

  // The full id works too, URL-encoded.
  expect(get(`/htmlblog/${encodeURIComponent(blog.handle)}/skill.md`).status).toBe(200);
  expect(get("/htmlblog/nobody/skill.md").status).toBe(404);
});

test("GET /:network/:account/skills/ lists them and /skills/:slug.md serves one", async () => {
  ensureAccountSkill(blog);
  addAccountSkill(blog, "quiet", "Say less.");
  const list = await get("/htmlblog/dev.profullstack.com-~anthony-blog/skills/").text();
  expect(list).toContain("- [skill](/htmlblog/dev.profullstack.com-~anthony-blog/skills/skill.md) (selected)");
  expect(list).toContain("- [quiet](/htmlblog/dev.profullstack.com-~anthony-blog/skills/quiet.md)");
  expect(list).toContain("[htmlblog](/htmlblog/skill.md)");

  const one = get("/htmlblog/dev.profullstack.com-~anthony-blog/skills/quiet.md");
  expect(one.status).toBe(200);
  expect(await one.text()).toContain("Say less.");
  expect(get("/htmlblog/dev.profullstack.com-~anthony-blog/skills/nope.md").status).toBe(404);
});

test("GET /skills is the index, GET /skills.json the same as data, and other paths still 404", async () => {
  const index = get("/skills");
  expect(index.headers.get("content-type")).toContain("text/markdown");
  const body = await index.text();
  expect(body).toContain("- [htmlblog](/htmlblog/skill.md) (blog)");
  expect(body).toContain("- [bluesky](/bluesky/skill.md) (social)");
  expect(body).toContain("[htmlblog:dev.profullstack.com/~anthony/blog](/htmlblog/dev.profullstack.com-~anthony-blog/skill.md) using `skill`: 4/day, major-features-only");
  expect(body).toContain("300 chars");

  const data = (await get("/skills.json").json()) as { skills: Array<{ accountId: string; maxPerDay?: number; maxChars?: number }> };
  expect(data.skills.find((row) => row.accountId === blog.id)?.maxPerDay).toBe(4);
  expect(data.skills.find((row) => row.accountId === bsky.id)?.maxChars).toBe(300);

  expect(get("/nope").status).toBe(404);
  expect(get("/htmlblog").status).toBe(404);
});

test("the snapshot carries each account's skill and how much of the day is used", () => {
  const NOW = Date.parse("2026-09-12T12:00:00.000Z");
  const settings: Settings = structuredClone(DEFAULT_SETTINGS);
  const history = [1, 2, 3].map((h) => ({
    at: new Date(NOW - h * 3_600_000).toISOString(),
    accountId: blog.id,
    network: "htmlblog",
    handle: blog.handle,
    text: `# Post ${h}`,
    ok: true,
    skill: "skill",
  }));
  const snap = buildSnapshot({ now: NOW, history, queue: [], accounts: [blog, bsky], engagement: [], settings, skills: skillRows([blog, bsky], settings) });
  const row = snap.skills.find((entry) => entry.accountId === blog.id)!;
  expect(row).toMatchObject({ kind: "blog", selected: "skill", rotating: false, maxPerDay: 4, sentToday: 3, contentPolicy: "major-features-only" });
  expect(row.path).toBe("/htmlblog/dev.profullstack.com-~anthony-blog/skill.md");
  expect(snap.history[0].skill).toBe("skill");
});
