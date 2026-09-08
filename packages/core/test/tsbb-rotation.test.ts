/**
 * The rotation against a board that refuses one of its forums.
 *
 * MYNA_HOME is set before anything imports the store, so the vault these tests
 * write to is a temp directory and never the one on this machine.
 */
import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "myna-tsbb-rotation-"));
process.env.MYNA_HOME = home;

const { tsbb } = await import("../src/net/adapters/tsbb.ts");
const { saveAccount, getAccount, removeAccount } = await import("../src/store/accounts.ts");

const realFetch = globalThis.fetch;

/** A board that 403s on `news` and accepts everything else. */
function board(forbidden: string[] = ["news"], seen: string[] = []): string[] {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(typeof input === "object" && "url" in input ? input.url : input);
    const forum = /\/forums\/([^/]+)\/topics$/.exec(url)?.[1];
    if (!forum) throw new Error(`unexpected request: ${url}`);
    seen.push(forum);
    if (forbidden.includes(forum)) {
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    }
    return new Response(JSON.stringify({ id: 7, url: `/t/a-topic-7` }), { status: 201 });
  }) as typeof fetch;
  return seen;
}

const account = (forum: string, cursor: string) => ({
  id: "tsbb:member@example.com",
  network: "tsbb",
  handle: "member@example.com",
  addedAt: new Date().toISOString(),
  creds: { token: "tsbb_test" },
  meta: { instance: "https://example.com", forum, forumCursor: cursor },
});

beforeAll(() => {
  process.env.MYNA_HOME = home;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  try {
    removeAccount("tsbb:member@example.com");
  } catch {
    /* not every test saved one */
  }
});

afterAll(() => {
  globalThis.fetch = realFetch;
  rmSync(home, { recursive: true, force: true });
});

test("a forum the board refuses is skipped, and dropped from the rotation", async () => {
  // The real case: the cursor was sitting on `news`, which is feed-only on
  // bbs.hqtui.com, so every fan-out would have failed there forever.
  saveAccount(account("app-showcase,announcements,news", "2") as never);
  const seen = board(["news"]);

  const result = await tsbb.post(getAccount("tsbb:member@example.com") as never, {
    text: "myna 0.15.2 is out. It skips a forum the board will not take.",
  });

  expect(result.id).toBe("7");
  // Tried news, was refused, moved on rather than failing the post.
  expect(seen).toEqual(["news", "app-showcase"]);

  const after = getAccount("tsbb:member@example.com");
  expect(after?.meta.forum).toBe("app-showcase,announcements");
});

test("the next post carries on from where the pruned list left off", async () => {
  saveAccount(account("app-showcase,announcements", "1") as never);
  const seen = board([]);

  await tsbb.post(getAccount("tsbb:member@example.com") as never, { text: "Second announcement." });

  expect(seen).toEqual(["announcements"]);
  expect(getAccount("tsbb:member@example.com")?.meta.forumCursor).toBe("0");
});

test("a board that refuses everything fails the post and says why", async () => {
  saveAccount(account("news,help", "0") as never);
  board(["news", "help"]);

  await expect(
    tsbb.post(getAccount("tsbb:member@example.com") as never, { text: "Nowhere to put this." }),
  ).rejects.toThrow(/would not accept a new topic in news, help/);
});

test("a 500 is not a refusal: it fails, and the forum list is left alone", async () => {
  saveAccount(account("app-showcase,announcements", "0") as never);
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "boom" }), { status: 500 })) as unknown as typeof fetch;

  await expect(
    tsbb.post(getAccount("tsbb:member@example.com") as never, { text: "Server is having a day." }),
  ).rejects.toThrow();

  expect(getAccount("tsbb:member@example.com")?.meta.forum).toBe("app-showcase,announcements");
});

test("--forum names one forum and never prunes the rotation", async () => {
  saveAccount(account("app-showcase,announcements,news", "0") as never);
  const seen = board(["news"]);

  await expect(
    tsbb.post(getAccount("tsbb:member@example.com") as never, {
      text: "Straight to news, please.",
      extra: { forum: "news" },
    }),
  ).rejects.toThrow();

  expect(seen).toEqual(["news"]);
  // An explicit target that fails is the caller's problem to fix, not a
  // reason to quietly edit the account.
  expect(getAccount("tsbb:member@example.com")?.meta.forum).toBe("app-showcase,announcements,news");
});
