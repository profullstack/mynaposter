/**
 * The snapshot: the policy's files as one JSON document, and the marker
 * that remembers what was last synced.
 *
 * Whole files, not keys. A config file is edited by hand and by the tool,
 * and merging two edits of one file is a guess; a snapshot is a fact. The
 * digest over the files is what both sides compare: the server recognises
 * an unchanged snapshot by it and hands the old revision back, and the
 * marker keeps a per-file digest so a pull can tell a local edit from a
 * stale copy.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { entryFor, isSyncable, limitsOf, normalizeRel, type SyncPolicy } from "./policy.ts";

export interface SnapshotFile {
  content: string;
}

export interface Snapshot {
  version: 1;
  /** The machine it was taken on. */
  host: string;
  /** The tool and its version: `myna 0.26.0`. */
  app: string;
  files: Record<string, SnapshotFile>;
}

/** What this machine last synced, kept beside the config as `sync.json`. */
export interface Marker {
  revision: number;
  digest: string;
  at: string;
  host: string;
  api: string;
  /** sha256 of each file's content as synced, by relative path. */
  files: Record<string, string>;
}

export interface Skipped {
  path: string;
  reason: string;
}

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * One digest over every file: sorted by path, each as `path\0length\0content\0`.
 * The server computes the same, so an unchanged snapshot is recognised
 * without comparing bodies.
 */
export function digestFiles(files: Record<string, SnapshotFile>): string {
  const hash = createHash("sha256");
  for (const path of Object.keys(files).sort()) {
    const content = files[path]!.content;
    hash.update(`${path}\0${Buffer.byteLength(content, "utf8")}\0${content}\0`);
  }
  return hash.digest("hex");
}

function walk(root: string, dir: string, out: string[]): void {
  const full = join(root, dir);
  if (!existsSync(full) || !statSync(full).isDirectory()) return;
  for (const name of readdirSync(full).sort()) {
    const rel = `${dir}/${name}`;
    const stat = statSync(join(root, rel));
    if (stat.isDirectory()) walk(root, rel, out);
    else if (stat.isFile()) out.push(rel);
  }
}

