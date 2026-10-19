import { readFileSync, writeFileSync, renameSync, existsSync, chmodSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { configPath, ensureConfigDir } from "./paths.ts";

/**
 * Read a JSON file from the config dir, or the fallback when it is absent.
 *
 * A file that exists but does not parse is an error, never the fallback: every
 * caller writes back what it read, so treating a half-read file as empty wipes
 * it. On 2026-10-19 a newsletter send and the daemon did exactly that to
 * newsletters.json mid-send, dropping every issue and delivery ledger. A short
 * retry covers a read that raced a writer.
 */
export function readJson<T>(file: string, fallback: T): T {
  const path = configPath(file);
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (!existsSync(path)) return fallback;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch (error) {
      lastError = error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
    }
  }
  throw new Error(`${path} is not valid JSON, so it was left alone rather than read as empty: ${(lastError as Error)?.message ?? lastError}`);
}

/**
 * Write via a temp file and rename, so a crash mid-write cannot leave a
 * truncated vault behind. Mode 0600 — these files hold credentials. The temp
 * name is unique per write: a shared one let two processes saving at once
 * rename each other's half-written file into place.
 */
export function writeJson(file: string, value: unknown): void {
  ensureConfigDir();
  const path = configPath(file);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  chmodSync(path, 0o600);
}

export function fileExists(file: string): boolean {
  return existsSync(configPath(file));
}
