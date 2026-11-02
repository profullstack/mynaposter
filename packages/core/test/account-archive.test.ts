/**
 * Archived accounts.
 *
 * An archived account keeps its credentials and stays in the accounts list,
 * but nothing posts to it: `all` leaves it out, naming it is refused with the
 * note, rotation skips it, the daemon cancels its queued posts with the
 * reason, and restore puts it back.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postPaced, postToAll } from "../src/core/poster.ts";
import { runDuePosts } from "../src/core/scheduler.ts";
import { pickRotation } from "../src/core/rotate.ts";
import { registerNetwork, unregisterNetwork } from "../src/net/registry.ts";
import { NO_CAPS, type Account, type Network, type PostInput } from "../src/net/types.ts";
import { dropQueuedFor, enqueue, listQueue } from "../src/store/queue.ts";
import {
  ArchivedAccountError,
  archiveAccount,
  archivedAccounts,
  getAccount,
  listAccounts,
  resetAccountCache,
  resolveTargets,
  restoreAccount,
  saveAccount,
} from "../src/store/accounts.ts";
import { resetPlugins } from "../src/plugins/loader.ts";

const sent: Array<{ account: string; input: PostInput }> = [];

const fake: Network = {
  id: "archtest",
  name: "Archive test network",
  category: "minor",
  blurb: "Test double.",
  auth: { kind: "local", fields: [] },
  caps: { ...NO_CAPS },
  async login() {
    throw new Error("not used");
  },
  async post(account, input) {
    sent.push({ account: account.id, input });
    return { id: `${sent.length}`, url: `https://archtest.example/${sent.length}` };
  },
};

const account = (handle: string): Account => ({
  id: `archtest:${handle}`,
  network: "archtest",
  handle,
  addedAt: "2026-10-01T00:00:00.000Z",
  creds: { token: `secret-${handle}` },
  meta: {},
});

const NOTE = "the instance disabled the login";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-archive-"));
  process.env.MYNA_HOME = dir;
  resetPlugins();
  resetAccountCache();
  registerNetwork(fake);
  saveAccount(account("live"));
  saveAccount(account("gone"));
  archiveAccount("archtest:gone", { banned: true, note: NOTE, at: "2026-11-02T12:00:00.000Z" });
});
afterEach(() => {
  sent.length = 0;
  unregisterNetwork("archtest");
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
  resetAccountCache();
  resetPlugins();
});

test("archiving keeps the credentials and records banned, note and date outside creds", () => {
  const stored = getAccount("archtest:gone")!;
  expect(stored.creds.token).toBe("secret-gone");
  expect(stored.archived).toEqual({ at: "2026-11-02T12:00:00.000Z", banned: true, note: NOTE });
  expect(stored.creds).not.toHaveProperty("archived");
  // Listed when asked for, left out of the default walk.
  expect(listAccounts().map((a) => a.id)).toEqual(["archtest:live"]);
  expect(listAccounts({ includeArchived: true }).map((a) => a.id)).toEqual(["archtest:gone", "archtest:live"]);
  expect(archivedAccounts().map((a) => a.id)).toEqual(["archtest:gone"]);
});

test("`all` and a network name leave the archived account out", () => {
  expect(resolveTargets("all").map((a) => a.id)).not.toContain("archtest:gone");
  expect(resolveTargets("all").map((a) => a.id)).toContain("archtest:live");
  expect(resolveTargets("archtest").map((a) => a.id)).toEqual(["archtest:live"]);
});

test("naming an archived account is refused with the note", () => {
  expect(() => resolveTargets("archtest:gone")).toThrow(ArchivedAccountError);
  expect(() => resolveTargets("archtest:gone")).toThrow(NOTE);
  expect(() => resolveTargets("archtest:live,archtest:gone")).toThrow("is banned");
  // By handle too.
  expect(() => resolveTargets("gone")).toThrow(ArchivedAccountError);
});

test("a network whose only account is archived is refused rather than matching nothing", () => {
  archiveAccount("archtest:live", { note: "retired" });
  expect(() => resolveTargets("archtest")).toThrow(ArchivedAccountError);
});

test("postPaced and postToAll refuse an archived account and send nothing", async () => {
  const gone = getAccount("archtest:gone")!;
  await expect(postPaced([gone], { text: "hello" })).rejects.toThrow(ArchivedAccountError);
  await expect(postToAll([gone], { text: "hello" })).rejects.toThrow(ArchivedAccountError);
  expect(sent).toHaveLength(0);
  expect(listQueue()).toHaveLength(0);
});

test("rotation never picks an archived account", () => {
  const accounts = listAccounts({ includeArchived: true });
  for (let i = 0; i < 5; i++) {
    const pick = pickRotation({ accounts, mode: "random", state: { cursor: {}, picks: [] }, now: 0, slot: () => 0, random: () => 0 });
    expect(pick.account.id).toBe("archtest:live");
  }
  expect(() =>
    pickRotation({ accounts: [getAccount("archtest:gone")!], mode: "cycle", state: { cursor: {}, picks: [] }, now: 0, slot: () => 0 }),
  ).toThrow("not archived");
});

test("the daemon cancels a queued post for an archived account with the reason, and trims a shared one", async () => {
  const past = "2026-11-01T00:00:00.000Z";
  const solo = enqueue({ scheduledFor: past, targets: ["archtest:gone"], text: "only for the banned one" });
  const shared = enqueue({ scheduledFor: past, targets: ["archtest:gone", "archtest:live"], text: "for both", extra: { now: "true" } });

  await runDuePosts(new Date("2026-11-02T13:00:00.000Z"));

  const after = new Map(listQueue().map((entry) => [entry.id, entry]));
  expect(after.get(solo.id)?.status).toBe("cancelled");
  expect(after.get(solo.id)?.lastError).toContain("archtest:gone is banned");
  expect(after.get(solo.id)?.lastError).toContain(NOTE);
  expect(after.get(shared.id)?.targets).toEqual(["archtest:live"]);
  expect(sent.map((s) => s.account)).toEqual(["archtest:live"]);
});

test("dropQueuedFor cancels pending entries for the account and leaves everything else alone", () => {
  const solo = enqueue({ scheduledFor: "2026-12-01T00:00:00.000Z", targets: ["archtest:gone"], text: "a" });
  const shared = enqueue({ scheduledFor: "2026-12-01T00:00:00.000Z", targets: ["archtest:gone", "archtest:live"], text: "b" });
  const other = enqueue({ scheduledFor: "2026-12-01T00:00:00.000Z", targets: ["archtest:live"], text: "c" });

  const dropped = dropQueuedFor("archtest:gone", "banned: reason");
  expect(dropped.cancelled.map((e) => e.id)).toEqual([solo.id]);
  expect(dropped.trimmed.map((e) => e.id)).toEqual([shared.id]);

  const after = new Map(listQueue().map((entry) => [entry.id, entry]));
  expect(after.get(solo.id)).toMatchObject({ status: "cancelled", lastError: "banned: reason" });
  expect(after.get(shared.id)).toMatchObject({ status: "pending", targets: ["archtest:live"] });
  expect(after.get(other.id)).toMatchObject({ status: "pending", targets: ["archtest:live"] });
  expect(listQueue().filter((e) => e.status === "pending" && e.targets.includes("archtest:gone"))).toHaveLength(0);
});

test("saving the account again (a token refresh, a re-login) keeps it archived", () => {
  saveAccount({ ...account("gone"), creds: { token: "refreshed" } });
  const stored = getAccount("archtest:gone")!;
  expect(stored.creds.token).toBe("refreshed");
  expect(stored.archived?.banned).toBe(true);
});

test("restore puts it back as a target", async () => {
  expect(restoreAccount("archtest:gone")?.id).toBe("archtest:gone");
  expect(getAccount("archtest:gone")?.archived).toBeUndefined();
  expect(resolveTargets("archtest:gone").map((a) => a.id)).toEqual(["archtest:gone"]);
  expect(resolveTargets("all").map((a) => a.id)).toContain("archtest:gone");
  // Restoring an active account says so instead of pretending.
  expect(restoreAccount("archtest:gone")).toBeUndefined();
  await postToAll([getAccount("archtest:gone")!], { text: "back" });
  expect(sent.map((s) => s.account)).toEqual(["archtest:gone"]);
});
