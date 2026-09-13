/**
 * OpenConnection against a real Postgres. Skipped unless DATABASE_URL is
 * set, like the cloud test beside it. What has to hold: a setup token is
 * claimed once and only once; the bearer it yields authenticates with the
 * scopes chosen at issuance; the person sees the app and revokes it; the
 * next call says `revoked`; an expired token says `expired`; accounts come
 * from the person's published or synced OpenProfile.md; activity round-trips.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { migrate, closeDatabase, hasDatabase, db } from "../src/db/index.ts";
import * as cloud from "../src/cloud.ts";
import * as oc from "../src/openconnection.ts";

const enabled = hasDatabase();
const it = enabled ? test : test.skip;

const PASSWORD = "a long enough password";
const unique = () => `oc${Date.now()}${Math.random().toString(36).slice(2, 8)}@example.com`;
const secretOf = (token: string) => oc.decodeSetupToken(token).pathname.split("/").pop() as string;

beforeAll(async () => {
  if (enabled) await migrate();
});
afterAll(async () => {
  if (enabled) await closeDatabase();
});

it("a setup token is claimed once for a scoped bearer, listed, and revoked", async () => {
  const { user } = await cloud.signup(unique(), PASSWORD);

  const setup = await oc.issueSetup(user.id, { scopes: "write:create,accounts:read" });
  expect(setup.scopes).toEqual(["write:create", "accounts:read"]);
  expect(oc.decodeSetupToken(setup.token).toString()).toBe(setup.claimUrl);

  const secret = secretOf(setup.token);
  await expect(oc.claim("not-a-secret", {})).rejects.toMatchObject({ status: 404, code: "unknown" });

  const claimed = await oc.claim(secret, { app: "ignored", name: "DefPromo", url: "https://defpromo.com", version: "1.5.0" });
  expect(claimed.auth).toBe("bearer");
  expect(claimed.token).toMatch(/^oc_/);
  expect(claimed.scopes).toEqual(["write:create", "accounts:read"]);
  expect(claimed.access_url).toBe(oc.accessUrlFor());
  expect(claimed.principal.name).toBeTruthy();

  // The second claim is refused and counted, so the person's page can warn.
  await expect(oc.claim(secret, {})).rejects.toMatchObject({ status: 403, code: "claimed" });

  const connection = await oc.authenticate(claimed.token);
  expect(connection.userId).toBe(user.id);
  expect(connection.app).toEqual({ name: "DefPromo", url: "https://defpromo.com", version: "1.5.0" });
  expect(oc.hasScope(connection.scopes, "write:create")).toBe(true);
  expect(oc.hasScope(connection.scopes, "analyze:create")).toBe(false);

  await expect(oc.authenticate("")).rejects.toMatchObject({ code: "unauthorized" });
  await expect(oc.authenticate("oc_nope")).rejects.toMatchObject({ code: "unauthorized" });

  const apps = await oc.listApps(user.id);
  expect(apps).toHaveLength(1);
  expect(apps[0]).toMatchObject({ id: connection.id, app: { name: "DefPromo" }, reclaims: 1, revokedAt: null });
  expect(apps[0].lastUsedAt).not.toBeNull();

  const { user: other } = await cloud.signup(unique(), PASSWORD);
  expect(await oc.revokeApp(other.id, connection.id)).toBe(false);
  expect(await oc.revokeApp(user.id, connection.id)).toBe(true);
  await expect(oc.authenticate(claimed.token)).rejects.toMatchObject({ code: "revoked" });
  expect(await oc.listApps(user.id)).toHaveLength(0);
  expect((await oc.listApps(user.id, { all: true }))[0].revokedAt).not.toBeNull();
});

it("an expired setup token says so, and an app can leave on its own", async () => {
  const { user } = await cloud.signup(unique(), PASSWORD);
  const setup = await oc.issueSetup(user.id, { minutes: 1 });
  await db()`update oc_setup_tokens set expires_at = now() - interval '1 minute' where secret_hash = ${(await import("../src/credentials.ts")).hashToken(secretOf(setup.token))}`;
  await expect(oc.claim(secretOf(setup.token), {})).rejects.toMatchObject({ status: 410, code: "expired" });

  const fresh = await oc.claim(secretOf((await oc.issueSetup(user.id)).token), { name: "A script" });
  const connection = await oc.authenticate(fresh.token);
  await oc.revokeToken(connection.id);
  await expect(oc.authenticate(fresh.token)).rejects.toMatchObject({ code: "revoked" });
});

it("accounts are read from the synced OpenProfile.md, the reshare profile wins, and none is reported as absent", async () => {
  const { user } = await cloud.signup(unique(), PASSWORD);
  expect((await oc.accountsFor(user.id)).errlist[0]?.code).toBe("no-profile");

  const synced = `# Synced Person\n\nKind: person\n\n## Accounts\n\n- Bluesky: https://bsky.app/profile/synced.bsky.social\n`;
  await db()`
    insert into settings_snapshots (user_id, revision, digest, host, version, size, body)
    values (${user.id}, 1, 'd', 'box', 'myna 0.26.0', 10, ${db().json({ version: 1, host: "box", app: "myna 0.26.0", files: { "openprofile.md": { content: synced } } } as never)})
  `;
  let set = await oc.accountsFor(user.id);
  expect(set.errlist).toEqual([]);
  expect(set.accounts.map((a) => a.id)).toEqual(["bluesky:synced.bsky.social"]);

  const published = `# Published Person\n\nKind: person\n\n## Accounts\n\n- Mastodon: https://mastodon.social/@published\n`;
  await db()`insert into reshare_profiles (user_id, markdown, name) values (${user.id}, ${published}, 'Published Person')`;
  set = await oc.accountsFor(user.id);
  expect(set.accounts.map((a) => a.id)).toEqual(["mastodon:published"]);
  expect(await oc.principalName(user.id)).toBe("Published Person");
});

it("activity an app reports is kept per person, newest first, with the app named", async () => {
  const { user } = await cloud.signup(unique(), PASSWORD);
  const claimed = await oc.claim(secretOf((await oc.issueSetup(user.id)).token), { name: "DefPromo" });
  const connection = await oc.authenticate(claimed.token);

  await expect(oc.recordActivity(connection, {})).rejects.toThrow(/network/);
  const first = await oc.recordActivity(connection, { network: "Reddit", kind: "comment", url: "https://reddit.com/r/x/c/1", text: "hi", project: "myna", at: "2026-09-13T01:00:00Z" });
  const second = await oc.recordActivity(connection, { network: "bluesky", url: "javascript:alert(1)", at: "not a date" });
  expect(first.id).not.toBe(second.id);

  const activity = await oc.listActivity(user.id);
  expect(activity.map((a) => a.id)).toEqual([second.id, first.id]);
  expect(activity[1]).toMatchObject({ app: "DefPromo", network: "reddit", kind: "comment", url: "https://reddit.com/r/x/c/1", project: "myna", at: "2026-09-13T01:00:00.000Z" });
  expect(activity[0]).toMatchObject({ network: "bluesky", kind: "post", url: null });
});
