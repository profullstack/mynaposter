/**
 * Skill files on disk.
 *
 * A skill is a Markdown file with YAML frontmatter, the same shape an agent
 * loads as a skill: `name`, `description`, then prose. myna keeps them under
 * the config dir, one tree per network:
 *
 *   ~/.config/myna/skills/<network>/skill.md               the network's rules
 *   ~/.config/myna/skills/<network>/<account>/skill.md     one account's default
 *   ~/.config/myna/skills/<network>/<account>/<slug>.md    more skills to rotate through
 *
 * The frontmatter also carries the limits myna itself enforces (`maxPerDay`,
 * `minGapMinutes`, `maxChars`, `requiresCanonical`, `contentPolicy`), so the
 * file a person edits is the file the scheduler reads. This module only knows
 * about paths, parsing and writing; what goes in a file is core/skills.ts.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { configPath } from "../util/paths.ts";

export const SKILLS_DIR = "skills";
/** The file name of the generated default, at both levels. */
export const DEFAULT_SKILL_SLUG = "skill";

export type SkillKind = "blog" | "social" | "forum" | "longform" | "directory" | "youtube" | "other";

/** The limits myna enforces, as they appear in frontmatter. Every one is optional. */
export interface SkillLimits {
  /** Posts to this account in any rolling 24 hours. */
  maxPerDay?: number;
  /** Least minutes between two posts here. Overrides the global gap when larger. */
  minGapMinutes?: number;
  /** Characters in one post; the network's own limit when absent. */
  maxChars?: number;
  /** A syndicated copy must carry rel=canonical back to the original. */
  requiresCanonical?: boolean;
  /** `major-features-only` on a blog; free text otherwise. */
  contentPolicy?: string;
}

export interface SkillFrontmatter extends SkillLimits {
  name: string;
  description: string;
  kind?: SkillKind;
  network?: string;
  account?: string;
  /** The template version this file was written from; absent once a person edits it. */
  generatedFrom?: string;
  /** Anything else a person put in the frontmatter, kept as written. */
  [key: string]: string | number | boolean | undefined;
}

export interface SkillFile {
  /** The file name without `.md`. */
  slug: string;
  path: string;
  frontmatter: SkillFrontmatter;
  body: string;
  raw: string;
}

/**
 * A handle as a directory name. Handles carry slashes (`profullstack/hqtui`,
 * `dev.profullstack.com/~anthony/blog`), spaces (`Anthony Ettinger`) and
 * colons, none of which belong in one path segment or one URL segment.
 */
export function handleSlug(handle: string): string {
  return handle
    .trim()
    .replace(/^@/, "")
    .replace(/[\s/\\:]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "account";
}

export function skillsDir(): string {
  return configPath(SKILLS_DIR);
}

export function networkSkillDir(network: string): string {
  return join(skillsDir(), network);
}

export function networkSkillPath(network: string): string {
  return join(networkSkillDir(network), `${DEFAULT_SKILL_SLUG}.md`);
}

export function accountSkillDir(network: string, handle: string): string {
  return join(networkSkillDir(network), handleSlug(handle));
}

export function accountSkillPath(network: string, handle: string, slug = DEFAULT_SKILL_SLUG): string {
  return join(accountSkillDir(network, handle), `${safeSlug(slug)}.md`);
}

/** A skill slug typed by a person: lower-case, digits, dashes. */
export function safeSlug(slug: string): string {
  const clean = slug
    .trim()
    .toLowerCase()
    .replace(/\.md$/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!clean) throw new Error(`"${slug}" is not a usable skill name. Use letters, digits and dashes.`);
  return clean;
}

/* ------------------------------------------------------------------ parsing */

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function readScalar(raw: string): string | number | boolean {
  const value = raw.trim();
  if (/^"(.*)"$/.test(value)) return value.slice(1, -1).replace(/\\"/g, '"');
  if (/^'(.*)'$/.test(value)) return value.slice(1, -1);
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

/**
 * Split a skill file into frontmatter and body. The frontmatter is the flat
 * `key: value` subset of YAML; that is all a skill needs and it means no
 * dependency. A file without frontmatter is all body with an empty name.
 */
export function parseSkill(raw: string): { frontmatter: SkillFrontmatter; body: string } {
  const match = raw.match(FRONTMATTER);
  if (!match) return { frontmatter: { name: "", description: "" }, body: raw.trim() };
  const frontmatter: SkillFrontmatter = { name: "", description: "" };
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    const key = line.slice(0, colon).trim();
    const value = readScalar(line.slice(colon + 1));
    frontmatter[key] = value;
  }
  frontmatter.name = String(frontmatter.name ?? "");
  frontmatter.description = String(frontmatter.description ?? "");
  return { frontmatter, body: match[2].trim() };
}

function writeScalar(value: string | number | boolean): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // Quote anything YAML would otherwise misread: a colon, a leading symbol, a bare number or boolean.
  if (value === "" || /[:#'"\n]|^[\s\-?&*!|>%@`[\]{},]|^(true|false|null|~)$|^-?\d+(\.\d+)?$/.test(value) || /^\s|\s$/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

/** The order the well-known keys are written in; anything else follows alphabetically. */
const KEY_ORDER = ["name", "description", "kind", "network", "account", "profileUrl", "connectedAt", "maxPerDay", "minGapMinutes", "maxChars", "requiresCanonical", "contentPolicy", "generatedFrom"];

export function serializeSkill(frontmatter: SkillFrontmatter, body: string): string {
  const keys = Object.keys(frontmatter).filter((key) => frontmatter[key] !== undefined);
  keys.sort((a, b) => {
    const ia = KEY_ORDER.indexOf(a);
    const ib = KEY_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  const lines = keys.map((key) => `${key}: ${writeScalar(frontmatter[key] as string | number | boolean)}`);
  return `---\n${lines.join("\n")}\n---\n\n${body.trim()}\n`;
}

/* --------------------------------------------------------------------- IO */

export function readSkillFile(path: string): SkillFile | undefined {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8");
  const { frontmatter, body } = parseSkill(raw);
  const slug = path.replace(/\\/g, "/").split("/").pop()?.replace(/\.md$/, "") ?? DEFAULT_SKILL_SLUG;
  return { slug, path, frontmatter, body, raw };
}

/** Write a skill file. Atomic, like every other file in the config dir. */
export function writeSkillFile(path: string, frontmatter: SkillFrontmatter, body: string): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, serializeSkill(frontmatter, body), { mode: 0o600 });
  renameSync(tmp, path);
}

export function removeSkillFile(path: string): boolean {
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

/** The `.md` files directly inside `dir`, default first, then alphabetical. */
export function listSkillFiles(dir: string): SkillFile[] {
  if (!existsSync(dir)) return [];
  const files: SkillFile[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    const file = readSkillFile(path);
    if (file) files.push(file);
  }
  return files.sort((a, b) => {
    if (a.slug === DEFAULT_SKILL_SLUG) return -1;
    if (b.slug === DEFAULT_SKILL_SLUG) return 1;
    return a.slug.localeCompare(b.slug);
  });
}

/** Every network directory that has a skill tree, alphabetical. */
export function listSkillNetworks(): string[] {
  const dir = skillsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort();
}

/** Every account directory under a network's skill tree. */
export function listSkillAccountDirs(network: string): string[] {
  const dir = networkSkillDir(network);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort();
}
