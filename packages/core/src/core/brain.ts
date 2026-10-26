/**
 * The brain: the team's marketing knowledge and skills as plain Markdown in a
 * git repo, so every change is versioned, a rollback is one revert, the files
 * are nobody's proprietary format, and every teammate's AI reads the same
 * thing.
 *
 *   <brain>/
 *     README.md
 *     knowledge/
 *       positioning.md   what it is, who it is for, why it is different
 *       voice.md         brand voice
 *       audience.md      the ideal customer
 *       objections.md    what prospects push back on or ask
 *       *.md             any other knowledge file
 *       <product>/*.md   per-product files for a multi-product brain
 *     skills/            the same layout as ~/.config/myna/skills
 *
 * OutreachGraph writes the same layout (`og brain export`), so one repo can
 * be fed by both tools. brand.md stays: it is this person's short voice card;
 * the brain is the team's longer reference, appended after it.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { brainCloneDir } from "../util/paths.ts";
import { brainRoot, brainSettings, isGitUrl, saveBrainSettings, type BrainSettings } from "../store/brain.ts";
import { parseSkill, skillsDir } from "../store/skills.ts";
import type { Brand } from "./brand.ts";

export { brainRoot, brainSettings, isGitUrl, type BrainSettings };

/** The most knowledge text that goes into one system prompt. */
export const BRAIN_PROMPT_CAP = 24 * 1024;
/** These go first, in this order; everything else follows alphabetically. */
export const BRAIN_PRIORITY = ["positioning", "voice", "audience", "objections"];
/** Pull at most this often from the daemon. */
export const BRAIN_PULL_EVERY_MS = 3_600_000;

/* ------------------------------------------------------------------ git */

interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

function git(args: string[], cwd?: string): GitResult {
  const run = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    // Never stop to ask for a password: a daemon has nobody to answer.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeout: 120_000,
  });
  if (run.error) return { ok: false, out: "", err: run.error.message };
  return { ok: run.status === 0, out: (run.stdout ?? "").trim(), err: (run.stderr ?? "").trim() };
}

const isGitRepo = (dir: string): boolean => existsSync(dir) && git(["rev-parse", "--is-inside-work-tree"], dir).out === "true";

const head = (dir: string): string | undefined => {
  const result = git(["rev-parse", "HEAD"], dir);
  return result.ok ? result.out : undefined;
};

/* ------------------------------------------------------------ knowledge */

export interface KnowledgeFile {
  /** The name without `.md`: "positioning". */
  name: string;
  /** Relative to the brain root: "knowledge/acme/positioning.md". */
  path: string;
  /** Set when the file came from knowledge/<product>/. */
  product?: string;
  frontmatter: Record<string, unknown>;
  body: string;
  bytes: number;
}

const mdFiles = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md") && !name.startsWith("."))
    .filter((name) => {
      try {
        return statSync(join(dir, name)).isFile();
      } catch {
        return false;
      }
    });
};

function readKnowledge(root: string, rel: string, product?: string): KnowledgeFile {
  const raw = readFileSync(join(root, rel), "utf8");
  const { frontmatter, body } = parseSkill(raw);
  const name = rel.replace(/\\/g, "/").split("/").pop()!.replace(/\.md$/, "");
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === "" || value === undefined) continue;
    clean[key] = value;
  }
  return { name, path: rel.replace(/\\/g, "/"), product, frontmatter: clean, body, bytes: Buffer.byteLength(raw) };
}

const rank = (name: string): number => {
  const index = BRAIN_PRIORITY.indexOf(name.toLowerCase());
  return index === -1 ? BRAIN_PRIORITY.length : index;
};

/**
 * The knowledge files that apply, in prompt order: knowledge/*.md, with
 * knowledge/<product>/*.md replacing a same-named root file when a product is
 * set. positioning, voice, audience, objections first; then alphabetical.
 */
