# @profullstack/synconfig

Sync a tool's config files with the tool's own cloud. Also published as
`@profullstack/syncfg`, the same package under the short name.

A tool declares which files leave the machine and which never do. It takes
them as one snapshot and saves it under a revision; another machine loads
it. Whole files, never keys: a config file is edited by hand and by the
tool, and merging two edits of one file is a guess, while a snapshot is a
fact. Extracted from moshcode's settings sync; myna is the second user.

## The rules

- **An allowlist, never a directory walk.** Files by exact path, or a
  directory with allowed suffixes. Exact paths, prefixes and suffixes can be
  marked never, and never wins. Checked on the way out and again on the
  way in, so a snapshot from the network can only write the files the tool
  named, under the config directory, and nothing else.
- **A digest both sides compute.** sha256 over the sorted files, each as
  `path NUL length NUL content NUL`. The server answers an unchanged save
  with the revision it already holds.
- **Revisions, not merges.** A monotonic integer per user. A save carries
  the revision this machine last saw; the server refuses (409) when another
  machine has saved since. Force sends `null`. The last ten are kept.
- **A marker on each machine** (`sync.json`) with per-file digests, so a
  load refuses to overwrite a file edited locally since the last sync
  unless forced, and a dry run shows the plan.
- **Retries only when nobody heard you**: no response, 502, 503, 504. Safe
  because a save is conditional.

## Client

```ts
import { createClient, save, load, status, syncOnce, autosync, type SyncPolicy } from "@profullstack/synconfig";

const policy: SyncPolicy = {
  files: [{ path: "settings.json", json: true }, { path: "openprofile.md" }],
  dirs: [{ path: "skills", suffixes: [".md"] }],
  never: ["vault.json", "cloud.json", "sync.json"],
  neverSuffixes: [".log", ".pid"],
};

const ctx = {
  rootDir: "/home/me/.config/tool",
  policy,
  client: createClient({ baseUrl: "https://tool.example/api", token }),
  api: "https://tool.example/api",
  host: os.hostname(),
  app: "tool 1.2.3",
};

await save(ctx);                      // { status: "saved" | "unchanged" | "conflict" | "empty", revision, ... }
await load(ctx, { dryRun: true });    // { status: "planned", plan: [{ path, status: "new" | "changed" | "same" }] }
await load(ctx);                      // "loaded" | "same" | "empty" | "local_changes"
await status(ctx);                    // { marker, drifted, serverRevision, behind }
autosync({ everyMs: 300_000, tick: () => syncOnce(ctx).then(() => {}) });
```

The pure pieces are exported too: `collectSnapshot`, `validateSnapshot`,
`planApply`, `applyFiles`, `localDrift`, `digestFiles`, `markerFor`,
`loadMarker`, `saveMarker`, `isSyncable`, `normalizeRel`.

## Server

Three framework-free handlers over a store you implement for your database.

```ts
import { handleGet, handlePut, handleRevisions, type SnapshotStore } from "@profullstack/synconfig/server";

const store: SnapshotStore = {
  latest: async (userId) => ...,
  insert: async (userId, entry, ifRevision) => ...,   // max+1 under a precondition on max, in one statement
  list: async (userId, limit) => ...,
};

app.get("/v1/synconfig", async (req) => reply(await handleGet(store, user.id)));
app.put("/v1/synconfig", async (req) => reply(await handlePut(store, user.id, await req.json())));
app.get("/v1/synconfig/revisions", async (req) => reply(await handleRevisions(store, user.id)));
```

`memoryStore()` is the reference implementation and what the tests use.
The server does not know the tool's policy, only the shape and size of a
snapshot, so a tool can start syncing a new file without a redeploy.

## Wire format

```
PUT  <path>            { snapshot: { version: 1, host, app, files: { "a.json": { content } } }, ifRevision: 3 | null }
                       200 { ok, revision, digest, savedAt, unchanged? }   409 { ok: false, error, revision }
GET  <path>            200 { ok, revision, digest, savedAt, host, version, size, snapshot }   404 when empty
GET  <path>/revisions  200 { ok, revisions: [{ revision, digest, savedAt, host, version, size }] }
```

Limits by default: 64 KB per file, 256 KB per snapshot, 64 files.
