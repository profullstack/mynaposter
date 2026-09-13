/**
 * What a tool lets out of its config directory, and what it never does.
 *
 * The policy is data, so the tool declares it once and both sides of the
 * sync (the collector on the way out, the validator on the way in) apply
 * the same one. A file is synced only when the policy names it, by exact
 * path or as a member of a named directory with an allowed suffix; and
 * never when it is on the never list, under a never prefix, or carries a
 * never suffix. Secrets, sessions, ledgers and sockets belong on the never
 * side, and the point of the allowlist is that forgetting to add a new
 * file there fails safe.
 */

export interface SyncedFile {
  /** Relative to the config directory, forward slashes. */
  path: string;
  /** Parse as JSON on the way out and in; a file that does not parse is skipped, not synced broken. */
  json?: boolean;
  label?: string;
}

export interface SyncedDir {
  /** A directory whose files are synced recursively. */
  path: string;
  /** Only files with one of these suffixes; default: every file. */
  suffixes?: string[];
  label?: string;
}

export interface SyncPolicy {
  files: SyncedFile[];
  dirs?: SyncedDir[];
  /** Exact relative paths that are never synced, whatever the lists above say. */
  never?: string[];
  neverPrefixes?: string[];
  neverSuffixes?: string[];
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxFiles?: number;
}

export interface SyncLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
}

/** moshcode's numbers: a config file is small, and a snapshot is a page, not a backup. */
export const DEFAULT_LIMITS: SyncLimits = { maxFileBytes: 64 * 1024, maxTotalBytes: 256 * 1024, maxFiles: 64 };

export function limitsOf(policy: SyncPolicy): SyncLimits {
  return {
    maxFileBytes: policy.maxFileBytes ?? DEFAULT_LIMITS.maxFileBytes,
    maxTotalBytes: policy.maxTotalBytes ?? DEFAULT_LIMITS.maxTotalBytes,
    maxFiles: policy.maxFiles ?? DEFAULT_LIMITS.maxFiles,
  };
}

/**
 * A relative path as the snapshot spells it, or null when it is not one: no
 * leading slash, no `..`, no backslash, no empty or dot segments, so a path
 * from a server can never reach outside the config directory.
 */
export function normalizeRel(path: string): string | null {
  if (typeof path !== "string" || !path || path.length > 512) return null;
  if (path.includes("\\") || path.startsWith("/") || path.includes("\0")) return null;
  const segments = path.split("/");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") return null;
  }
  return segments.join("/");
}

const norm = (path: string): string => path.replace(/^\.?\//, "").replace(/\/+$/, "");

/** Is this relative path one the policy lets through? */
export function isSyncable(policy: SyncPolicy, path: string): boolean {
  const rel = normalizeRel(path);
  if (!rel) return false;
  if ((policy.never ?? []).some((entry) => norm(entry) === rel)) return false;
  if ((policy.neverPrefixes ?? []).some((prefix) => rel.startsWith(`${norm(prefix)}/`) || rel === norm(prefix))) return false;
  if ((policy.neverSuffixes ?? []).some((suffix) => rel.endsWith(suffix))) return false;
  if (policy.files.some((entry) => norm(entry.path) === rel)) return true;
  for (const dir of policy.dirs ?? []) {
    const base = norm(dir.path);
    if (!rel.startsWith(`${base}/`)) continue;
    if (!dir.suffixes?.length || dir.suffixes.some((suffix) => rel.endsWith(suffix))) return true;
  }
  return false;
}

/** The policy entry that admits a path, for its `json` and `label`. */
export function entryFor(policy: SyncPolicy, path: string): SyncedFile | SyncedDir | undefined {
  const rel = normalizeRel(path);
  if (!rel) return undefined;
  return policy.files.find((entry) => norm(entry.path) === rel) ?? (policy.dirs ?? []).find((dir) => rel.startsWith(`${norm(dir.path)}/`));
}
