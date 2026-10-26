/**
 * Where the linked brain is, read straight from settings.json.
 *
 * Deliberately tiny and free of the settings module: store/skills.ts asks
 * this for the brain's skills/ on every skill read, and pulling the whole
 * settings graph into that path would be an import cycle waiting to happen.
 * settings.json is synced, so a second machine sees the same `brain` entry
 * and `myna brain pull` clones a git source on demand.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJson } from "../util/json.ts";
import { SETTINGS_FILE, brainCloneDir } from "../util/paths.ts";
import type { BrainSettings } from "./settings.ts";

export type { BrainSettings };

/** A source that git has to fetch, as opposed to a directory already here. */
export function isGitUrl(source: string): boolean {
  const value = source.trim();
  if (/^(https?|ssh|git|file):\/\//i.test(value)) return true;
  // scp-like: git@github.com:org/repo.git
  if (/^[\w.-]+@[\w.-]+:/.test(value)) return true;
  return false;
}

export function brainSettings(): BrainSettings | undefined {
  const stored = readJson<{ brain?: BrainSettings }>(SETTINGS_FILE, {});
  const brain = stored.brain;
  if (!brain || typeof brain.source !== "string" || !brain.source) return undefined;
  return brain;
}

/** Write (or with undefined, remove) settings.brain, leaving every other key as it is on disk. */
export function saveBrainSettings(brain: BrainSettings | undefined): void {
  const stored = readJson<Record<string, unknown>>(SETTINGS_FILE, {});
  if (brain) stored.brain = brain;
  else delete stored.brain;
  writeJson(SETTINGS_FILE, stored);
}

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The brain's working copy on this machine, when there is one. A git source
 * whose stored dir is missing (settings came from another machine) falls back
 * to the clone dir here; nothing is cloned by reading.
 */
export function brainRoot(brain: BrainSettings | undefined = brainSettings()): string | undefined {
  if (!brain) return undefined;
  if (brain.dir && isDir(brain.dir)) return brain.dir;
  if (isGitUrl(brain.source)) {
    const local = brainCloneDir();
    return isDir(local) ? local : undefined;
  }
  return undefined;
}

/** The brain's skills/ directory, when a brain is linked and has one. */
export function brainSkillsDir(): string | undefined {
  const root = brainRoot();
  if (!root) return undefined;
  const dir = join(root, "skills");
  return existsSync(dir) ? dir : undefined;
}
