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
  expect(mine.map((row) => [row.token, row.state])).toEqual([[token, "unsubscribed"]]);
  expect(await newsletter.listUnsubscribes(other.id)).toEqual([]);
  const seen = mine[0]?.at as string;
  expect(await newsletter.listUnsubscribes(user.id, seen)).toEqual([]);

  // Re-subscribe moves the row forward, so the next pull hands it over again.
  expect(await newsletter.recordResubscribe(inbox, token)).toBe(true);
  const after = await newsletter.listUnsubscribes(user.id, seen);
  expect(after.map((row) => [row.token, row.state])).toEqual([[token, "resubscribed"]]);
  expect(await newsletter.recordUnsubscribe(inbox, token)).toBe(true);
  expect((await newsletter.listUnsubscribes(user.id, after[0]?.at)).map((row) => row.state)).toEqual(["unsubscribed"]);
});

test("the pages carry no script; one says done and offers Re-subscribe, the other offers the way out again", () => {
  expect(newsletter.PAGE_CSP).toContain("default-src 'none'");
  expect(newsletter.PAGE_CSP).toContain("form-action 'self'");
  const done = newsletter.unsubscribedPage("tok/resubscribe");
  expect(done).toContain("You're unsubscribed.");
  expect(done).toContain('<form method="post" action="tok/resubscribe"><button type="submit" class="quiet">Re-subscribe</button>');
  expect(done).not.toContain("<script");
  const back = newsletter.resubscribedPage("../tok");
  expect(back).toContain("subscribed again");
  expect(back).toContain('action="../tok"');
});
