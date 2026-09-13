/**
 * synconfig, end to end against the in-memory store.
 *
 * What has to hold: only the policy's files leave the machine and only
 * they are written back; the digest is the same on both sides so an
 * unchanged save is the old revision; a save from a machine that has not
 * loaded another machine's revision is a conflict, and forced it is a new
 * revision; a load that would overwrite a local edit stops unless forced;
 * a dry run writes nothing; and a bad snapshot from the server never
 * reaches disk.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSnapshot, createClient, digestFiles, isSyncable, load, loadMarker, normalizeRel, save, status, syncOnce, validateSnapshot, type SyncPolicy } from "../src/index.ts";
import { digestSnapshot, handleGet, handlePut, handleRevisions, memoryStore, snapshotProblem } from "../src/server.ts";

const policy: SyncPolicy = {
  files: [
    { path: "settings.json", json: true },
    { path: "openprofile.md" },
  ],
  dirs: [{ path: "skills", suffixes: [".md"] }],
  never: ["vault.json", "sync.json"],
  neverPrefixes: ["state"],
  neverSuffixes: [".log"],
};

let a = "";
let b = "";
const store = memoryStore();

/** A fake cloud: the handlers behind a fetch, one user. */
function fakeFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? "GET";
    const auth = (init?.headers as Record<string, string>)?.authorization;
    if (auth !== "Bearer tok") return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), { status: 401 });
    const reply = url.pathname.endsWith("/revisions") ? await handleRevisions(store, "u1") : method === "PUT" ? await handlePut(store, "u1", JSON.parse(String(init?.body))) : await handleGet(store, "u1");
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

const ctx = (rootDir: string, host: string) => ({ rootDir, policy, client: createClient({ baseUrl: "https://cloud.example/api", token: "tok", fetchImpl: fakeFetch() }), api: "https://cloud.example/api", host, app: "tool 1.0" });

beforeEach(() => {
  a = mkdtempSync(join(tmpdir(), "synconfig-a-"));
  b = mkdtempSync(join(tmpdir(), "synconfig-b-"));
  store.rows.clear();
  writeFileSync(join(a, "settings.json"), '{"theme":"dark"}\n');
  writeFileSync(join(a, "openprofile.md"), "# Ada\n");
  mkdirSync(join(a, "skills", "blog"), { recursive: true });
  writeFileSync(join(a, "skills", "blog", "skill.md"), "---\nmaxPerDay: 4\n---\n");
  writeFileSync(join(a, "skills", "blog", "notes.txt"), "not synced");
  writeFileSync(join(a, "vault.json"), "SECRET");
  mkdirSync(join(a, "state"));
  writeFileSync(join(a, "state", "queue.json"), "[]");
  writeFileSync(join(a, "daemon.log"), "noise");
});
afterEach(() => {
  rmSync(a, { recursive: true, force: true });
  rmSync(b, { recursive: true, force: true });
});

test("the policy decides what leaves the machine", () => {
  expect(isSyncable(policy, "settings.json")).toBe(true);
  expect(isSyncable(policy, "skills/blog/skill.md")).toBe(true);
  expect(isSyncable(policy, "skills/blog/notes.txt")).toBe(false);
  expect(isSyncable(policy, "vault.json")).toBe(false);
  expect(isSyncable(policy, "state/queue.json")).toBe(false);
  expect(isSyncable(policy, "daemon.log")).toBe(false);
  expect(isSyncable(policy, "../settings.json")).toBe(false);
  expect(normalizeRel("skills//x.md")).toBeNull();
  expect(normalizeRel("/etc/passwd")).toBeNull();

  const { snapshot, skipped } = collectSnapshot(a, policy, { host: "laptop", app: "tool 1.0" });
  expect(Object.keys(snapshot.files).sort()).toEqual(["openprofile.md", "settings.json", "skills/blog/skill.md"]);
  expect(skipped).toEqual([]);
  expect(digestFiles(snapshot.files)).toBe(digestSnapshot(snapshot));

  writeFileSync(join(a, "settings.json"), "{not json");
  expect(collectSnapshot(a, policy, { host: "laptop", app: "tool 1.0" }).skipped).toEqual([{ path: "settings.json", reason: "not valid JSON" }]);
});

