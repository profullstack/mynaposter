/**
 * Post types: what a kind of post is, wherever it goes.
 *
 * The nine built-ins materialise once and are never overwritten; the default
 * type follows the targets; a type is refused on a target whose kind it does
 * not allow (a bug-story never reaches the blog); a type's own daily cap is
 * applied across every account on top of the account caps; the type is
 * written onto the queue entry and the history entry; and an agent reads the
 * type skill first.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_TYPES,
  addTypeSkill,
  bookingsForType,
  defaultTypeFor,
  ensureTypeSkill,
  initTypeSkills,
  listTypeSkills,
  readTypeSkill,
  refuseTypeMismatch,
  refusedTargets,
  removeTypeSkill,
  typeAllows,
  typeCapFor,
  typeTemplate,
} from "../src/core/post-types.ts";
import { resolveSkill } from "../src/core/skills.ts";
import { parseSkill, serializeSkill, typeSkillPath } from "../src/store/skills.ts";
import { planTargets, pacingRules, DEFAULT_PACING, DAY_MS } from "../src/core/pacing.ts";
import { postPaced, postToAll } from "../src/core/poster.ts";
import { runDuePosts } from "../src/core/scheduler.ts";
import { registerNetwork, unregisterNetwork, getNetwork } from "../src/net/registry.ts";
import { NO_CAPS, type Account, type Network, type PostInput } from "../src/net/types.ts";
import { listHistory, recordHistory } from "../src/store/history.ts";
import { enqueue, listQueue } from "../src/store/queue.ts";
import { saveAccount, resetAccountCache } from "../src/store/accounts.ts";
import { resetPlugins } from "../src/plugins/loader.ts";
import type { HistoryEntry } from "../src/store/history.ts";
import type { QueuedPost } from "../src/store/queue.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-types-"));
  process.env.MYNA_HOME = dir;
  resetPlugins();
  resetAccountCache();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
  resetAccountCache();
  resetPlugins();
});

const acct = (network: string, handle: string): Account => ({ id: `${network}:${handle}`, network, handle, addedAt: "2026-09-01T00:00:00.000Z", creds: {}, meta: {} });
const blog = acct("htmlblog", "dev.profullstack.com/~anthony/blog");
const bsky = acct("bluesky", "chovyfu.bsky.social");
const masto = acct("mastodon", "chovy@defcon.social");
const devto = acct("devto", "chovy");
const board = acct("tsbb", "member@bbs.hqtui.com");

const H = 3_600_000;
const NOW = Date.parse("2026-09-12T12:00:00.000Z");

test("nine built-in types, each with allowed kinds, a structure and a body free of dashes", () => {
  expect(BUILTIN_TYPES).toEqual(["launch-announcement", "release-notes", "bug-story", "essay", "repost", "promo", "reply", "event", "social-update"]);
  for (const slug of BUILTIN_TYPES) {
    const { frontmatter, body } = typeTemplate(slug);
    expect(frontmatter.type).toBe(slug);
    expect(frontmatter.name).toBe(`myna-type-${slug}`);
    expect(frontmatter.allowedKinds?.length).toBeGreaterThan(0);
    expect(frontmatter.structure?.length).toBeGreaterThan(0);
    expect(typeof frontmatter.requiresUrl).toBe("boolean");
    expect(serializeSkill(frontmatter, body)).not.toMatch(/[—–]/);
  }
  expect(typeTemplate("bug-story").frontmatter.allowedKinds).toEqual(["social", "forum"]);
  expect(typeTemplate("essay").frontmatter.maxPerDay).toBe(1);
  expect(typeTemplate("launch-announcement").frontmatter.structure).toEqual(["what-it-is", "who-it-is-for", "what-changed", "how-to-use-it", "link"]);
  expect(() => typeTemplate("nope")).toThrow(/No built-in post type/);
});

test("list frontmatter round-trips as a flow list", () => {
  const { frontmatter, body } = typeTemplate("bug-story");
  const raw = serializeSkill(frontmatter, body);
  expect(raw).toContain("allowedKinds: [social, forum]");
  expect(raw).toContain("structure: [what-broke, why, the-fix, the-lesson]");
  const back = parseSkill(raw);
  expect(back.frontmatter.allowedKinds).toEqual(["social", "forum"]);
  expect(back.frontmatter.structure).toEqual(["what-broke", "why", "the-fix", "the-lesson"]);
  expect(back.frontmatter.requiresUrl).toBe(false);
  expect(parseSkill("---\nallowedKinds: []\n---\nx").frontmatter.allowedKinds).toEqual([]);
});

test("init writes every type once and never overwrites an edited one; a person can add a type", () => {
  const first = initTypeSkills();
  expect(first.written).toHaveLength(9);
  expect(first.kept).toHaveLength(0);
  const path = typeSkillPath("bug-story");
  expect(existsSync(path)).toBe(true);

  writeFileSync(path, readFileSync(path, "utf8").replace("allowedKinds: [social, forum]", "allowedKinds: [forum]") + "\nMine.\n");
  const second = initTypeSkills();
  expect(second.written).toHaveLength(0);
  expect(second.kept).toHaveLength(9);
  expect(readTypeSkill("bug-story")?.frontmatter.allowedKinds).toEqual(["forum"]);
  expect(readTypeSkill("bug-story")?.body).toContain("Mine.");

  // Without a file, a built-in still reads as its template.
  removeTypeSkill("essay");
  expect(readTypeSkill("essay")?.raw).toBe("");
  expect(readTypeSkill("essay")?.frontmatter.maxPerDay).toBe(1);
  expect(ensureTypeSkill("essay").written).toBe(true);
  expect(ensureTypeSkill("essay").written).toBe(false);

  const added = addTypeSkill("changelog", "---\nallowedKinds: [social]\nmaxPerDay: 3\n---\n\nA short changelog line.");
  expect(added.type).toBe("changelog");
  expect(added.frontmatter.allowedKinds).toEqual(["social"]);
  expect(added.frontmatter.name).toBe("myna-type-changelog");
  expect(listTypeSkills().map((type) => type.type)).toEqual([...BUILTIN_TYPES, "changelog"]);
  expect(() => addTypeSkill("changelog", "again")).toThrow(/already exists/);
  expect(readTypeSkill("nope")).toBeUndefined();
});

test("the default type follows the targets: a blog or a mirror makes it a launch, else a social update", () => {
  expect(defaultTypeFor([bsky, masto, board])).toBe("social-update");
  expect(defaultTypeFor([blog])).toBe("launch-announcement");
  expect(defaultTypeFor([bsky, devto])).toBe("launch-announcement");
  expect(defaultTypeFor([])).toBe("social-update");
});

test("a type is refused on a target whose kind it does not carry", () => {
  expect(typeAllows(readTypeSkill("bug-story")!, "social")).toBe(true);
  expect(typeAllows(readTypeSkill("bug-story")!, "blog")).toBe(false);
  expect(typeAllows({ frontmatter: { name: "", description: "" } }, "blog")).toBe(true);

  const refused = refusedTargets("bug-story", [blog, bsky, devto]);
  expect(refused.map((row) => row.account.id)).toEqual([blog.id, devto.id]);
  expect(refused[0].reason).toContain("is a blog target and a bug-story is allowed on social, forum only");
  expect(() => refuseTypeMismatch("bug-story", [blog])).toThrow(/The blog carries launch-announcement and essay only/);
  expect(() => refuseTypeMismatch("launch-announcement", [blog, bsky, devto, board])).not.toThrow();
  expect(() => refuseTypeMismatch("social-update", [blog])).toThrow(/blog target/);
  expect(() => refuseTypeMismatch("repost", [bsky])).toThrow(/longform only/);
  expect(() => refuseTypeMismatch("nope", [bsky])).toThrow(/No post type "nope"/);
});

test("a type's cap holds across every account, on top of the account caps, and stricter wins", () => {
  const rules = pacingRules({ ...DEFAULT_PACING, minGap: "1h" });
  const accountNetwork = (id: string) => ({ [blog.id]: "htmlblog", [bsky.id]: "bluesky" })[id];
  // One essay already out today, on the socials.
  const history: HistoryEntry[] = [
    { at: new Date(NOW - 5 * H).toISOString(), accountId: bsky.id, network: "bluesky", handle: bsky.handle, text: "an essay", ok: true, type: "essay" },
    { at: new Date(NOW - 4 * H).toISOString(), accountId: bsky.id, network: "bluesky", handle: bsky.handle, text: "a launch", ok: true, type: "launch-announcement" },
  ];
  const queue: QueuedPost[] = [];
  expect(bookingsForType("essay", history, queue)).toEqual([NOW - 5 * H]);
  expect(typeCapFor("essay")).toBe(1);
  expect(typeCapFor("bug-story")).toBeUndefined();

  // A second essay today, to the blog, waits for the first to leave the window.
  const plan = planTargets({
    accounts: [blog],
    text: "another essay",
    now: NOW,
    history,
    queue,
    rules,
    accountNetwork,
    order: (a) => a,
    limitsFor: () => ({ maxPerDay: 4 }),
    typeLimit: { type: "essay", maxPerDay: 1, bookings: bookingsForType("essay", history, queue) },
  });
  expect(plan.now).toEqual([]);
  expect(plan.later[0].at).toBe(NOW - 5 * H + DAY_MS);
  expect(plan.later[0].reason).toContain("essay is at its 1 a day across every account");

  // The same post as a launch is fine: the account is at 0 of 4 today.
  const launch = planTargets({ accounts: [blog], text: "a launch", now: NOW, history, queue, rules, accountNetwork, order: (a) => a, limitsFor: () => ({ maxPerDay: 4 }) });
  expect(launch.now).toEqual([blog]);

  // Two targets for one essay in one plan: the second waits for the first, even under --now.
  const two = planTargets({
    accounts: [blog, bsky],
    text: "essay",
    now: NOW,
    history: [],
    queue,
    rules,
    accountNetwork,
    order: (a) => a,
    force: true,
    typeLimit: { type: "essay", maxPerDay: 1, bookings: [] },
  });
  expect(two.now).toEqual([blog]);
  expect(two.later.map((t) => [t.account.id, t.at])).toEqual([[bsky.id, NOW + DAY_MS]]);
});

test("an agent reads the type skill first, then the account's, then the network's", () => {
  const resolved = resolveSkill(blog, { type: "essay" });
  expect(resolved.typeSkill?.type).toBe("essay");
  const body = resolved.body;
  expect(body.indexOf("# essay")).toBeLessThan(body.indexOf(`# ${blog.id}`));
  expect(body.indexOf(`# ${blog.id}`)).toBeLessThan(body.indexOf("## What this blog is for"));
  expect(resolveSkill(blog).typeSkill).toBeUndefined();
});

/* --------------------------------------------- at the point of sending */