/** Read the policy's files from `rootDir`. Missing files are simply absent; oversize or unparseable ones are reported. */
export function collectSnapshot(rootDir: string, policy: SyncPolicy, meta: { host: string; app: string }): { snapshot: Snapshot; skipped: Skipped[] } {
  const limits = limitsOf(policy);
  const files: Record<string, SnapshotFile> = {};
  const skipped: Skipped[] = [];
  const candidates: string[] = policy.files.map((entry) => entry.path.replace(/^\.?\//, ""));
  for (const dir of policy.dirs ?? []) walk(rootDir, dir.path.replace(/^\.?\//, "").replace(/\/+$/, ""), candidates);

  let total = 0;
  for (const path of candidates) {
    if (!isSyncable(policy, path)) continue;
    const full = join(rootDir, path);
    if (!existsSync(full) || !statSync(full).isFile()) continue;
    if (Object.keys(files).length >= limits.maxFiles) {
      skipped.push({ path, reason: `more than ${limits.maxFiles} files` });
      continue;
    }
    const content = readFileSync(full, "utf8");
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > limits.maxFileBytes) {
      skipped.push({ path, reason: `${bytes} bytes, over the ${limits.maxFileBytes} limit` });
      continue;
    }
    if (total + bytes > limits.maxTotalBytes) {
      skipped.push({ path, reason: `would take the snapshot over ${limits.maxTotalBytes} bytes` });
      continue;
    }
    const entry = entryFor(policy, path);
    if (entry && "json" in entry && entry.json) {
      try {
        JSON.parse(content);
      } catch {
        skipped.push({ path, reason: "not valid JSON" });
        continue;
      }
    }
    files[path] = { content };
    total += bytes;
  }
  return { snapshot: { version: 1, host: meta.host, app: meta.app, files }, skipped };
}

/** Check a snapshot that arrived from the server against the policy, file by file. Nothing here throws. */
export function validateSnapshot(snapshot: unknown, policy: SyncPolicy): { files: Record<string, SnapshotFile>; rejected: Skipped[] } {
  const files: Record<string, SnapshotFile> = {};
  const rejected: Skipped[] = [];
  const limits = limitsOf(policy);
  const raw = (snapshot as { files?: unknown })?.files;
  if (!raw || typeof raw !== "object") return { files, rejected: [{ path: "*", reason: "no files in the snapshot" }] };
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    const rel = normalizeRel(path);
    if (!rel || rel !== path) {
      rejected.push({ path, reason: "not a plain relative path" });
      continue;
    }
    if (!isSyncable(policy, rel)) {
      rejected.push({ path, reason: "not a file this tool syncs" });
      continue;
    }
    const content = (value as { content?: unknown })?.content;
    if (typeof content !== "string") {
      rejected.push({ path, reason: "content is not a string" });
      continue;
    }
    if (Buffer.byteLength(content, "utf8") > limits.maxFileBytes) {
      rejected.push({ path, reason: `over the ${limits.maxFileBytes} byte limit` });
      continue;
    }
    const entry = entryFor(policy, rel);
    if (entry && "json" in entry && entry.json) {
      try {
        JSON.parse(content);
      } catch {
        rejected.push({ path, reason: "not valid JSON" });
        continue;
      }
    }
    files[rel] = { content };
  }
  return { files, rejected };
}

export type PlanStatus = "new" | "changed" | "same";

export interface PlanEntry {
  path: string;
  status: PlanStatus;
}

/** What applying `files` would do to `rootDir`, without doing it. */
export function planApply(rootDir: string, files: Record<string, SnapshotFile>): PlanEntry[] {
  return Object.keys(files)
    .sort()
    .map((path) => {
      const full = join(rootDir, path);
      if (!existsSync(full)) return { path, status: "new" as const };
      return { path, status: readFileSync(full, "utf8") === files[path]!.content ? ("same" as const) : ("changed" as const) };
    });
}

/** Write the files that differ, each through a temp file and a rename, mode 0600 in 0700 directories. Returns what was written. */
export function applyFiles(rootDir: string, files: Record<string, SnapshotFile>, plan = planApply(rootDir, files)): string[] {
  const written: string[] = [];
  for (const entry of plan) {
    if (entry.status === "same") continue;
    const full = join(rootDir, entry.path);
    mkdirSync(dirname(full), { recursive: true, mode: 0o700 });
    const tmp = `${full}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, files[entry.path]!.content, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, full);
    written.push(entry.path);
  }
  return written;
}

/** Files edited here since the marker: content differs from what was synced, or a synced file is gone. */
export function localDrift(rootDir: string, marker: Marker | null, files: Record<string, SnapshotFile>): string[] {
  if (!marker) return [];
  const drifted: string[] = [];
  for (const [path, digest] of Object.entries(marker.files)) {
    const current = files[path];
    if (!current) {
      if (existsSync(join(rootDir, path)) || true) drifted.push(path);
      continue;
    }
    if (sha256(current.content) !== digest) drifted.push(path);
  }
  for (const path of Object.keys(files)) {
    if (!(path in marker.files)) drifted.push(path);
  }
  return [...new Set(drifted)].sort();
}

export function markerFor(snapshot: Snapshot, revision: number, api: string, at = new Date().toISOString()): Marker {
  const files: Record<string, string> = {};
  for (const [path, file] of Object.entries(snapshot.files)) files[path] = sha256(file.content);
  return { revision, digest: digestFiles(snapshot.files), at, host: snapshot.host, api, files };
}

export const MARKER_FILE = "sync.json";

export function loadMarker(rootDir: string, name = MARKER_FILE): Marker | null {
  const full = join(rootDir, name);
  if (!existsSync(full)) return null;
  try {
    const parsed = JSON.parse(readFileSync(full, "utf8")) as Partial<Marker>;
    if (typeof parsed.revision !== "number" || typeof parsed.digest !== "string") return null;
    return { revision: parsed.revision, digest: parsed.digest, at: parsed.at ?? "", host: parsed.host ?? "", api: parsed.api ?? "", files: parsed.files ?? {} };
  } catch {
    return null;
  }
}

export function saveMarker(rootDir: string, marker: Marker, name = MARKER_FILE): void {
  mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  const full = join(rootDir, name);
  const tmp = `${full}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, full);
}