test("save, load on another machine, unchanged save, conflict, force", async () => {
  const first = await save(ctx(a, "laptop"));
  expect(first).toMatchObject({ status: "saved", revision: 1, files: 3 });
  expect(loadMarker(a)?.revision).toBe(1);
  expect(await save(ctx(a, "laptop"))).toMatchObject({ status: "unchanged", revision: 1 });

  const pulled = await load(ctx(b, "desktop"));
  expect(pulled.status).toBe("loaded");
  expect(pulled.written.sort()).toEqual(["openprofile.md", "settings.json", "skills/blog/skill.md"]);
  expect(readFileSync(join(b, "skills", "blog", "skill.md"), "utf8")).toBe("---\nmaxPerDay: 4\n---\n");
  expect(existsSync(join(b, "vault.json"))).toBe(false);
  expect(loadMarker(b)?.revision).toBe(1);
  expect(await load(ctx(b, "desktop"))).toMatchObject({ status: "same", revision: 1 });

  // b edits and saves: revision 2. a, still on 1, edits and saves: conflict.
  writeFileSync(join(b, "settings.json"), '{"theme":"light"}\n');
  expect(await save(ctx(b, "desktop"))).toMatchObject({ status: "saved", revision: 2 });
  writeFileSync(join(a, "openprofile.md"), "# Ada Lovelace\n");
  const clash = await save(ctx(a, "laptop"));
  expect(clash).toMatchObject({ status: "conflict", serverRevision: 2 });

  // a's load refuses to overwrite the local edit, unless forced or dry.
  const refused = await load(ctx(a, "laptop"));
  expect(refused.status).toBe("local_changes");
  // a's openprofile.md edit is unsynced and the server would overwrite it; settings.json is only new there.
  expect(refused.drifted).toEqual(["openprofile.md"]);
  const dry = await load(ctx(a, "laptop"), { dryRun: true });
  expect(dry.status).toBe("planned");
  expect(dry.plan.find((entry) => entry.path === "settings.json")?.status).toBe("changed");
  expect(readFileSync(join(a, "settings.json"), "utf8")).toBe('{"theme":"dark"}\n');

  // Forced save wins the race and becomes revision 3; b then loads it.
  expect(await save(ctx(a, "laptop"), { force: true })).toMatchObject({ status: "saved", revision: 3 });
  const caughtUp = await load(ctx(b, "desktop"));
  expect(caughtUp.status).toBe("loaded");
  expect(readFileSync(join(b, "openprofile.md"), "utf8")).toBe("# Ada Lovelace\n");

  const revisions = await ctx(a, "laptop").client.revisions();
  expect(revisions.map((entry) => entry.revision)).toEqual([3, 2, 1]);
  expect(revisions[0]?.host).toBe("laptop");
});

test("a local edit that the server would overwrite stops a load; status says so", async () => {
  await save(ctx(a, "laptop"));
  await load(ctx(b, "desktop"));
  writeFileSync(join(b, "openprofile.md"), "# Edited on b\n");
  writeFileSync(join(a, "openprofile.md"), "# Edited on a\n");
  await save(ctx(a, "laptop"));

  const before = await status(ctx(b, "desktop"));
  expect(before.drifted).toEqual(["openprofile.md"]);
  expect(before.behind).toBe(true);
  expect(before.serverRevision).toBe(2);

  const refused = await load(ctx(b, "desktop"));
  expect(refused.status).toBe("local_changes");
  expect(refused.drifted).toEqual(["openprofile.md"]);
  expect(readFileSync(join(b, "openprofile.md"), "utf8")).toBe("# Edited on b\n");

  const forced = await load(ctx(b, "desktop"), { force: true });
  expect(forced.status).toBe("loaded");
  expect(readFileSync(join(b, "openprofile.md"), "utf8")).toBe("# Edited on a\n");
});

test("syncOnce pulls then pushes, and a fresh machine simply pushes", async () => {
  const tick = await syncOnce(ctx(a, "laptop"));
  expect(tick.load.status).toBe("empty");
  expect(tick.save).toMatchObject({ status: "saved", revision: 1 });
  writeFileSync(join(a, "settings.json"), '{"theme":"light"}\n');
  const again = await syncOnce(ctx(a, "laptop"));
  expect(again.load.status).toBe("local_changes");
  expect(again.save).toMatchObject({ status: "saved", revision: 2 });
});

test("the server checks shape and size, and a bad snapshot never reaches disk", async () => {
  expect(snapshotProblem(null)).toMatch(/object/);
  expect(snapshotProblem({ version: 2, files: {} })).toMatch(/version/);
  expect(snapshotProblem({ version: 1, files: { "../x": { content: "" } } })).toMatch(/relative/);
  expect(snapshotProblem({ version: 1, files: { "a.md": { content: 1 } } })).toMatch(/string/);
  expect(snapshotProblem({ version: 1, files: { "a.md": { content: "x".repeat(70_000) } } })).toMatch(/bytes/);
  expect(snapshotProblem({ version: 1, files: { "a.md": { content: "ok" } }, host: "h", app: "t" })).toBeNull();

  const bad = await handlePut(store, "u1", { snapshot: { version: 1, files: { "../x": { content: "" } } } });
  expect(bad.status).toBe(400);

  // A snapshot the server holds with a file the policy does not admit is filtered on the way in.
  await store.insert("u1", { digest: "d", host: null, version: null, size: 1, body: { version: 1, host: "x", app: "t", files: { "vault.json": { content: "SECRET" }, "settings.json": { content: "{}" } } } }, null);
  const { files, rejected } = validateSnapshot((await store.latest("u1"))!.body, policy);
  expect(Object.keys(files)).toEqual(["settings.json"]);
  expect(rejected).toEqual([{ path: "vault.json", reason: "not a file this tool syncs" }]);
  const pulled = await load(ctx(b, "desktop"));
  expect(pulled.status).toBe("loaded");
  expect(existsSync(join(b, "vault.json"))).toBe(false);
  expect(pulled.rejected).toHaveLength(1);
});
