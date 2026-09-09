/**
 * Where a directory's API key lives.
 *
 * The property that matters is the second test: `resolveTargets("all")` returns
 * every account whose network is not an explicit target, and a network it does
 * not recognise reads as "not explicit" — so a directory credential kept among
 * the accounts would quietly become a posting target, and a stray thought would
 * go out as a product submission.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-directory-vault-"));
  process.env.MYNA_HOME = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
  delete process.env.MYNA_PASSPHRASE;
});

/** Imported lazily so each test picks up the fresh MYNA_HOME. */
async function fresh() {
  const accounts = await import(`../src/store/accounts.ts?${Math.random()}`);
  accounts.resetAccountCache();
  return accounts;
}

const saasrowAccount = {
  directory: "saasrow",
  handle: "you@example.com",
  addedAt: new Date().toISOString(),
  creds: { key: "sr_correct_horse_battery_staple" },
  meta: { site: "https://saasrow.com", keyPrefix: "sr_correct" },
};

test("a directory credential survives a save and reload", async () => {
  const store = await fresh();
  store.saveDirectoryAccount(saasrowAccount);

  const reloaded = await fresh();
  expect(reloaded.getDirectoryAccount("saasrow")?.creds.key).toBe("sr_correct_horse_battery_staple");
  expect(reloaded.listDirectoryAccounts()).toHaveLength(1);
});

test("a directory is never a posting target", async () => {
  const store = await fresh();
  store.saveDirectoryAccount(saasrowAccount);
  store.saveAccount({
    id: "bluesky:alice.bsky.social",
    network: "bluesky",
    handle: "alice.bsky.social",
    addedAt: new Date().toISOString(),
    creds: {},
    meta: {},
  });

  expect(store.listAccounts()).toHaveLength(1);
  const targets = store.resolveTargets("all");
  expect(targets).toHaveLength(1);
  expect(targets[0].id).toBe("bluesky:alice.bsky.social");
  // And it cannot be named as one either.
  expect(() => store.resolveTargets("saasrow")).toThrow(/No connected account/);
});

test("the API key is not sitting in the file in plaintext", async () => {
  const store = await fresh();
  store.saveDirectoryAccount(saasrowAccount);

  const raw = await Bun.file(join(dir, "vault.json")).text();
  expect(raw).not.toContain("sr_correct_horse_battery_staple");
});

test("logging out of a directory takes its key with it", async () => {
  const store = await fresh();
  store.saveDirectoryAccount(saasrowAccount);
  expect(store.removeDirectoryAccount("saasrow")).toBe(true);
  expect(store.removeDirectoryAccount("saasrow")).toBe(false);

  const reloaded = await fresh();
  expect(reloaded.getDirectoryAccount("saasrow")).toBeUndefined();
  const raw = await Bun.file(join(dir, "vault.json")).text();
  expect(raw).not.toContain("sr_correct_horse_battery_staple");
});

test("directory credentials and accounts do not overwrite each other in the vault", async () => {
  const store = await fresh();
  store.saveAccount({
    id: "bluesky:alice.bsky.social",
    network: "bluesky",
    handle: "alice.bsky.social",
    addedAt: new Date().toISOString(),
    creds: { password: "hunter2" },
    meta: {},
  });
  store.saveDirectoryAccount(saasrowAccount);
  store.setPluginSecrets("crawlproof", { token: "cp_token" });

  const reloaded = await fresh();
  expect(reloaded.getAccount("bluesky:alice.bsky.social")?.creds.password).toBe("hunter2");
  expect(reloaded.getDirectoryAccount("saasrow")?.handle).toBe("you@example.com");
  expect(reloaded.getPluginSecrets("crawlproof").token).toBe("cp_token");
});