export function knowledgeFiles(root: string, product?: string): KnowledgeFile[] {
  const dir = join(root, "knowledge");
  const byName = new Map<string, KnowledgeFile>();
  for (const name of mdFiles(dir)) {
    if (name.toLowerCase() === "readme.md") continue;
    const file = readKnowledge(root, join("knowledge", name));
    byName.set(file.name.toLowerCase(), file);
  }
  if (product) {
    for (const name of mdFiles(join(dir, product))) {
      if (name.toLowerCase() === "readme.md") continue;
      const file = readKnowledge(root, join("knowledge", product, name), product);
      byName.set(file.name.toLowerCase(), file);
    }
  }
  return [...byName.values()].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

/** A knowledge file's frontmatter, folded into one short header line. */
function header(file: KnowledgeFile): string {
  const title = typeof file.frontmatter.title === "string" ? file.frontmatter.title : typeof file.frontmatter.name === "string" ? file.frontmatter.name : file.name;
  const meta = Object.entries(file.frontmatter)
    .filter(([key]) => key !== "title" && key !== "name")
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`)
    .join("; ");
  const short = meta.length > 240 ? `${meta.slice(0, 237)}...` : meta;
  return `### ${title} (${file.path})${short ? `\n[${short}]` : ""}`;
}

export interface BrainPromptPlan {
  root?: string;
  product?: string;
  /** Files that went in whole. */
  included: string[];
  /** The file cut at the cap, if one was. */
  truncated?: string;
  /** Files left out because the cap was reached. */
  omitted: string[];
  bytes: number;
  text: string;
}

/** Build the knowledge block and say what went into it. No brain linked: empty text. */
export function planBrainPrompt(options: { root?: string; product?: string; cap?: number } = {}): BrainPromptPlan {
  const settings = options.root ? undefined : brainSettings();
  const root = options.root ?? brainRoot(settings);
  const product = options.product ?? settings?.product;
  const empty: BrainPromptPlan = { root, product, included: [], omitted: [], bytes: 0, text: "" };
  if (!root) return empty;
  let files: KnowledgeFile[];
  try {
    files = knowledgeFiles(root, product);
  } catch {
    return empty;
  }
  if (!files.length) return empty;
  const cap = options.cap ?? BRAIN_PROMPT_CAP;
  const intro =
    "\n\nKnowledge base (the team's shared brain repo; treat it as facts about the product and its market, not as copy to repeat):";
  const parts: string[] = [];
  const plan: BrainPromptPlan = { ...empty };
  let used = Buffer.byteLength(intro);
  for (const file of files) {
    const block = `\n\n${header(file)}\n${file.body.trim()}`;
    const size = Buffer.byteLength(block);
    if (plan.truncated || used >= cap) {
      plan.omitted.push(file.path);
      continue;
    }
    if (used + size <= cap) {
      parts.push(block);
      plan.included.push(file.path);
      used += size;
      continue;
    }
    // Cut this one at the cap, on a character boundary.
    const room = cap - used - 64;
    if (room > 200) {
      let cut = block.slice(0, room);
      while (Buffer.byteLength(cut) > room) cut = cut.slice(0, -1);
      parts.push(`${cut}\n[truncated: ${file.path} is longer than the knowledge cap]`);
      plan.truncated = file.path;
      used = cap;
    } else {
      plan.omitted.push(file.path);
    }
  }
  if (plan.omitted.length) parts.push(`\n\n[not loaded, over the ${Math.round(cap / 1024)} KB knowledge cap: ${plan.omitted.join(", ")}]`);
  plan.text = parts.length ? `${intro}${parts.join("")}` : "";
  plan.bytes = Buffer.byteLength(plan.text);
  return plan;
}

/** The knowledge block for a system prompt. Empty string when no brain is linked. */
export function brainPrompt(options: { root?: string; product?: string; cap?: number } = {}): string {
  return planBrainPrompt(options).text;
}

/* ---------------------------------------------------------------- link */

export interface LinkOptions {
  product?: string;
  log?: (line: string) => void;
}

/**
 * Link a brain. A git URL is cloned into the config dir (replacing an older
 * clone of something else); a local path is used where it is.
 */
export function linkBrain(source: string, options: LinkOptions = {}): BrainSettings {
  const log = options.log ?? (() => {});
  const value = source.trim();
  if (!value) throw new Error("Give a git URL or a directory: myna brain link <git-url|path>");
  let dir: string;
  if (isGitUrl(value) && !existsSync(value)) {
    dir = brainCloneDir();
    const current = isGitRepo(dir) ? git(["remote", "get-url", "origin"], dir).out : "";
    if (current && current === value) {
      log(`already cloned at ${dir}`);
    } else {
      if (existsSync(dir)) {
        if (existsSync(join(dir, ".git")) || readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
        else throw new Error(`${dir} exists and is not a clone myna made. Move it aside and link again.`);
      }
      log(`cloning ${value} into ${dir}`);
      const cloned = git(["clone", "--quiet", value, dir]);
      if (!cloned.ok) throw new Error(`git clone failed: ${cloned.err || cloned.out}`);
    }
  } else {
    dir = resolve(value.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`${dir} is not a directory. Give a git URL or an existing brain directory (myna brain init <dir> makes one).`);
  }
  if (!existsSync(join(dir, "knowledge")) && !existsSync(join(dir, "skills"))) {
    log(`note: ${dir} has no knowledge/ or skills/ yet; see docs/brain.md for the layout`);
  }
  const brain: BrainSettings = {
    source: isGitUrl(value) && !existsSync(value) ? value : dir,
    dir,
    ...(options.product ? { product: options.product } : {}),
    lastPull: new Date().toISOString(),
  };
  saveBrainSettings(brain);
  return brain;
}

/** Forget the brain. A clone under the config dir is deleted; a local path is left alone. */
export function unlinkBrain(): { was?: BrainSettings; removed?: string } {
  const was = brainSettings();
  if (!was) return {};
  saveBrainSettings(undefined);
  const clone = brainCloneDir();
  if (isGitUrl(was.source) && existsSync(clone)) {
    rmSync(clone, { recursive: true, force: true });
    return { was, removed: clone };
  }
  return { was };
}

/* ---------------------------------------------------------------- pull */

export interface PullResult {
  ok: boolean;
  /** Why nothing was pulled, when nothing was. */
  skipped?: string;
  cloned?: boolean;
  dir?: string;
  from?: string;
  to?: string;
  changed: string[];
  error?: string;
}

/**
 * `git pull --ff-only` in the brain. A missing clone of a git source (the
 * settings came from another machine) is cloned first. A directory that is
 * not a git repo is skipped, not an error.
 */
export function pullBrain(): PullResult {
  const brain = brainSettings();
  if (!brain) return { ok: true, skipped: "no brain linked", changed: [] };
  let dir = brainRoot(brain);
  if (!dir) {
    if (!isGitUrl(brain.source)) return { ok: false, error: `${brain.dir} is missing on this machine`, changed: [] };
    dir = brainCloneDir();
    const cloned = git(["clone", "--quiet", brain.source, dir]);
    if (!cloned.ok) return { ok: false, dir, error: `git clone failed: ${cloned.err || cloned.out}`, changed: [] };
    saveBrainSettings({ ...brain, dir, lastPull: new Date().toISOString() });
    return { ok: true, cloned: true, dir, to: head(dir), changed: listBrainFiles(dir).map((file) => file.path) };
  }
  if (!isGitRepo(dir)) return { ok: true, skipped: `${dir} is not a git repo`, dir, changed: [] };
  const from = head(dir);
  const hasUpstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], dir).ok;
  if (!hasUpstream) return { ok: true, skipped: "no upstream branch to pull from", dir, from, to: from, changed: [] };
  const pulled = git(["pull", "--ff-only", "--quiet"], dir);
  if (!pulled.ok) return { ok: false, dir, from, error: `git pull --ff-only failed: ${pulled.err || pulled.out}`, changed: [] };
  const to = head(dir);
  const changed = from && to && from !== to ? git(["diff", "--name-only", from, to], dir).out.split("\n").filter(Boolean) : [];
  saveBrainSettings({ ...brain, dir: brain.dir || dir, lastPull: new Date().toISOString() });
  return { ok: true, dir, from, to, changed };
}

