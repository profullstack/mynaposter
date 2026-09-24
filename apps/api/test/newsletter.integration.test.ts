/**
 * Newsletter one-click unsubscribe, against a real Postgres.
 *
 * Skipped unless DATABASE_URL is set, like the cloud test beside it. What
 * has to hold: a user gets one inbox however often it is asked for; a token
 * is recorded once however often it is pressed; a made-up inbox records
 * nothing; each user reads back only their own tokens, after `since`.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { migrate, closeDatabase, hasDatabase } from "../src/db/index.ts";
import * as cloud from "../src/cloud.ts";
import * as newsletter from "../src/newsletter.ts";

const enabled = hasDatabase();
const it = enabled ? test : test.skip;

const PASSWORD = "a long enough password";
const unique = () => `n${Date.now()}${Math.random().toString(36).slice(2, 8)}@example.com`;

beforeAll(async () => {
  if (enabled) await migrate();
});
afterAll(async () => {
  if (enabled) await closeDatabase();
});

it("one inbox per user; a token recorded once; each user reads only their own", async () => {
  const { user } = await cloud.signup(unique(), PASSWORD);
  const { user: other } = await cloud.signup(unique(), PASSWORD);

  const inbox = await newsletter.ensureInbox(user.id);
  expect(inbox).toMatch(newsletter.PART_SHAPE);
  expect(await newsletter.ensureInbox(user.id)).toBe(inbox);
  const otherInbox = await newsletter.ensureInbox(other.id);
  expect(otherInbox).not.toBe(inbox);

  const token = "tokentokentokentoken12";
  expect(await newsletter.recordUnsubscribe(inbox, token)).toBe(true);
  expect(await newsletter.recordUnsubscribe(inbox, token)).toBe(true);
  expect(await newsletter.recordUnsubscribe("nosuchinboxnosuch", token)).toBe(false);
  expect(await newsletter.recordUnsubscribe(inbox, "short")).toBe(false);

  const mine = await newsletter.listUnsubscribes(user.id);
  expect(mine.map((row) => row.token)).toEqual([token]);
  expect(await newsletter.listUnsubscribes(other.id)).toEqual([]);
  expect(await newsletter.listUnsubscribes(user.id, new Date(Date.now() + 60_000).toISOString())).toEqual([]);
});

test("the pages carry no script and post only to themselves", () => {
  expect(newsletter.PAGE_CSP).toContain("default-src 'none'");
  expect(newsletter.PAGE_CSP).toContain("form-action 'self'");
  expect(newsletter.confirmPage()).toContain('<form method="post">');
  expect(newsletter.confirmPage()).not.toContain("<script");
  expect(newsletter.donePage()).toContain("unsubscribed");
});
