/**
 * @profullstack/synconfig (alias: @profullstack/syncfg)
 *
 * Sync a tool's config files with its cloud. The tool declares a policy
 * (which files, which never), takes a snapshot, and saves it under a
 * revision; another machine loads it. Whole files, a digest to recognise
 * "nothing changed", optimistic revisions instead of merges, and a marker
 * on each machine so a local edit is never overwritten by a stale copy.
 *
 * Client:  createClient, save, load, status, syncOnce, autosync
 * Pure:    collectSnapshot, validateSnapshot, planApply, applyFiles,
 *          localDrift, digestFiles, markerFor, loadMarker, saveMarker
 * Server:  import "@profullstack/synconfig/server" for the handlers and a
 *          SnapshotStore to implement over your database.
 */
export { DEFAULT_LIMITS, entryFor, isSyncable, limitsOf, normalizeRel, type SyncLimits, type SyncPolicy, type SyncedDir, type SyncedFile } from "./policy.ts";
export {
  MARKER_FILE,
  SNAPSHOT_VERSION,
  applyFiles,
  collectSnapshot,
  digestFiles,
  loadMarker,
  localDrift,
  markerFor,
  planApply,
  saveMarker,
  sha256,
  validateSnapshot,
  backupPath,
  type ApplyOptions,
  type Marker,
  type PlanEntry,
  type PlanStatus,
  type Skipped,
  type Snapshot,
  type SnapshotFile,
} from "./snapshot.ts";
export { createClient, type ClientOptions, type Latest, type PutResult, type StoredSnapshotInfo, type SyncTransport } from "./client.ts";
export { autosync, load, save, status, syncOnce, type AutosyncHandle, type Backup, type LoadResult, type SaveResult, type StatusResult, type SyncContext } from "./sync.ts";