/** The daemon's turn: at most hourly, never throws. Returns a log line or nothing. */
export function brainDaemonTurn(now = Date.now()): string | undefined {
  try {
    const brain = brainSettings();
    if (!brain) return undefined;
    const last = brain.lastPull ? Date.parse(brain.lastPull) : 0;
    if (Number.isFinite(last) && now - last < BRAIN_PULL_EVERY_MS) return undefined;
    const result = pullBrain();
    if (!result.ok) return `pull failed: ${result.error}`;
    if (result.skipped) return undefined;
    if (result.cloned) return `cloned ${brain.source}`;
    return result.changed.length ? `pulled ${result.changed.length} changed file${result.changed.length === 1 ? "" : "s"}` : undefined;
  } catch (error) {
    return `pull failed: ${(error as Error).message}`;
  }
}

/* ---------------------------------------------------------------- push */

export interface PushResult {
  ok: boolean;
  committed: boolean;
  pushed: boolean;
  sha?: string;
  note?: string;
  error?: string;
}

/** `git add -A`, commit, push. For a teammate who edits the brain through myna. */
export function pushBrain(message = "Update brain via myna"): PushResult {
  const dir = brainRoot();
  if (!dir) return { ok: false, committed: false, pushed: false, error: "no brain linked (myna brain link <git-url|path>)" };
  if (!isGitRepo(dir)) return { ok: false, committed: false, pushed: false, error: `${dir} is not a git repo` };
  git(["add", "-A"], dir);
  const dirty = git(["status", "--porcelain"], dir).out.length > 0;
  let committed = false;
  if (dirty) {
    const commit = git(["commit", "--quiet", "-m", message], dir);
    if (!commit.ok) return { ok: false, committed: false, pushed: false, error: `git commit failed: ${commit.err || commit.out}` };
    committed = true;
  }
  const sha = head(dir)?.slice(0, 7);
  const remotes = git(["remote"], dir).out;
  if (!remotes) return { ok: true, committed, pushed: false, sha, note: "no remote to push to; committed locally" };
  const push = git(["push", "--quiet"], dir);
  if (!push.ok) {
    // A new branch with no upstream: set it once.
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], dir).out;
    const retry = git(["push", "--quiet", "-u", remotes.split("\n")[0], branch], dir);
    if (!retry.ok) return { ok: false, committed, pushed: false, sha, error: `git push failed: ${retry.err || push.err}` };
  }
  return { ok: true, committed, pushed: true, sha, note: committed ? undefined : "nothing to commit; pushed what was there" };
}

