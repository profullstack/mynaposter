/**
 * Several accounts on one network.
 *
 * Account ids are `network:handle`, so this has always been possible, but
 * "possible by construction" is not the same as tested — and the target
 * resolver is where it would break.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-multi-"));
  process.env.MYNA_HOME = dir;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
});

async function fresh() {
  const store = await import(`../src/store/accounts.ts?${Math.random()}`);
  store.resetAccountCache();
  return store;
}

const account = (network: string, handle: string, secret: string) => ({
  id: `${network}:${handle}`,
  network,
  handle,
  displayName: handle,
  addedAt: new Date().toISOString(),
  creds: { token: secret },
  meta: {},
});

test("two accounts on the same network both persist", async () => {
  const store = await fresh();
  store.saveAccount(account("bluesky", "alice.bsky.social", "A"));
  store.saveAccount(account("bluesky", "work.bsky.social", "B"));

  const all = store.listAccounts();
  expect(all).toHaveLength(2);
  expect(all.map((a: { id: string }) => a.id).sort()).toEqual([
    "bluesky:alice.bsky.social",
    "bluesky:work.bsky.social",
  ]);
  // Distinct credentials, not one overwriting the other.
  expect(store.getAccount("bluesky:alice.bsky.social").creds.token).toBe("A");
  expect(store.getAccount("bluesky:work.bsky.social").creds.token).toBe("B");
});

test("the same handle twice is one account, updated", async () => {
  const store = await fresh();
  store.saveAccount(account("bluesky", "alice.bsky.social", "OLD"));
  store.saveAccount(account("bluesky", "alice.bsky.social", "NEW"));
  expect(store.listAccounts()).toHaveLength(1);
  expect(store.getAccount("bluesky:alice.bsky.social").creds.token).toBe("NEW");
});

test("naming the network targets every account on it", async () => {
  const store = await fresh();
  store.saveAccount(account("bluesky", "alice.bsky.social", "A"));
  store.saveAccount(account("bluesky", "work.bsky.social", "B"));
  store.saveAccount(account("mastodon", "@alice@example.com", "C"));

  expect(store.resolveTargets("bluesky")).toHaveLength(2);
  expect(store.resolveTargets("mastodon")).toHaveLength(1);
  expect(store.resolveTargets("all")).toHaveLength(3);
});

test("one account can be singled out by its id", async () => {
  const store = await fresh();
  store.saveAccount(account("bluesky", "alice.bsky.social", "A"));
  store.saveAccount(account("bluesky", "work.bsky.social", "B"));

  const picked = store.resolveTargets("bluesky:work.bsky.social");
  expect(picked).toHaveLength(1);
  expect(picked[0].handle).toBe("work.bsky.social");
});

test("a network and one of its accounts together is still one post", async () => {
  const store = await fresh();
  store.saveAccount(account("bluesky", "alice.bsky.social", "A"));
  store.saveAccount(account("bluesky", "work.bsky.social", "B"));

  // Deduplicated, or naming both would post twice to the same account.
  expect(store.resolveTargets("bluesky,bluesky:work.bsky.social")).toHaveLength(2);
});

test("removing one leaves the other alone", async () => {
  const store = await fresh();
  store.saveAccount(account("bluesky", "alice.bsky.social", "A"));
  store.saveAccount(account("bluesky", "work.bsky.social", "B"));

  expect(store.removeAccount("bluesky:alice.bsky.social")).toBe(true);
  expect(store.listAccounts()).toHaveLength(1);
  expect(store.resolveTargets("bluesky")).toHaveLength(1);
});
