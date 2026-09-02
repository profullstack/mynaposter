/**
 * Cloud backup, against a real Postgres.
 *
 * Skipped unless DATABASE_URL is set, so `bun test` stays runnable with no
 * database. Bring one up with:
 *
 *   docker compose up -d postgres
 *   export DATABASE_URL=postgres://myna:myna@127.0.0.1:5432/myna?sslmode=disable
 *   bun apps/api/src/db/migrate.ts
 *   bun test apps/api/test
 *
 * These exercise the SQL, which the credential unit tests deliberately do not.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { seal, open as openBundle, type BundlePayload } from "../../../packages/core/src/store/bundle.ts";
import { migrate, closeDatabase, hasDatabase } from "../src/db/index.ts";
import * as cloud from "../src/cloud.ts";

const enabled = hasDatabase();
const it = enabled ? test : test.skip;

const PASSWORD = "a long enough password";
const PASSPHRASE = "bundle passphrase here";
const unique = () => `t${Date.now()}${Math.random().toString(36).slice(2, 8)}@example.com`;

const payload = (secret: string): BundlePayload => ({
  accounts: [
    {
      id: "bluesky:alice.bsky.social",
      network: "bluesky",
      handle: "alice.bsky.social",
      addedAt: new Date().toISOString(),
      creds: { token: secret },
      meta: {},
    },
  ],
  queue: [],
  settings: {} as never,
  savedAt: new Date().toISOString(),
  savedBy: "alice@laptop",
});

beforeAll(async () => {
  if (enabled) await migrate();
});
afterAll(async () => {
  if (enabled) await closeDatabase();
});

it("signs up and hands back a usable token", async () => {
  const { user, token } = await cloud.signup(unique(), PASSWORD);
  expect(token.startsWith("myna_")).toBe(true);
  expect((await cloud.whoami(token))?.id).toBe(user.id);
});

it("refuses a second account on the same address", async () => {
  const email = unique();
  await cloud.signup(email, PASSWORD);
  await expect(cloud.signup(email, PASSWORD)).rejects.toThrow(/already has an account/);
});

it("normalizes the address, so Alice@ and alice@ are one account", async () => {
  const email = unique();
  await cloud.signup(email.toUpperCase(), PASSWORD);
  const { user } = await cloud.login(email.toLowerCase(), PASSWORD);
  expect(user.email).toBe(email.toLowerCase());
});

it("refuses the wrong password, and says the same thing for an unknown address", async () => {
  const email = unique();
  await cloud.signup(email, PASSWORD);
  await expect(cloud.login(email, "some other password")).rejects.toThrow(/Wrong email or password/);
  await expect(cloud.login(unique(), PASSWORD)).rejects.toThrow(/Wrong email or password/);
});

it("does not accept a token it never minted", async () => {
  expect(await cloud.whoami("myna_not_a_real_token")).toBeNull();
  expect(await cloud.whoami("")).toBeNull();
});

it("stores and returns a sealed bundle unchanged", async () => {
  const { user } = await cloud.signup(unique(), PASSWORD);
  const sealed = seal(payload("SUPER-SECRET-TOKEN"), PASSPHRASE);

  const saved = await cloud.putBackup(user.id, JSON.stringify(sealed), sealed.meta);
  expect(saved.bytes).toBeGreaterThan(0);

  const fetched = await cloud.getBackup(user.id);
  expect(fetched).not.toBeNull();
  const reopened = openBundle(JSON.parse(fetched!.blob), PASSPHRASE);
  expect(reopened.accounts[0].creds.token).toBe("SUPER-SECRET-TOKEN");
});

it("never has the plaintext to begin with", async () => {
  const { user } = await cloud.signup(unique(), PASSWORD);
  const sealed = seal(payload("SUPER-SECRET-TOKEN"), PASSPHRASE);
  await cloud.putBackup(user.id, JSON.stringify(sealed), sealed.meta);

  const stored = await cloud.getBackup(user.id);
  expect(stored!.blob).not.toContain("SUPER-SECRET-TOKEN");
  expect(stored!.blob).not.toContain("alice.bsky.social");
});

it("refuses to store anything that is not already sealed", async () => {
  const { user } = await cloud.signup(unique(), PASSWORD);
  const readable = JSON.stringify({ accounts: [{ creds: { token: "PLAINTEXT" } }] });
  await expect(cloud.putBackup(user.id, readable, null)).rejects.toThrow(/not a sealed myna bundle/);
  await expect(cloud.putBackup(user.id, "not json", null)).rejects.toThrow(/not a myna bundle/);
});

it("replaces the previous backup rather than accumulating them", async () => {
  const { user } = await cloud.signup(unique(), PASSWORD);
  await cloud.putBackup(user.id, JSON.stringify(seal(payload("FIRST"), PASSPHRASE)), null);
  await cloud.putBackup(user.id, JSON.stringify(seal(payload("SECOND"), PASSPHRASE)), null);

  const fetched = await cloud.getBackup(user.id);
  expect(openBundle(JSON.parse(fetched!.blob), PASSPHRASE).accounts[0].creds.token).toBe("SECOND");
});

it("keeps one account's backup away from another", async () => {
  const mine = await cloud.signup(unique(), PASSWORD);
  const yours = await cloud.signup(unique(), PASSWORD);
  await cloud.putBackup(mine.user.id, JSON.stringify(seal(payload("MINE"), PASSPHRASE)), null);

  expect(await cloud.getBackup(yours.user.id)).toBeNull();
  expect(await cloud.backupStatus(yours.user.id)).toBeNull();
});

it("forgets a backup when asked", async () => {
  const { user } = await cloud.signup(unique(), PASSWORD);
  await cloud.putBackup(user.id, JSON.stringify(seal(payload("GONE"), PASSPHRASE)), null);
  expect(await cloud.deleteBackup(user.id)).toBe(true);
  expect(await cloud.getBackup(user.id)).toBeNull();
  expect(await cloud.deleteBackup(user.id)).toBe(false);
});

it("stops accepting a token after logout", async () => {
  const { token } = await cloud.signup(unique(), PASSWORD);
  expect(await cloud.whoami(token)).not.toBeNull();
  expect(await cloud.logout(token)).toBe(true);
  expect(await cloud.whoami(token)).toBeNull();
});
