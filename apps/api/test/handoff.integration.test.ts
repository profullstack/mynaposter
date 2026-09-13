/**
 * Hand-off cards, against a real Postgres.
 *
 * Skipped unless DATABASE_URL is set, like the cloud test beside it. What
 * has to hold: a card is made for a user and read back by its id alone; the
 * id has the shape the page accepts; marking done round-trips; the owner's
 * list shows open cards first; only the owner can remove one.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { migrate, closeDatabase, hasDatabase } from "../src/db/index.ts";
import * as cloud from "../src/cloud.ts";
import * as handoff from "../src/handoff.ts";

const enabled = hasDatabase();
const it = enabled ? test : test.skip;

const PASSWORD = "a long enough password";
const unique = () => `h${Date.now()}${Math.random().toString(36).slice(2, 8)}@example.com`;

beforeAll(async () => {
  if (enabled) await migrate();
});
afterAll(async () => {
  if (enabled) await closeDatabase();
});

it("a card is made for a user, read by its link, marked done, and removed only by its owner", async () => {
  const { user } = await cloud.signup(unique(), PASSWORD);
  const { user: other } = await cloud.signup(unique(), PASSWORD);

  const card = await handoff.createHandoff(user.id, {
    place: "Hacker News",
    title: "Submit the post",
    text: "Amodei, Altman and Musk agree on one thing",
    openUrl: "https://news.ycombinator.com/submit",
    steps: ["Open HN submit", "Paste title and URL", "Submit"],
  });
  expect(card.id).toMatch(handoff.ID_SHAPE);
  expect(card.url).toBe(`${handoff.siteUrl()}/handoff/${card.id}`);
  expect(card.doneAt).toBeNull();

  expect((await handoff.getHandoff(card.id))?.title).toBe("Submit the post");
  expect(await handoff.getHandoff("nope")).toBeNull();

  const done = await handoff.finishHandoff(card.id);
  expect(done?.doneAt).not.toBeNull();
  expect((await handoff.listHandoffs(user.id)).map((entry) => entry.id)).not.toContain(card.id);
  expect((await handoff.listHandoffs(user.id, { all: true })).map((entry) => entry.id)).toContain(card.id);
  expect((await handoff.finishHandoff(card.id, false))?.doneAt).toBeNull();
  expect((await handoff.listHandoffs(user.id)).map((entry) => entry.id)).toContain(card.id);

  await expect(handoff.removeHandoff(card.id, other.id)).rejects.toThrow(/whoever made/);
  expect(await handoff.removeHandoff(card.id, user.id)).toBe(true);
  expect(await handoff.removeHandoff(card.id, user.id)).toBe(false);
});

it("a card without a place, a title or text is refused before it reaches the table", async () => {
  const { user } = await cloud.signup(unique(), PASSWORD);
  await expect(handoff.createHandoff(user.id, { place: "HN", title: "", text: "x" })).rejects.toThrow(/needs a title/);
  await expect(handoff.createHandoff(user.id, { place: "HN", title: "t", text: "x", openUrl: "ftp://x" })).rejects.toThrow(/http/);
});