const seen: Array<{ account: string; input: PostInput }> = [];
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
const gitblog = acct("gitblog", "test/blog");

async function withFakeBlog(run: () => Promise<void>): Promise<void> {
  const real = getNetwork("gitblog");
  registerNetwork(fakeBlog);
  saveAccount(gitblog);
  try {
    await run();
  } finally {
    seen.length = 0;
    unregisterNetwork("gitblog");
    if (real) registerNetwork(real);
  }
}

test("postPaced refuses a bug-story to the blog with an error and no queue entry, and tags what it sends", async () => {
  await withFakeBlog(async () => {
    await expect(postPaced([gitblog], { text: "# It broke\n\nbecause of a header", type: "bug-story" }, { now: NOW })).rejects.toThrow(/A bug-story cannot go there/);
    expect(listQueue()).toEqual([]);
    expect(seen).toEqual([]);

    // No type given: a blog target makes it a launch-announcement, which the blog carries.
    const outcome = await postPaced([gitblog], { text: "# A launch\n\nbody https://example.test" }, { now: NOW, force: true });
    expect(outcome.results[0]?.ok).toBe(true);
    expect(listHistory()[0]?.type).toBe("launch-announcement");

    // Queued entries carry the type too.
    const later = await postPaced([gitblog], { text: "# Later\n\nbody", type: "essay" }, { now: NOW, from: NOW + 2 * H });
    expect(later.queued[0]?.type).toBe("essay");
  });
});