/* -------------------------------------------------------------- status */

export interface BrainFile {
  path: string;
  bytes: number;
}

/** Every file in the brain, .git aside, relative to its root. */
export function listBrainFiles(root: string): BrainFile[] {
  const out: BrainFile[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === ".git") continue;
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) out.push({ path: relative(root, path).replace(/\\/g, "/"), bytes: stat.size });
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

export interface BrainStatus {
  linked: boolean;
  source?: string;
  dir?: string;
  present: boolean;
  product?: string;
  lastPull?: string;
  git?: { sha: string; subject: string; branch?: string; dirty: boolean };
  files: BrainFile[];
  prompt: Omit<BrainPromptPlan, "text">;
}

export function brainStatus(): BrainStatus {
  const brain = brainSettings();
  const empty = { included: [], omitted: [], bytes: 0 };
  if (!brain) return { linked: false, present: false, files: [], prompt: empty };
  const dir = brainRoot(brain);
  const status: BrainStatus = {
    linked: true,
    source: brain.source,
    dir: dir ?? brain.dir,
    present: Boolean(dir),
    product: brain.product,
    lastPull: brain.lastPull,
    files: dir ? listBrainFiles(dir) : [],
    prompt: empty,
  };
  if (dir && isGitRepo(dir)) {
    const log = git(["log", "-1", "--format=%h%x00%s"], dir);
    if (log.ok && log.out) {
      const [sha, subject] = log.out.split("\0");
      status.git = {
        sha,
        subject: subject ?? "",
        branch: git(["rev-parse", "--abbrev-ref", "HEAD"], dir).out || undefined,
        dirty: git(["status", "--porcelain"], dir).out.length > 0,
      };
    }
  }
  const { text: _text, ...plan } = planBrainPrompt();
  status.prompt = plan;
  return status;
}

/* ---------------------------------------------------------------- init */

const README = `# Content brain

This repo is the marketing team's shared brain: what we say, who we say it to,
how we sound, and what prospects push back on. Every teammate's AI reads these
same files, so a change here changes every draft, and a bad change is one
\`git revert\` away.

## Layout

\`\`\`
knowledge/
  positioning.md   what it is, who it is for, why it is different
  voice.md         brand voice
  audience.md      the ideal customer
  objections.md    what prospects push back on or ask
  *.md             any other knowledge file
  <product>/*.md   per-product files; they override same-named root files
skills/            per-network, per-account and per-post-type rules
                   (types/<type>/skill.md, <network>/skill.md,
                   <network>/<account>/skill.md, extra *.md)
\`\`\`

Every knowledge file is Markdown with optional YAML frontmatter (\`title\`,
\`updated\`, \`owner\`, anything flat). Plain files, any editor, any AI.

## Workflow

- Edit on a branch, open a pull request, review it like code, merge.
- \`myna brain pull\` (the myna daemon also pulls hourly) brings the change to
  every machine. \`myna brain push -m "..."\` commits and pushes from myna.
- \`myna brain show --prompt\` prints exactly what the writer will read.
- OutreachGraph can write into the same repo: \`og brain export\`.
`;

