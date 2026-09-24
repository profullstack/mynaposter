/**
 * One list send per issue at a time.
 *
 * A lock file per issue in the state dir holds the pid of the process that is
 * sending it. A second send of the same issue (a background one, a foreground
 * `send --yes`, the daemon, the TUI) is refused while that pid is alive, so
 * two processes never walk the same ledger at once. A lock whose pid is gone,
 * or whose pid now belongs to some other program, is stale and is cleared.
 */
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureStateDir, stateDir } from "../util/paths.ts";

export interface SendLock {
  pid: number;
  id: string;
  startedAt: string;
  /** The process's command line when it took the lock (Linux), to spot a reused pid. */
  cmdline?: string;
  /** Where a background send writes its progress. */
  log?: string;
  /** How many this run meant to send (the daily cap or --limit cut it to this). */
  batch?: number;
  maxPerDay?: number;
}

const safe = (id: string): string => id.replace(/[^a-z0-9._-]/gi, "_");

export const sendLockPath = (id: string): string => join(stateDir(), `newsletter-${safe(id)}.lock`);
export const sendLogPath = (id: string): string => join(stateDir(), `newsletter-${safe(id)}.log`);

function cmdlineOf(pid: number): string | undefined {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0+$/, "").replace(/\0/g, " ");
  } catch {
    return undefined;
  }
}

/** Whether a process with this pid exists (one owned by someone else counts). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The lock as written, stale or not. */
export function readSendLock(id: string): SendLock | null {
  const path = sendLockPath(id);
  if (!existsSync(path)) return null;
  try {
    const lock = JSON.parse(readFileSync(path, "utf8")) as SendLock;
    return typeof lock.pid === "number" ? lock : null;
  } catch {
    return null;
  }
}

/** A lock is live while its pid runs the same command line it took the lock with. */
export function lockIsLive(lock: SendLock): boolean {
  if (!pidAlive(lock.pid)) return false;
  if (lock.cmdline) {
    const now = cmdlineOf(lock.pid);
    if (now !== undefined && now !== lock.cmdline) return false;
  }
  return true;
}

/** The live lock on an issue, or null when nobody is sending it. */
export function liveSendLock(id: string): SendLock | null {
  const lock = readSendLock(id);
  return lock && lockIsLive(lock) ? lock : null;
}

export class SendLockedError extends Error {
  constructor(readonly lock: SendLock) {
    super(`${lock.id} is already being sent by pid ${lock.pid} (since ${lock.startedAt}). myna newsletter status ${lock.id} shows how far it is.`);
    this.name = "SendLockedError";
  }
}

/**
 * Take the lock, or throw SendLockedError when another live process holds it.
 * Held by this process already, it is a no-op. Returns the release.
 */
export function acquireSendLock(id: string, info: Partial<Pick<SendLock, "log" | "batch" | "maxPerDay">> = {}): () => void {
  ensureStateDir();
  const path = sendLockPath(id);
  for (let attempt = 0; attempt < 3; attempt++) {
    const lock: SendLock = { pid: process.pid, id, startedAt: new Date().toISOString(), ...info };
    const cmdline = cmdlineOf(process.pid);
    if (cmdline) lock.cmdline = cmdline;
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const held = readSendLock(id);
      if (held?.pid === process.pid) return () => undefined;
      if (held && lockIsLive(held)) throw new SendLockedError(held);
      // Stale (or unreadable, from a crash mid-write): clear it and try again.
      try {
        unlinkSync(path);
      } catch {
        /* another process cleared it first */
      }
      continue;
    }
    try {
      writeFileSync(fd, `${JSON.stringify(lock, null, 2)}\n`);
    } finally {
      closeSync(fd);
    }
    return () => releaseSendLock(id);
  }
  throw new Error(`Could not take the send lock at ${path}.`);
}

/** Merge run details into a lock this process holds. */
export function updateSendLock(id: string, patch: Partial<Pick<SendLock, "log" | "batch" | "maxPerDay">>): void {
  const lock = readSendLock(id);
  if (!lock || lock.pid !== process.pid) return;
  writeFileSync(sendLockPath(id), `${JSON.stringify({ ...lock, ...patch }, null, 2)}\n`, { mode: 0o600 });
}

/** Drop the lock if this process holds it. */
export function releaseSendLock(id: string): void {
  const lock = readSendLock(id);
  if (lock && lock.pid !== process.pid) return;
  try {
    unlinkSync(sendLockPath(id));
  } catch {
    /* already gone */
  }
}
