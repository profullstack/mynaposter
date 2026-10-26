/**
 * The brain repo: what reaches the writer, in what order, under what cap;
 * linking and pulling a real git repo; the skills layer; and that sync now
 * carries brand.md. Every test runs in its own MYNA_HOME.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainDaemonTurn, brainPrompt, brainStatus, initBrain, knowledgeFiles, linkBrain, planBrainPrompt, pullBrain, pushBrain, unlinkBrain } from "../src/core/brain.ts";
import { brainSettings, isGitUrl, saveBrainSettings } from "../src/store/brain.ts";
import { writerContext, parseBrand } from "../src/core/brand.ts";
import { ensureNetworkSkill, readNetworkSkill } from "../src/core/skills.ts";
import { readTypeSkill } from "../src/core/post-types.ts";
import { networkSkillPath, writeSkillFile } from "../src/store/skills.ts";
import { MYNA_SYNC_POLICY } from "../src/store/synconfig.ts";

let home = "";
let scratch = "";
const saved: Record<string, string | undefined> = {};
const GIT_ENV = {
  GIT_AUTHOR_NAME: "myna test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "myna test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "myna-brain-home-"));
  scratch = mkdtempSync(join(tmpdir(), "myna-brain-repo-"));
  saved.MYNA_HOME = process.env.MYNA_HOME;
  process.env.MYNA_HOME = home;
  for (const [key, value] of Object.entries(GIT_ENV)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
};

const put = (root: string, rel: string, body: string) => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), body);
};

test("knowledge goes in priority order, then alphabetical, with frontmatter folded into a header", () => {
  const root = join(scratch, "brain");
  for (const name of ["zeta", "objections", "audience", "voice", "positioning", "alpha"]) {
    put(root, `knowledge/${name}.md`, `---\ntitle: ${name.toUpperCase()}\nowner: growth\n---\n\nbody of ${name}\n`);
  }
  put(root, "knowledge/README.md", "not knowledge");
  expect(knowledgeFiles(root).map((file) => file.name)).toEqual(["positioning", "voice", "audience", "objections", "alpha", "zeta"]);
  const text = brainPrompt({ root });
  expect(text).toContain("### POSITIONING (knowledge/positioning.md)\n[owner: growth]\nbody of positioning");
  expect(text).not.toContain("---\ntitle");
  expect(text).not.toContain("not knowledge");
  expect(text.indexOf("body of positioning")).toBeLessThan(text.indexOf("body of voice"));
  expect(text.indexOf("body of objections")).toBeLessThan(text.indexOf("body of alpha"));
});

test("the cap truncates the file that crosses it and names what was left out", () => {
  const root = join(scratch, "brain");
  put(root, "knowledge/positioning.md", "short positioning\n");
  put(root, "knowledge/voice.md", `${"v".repeat(3000)}\n`);
  put(root, "knowledge/zz.md", "never reached\n");
  const plan = planBrainPrompt({ root, cap: 1500 });
  expect(plan.included).toEqual(["knowledge/positioning.md"]);
  expect(plan.truncated).toBe("knowledge/voice.md");
  expect(plan.omitted).toEqual(["knowledge/zz.md"]);
  expect(plan.text).toContain("[truncated: knowledge/voice.md");
  expect(plan.text).toContain("knowledge/zz.md");
  expect(plan.text).not.toContain("never reached");
  expect(Buffer.byteLength(plan.text)).toBeLessThan(1500 + 200);
});

test("a product's files override same-named root files and add their own", () => {
  const root = join(scratch, "brain");
  put(root, "knowledge/voice.md", "root voice\n");
  put(root, "knowledge/positioning.md", "root positioning\n");
  put(root, "knowledge/acme/voice.md", "acme voice\n");
  put(root, "knowledge/acme/pricing.md", "acme pricing\n");
  const text = brainPrompt({ root, product: "acme" });
  expect(text).toContain("acme voice");
  expect(text).not.toContain("root voice");
  expect(text).toContain("root positioning");
  expect(text).toContain("acme pricing");
  expect(brainPrompt({ root })).not.toContain("acme");
});

test("linking a local path saves settings.brain and every writer gets the knowledge", () => {
  expect(writerContext(null)).toBe("");
  const root = join(scratch, "brain");
  put(root, "knowledge/positioning.md", "---\ntitle: Positioning\n---\n\nWe sell shovels to miners.\n");
  const brain = linkBrain(root, { product: "acme" });
  expect(brain).toMatchObject({ source: root, dir: root, product: "acme" });
  expect(brainSettings()?.dir).toBe(root);
  const settings = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
  expect(settings.brain.source).toBe(root);
  const brand = parseBrand("# Acme\n\n## Voice\n\nPlain.\n");
  const context = writerContext(brand);
  expect(context).toContain("You write as Acme.");
  expect(context).toContain("We sell shovels to miners.");
  expect(context.indexOf("Plain.")).toBeLessThan(context.indexOf("shovels"));
  const status = brainStatus();
  expect(status.linked).toBe(true);
  expect(status.prompt.included).toEqual(["knowledge/positioning.md"]);
  expect(status.files.map((file) => file.path)).toEqual(["knowledge/positioning.md"]);
  unlinkBrain();
  expect(brainSettings()).toBeUndefined();
  expect(existsSync(root)).toBe(true);
  expect(writerContext(null)).toBe("");
});

test("pull fast-forwards a git brain and reports changed files; a plain dir is skipped", () => {
  const upstream = join(scratch, "upstream");
  mkdirSync(upstream);
  git(upstream, "init", "--quiet", "-b", "main");
  put(upstream, "knowledge/positioning.md", "v1\n");
  git(upstream, "add", "-A");
  git(upstream, "commit", "--quiet", "-m", "one");

  const brain = linkBrain(`file://${upstream}`);
  expect(brain.dir).toBe(join(home, "brain"));
  expect(existsSync(join(home, "brain", "knowledge", "positioning.md"))).toBe(true);
  expect(pullBrain()).toMatchObject({ ok: true, changed: [] });

  put(upstream, "knowledge/objections.md", "too expensive\n");
  git(upstream, "add", "-A");
  git(upstream, "commit", "--quiet", "-m", "two");
  const pulled = pullBrain();
  expect(pulled.ok).toBe(true);
  expect(pulled.changed).toEqual(["knowledge/objections.md"]);
  expect(brainPrompt()).toContain("too expensive");
  expect(brainStatus().git?.subject).toBe("two");

  // Another machine: settings synced, clone missing. Pull clones on demand.
  rmSync(join(home, "brain"), { recursive: true, force: true });
  expect(brainPrompt()).toBe("");
  const again = pullBrain();
  expect(again).toMatchObject({ ok: true, cloned: true });
  expect(brainPrompt()).toContain("too expensive");

  const plain = join(scratch, "plain");
  put(plain, "knowledge/voice.md", "plain\n");
  linkBrain(plain);
  expect(pullBrain().skipped).toContain("not a git repo");
});

test("push commits and pushes to the remote", () => {
  const bare = join(scratch, "bare.git");
  git(scratch, "init", "--quiet", "--bare", "-b", "main", bare);
  const work = join(scratch, "work");
  git(scratch, "clone", "--quiet", bare, work);
  put(work, "knowledge/voice.md", "first\n");
  linkBrain(work);
  const result = pushBrain("add voice");
  expect(result).toMatchObject({ ok: true, committed: true, pushed: true });
  expect(git(bare, "log", "-1", "--format=%s", "main")).toBe("add voice");
});

test("the daemon turn never throws and waits an hour between pulls", () => {
  expect(brainDaemonTurn()).toBeUndefined();
  saveBrainSettings({ source: "file:///nonexistent/brain.git", dir: join(home, "brain") });
  const line = brainDaemonTurn();
  expect(line).toContain("pull failed");
  saveBrainSettings({ source: "file:///nonexistent/brain.git", dir: join(home, "brain"), lastPull: new Date().toISOString() });
  expect(brainDaemonTurn()).toBeUndefined();
});

test("brain skills fill what is missing locally; a hand-written local file wins; an untouched template yields", () => {
  const root = join(scratch, "brain");
  put(root, "skills/bluesky/skill.md", "---\nname: team-bluesky\ndescription: the team's rules\nmaxPerDay: 3\n---\n\nTeam rules.\n");
  put(root, "skills/types/launch/skill.md", "---\nname: team-launch\ndescription: launches\n---\n\nTeam launch.\n");
  linkBrain(root);

  let skill = readNetworkSkill("bluesky");
  expect(skill.source).toBe("brain");
  expect(skill.body).toBe("Team rules.");
  expect(readTypeSkill("launch")?.source).toBe("brain");

  // Materialising does not write a template that would shadow the team's file.
  expect(ensureNetworkSkill("bluesky").written).toBe(false);
  expect(existsSync(networkSkillPath("bluesky"))).toBe(false);

  // An untouched generated template here still yields to the brain.
  ensureNetworkSkill("bluesky", { force: true });
  expect(readNetworkSkill("bluesky").source).toBe("brain");

  // A file a person wrote here wins.
  writeSkillFile(networkSkillPath("bluesky"), { name: "mine", description: "my rules" }, "Local rules.");
  skill = readNetworkSkill("bluesky");
  expect(skill.source).toBe("local");
  expect(skill.body).toBe("Local rules.");

  unlinkBrain();
  expect(readNetworkSkill("mastodon").source).toBe("local");
});

test("init scaffolds a git repo seeded from brand.md and links it", () => {
  const dir = join(scratch, "new-brain");
  const brand = parseBrand("# Acme\n\n## Audience\n\nMiners.\n\n## Positioning\n\nShovels that last.\n\n## Voice\n\nShort.\n\n## Avoid\n\n- hype\n");
  const result = initBrain(dir, { brand });
  expect(result.seededFromBrand).toBe(true);
  expect(result.committed).toBe(true);
  expect(readFileSync(join(dir, "knowledge", "positioning.md"), "utf8")).toContain("Shovels that last.");
  expect(readFileSync(join(dir, "knowledge", "voice.md"), "utf8")).toContain("- hype");
  expect(existsSync(join(dir, "knowledge", "objections.md"))).toBe(true);
  expect(existsSync(join(dir, "README.md"))).toBe(true);
  expect(git(dir, "log", "-1", "--format=%s")).toBe("myna brain init");
  expect(brainSettings()?.dir).toBe(dir);
  expect(() => initBrain(dir, { brand: null })).toThrow("not empty");
  expect(brainPrompt()).toContain("Shovels that last.");
});

test("git URLs and paths are told apart", () => {
  expect(isGitUrl("git@github.com:acme/brain.git")).toBe(true);
  expect(isGitUrl("https://github.com/acme/brain")).toBe(true);
  expect(isGitUrl("file:///srv/brain.git")).toBe(true);
  expect(isGitUrl("/home/me/brain")).toBe(false);
  expect(isGitUrl("./brain")).toBe(false);
});

test("sync carries brand.md (and settings.json, which holds settings.brain)", () => {
  const paths = MYNA_SYNC_POLICY.files.map((file) => file.path);
  expect(paths).toContain("brand.md");
  expect(paths).toContain("settings.json");
});
