/**
 * A backup before every overwrite.
 *
 * A load is the one moment a sync can destroy something the server never
 * had. The marker refuses when it can tell; the copy beside the file catches
 * the rest, including a forced load. `<name>.bak-NNN.<ext>`, numbered, never
 * reused, never synced.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyFiles, backupPath, collectSnapshot, createClient, load, save, type SyncPolicy } from "../src/index.ts";
import { handleGet, handlePut, handleRevisions, memoryStore } from "../src/server.ts";

let root = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "synconfig-bak-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

test("backupPath: <name>.bak-NNN.<ext>, one more than the highest there, never reused", () => {
  expect(backupPath(join(root, "settings.json"))).toBe(join(root, "settings.bak-001.json"));
  writeFileSync(join(root, "settings.bak-001.json"), "");
  writeFileSync(join(root, "settings.bak-007.json"), "");
  expect(backupPath(join(root, "settings.json"))).toBe(join(root, "settings.bak-008.json"));
  // A dotfile has no extension: the number goes at the end.
  expect(backupPath(join(root, ".zshrc"))).toBe(join(root, ".zshrc.bak-001"));
  // Another file's backups do not count.
  writeFileSync(join(root, "other.bak-003.json"), "");
  expect(backupPath(join(root, "other.json"))).toBe(join(root, "other.bak-004.json"));
  expect(backupPath(join(root, "settings.json"))).toBe(join(root, "settings.bak-008.json"));
  // A directory that does not exist yet has nothing to count.
  expect(backupPath(join(root, "nested", "a.md"))).toBe(join(root, "nested", "a.bak-001.md"));
});

test("applyFiles copies a file it replaces, and only such a file", () => {
  writeFileSync(join(root, "settings.json"), '{"old":true}');
  mkdirSync(join(root, "skills"));
  writeFileSync(join(root, "skills", "same.md"), "unchanged");
  const backups: Array<[string, string]> = [];
  const written = applyFiles(root, {
    "settings.json": { content: '{"new":true}' },
    "skills/same.md": { content: "unchanged" },
    "openprofile.md": { content: "brand new" },
  }, undefined, { onBackup: (p, b) => backups.push([p, b]) });

  expect(written.sort()).toEqual(["openprofile.md", "settings.json"]);
  expect(backups).toEqual([["settings.json", "settings.bak-001.json"]]);
  expect(readFileSync(join(root, "settings.bak-001.json"), "utf8")).toBe('{"old":true}');
  expect(readFileSync(join(root, "settings.json"), "utf8")).toBe('{"new":true}');
  expect(statSync(join(root, "settings.bak-001.json")).mode & 0o777).toBe(0o600);
  // A new file has nothing to back up; an unchanged one is not touched.
  expect(existsSync(join(root, "openprofile.bak-001.md"))).toBe(false);
  expect(existsSync(join(root, "skills", "same.bak-001.md"))).toBe(false);

  // The next replacement gets the next number; the first backup stays.
  applyFiles(root, { "settings.json": { content: '{"newer":true}' } });
  expect(readFileSync(join(root, "settings.bak-001.json"), "utf8")).toBe('{"old":true}');
  expect(readFileSync(join(root, "settings.bak-002.json"), "utf8")).toBe('{"new":true}');
});

test("applyFiles with backup: false replaces in place, as before", () => {
  writeFileSync(join(root, "settings.json"), "old");
  applyFiles(root, { "settings.json": { content: "new" } }, undefined, { backup: false });
  expect(readFileSync(join(root, "settings.json"), "utf8")).toBe("new");
  expect(existsSync(join(root, "settings.bak-001.json"))).toBe(false);
});

const policy: SyncPolicy = {
  files: [{ path: "settings.json", json: true }],
  dirs: [],
  never: ["sync.json"],
  neverPrefixes: [],
  neverSuffixes: [],
};

/** A fake cloud, the same shape as synconfig.test.ts: the handlers behind a fetch. */
function ctxFor(dir: string, store: ReturnType<typeof memoryStore>) {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? "GET";
    const reply = url.pathname.endsWith("/revisions")
      ? await handleRevisions(store, "u1")
      : method === "PUT" ? await handlePut(store, "u1", JSON.parse(String(init?.body))) : await handleGet(store, "u1");
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return {
    rootDir: dir, policy, host: "test", app: "test 1.0", api: "https://cloud.example/api",
    client: createClient({ baseUrl: "https://cloud.example/api", token: "tok", fetchImpl }),
  };
}

test("a load reports the backups it made, a forced load included, and they never leave the machine", async () => {
  const store = memoryStore();
  const a = join(root, "a"); mkdirSync(a);
  const b = join(root, "b"); mkdirSync(b);
  writeFileSync(join(a, "settings.json"), '{"from":"a"}');
  await save(ctxFor(a, store));

  // b has its own settings and has never synced: the load must replace the
  // file, and the old content must be beside it.
  writeFileSync(join(b, "settings.json"), '{"from":"b"}');
  const first = await load(ctxFor(b, store));
  expect(first.status).toBe("loaded");
  expect(first.backups).toEqual([{ path: "settings.json", backup: "settings.bak-001.json" }]);
  expect(readFileSync(join(b, "settings.bak-001.json"), "utf8")).toBe('{"from":"b"}');
  expect(readFileSync(join(b, "settings.json"), "utf8")).toBe('{"from":"a"}');

  // b edits locally; a saves again; a forced load overwrites the edit — and
  // the edit is still on disk, numbered after the first backup.
  writeFileSync(join(b, "settings.json"), '{"from":"b-edit"}');
  writeFileSync(join(a, "settings.json"), '{"from":"a2"}');
  await save(ctxFor(a, store));
  expect((await load(ctxFor(b, store))).status).toBe("local_changes");
  const forced = await load(ctxFor(b, store), { force: true });
  expect(forced.status).toBe("loaded");
  expect(forced.backups).toEqual([{ path: "settings.json", backup: "settings.bak-002.json" }]);
  expect(readFileSync(join(b, "settings.bak-002.json"), "utf8")).toBe('{"from":"b-edit"}');

  // A dry run and an unchanged load make no backup.
  expect((await load(ctxFor(b, store), { dryRun: true })).backups).toEqual([]);
  expect((await load(ctxFor(b, store))).backups).toEqual([]);
  expect(existsSync(join(b, "settings.bak-003.json"))).toBe(false);

  // Backups are not part of any snapshot: the policy names files exactly.
  const snap = collectSnapshot(b, policy, { host: "test", app: "test" }).snapshot;
  expect(Object.keys(snap.files)).toEqual(["settings.json"]);
});
