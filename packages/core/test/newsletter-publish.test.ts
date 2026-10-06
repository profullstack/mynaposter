/**
 * An issue's web copy: once a newsletter has gone out it is posted to the
 * accounts its list names in newsletter.publishTo, once each.
 *
 * What has to hold: nothing goes up before anyone was mailed; the post is the
 * newsletter channel with the issue id as its idempotency key and the CTA as a
 * plain link; a recent issue is broadcast and an old one is filed quietly; a
 * second daemon turn posts nothing; a failure is recorded and retried, up to
 * the cap; a list with no publishTo is left alone.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNewsletter, readNewsletters, recordDelivery, writeNewsletters } from "../src/store/newsletters.ts";
import { MAX_ATTEMPTS, publishDueNewsletters, publishNewsletter, webBody } from "../src/core/newsletter-publish.ts";
import { loadSettings, saveSettings } from "../src/store/settings.ts";
import { resetAccountCache, saveAccount } from "../src/store/accounts.ts";
import type { Account } from "../src/net/types.ts";

const realFetch = globalThis.fetch;
let dir = "";
let posts: any[] = [];
let failing = false;

const PUBLICATION_URL = "https://chovy.bl0ggers.com";
const account: Account = {
  id: "bl0ggers:chovy",
  network: "bl0ggers",
  handle: "chovy",
  addedAt: new Date().toISOString(),
  creds: { token: "blg_good" },
  meta: { site: "https://bl0ggers.com", slug: "chovy", channels: "blog,newsletter", channel: "newsletter", siteUrl: PUBLICATION_URL },
};

const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-publish-"));
  process.env.MYNA_HOME = dir;
  resetAccountCache();
  posts = [];
  failing = false;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (failing) return json(503, { ok: false, error: "down for maintenance" });
    const body = JSON.parse(String(init?.body));
    expect(body.ad).toBeUndefined();
    posts.push(body);
    return json(201, { ok: true, data: { id: `post_${posts.length}`, slug: "issue", channel: body.channel, status: "published", url: `${PUBLICATION_URL}/issues/issue` } });
  }) as unknown as typeof fetch;
  saveAccount(account);
  const settings = loadSettings();
  settings.newsletter.ctaSets.winner = [{ label: "Schedule a call", url: "https://profullstack.com/contact" }];
  settings.newsletter.publishTo = { "profullstack-users": ["bl0ggers:chovy"] };
  saveSettings(settings);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
  resetAccountCache();
});

function issue(id: string, list = "profullstack-users") {
  return createNewsletter({ id, subject: "Profullstack: What shipped", body: "Hi,\n\nWe shipped things.\n\n{{cta}}\n\nThanks.", list, ctaSet: "winner" });
}

function markSent(id: string, at: string) {
  recordDelivery(id, "c1", { state: "sent", at, to: "a@example.com" });
  const file = readNewsletters();
  const entry = file.newsletters.find((n) => n.id === id)!;
  entry.status = "sent";
  entry.sentAt = at;
  writeNewsletters(file);
}

test("the web body turns {{cta}} into a plain link to the set's first call to action", () => {
  expect(webBody({ body: "One.\n\n{{cta}}\n\nTwo.", ctaSet: "winner" })).toBe("One.\n\n[Schedule a call](https://profullstack.com/contact)\n\nTwo.");
  expect(webBody({ body: "One.\n\n{{cta}}\n\nTwo.", ctaSet: null })).toBe("One.\n\nTwo.");
});

test("an issue nobody has been mailed is not published", async () => {
  issue("p-001");
  await expect(publishNewsletter("p-001")).rejects.toThrow(/has not gone out/);
  expect(await publishDueNewsletters()).toEqual([]);
  expect(posts).toEqual([]);
});

test("a sent issue goes up once, on the newsletter channel, keyed by its id, and is broadcast while fresh", async () => {
  issue("p-002");
  markSent("p-002", new Date().toISOString());
  const lines = await publishDueNewsletters();
  expect(lines).toEqual([`p-002 → bl0ggers:chovy: ${PUBLICATION_URL}/issues/issue`]);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ title: "Profullstack: What shipped", channel: "newsletter", external_id: "myna:newsletter:p-002", broadcast: true, status: "published" });
  expect(posts[0].markdown).toContain("[Schedule a call](https://profullstack.com/contact)");
  expect(posts[0].markdown).not.toContain("{{cta}}");

  // The next turn has nothing owed, and a hand re-run says so without posting.
  expect(await publishDueNewsletters()).toEqual([]);
  expect((await publishNewsletter("p-002"))[0]).toMatchObject({ ok: true, skipped: "already published" });
  expect(posts).toHaveLength(1);
  expect(readNewsletters().newsletters[0]?.published?.["bl0ggers:chovy"]).toMatchObject({ ok: true, attempts: 1, url: `${PUBLICATION_URL}/issues/issue` });
});

test("an issue sent days ago is filed without mailing the publication's subscribers", async () => {
  issue("p-003");
  markSent("p-003", new Date(Date.now() - 10 * 24 * 3600_000).toISOString());
  await publishDueNewsletters();
  expect(posts[0]).toMatchObject({ broadcast: false });
});

test("an issue part way out counts from its first delivery", async () => {
  issue("p-004");
  recordDelivery("p-004", "c1", { state: "sent", at: new Date().toISOString(), to: "a@example.com" });
  await publishDueNewsletters();
  expect(posts[0]).toMatchObject({ external_id: "myna:newsletter:p-004", broadcast: true });
});

test("a failure is written down and retried on later turns, up to the cap", async () => {
  issue("p-005");
  markSent("p-005", new Date().toISOString());
  failing = true;
  for (let n = 0; n < MAX_ATTEMPTS + 2; n++) await publishDueNewsletters();
  const copy = readNewsletters().newsletters[0]?.published?.["bl0ggers:chovy"];
  expect(copy).toMatchObject({ ok: false, attempts: MAX_ATTEMPTS });
  expect(copy?.error).toContain("down for maintenance");
  // By hand it can still be pushed through.
  failing = false;
  expect((await publishNewsletter("p-005"))[0]).toMatchObject({ ok: true });
  expect(posts).toHaveLength(1);
});

test("a list with no publishTo is left alone, and --to names accounts by hand", async () => {
  issue("m-001", "moshcode-users");
  markSent("m-001", new Date().toISOString());
  expect(await publishDueNewsletters()).toEqual([]);
  await expect(publishNewsletter("m-001")).rejects.toThrow(/Nowhere to publish/);
  const [result] = await publishNewsletter("m-001", { to: ["bl0ggers:chovy"], broadcast: false });
  expect(result).toMatchObject({ ok: true });
  expect(posts[0]).toMatchObject({ broadcast: false, external_id: "myna:newsletter:m-001" });
});

test("publishTo survives a settings round trip and drops junk", () => {
  const settings = loadSettings();
  (settings.newsletter as any).publishTo = { " Profullstack-Users ": ["bl0ggers:chovy", "", 3], other: "nope" };
  saveSettings(settings);
  expect(loadSettings().newsletter.publishTo).toEqual({ "profullstack-users": ["bl0ggers:chovy"] });
});
