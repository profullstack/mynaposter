/**
 * Skills: the rules per network and per account, as files.
 *
 * Materialising never overwrites a file a person edited; an account's skill
 * inherits from its network's, which inherits from the template, with the
 * stricter limit winning; rotation takes turns and remembers where it was in
 * settings, not in the files; a rotated skill can tighten a cap and never
 * loosen it; a blog refuses a title it already carries.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountTemplate,
  addAccountSkill,
  duplicateTitle,
  ensureAccountSkill,
  ensureNetworkSkill,
  initSkills,
  listAccountSkills,
  mergeLimits,
  networkTemplate,
  pinDefaultSkill,
  planLimitsFor,
  readNetworkSkill,
  removeAccountSkill,
  resolveSkill,
  selectSkill,
  setRotation,
  skillKindFor,
  takeSkill,
  templateLimits,
  titleOf,
  findSkillTarget,
  profileUrlFor,
} from "../src/core/skills.ts";
import { accountSkillPath, handleSlug, networkSkillPath, parseSkill, serializeSkill, skillsDir } from "../src/store/skills.ts";
import { loadSettings, saveSettings } from "../src/store/settings.ts";
import type { Account } from "../src/net/types.ts";
import type { HistoryEntry } from "../src/store/history.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-skills-"));
  process.env.MYNA_HOME = dir;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
});

const acct = (network: string, handle: string, meta: Record<string, string> = {}): Account => ({
  id: `${network}:${handle}`,
  network,
  handle,
  addedAt: "2026-09-05T22:00:00.000Z",
  creds: {},
  meta,
});

const blog = acct("htmlblog", "dev.profullstack.com/~anthony/blog", { dir: "/tmp/blog", siteUrl: "https://dev.profullstack.com/~anthony/blog" });
const bsky = acct("bluesky", "chovyfu.bsky.social");
const devto = acct("devto", "chovy");
const board = acct("tsbb", "member@bbs.hqtui.com", { instance: "https://bbs.hqtui.com" });

test("every network maps to a kind, and the kinds carry the limits that were asked for", () => {
  expect(skillKindFor("htmlblog")).toBe("blog");
  expect(skillKindFor("gitblog")).toBe("blog");
  expect(skillKindFor("devto")).toBe("longform");
  expect(skillKindFor("hashnode")).toBe("longform");
  expect(skillKindFor("tumblr")).toBe("longform");
  expect(skillKindFor("bluesky")).toBe("social");
  expect(skillKindFor("linkedin")).toBe("social");
  expect(skillKindFor("tsbb")).toBe("forum");
  expect(skillKindFor("reddit")).toBe("forum");
  expect(skillKindFor("youtube")).toBe("youtube");
  expect(skillKindFor("saasrow")).toBe("directory");
  expect(skillKindFor("no-such-thing")).toBe("other");

  expect(templateLimits("blog", "htmlblog")).toMatchObject({ maxPerDay: 4, contentPolicy: "major-features-only" });
  expect(templateLimits("longform", "devto")).toMatchObject({ requiresCanonical: true });
  // A board is four hours apart and six a day whatever `myna pace --gap` says:
  // bbs.hqtui.com got topics 29 minutes apart on a 2h gap, and a board reads
  // that as spam.
  expect(templateLimits("forum", "tsbb")).toMatchObject({ maxPerDay: 6, minGapMinutes: 240 });
  expect(templateLimits("forum", "reddit")).toMatchObject({ maxPerDay: 6, minGapMinutes: 240 });
  expect(templateLimits("social", "bluesky").maxChars).toBe(300);
  expect(templateLimits("social", "mastodon").maxChars).toBe(500);
  expect(templateLimits("social", "linkedin").maxChars).toBe(3000);
  expect(templateLimits("social", "x").maxChars).toBe(280);
});

test("a handle becomes one safe path segment", () => {
  expect(handleSlug("dev.profullstack.com/~anthony/blog")).toBe("dev.profullstack.com-~anthony-blog");
  expect(handleSlug("profullstack/hqtui")).toBe("profullstack-hqtui");
  expect(handleSlug("Anthony Ettinger")).toBe("Anthony-Ettinger");
  expect(handleSlug("chovy@defcon.social")).toBe("chovy@defcon.social");
  expect(handleSlug("@chovy")).toBe("chovy");
});

test("frontmatter round-trips, with the limits typed and odd values quoted", () => {
  const { frontmatter, body } = networkTemplate("htmlblog");
  const raw = serializeSkill(frontmatter, body);
  const back = parseSkill(raw);
  expect(back.frontmatter.maxPerDay).toBe(4);
  expect(back.frontmatter.requiresCanonical).toBe(false);
  expect(back.frontmatter.contentPolicy).toBe("major-features-only");
  expect(back.frontmatter.name).toBe("myna-htmlblog");
  expect(back.frontmatter.description).toContain("HTML blog");
  expect(back.body).toBe(body.trim());
  // The description holds a colon, so it must have been quoted to survive.
  expect(raw).toMatch(/^description: "/m);
});

test("the blog template says what Anthony asked for, in plain prose", () => {
  const { body, frontmatter } = networkTemplate("htmlblog");
  expect(frontmatter.maxPerDay).toBe(4);
  expect(frontmatter.contentPolicy).toBe("major-features-only");
  expect(body).toContain("major feature announcements and launches only");
  expect(body).toContain("No bug-fix stories");
  expect(body).toContain("At most 4 automated posts a day");
  expect(body).toContain("--canonical-url");
  expect(body).toContain("No em dashes");
  // No em dashes, no en dashes, anywhere in what we generate.
  for (const network of ["htmlblog", "gitblog", "bluesky", "devto", "tsbb", "youtube", "saasrow", "no-such-thing"]) {
    const text = serializeSkill(networkTemplate(network).frontmatter, networkTemplate(network).body);
    expect(text).not.toMatch(/[—–]/);
    const account = serializeSkill(accountTemplate(acct(network, "someone")).frontmatter, accountTemplate(network === "saasrow" ? { ...acct(network, "someone"), network: "saasrow" } : acct(network, "someone")).body);
    expect(account).not.toMatch(/[—–]/);
  }
});

test("the account template carries its header: network, username, profile URL, connected date", () => {
  const { frontmatter, body } = accountTemplate(bsky);
  expect(frontmatter.account).toBe("bluesky:chovyfu.bsky.social");
  expect(frontmatter.network).toBe("bluesky");
  expect(frontmatter.profileUrl).toBe("https://bsky.app/profile/chovyfu.bsky.social");
  expect(frontmatter.connectedAt).toBe("2026-09-05");
  expect(frontmatter.maxChars).toBe(300);
  expect(body).toContain("- Username: chovyfu.bsky.social");
  expect(body).toContain("- Connected: 2026-09-05");
  expect(profileUrlFor(blog)).toBe("https://dev.profullstack.com/~anthony/blog");
  expect(profileUrlFor(board)).toBe("https://bbs.hqtui.com");
  expect(profileUrlFor(acct("mastodon", "chovy@defcon.social"))).toBe("https://defcon.social/@chovy");
});

test("init writes the missing files and never overwrites one a person edited", () => {
  const first = initSkills([blog, bsky]);
  expect(first.written).toHaveLength(4); // two networks, two accounts
  expect(first.kept).toHaveLength(0);
  expect(existsSync(networkSkillPath("htmlblog"))).toBe(true);
  expect(existsSync(networkSkillPath("bluesky"))).toBe(true);
  expect(existsSync(accountSkillPath("htmlblog", blog.handle))).toBe(true);
  expect(accountSkillPath("htmlblog", blog.handle)).toBe(join(skillsDir(), "htmlblog", "dev.profullstack.com-~anthony-blog", "skill.md"));

  // A person tightens the blog and adds a note.
  const path = accountSkillPath("htmlblog", blog.handle);
  const edited = readFileSync(path, "utf8").replace("maxPerDay: 4", "maxPerDay: 2") + "\nMy own note.\n";
  writeFileSync(path, edited);

  const second = initSkills([blog, bsky]);
  expect(second.written).toHaveLength(0);
  expect(second.kept).toHaveLength(4);
  expect(readFileSync(path, "utf8")).toBe(edited);

  // --force rewrites from the template, which is the only way the note goes.
  const forced = initSkills([blog], { force: true });
  expect(forced.written).toHaveLength(2);
  expect(readFileSync(path, "utf8")).not.toContain("My own note.");
});

test("an account inherits from its network, and the stricter limit wins in either direction", () => {
  ensureNetworkSkill("htmlblog");
  ensureAccountSkill(blog);

  // Nothing edited: the template values, with the sources saying so.
  let resolved = resolveSkill(blog);
  expect(resolved.limits.maxPerDay).toBe(4);
  expect(resolved.limits.contentPolicy).toBe("major-features-only");
  // The body an agent reads is the account skill, then the network skill.
  expect(resolved.body.indexOf("# htmlblog:dev.profullstack.com")).toBeLessThan(resolved.body.indexOf("## What this blog is for"));

  // The network tightens to 2: the account, still at 4, gets 2.
  const netPath = networkSkillPath("htmlblog");
  writeFileSync(netPath, readFileSync(netPath, "utf8").replace("maxPerDay: 4", "maxPerDay: 2"));
  resolved = resolveSkill(blog);
  expect(resolved.limits.maxPerDay).toBe(2);
  expect(resolved.limits.sources.maxPerDay).toBe("network");

  // The account tightens further to 1: 1 wins.
  const acctPath = accountSkillPath("htmlblog", blog.handle);
  writeFileSync(acctPath, readFileSync(acctPath, "utf8").replace("maxPerDay: 4", "maxPerDay: 1"));
  resolved = resolveSkill(blog);
  expect(resolved.limits.maxPerDay).toBe(1);
  expect(resolved.limits.sources.maxPerDay).toBe("account");

  // The account loosens to 9 while the network says 2: the network's 2 holds.
  writeFileSync(acctPath, readFileSync(acctPath, "utf8").replace("maxPerDay: 1", "maxPerDay: 9"));
  expect(resolveSkill(blog).limits.maxPerDay).toBe(2);

  // A wider gap is the stricter gap.
  writeFileSync(acctPath, readFileSync(acctPath, "utf8").replace("minGapMinutes: 60", "minGapMinutes: 180"));
  expect(resolveSkill(blog).limits.minGapMinutes).toBe(180);
  expect(planLimitsFor(blog)).toEqual({ maxPerDay: 2, minGapMs: 180 * 60_000 });
});

test("a value in a file beats the template; settings.blog.maxPerDay stands in only when no file names one", () => {
  ensureNetworkSkill("htmlblog");
  ensureAccountSkill(blog);
  const settings = loadSettings();
  settings.blog.maxPerDay = 2;
  saveSettings(settings);

  // Both generated files say 4, so 4 it is: the files are the source of truth.
  expect(resolveSkill(blog).limits.maxPerDay).toBe(4);

  // Drop the line from both files and the setting takes over.
  for (const path of [networkSkillPath("htmlblog"), accountSkillPath("htmlblog", blog.handle)]) {
    writeFileSync(path, readFileSync(path, "utf8").replace(/^maxPerDay: 4\n/m, ""));
  }
  const resolved = resolveSkill(blog);
  expect(resolved.limits.maxPerDay).toBe(2);
  expect(resolved.limits.sources.maxPerDay).toBe("settings");

  // And a blog file that says 6 beats both the setting and the template.
  const path = accountSkillPath("htmlblog", blog.handle);
  writeFileSync(path, readFileSync(path, "utf8").replace("---\n\n", "maxPerDay: 6\n---\n\n"));
  expect(resolveSkill(blog).limits.maxPerDay).toBe(6);

  // The setting is for blogs; a social account never sees it.
  expect(resolveSkill(bsky).limits.maxPerDay).toBe(templateLimits("social", "bluesky").maxPerDay);
});

test("mergeLimits: stricter wins per key, the policy comes from the most specific layer", () => {
  const merged = mergeLimits(
    { maxPerDay: 4, minGapMinutes: 60, contentPolicy: "major-features-only" },
    [
      { name: "network", limits: { maxPerDay: 4, maxChars: 5000 } },
      { name: "account", limits: { maxPerDay: 3, minGapMinutes: 30, requiresCanonical: true } },
      { name: "selected", limits: { maxPerDay: 8, maxChars: 1000, contentPolicy: "launch-week" } },
    ],
  );
  expect(merged).toMatchObject({ maxPerDay: 3, minGapMinutes: 30, maxChars: 1000, requiresCanonical: true, contentPolicy: "launch-week" });
  expect(merged.sources).toMatchObject({ maxPerDay: "account", maxChars: "selected", contentPolicy: "selected" });
});

test("more skills rotate in order, the cursor lives in settings, and a pin or the default is used otherwise", () => {
  ensureAccountSkill(blog);
  addAccountSkill(blog, "launch-week", "---\ncontentPolicy: launch-week\n---\n\nThis week, three features, one post.");
  addAccountSkill(blog, "quiet", "Say less.");
  expect(listAccountSkills(blog).map((file) => file.slug)).toEqual(["skill", "launch-week", "quiet"]);

  // Off by default: the generated default is what a post uses.
  expect(selectSkill(blog).skill.slug).toBe("skill");
  expect(selectSkill(blog).rotating).toBe(false);

  // Pin one.
  pinDefaultSkill(blog, "quiet");
  expect(selectSkill(blog).skill.slug).toBe("quiet");
  expect(loadSettings().skills.defaults[blog.id]).toBe("quiet");
  expect(takeSkill(blog).slug).toBe("quiet");
  expect(takeSkill(blog).slug).toBe("quiet");
  // Not rotating, so no cursor was written.
  expect(loadSettings().skills.cursor[blog.id]).toBeUndefined();

  // Rotate: first in order first, then the next after the one used last.
  setRotation(blog, true);
  expect(selectSkill(blog).skill.slug).toBe("skill");
  expect(takeSkill(blog).slug).toBe("skill");
  expect(loadSettings().skills.cursor[blog.id]).toBe("skill");
  // Peeking does not move it.
  expect(selectSkill(blog).skill.slug).toBe("launch-week");
  expect(selectSkill(blog).skill.slug).toBe("launch-week");
  expect(takeSkill(blog).slug).toBe("launch-week");
  expect(takeSkill(blog).slug).toBe("quiet");
  expect(takeSkill(blog).slug).toBe("skill");
  expect(loadSettings().skills.cursor[blog.id]).toBe("skill");
  // The files themselves are untouched by all of this.
  expect(readFileSync(accountSkillPath("htmlblog", blog.handle, "quiet"), "utf8")).not.toContain("cursor");

  // Off again: back to the pin.
  setRotation(blog, false);
  expect(selectSkill(blog).skill.slug).toBe("quiet");

  // Removing the pinned one clears the pin and the cursor.
  expect(removeAccountSkill(blog, "quiet")).toBe(true);
  expect(loadSettings().skills.defaults[blog.id]).toBeUndefined();
  expect(selectSkill(blog).skill.slug).toBe("skill");
  expect(() => removeAccountSkill(blog, "skill")).toThrow(/default/);
  expect(() => addAccountSkill(blog, "skill", "x")).toThrow(/default/);
});

test("a rotated skill can tighten the cap and never loosen it", () => {
  ensureNetworkSkill("htmlblog");
  ensureAccountSkill(blog);
  addAccountSkill(blog, "loose", "---\nmaxPerDay: 20\n---\n\nPost all day.");
  addAccountSkill(blog, "tight", "---\nmaxPerDay: 1\nminGapMinutes: 600\n---\n\nOne a day.");
  setRotation(blog, true);

  // The default's 4 holds against the loose skill.
  const loose = selectSkill(blog).all.find((file) => file.slug === "loose")!;
  expect(resolveSkill(blog, { selected: loose }).limits.maxPerDay).toBe(4);
  expect(resolveSkill(blog, { selected: loose }).limits.sources.maxPerDay).toBe("network");

  // The tight one narrows it.
  const tight = selectSkill(blog).all.find((file) => file.slug === "tight")!;
  const resolved = resolveSkill(blog, { selected: tight });
  expect(resolved.limits.maxPerDay).toBe(1);
  expect(resolved.limits.minGapMinutes).toBe(600);
  expect(resolved.limits.sources.maxPerDay).toBe("selected");
  // Its body leads, the network's follows.
  expect(resolved.body.startsWith("One a day.")).toBe(true);
  expect(resolved.body).toContain("## What this blog is for");
});

test("a blog refuses a title it already carries; a social account repeats freely", () => {
  const history: HistoryEntry[] = [
    { at: "2026-09-06T04:35:07.000Z", accountId: blog.id, network: "htmlblog", handle: blog.handle, text: "# NicheDB Premium: a dollar a day\n\nnichedb.dev has a paid tier.", ok: true, url: "https://dev.profullstack.com/~anthony/blog/058-post.html" },
    { at: "2026-09-06T05:00:00.000Z", accountId: blog.id, network: "htmlblog", handle: blog.handle, text: "body only", ok: true, title: "The job board is a blackhole" },
    { at: "2026-09-06T05:10:00.000Z", accountId: blog.id, network: "htmlblog", handle: blog.handle, text: "# Failed one", ok: false },
    { at: "2026-09-06T06:00:00.000Z", accountId: bsky.id, network: "bluesky", handle: bsky.handle, text: "NicheDB Premium: a dollar a day", ok: true },
  ];
  expect(titleOf("# NicheDB Premium: a dollar a day\n\nbody")).toBe("NicheDB Premium: a dollar a day");
  expect(titleOf("body", "Given title")).toBe("Given title");

  // Same first line, different body: a duplicate.
  expect(duplicateTitle(blog, "# NicheDB Premium: a dollar a day\n\nnew body", undefined, history)?.url).toContain("058-post");
  // Whitespace and case do not make it new.
  expect(duplicateTitle(blog, "#   nichedb premium:  A Dollar a Day", undefined, history)).toBeDefined();
  // A --title matches a recorded title.
  expect(duplicateTitle(blog, "anything", "The job board is a blackhole", history)).toBeDefined();
  // A failed attempt never counted as published.
  expect(duplicateTitle(blog, "# Failed one", undefined, history)).toBeUndefined();
  // A new title is fine, and a social account is never checked.
  expect(duplicateTitle(blog, "# Something new", undefined, history)).toBeUndefined();
  expect(duplicateTitle(bsky, "NicheDB Premium: a dollar a day", undefined, history)).toBeUndefined();
  // dev.to is a mirror and gets the same check.
  expect(duplicateTitle(devto, "# x", undefined, [{ ...history[0], accountId: devto.id, network: "devto" }])).toBeUndefined();
  expect(duplicateTitle(devto, "# NicheDB Premium: a dollar a day", undefined, [{ ...history[0], accountId: devto.id, network: "devto" }])).toBeDefined();
});

test("a target is found by id, by network:slug, or by handle", () => {
  const targets = [blog, bsky, board];
  expect(findSkillTarget("htmlblog:dev.profullstack.com/~anthony/blog", targets)).toBe(blog);
  expect(findSkillTarget("htmlblog:dev.profullstack.com-~anthony-blog", targets)).toBe(blog);
  expect(findSkillTarget("chovyfu.bsky.social", targets)).toBe(bsky);
  expect(findSkillTarget("tsbb:member@bbs.hqtui.com", targets)).toBe(board);
  expect(findSkillTarget("htmlblog", targets)).toBeUndefined();
  expect(findSkillTarget("bluesky:nobody", targets)).toBeUndefined();
});

test("reading a network skill without a file gives the template, and materialising writes it once", () => {
  const virtual = readNetworkSkill("bluesky");
  expect(virtual.raw).toBe("");
  expect(virtual.frontmatter.maxChars).toBe(300);
  const written = readNetworkSkill("bluesky", { materialise: true });
  expect(written.raw).toContain("name: myna-bluesky");
  expect(ensureNetworkSkill("bluesky").written).toBe(false);
});
