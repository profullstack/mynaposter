/**
 * Save and load, the way a person and a daemon both run them.
 *
 * Save takes a snapshot and sends it with the revision this machine last
 * saw. The server refuses if another machine has saved since, and that is
 * the whole conflict story: no merge, no clock comparison, a plain "load
 * first, or force". Load refuses to overwrite files edited here since the
 * last sync unless forced, so an unsynced local change is never silently
 * lost to a stale copy from another machine.
 */
import type { SyncTransport } from "./client.ts";
import type { SyncPolicy } from "./policy.ts";
import { applyFiles, collectSnapshot, digestFiles, loadMarker, localDrift, markerFor, planApply, saveMarker, validateSnapshot, type Marker, type PlanEntry, type Skipped } from "./snapshot.ts";

export interface SyncContext {
  rootDir: string;
  policy: SyncPolicy;
  client: SyncTransport;
  /** What the marker records as the server. */
  api: string;
  host: string;
  app: string;
  markerName?: string;
}

export interface SaveResult {
  status: "saved" | "unchanged" | "conflict" | "empty";
  revision?: number;
  digest?: string;
  files: number;
  skipped: Skipped[];
  /** On a conflict: the revision the server is at. */
  serverRevision?: number;
  error?: string;
}

export async function save(ctx: SyncContext, options: { force?: boolean } = {}): Promise<SaveResult> {
  const { snapshot, skipped } = collectSnapshot(ctx.rootDir, ctx.policy, { host: ctx.host, app: ctx.app });
  const files = Object.keys(snapshot.files).length;
  if (!files) return { status: "empty", files: 0, skipped };
  const marker = loadMarker(ctx.rootDir, ctx.markerName);
  const result = await ctx.client.put(snapshot, options.force ? null : (marker?.revision ?? null));
  if ("conflict" in result) return { status: "conflict", files, skipped, serverRevision: result.revision, error: result.error };
  saveMarker(ctx.rootDir, markerFor(snapshot, result.revision, ctx.api), ctx.markerName);
  return { status: result.unchanged ? "unchanged" : "saved", revision: result.revision, digest: result.digest, files, skipped };
}

export interface LoadResult {
  status: "loaded" | "same" | "empty" | "local_changes" | "planned" | "newer";
  revision?: number;
  plan: PlanEntry[];
  written: string[];
  drifted: string[];
  rejected: Skipped[];
}

export async function load(ctx: SyncContext, options: { force?: boolean; dryRun?: boolean } = {}): Promise<LoadResult> {
  const latest = await ctx.client.get();
  if (!latest) return { status: "empty", plan: [], written: [], drifted: [], rejected: [] };
  const { files, rejected, newer } = validateSnapshot(latest.snapshot, ctx.policy);
  if (newer) return { status: "newer", revision: latest.revision, plan: [], written: [], drifted: [], rejected };
  const plan = planApply(ctx.rootDir, files);

  const marker = loadMarker(ctx.rootDir, ctx.markerName);
  const here = collectSnapshot(ctx.rootDir, ctx.policy, { host: ctx.host, app: ctx.app }).snapshot;
  const drifted = localDrift(ctx.rootDir, marker, here.files).filter((path) => plan.some((entry) => entry.path === path && entry.status !== "same"));
  if (drifted.length && !options.force && !options.dryRun) {
    return { status: "local_changes", revision: latest.revision, plan, written: [], drifted, rejected };
  }
  if (options.dryRun) return { status: "planned", revision: latest.revision, plan, written: [], drifted, rejected };

  const written = applyFiles(ctx.rootDir, files, plan);
  const applied = { ...latest.snapshot, files };
  saveMarker(ctx.rootDir, { ...markerFor(applied, latest.revision, ctx.api), digest: digestFiles(files) }, ctx.markerName);
  return { status: written.length ? "loaded" : "same", revision: latest.revision, plan, written, drifted, rejected };
}

export interface StatusResult {
  marker: Marker | null;
  /** Files changed here since the last sync. */
  drifted: string[];
  /** The server's latest revision, when it could be read. */
  serverRevision?: number;
  serverSavedAt?: string;
  serverHost?: string | null;
  /** The server has a newer revision than this machine synced. */
  behind: boolean;
}

export async function status(ctx: SyncContext): Promise<StatusResult> {
  const marker = loadMarker(ctx.rootDir, ctx.markerName);
  const here = collectSnapshot(ctx.rootDir, ctx.policy, { host: ctx.host, app: ctx.app }).snapshot;
  const drifted = localDrift(ctx.rootDir, marker, here.files);
  let latest: Awaited<ReturnType<SyncTransport["get"]>> | null = null;
  try {
    latest = await ctx.client.get();
  } catch {
    latest = null;
  }
  return {
    marker,
    drifted,
    ...(latest ? { serverRevision: latest.revision, serverSavedAt: latest.savedAt, serverHost: latest.host } : {}),
    behind: Boolean(latest && (!marker || latest.revision > marker.revision)),
  };
}

/**
 * One tick of a background sync: pull what another machine saved, then push
 * what changed here. Never forced, so a local edit and a remote save that
 * cross are reported, not resolved.
 */
export async function syncOnce(ctx: SyncContext): Promise<{ load: LoadResult; save: SaveResult }> {
  const pulled = await load(ctx);
  const pushed = await save(ctx);
  return { load: pulled, save: pushed };
}

export interface AutosyncHandle {
  stop(): void;
  /** True while a tick is running; a second tick that lands then is skipped. */
  readonly busy: boolean;
}

/**
 * Run `tick` on an interval, one at a time, with the timer unref'd so it
 * never keeps a process alive. No tick at start: the first one lands a full
 * interval in, which is what a tool that just booted and is about to be
 * used by hand wants.
 */
export function autosync(options: { everyMs?: number; minMs?: number; tick: () => Promise<void>; log?: (line: string) => void }): AutosyncHandle {
  const every = Math.max(options.minMs ?? 30_000, options.everyMs ?? 300_000);
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    options
      .tick()
      .catch((error: Error) => options.log?.(`sync: ${error.message}`))
      .finally(() => {
        busy = false;
      });
  }, every);
  (timer as { unref?: () => void }).unref?.();
  return {
    stop: () => clearInterval(timer),
    get busy() {
      return busy;
    },
  };
}