const TEMPLATES: Record<string, string> = {
  positioning: `---
title: Positioning
---

# Positioning

Start here. Three short answers:

## What we do

(One or two sentences. What it is, in words a customer would use.)

## Who it is for

(The person who gets the most out of it, and the situation they are in.)

## Why it is different

(What we claim that a competitor would not, and the proof.)
`,
  voice: `---
title: Voice
---

# Voice

(How we sound, in specifics a writer could follow: sentence length, habits,
what we never do. Not adjectives.)

## Avoid

- (words, claims and tics that never go out)
`,
  audience: `---
title: Audience
---

# Audience

(The ideal customer: role, company size, what they already tried, what they
are trying to get done, and where they hang out.)
`,
  objections: `---
title: Objections
---

# Objections

(What prospects push back on or ask, and how we answer. One per heading.)

## "(objection)"

(our answer)
`,
};

function seededPositioning(brand: Brand): string {
  const lines = ["---", "title: Positioning", "source: brand.md", "---", "", `# ${brand.name || "Positioning"}`, ""];
  if (brand.positioning) lines.push("## Why it is different", "", brand.positioning, "");
  if (brand.audience) lines.push("## Who it is for", "", brand.audience, "");
  if (brand.pillars.length) {
    lines.push("## Pillars", "");
    for (const pillar of brand.pillars) lines.push(pillar.note ? `- ${pillar.name}: ${pillar.note}` : `- ${pillar.name}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function seededVoice(brand: Brand): string {
  const lines = ["---", "title: Voice", "source: brand.md", "---", "", "# Voice", ""];
  if (brand.voice) lines.push(brand.voice, "");
  if (brand.avoid.length) {
    lines.push("## Avoid", "");
    for (const item of brand.avoid) lines.push(`- ${item}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export interface InitBrainResult {
  dir: string;
  written: string[];
  seededFromBrand: boolean;
  skillsCopied: number;
  committed: boolean;
  note?: string;
  brain: BrainSettings;
}

/** Scaffold a brain repo at `dir`, seed it from brand.md and the local skills, commit, and link it. */
export function initBrain(target: string, options: { product?: string; force?: boolean; brand?: Brand | null } = {}): InitBrainResult {
  if (!target?.trim()) throw new Error("Say where: myna brain init <dir>");
  const dir = isAbsolute(target) ? target : resolve(target.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  if (existsSync(dir) && readdirSync(dir).length > 0 && !options.force) {
    throw new Error(`${dir} is not empty. Link an existing brain with: myna brain link ${dir}`);
  }
  mkdirSync(join(dir, "knowledge"), { recursive: true });
  const written: string[] = [];
  const put = (rel: string, body: string) => {
    const path = join(dir, rel);
    if (existsSync(path) && !options.force) return;
    writeFileSync(path, body);
    written.push(rel);
  };
  put("README.md", README);
  // The caller passes brand.md (loadBrand()); importing it here would loop brand.ts -> brain.ts -> brand.ts.
  const brand = options.brand ?? null;
  const hasPositioning = Boolean(brand && (brand.positioning || brand.audience || brand.pillars.length));
  const hasVoice = Boolean(brand && (brand.voice || brand.avoid.length));
  put("knowledge/positioning.md", hasPositioning && brand ? seededPositioning(brand) : TEMPLATES.positioning);
  put("knowledge/voice.md", hasVoice && brand ? seededVoice(brand) : TEMPLATES.voice);
  put("knowledge/audience.md", TEMPLATES.audience);
  put("knowledge/objections.md", TEMPLATES.objections);

  let skillsCopied = 0;
  const local = skillsDir();
  const skillsOut = join(dir, "skills");
  if (existsSync(local)) {
    cpSync(local, skillsOut, {
      recursive: true,
      filter: (src) => {
        const stat = statSync(src);
        if (stat.isDirectory()) return true;
        if (!src.endsWith(".md")) return false;
        skillsCopied += 1;
        return true;
      },
    });
  }
  mkdirSync(skillsOut, { recursive: true });
  if (!skillsCopied) {
    writeFileSync(join(skillsOut, ".gitkeep"), "");
  }

  let committed = false;
  let note: string | undefined;
  if (!isGitRepo(dir)) {
    const init = git(["init", "--quiet", "-b", "main"], dir);
    if (!init.ok) note = `git init failed: ${init.err}`;
  }
  if (isGitRepo(dir)) {
    git(["add", "-A"], dir);
    const commit = git(["commit", "--quiet", "-m", "myna brain init"], dir);
    if (commit.ok) committed = true;
    else note = `files written but not committed: ${commit.err || commit.out}`;
  }
  const brain = linkBrain(dir, { product: options.product });
  return { dir, written, seededFromBrand: hasPositioning || hasVoice, skillsCopied, committed, note, brain };
}
