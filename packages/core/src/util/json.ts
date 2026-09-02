import { readFileSync, writeFileSync, renameSync, existsSync, chmodSync } from "node:fs";
import { configPath, ensureConfigDir } from "./paths.ts";

/** Read a JSON file from the config dir, or the fallback when it is absent or corrupt. */
export function readJson<T>(file: string, fallback: T): T {
  const path = configPath(file);
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * Write via a temp file and rename, so a crash mid-write cannot leave a
 * truncated vault behind. Mode 0600 — these files hold credentials.
 */
export function writeJson(file: string, value: unknown): void {
  ensureConfigDir();
  const path = configPath(file);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function fileExists(file: string): boolean {
  return existsSync(configPath(file));
}
