import { test, expect, afterEach } from "bun:test";
import { moltbook, colony, fourclaw, ugig } from "../src/net/adapters/agentnets.ts";
import { devto } from "../src/net/adapters/blogs.ts";
import { getNetwork } from "../src/net/registry.ts";
import type { Account } from "../src/net/types.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Call {
  url: string;
  method: string;
  body?: any;
  auth?: string;
}

/** Answer each request from `routes` by "METHOD url-suffix", recording what was sent. */
function mockFetch(routes: Record<string, unknown>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url: input, method, body: init.body ? JSON.parse(String(init.body)) : undefined, auth: headers.authorization ?? headers["api-key"] });
    const key = Object.keys(routes).find((route) => {
      const [m, suffix] = route.split(" ");
      return m === method && input.split("?")[0].endsWith(suffix);
    });
    if (!key) return new Response(JSON.stringify({ error: `unmocked ${method} ${input}` }), { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as typeof fetch;
  return calls;
}

const account = (network: string, creds: Record<string, string>, meta: Record<string, string> = {}): Account => ({
  id: `${network}:me`,
  network,
  handle: "me",
  addedAt: "",
  creds,
  meta,
});

const ctx = { report: () => {}, openUrl: async () => {} };

test("the agent networks and Forem aliases resolve", () => {
  expect(getNetwork("moltbook")?.id).toBe("moltbook");
  expect(getNetwork("thecolony")?.id).toBe("colony");
  expect(getNetwork("4claw.org")?.id).toBe("4claw");
  expect(getNetwork("ugig.net")?.id).toBe("ugig");
  expect(getNetwork("moltexchange")?.id).toBe("moltexchange");
  expect(getNetwork("forem")?.id).toBe("devto");
  expect(getNetwork("codenewbie")?.id).toBe("devto");
});

test("moltbook solves the verification challenge a new post comes back with", async () => {
  const calls = mockFetch({
    "POST /api/v1/posts": {
      post: {
        id: "p1",
        verification_status: "pending",
        verification: { verification_code: "moltbook_verify_x", challenge_text: "A] lO^bSt-Er S[wImS aT/ tW]eNn-Tyy mE^tE[rS aNd] SlO/wS bY^ fI[vE" },
      },
    },
    "POST /api/v1/verify": { success: true },
  });
  const result = await moltbook.post(account("moltbook", { apiKey: "moltbook_k" }, { submolt: "general" }), { text: "Body here", title: "Hello" });
  expect(result).toEqual({ id: "p1", url: "https://www.moltbook.com/post/p1" });
  expect(calls[0].body).toMatchObject({ submolt_name: "general", title: "Hello", content: "Body here" });
  expect(calls[0].auth).toBe("Bearer moltbook_k");
  expect(calls[1].body).toEqual({ verification_code: "moltbook_verify_x", answer: "15.00" });
});

test("moltbook reports a rejected answer instead of claiming success", async () => {
  mockFetch({
    "POST /api/v1/posts": { post: { id: "p2", verification_status: "pending", verification: { verification_code: "c", challenge_text: "twenty plus five" } } },
    "POST /api/v1/verify": { success: false, error: "Incorrect answer" },
  });
  await expect(moltbook.post(account("moltbook", { apiKey: "k" }), { text: "x", title: "t" })).rejects.toThrow(/unpublished: Incorrect answer/);
});

test("the colony registers in two steps when no key is given, proving the key with its last six", async () => {
  const calls = mockFetch({
    "POST /auth/register/begin": { api_key: "col_abcdefghijklmnop123456", claim_token: "rct_1" },
    "POST /auth/register/confirm": { status: "active" },
    "POST /auth/token": { access_token: "jwt" },
    "GET /users/me": { username: "riotcoder", display_name: "riotcoder" },
  });
  const saved = await colony.login({ apiKey: "", username: "riotcoder", bio: "b", colony: "general" }, ctx);
  expect(saved.handle).toBe("riotcoder");
  expect(saved.creds.apiKey).toBe("col_abcdefghijklmnop123456");
  expect(calls[1].body).toEqual({ claim_token: "rct_1", key_fingerprint: "123456" });
  expect(calls[3].auth).toBe("Bearer jwt");
});

test("the colony posts by colony name, resolved to its id", async () => {
  const calls = mockFetch({
    "POST /auth/token": { access_token: "jwt" },
    "GET /colonies": [{ id: "fcd0f9ac-673d-4688-a95f-c21a560a8db8", name: "general" }],
    "POST /posts": { id: "c1" },
  });
  const result = await colony.post(account("colony", { apiKey: "col_k" }, { colony: "general" }), { text: "body", title: "A title", extra: { tags: "a,b", postType: "finding" } });
  expect(result.url).toBe("https://thecolony.ai/post/c1");
  expect(calls.at(-1)!.body).toEqual({ colony_id: "fcd0f9ac-673d-4688-a95f-c21a560a8db8", title: "A title", body: "body", tags: ["a", "b"], post_type: "finding" });
});

test("4claw needs a board and starts a thread on it", async () => {
  await expect(fourclaw.post(account("4claw", { apiKey: "k" }), { text: "x", title: "t" })).rejects.toThrow(/--board/);
  const calls = mockFetch({ "POST /boards/singularity/threads": { thread: { id: "t1" } } });
  const result = await fourclaw.post(account("4claw", { apiKey: "clawchan_k" }, { board: "singularity" }), { text: "body", title: "hi" });
  expect(result).toEqual({ id: "t1", url: "https://www.4claw.org/t/t1" });
  expect(calls[0].body).toEqual({ title: "hi", content: "body", anon: false });
});

test("ugig posts to the feed and lifts the first link into url", async () => {
  const calls = mockFetch({ "POST /api/posts": { post: { id: "u1" } } });
  const result = await ugig.post(account("ugig", { apiKey: "ugig_live_k" }), { text: "shipped https://example.com/x today" });
  expect(result.url).toBe("https://ugig.net/post/u1");
  expect(calls[0].body).toEqual({ content: "shipped https://example.com/x today", url: "https://example.com/x", tags: [] });
});

test("a Forem other than dev.to keeps its address and names the account user@host", async () => {
  const calls = mockFetch({
    "GET /api/users/me": { username: "chovy", name: "Anthony" },
    "POST /api/articles": { id: 7, url: "https://community.codenewbie.org/chovy/x" },
  });
  const saved = await devto.login({ apiKey: "k", instance: "community.codenewbie.org" }, ctx);
  expect(saved.handle).toBe("chovy@community.codenewbie.org");
  expect(saved.meta.instance).toBe("https://community.codenewbie.org");
  expect(calls[0].url).toBe("https://community.codenewbie.org/api/users/me");

  await devto.post({ ...account("devto", saved.creds, saved.meta) }, { text: "body", title: "t" });
  expect(calls[1].url).toBe("https://community.codenewbie.org/api/articles");
});

test("dev.to itself is unchanged: plain handle, no stored address", async () => {
  mockFetch({ "GET /api/users/me": { username: "chovy", name: "Anthony" } });
  const saved = await devto.login({ apiKey: "k", instance: "" }, ctx);
  expect(saved.handle).toBe("chovy");
  expect(saved.meta).toEqual({});
});
