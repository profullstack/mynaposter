import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-vault-"));
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

const sample = (id: string) => ({
  id,
  network: id.split(":")[0],
  handle: id.split(":")[1],
  displayName: "Test",
  addedAt: new Date().toISOString(),
  creds: { password: "correct horse battery staple" },
  meta: { instance: "https://example.com" },
});

test("an account survives a save and reload", async () => {
  const store = await fresh();
  store.saveAccount(sample("bluesky:alice.bsky.social"));

  const reloaded = await fresh();
  const account = reloaded.getAccount("bluesky:alice.bsky.social");
  expect(account?.handle).toBe("alice.bsky.social");
  expect(account?.creds.password).toBe("correct horse battery staple");
});

test("the secret is not sitting in the file in plaintext", async () => {
  const store = await fresh();
  store.saveAccount(sample("bluesky:alice.bsky.social"));

  const raw = await Bun.file(join(dir, "vault.json")).text();
  expect(raw).not.toContain("correct horse battery staple");
  expect(raw).toContain('"mode": "keyfile"');
});

test("the vault and its keyfile are owner-only", async () => {
  const store = await fresh();
  store.saveAccount(sample("bluesky:alice.bsky.social"));

  expect(statSync(join(dir, "vault.json")).mode & 0o777).toBe(0o600);
  expect(statSync(join(dir, "vault.key")).mode & 0o777).toBe(0o600);
});

test("removing an account takes its credentials with it", async () => {
  const store = await fresh();
  store.saveAccount(sample("bluesky:alice.bsky.social"));
  expect(store.removeAccount("bluesky:alice.bsky.social")).toBe(true);

  const reloaded = await fresh();
  expect(reloaded.listAccounts()).toHaveLength(0);
  const raw = await Bun.file(join(dir, "vault.json")).text();
  expect(raw).not.toContain("correct horse battery staple");
});

test("a passphrase vault refuses the wrong passphrase", async () => {
  const { rekeyVault, readVault } = await import(`../src/util/crypto/vault.ts?${Math.random()}`);
  rekeyVault({ accounts: [sample("bluesky:alice.bsky.social")] }, { mode: "passphrase", passphrase: "open sesame" });

  expect(readVault({ accounts: [] }, "open sesame").accounts).toHaveLength(1);
  expect(() => readVault({ accounts: [] }, "wrong")).toThrow(/Wrong passphrase/);
});

test("resolveTargets understands ids, networks and all", async () => {
  const store = await fresh();
  store.saveAccount(sample("bluesky:alice.bsky.social"));
  store.saveAccount(sample("mastodon:@alice@example.com"));

  expect(store.resolveTargets("all")).toHaveLength(2);
  expect(store.resolveTargets("bluesky")).toHaveLength(1);
  expect(store.resolveTargets("bluesky:alice.bsky.social")).toHaveLength(1);
  expect(store.resolveTargets("bluesky,mastodon")).toHaveLength(2);
  // A target named twice is still one post.
  expect(store.resolveTargets("bluesky,bluesky:alice.bsky.social")).toHaveLength(1);
  expect(() => store.resolveTargets("nosuchthing")).toThrow(/No connected account/);
});
