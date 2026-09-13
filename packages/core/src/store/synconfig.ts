/**
 * myna's settings, synced with myna cloud through @profullstack/synconfig.
 *
 * What goes: settings.json (every `myna config` key, the profile, the
 * pacing, the graph), openprofile.md when hand-written, and the skills
 * (the rules per network, account and post type). What never goes: the
 * vault and its key, the cloud session, the queue, the history, the graph
 * ledger, hand-offs, contacts, and every other piece of state that belongs
 * to this machine. Accounts travel by `myna cloud push`, sealed; this is
 * the plain half, and it is plain because nothing in it is a secret.
 */
import { hostname } from "node:os";
import { createClient, load, save, status, syncOnce, type LoadResult, type SaveResult, type StatusResult, type SyncContext, type SyncPolicy } from "@profullstack/synconfig";
import { configDir } from "../util/paths.ts";
import { VERSION } from "../version.ts";
import { requireSession, session, DEFAULT_SERVER } from "./cloud.ts";

export const MYNA_SYNC_POLICY: SyncPolicy = {
  files: [
    { path: "settings.json", json: true, label: "settings" },
    { path: "openprofile.md", label: "OpenProfile" },
  ],
  dirs: [{ path: "skills", suffixes: [".md"], label: "skills" }],
  never: [
    "vault.json",
    "vault.key",
    "cloud.json",
    "sync.json",
    "queue.json",
    "history.json",
    "graph.json",
    "handoffs.json",
    "recap.json",
    "engagement.json",
    "engage.json",
    "contacts.json",
    "outreach.json",
    "did.json",
    "reshare.json",
  ],
  neverPrefixes: ["plugins", "shim", "__pycache__"],
  neverSuffixes: [".log", ".pid", ".sock", ".bak", ".tmp", ".py", ".key"],
};

const base = (): string => (session()?.server ?? process.env.MYNA_SERVER ?? DEFAULT_SERVER).replace(/\/+$/, "");

/** Is there a cloud session to sync through? Everything here needs one. */
export const canSync = (): boolean => Boolean(session()?.token);

export function syncContext(): SyncContext {
  const api = base();
  return {
    rootDir: configDir(),
    policy: MYNA_SYNC_POLICY,
    client: createClient({ baseUrl: api, token: requireSession().token, headers: { "user-agent": `myna/${VERSION}` } }),
    api,
    host: hostname(),
    app: `myna ${VERSION}`,
  };
}

export const saveConfig = (options: { force?: boolean } = {}): Promise<SaveResult> => save(syncContext(), options);
export const loadConfig = (options: { force?: boolean; dryRun?: boolean } = {}): Promise<LoadResult> => load(syncContext(), options);
export const configStatus = (): Promise<StatusResult> => status(syncContext());

/** One daemon tick: pull, then push. A line for the log when something moved, nothing when the world is still. */
export async function syncConfigOnce(): Promise<string | void> {
  if (!canSync()) return;
  const { load: pulled, save: pushed } = await syncOnce(syncContext());
  const parts: string[] = [];
  if (pulled.status === "loaded") parts.push(`pulled revision ${pulled.revision} (${pulled.written.join(", ")})`);
  if (pulled.status === "local_changes") parts.push(`kept local edits to ${pulled.drifted.join(", ")}`);
  if (pushed.status === "saved") parts.push(`saved revision ${pushed.revision}`);
  if (pushed.status === "conflict") parts.push(`not saved: another machine is at revision ${pushed.serverRevision}; myna synconfig load, or save --force`);
  return parts.length ? `synconfig: ${parts.join("; ")}` : undefined;
}