test("the daemon drops a queued entry whose type its target no longer carries, and passes the type into history", async () => {
  await withFakeBlog(async () => {
    const bad = enqueue({ scheduledFor: new Date(NOW - 60_000).toISOString(), targets: [gitblog.id], text: "# Story\n\nbody", type: "bug-story" });
    const good = enqueue({ scheduledFor: new Date(NOW - 30_000).toISOString(), targets: [gitblog.id], text: "# Launch\n\nbody", type: "launch-announcement" });
    recordHistory([]);

    const results = await runDuePosts(new Date(NOW));
    expect(results.map((row) => row.post.id)).toEqual([good.id]);

    // An old entry with no type at all is left to the network and account
    // rules. Sent on its own tick, since two due entries on one network
    // gate each other.
    const untyped = enqueue({ scheduledFor: new Date(NOW + DAY_MS).toISOString(), targets: [gitblog.id], text: "# Old\n\nbody" });
    expect((await runDuePosts(new Date(NOW + DAY_MS))).map((row) => row.post.id)).toEqual([untyped.id]);
    const queue = listQueue();
    expect(queue.find((entry) => entry.id === bad.id)?.status).toBe("cancelled");
    expect(queue.find((entry) => entry.id === bad.id)?.lastError).toContain("is a blog target and a bug-story is allowed on social, forum only");
    expect(queue.find((entry) => entry.id === good.id)?.status).toBe("sent");
    const history = listHistory();
    expect(history.find((entry) => entry.text.startsWith("# Launch"))?.type).toBe("launch-announcement");
    expect(history.find((entry) => entry.text.startsWith("# Old"))?.type).toBeUndefined();
  });
});

test("postToAll records the type it was given", async () => {
  await withFakeBlog(async () => {
    const results = await postToAll([gitblog], { text: "# Direct\n\nbody", type: "essay" });
    expect(results[0].ok).toBe(true);
    expect(listHistory()[0]).toMatchObject({ type: "essay", skill: "skill", title: "Direct" });
  });
});
