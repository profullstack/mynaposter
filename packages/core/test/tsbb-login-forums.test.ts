/**
 * What login does with the board's answer about where a member may post.
 *
 * The whole device flow is stubbed here, because the interesting part is the
 * two forum-list reads around it: one as a guest before anyone approves a code,
 * and one as the member afterwards. `canPost` from the first is worthless — a
 * guest may post nowhere — and reading it as a refusal would reject a login
 * that works.
 */
import { test, expect, afterEach } from "bun:test";
import { tsbb } from "../src/net/adapters/tsbb.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface BoardForum {
  slug: string;
  kind?: string;
  canPost?: boolean;
}

/** A board whose forum list answers differently with and without a token. */
function stubBoard(guest: BoardForum[], member: BoardForum[]): { asked: string[] } {
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(typeof input === "object" && "url" in input ? input.url : input);
    const headers = new Headers(
      (typeof input === "object" && "headers" in input ? (input as Request).headers : init?.headers) ?? {},
    );
    const authed = headers.get("authorization") !== null;
    asked.push(`${authed ? "member" : "guest"} ${new URL(url).pathname}`);

    const body = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

    if (url.endsWith("/api/v1")) return body({ api: "tsbb", board: { name: "Test Board" } });
    if (url.endsWith("/api/v1/forums")) return body({ forums: authed ? member : guest });
    if (url.endsWith("/api/v1/device/start")) {
      return body({ userCode: "AAAA-BBBB", deviceCode: "dc", verifyUrl: "https://board.test/link", interval: 0 });
    }
    if (url.endsWith("/api/v1/device/poll")) return body({ status: "approved", token: "tsbb_member" });
    if (url.endsWith("/api/v1/me")) return body({ username: "member" });
    throw new Error(`unexpected request: ${url}`);
  }) as unknown as typeof fetch;
  return { asked };
}

const ctx = () => {
  const lines: string[] = [];
  return {
    lines,
    report: (line: string) => lines.push(line),
    openUrl: async () => {},
  };
};

test("a forum the member cannot post in is left out, with a line saying why", async () => {
  // The live case: `news` is fed by a blog and takes replies only. As a guest
  // every canPost is false, which is exactly why the guest list cannot decide.
  stubBoard(
    [{ slug: "app-showcase", canPost: false }, { slug: "news", canPost: false }],
    [{ slug: "app-showcase", canPost: true }, { slug: "news", canPost: false }],
  );
  const context = ctx();

  const account = await tsbb.login(
    { instance: "https://board.test", forum: "app-showcase,news" },
    context as never,
  );

  expect(account.meta.forum).toBe("app-showcase");
  expect(context.lines.some((line) => /news.*replies only|left out/i.test(line))).toBe(true);
});

test("an older board that omits canPost keeps every forum it was given", async () => {
  // "Cannot tell" must not read as "no", or myna would refuse a working login
  // against every board older than tsbb 0.5.1.
  stubBoard([{ slug: "general" }, { slug: "news" }], [{ slug: "general" }, { slug: "news" }]);

  const account = await tsbb.login(
    { instance: "https://board.test", forum: "general,news" },
    ctx() as never,
  );

  expect(account.meta.forum).toBe("general,news");
});

test("when nothing the member asked for takes topics, login says so", async () => {
  stubBoard([{ slug: "news", canPost: false }], [{ slug: "news", canPost: false }]);

  await expect(
    tsbb.login({ instance: "https://board.test", forum: "news" }, ctx() as never),
  ).rejects.toThrow(/cannot start topics in news/);
});

test("a category is refused before anyone approves a code", async () => {
  const board = stubBoard(
    [{ slug: "community", kind: "category" }, { slug: "general", kind: "forum" }],
    [{ slug: "community", kind: "category" }, { slug: "general", kind: "forum" }],
  );

  await expect(
    tsbb.login({ instance: "https://board.test", forum: "community" }, ctx() as never),
  ).rejects.toThrow(/is a category/);

  // Being a category is true of everybody, so this costs no device approval.
  expect(board.asked.some((call) => call.includes("device/start"))).toBe(false);
});

test("the member list is read with the token, not without it", async () => {
  const board = stubBoard(
    [{ slug: "general", canPost: false }],
    [{ slug: "general", canPost: true }],
  );

  await tsbb.login({ instance: "https://board.test", forum: "general" }, ctx() as never);

  expect(board.asked).toContain("guest /api/v1/forums");
  expect(board.asked).toContain("member /api/v1/forums");
});
