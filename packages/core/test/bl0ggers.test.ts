/**
 * The bl0ggers network, against a stand-in for the v1 API.
 *
 * fetch is replaced for the bl0ggers host only; calls to the loopback
 * listener go through the real fetch, so the PKCE sign-in is exercised over
 * a real socket end to end: authorize URL, redirect, state check, exchange.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import {
  bl0ggers,
  authorizeUrl,
  externalIdFor,
  listenForCode,
  makePkce,
  normalizeSite,
  postBody,
} from "../src/net/adapters/bl0ggers.ts";
import { getNetwork } from "../src/net/registry.ts";
import { skillKindFor } from "../src/core/skills.ts";
import { tailor } from "../src/core/poster.ts";
import type { Account, LoginContext } from "../src/net/types.ts";

const realFetch = globalThis.fetch;

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: any;
}

let calls: Call[];
/** Posts the fake server holds, by external_id, to prove a retry updates. */
let stored: Map<string, { id: string; slug: string }>;
let tokenGrant: { token: string; publication: any } | undefined;

const PUBLICATION = {
  id: "pub_1",
  slug: "riot-notes",
  title: "Riot Notes",
  description: "notes",
  channels: ["blog", "newsletter"],
  paused: false,
  url: "https://riot-notes.bl0ggers.com",
};

const json = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

function fakeServer(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("http://127.0.0.1")) return realFetch(input as any, init);
  const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const method = init?.method ?? "GET";
  calls.push({ method, url, headers, body });
  const path = new URL(url).pathname;

  if (path === "/api/v1/cli/token") {
    if (!tokenGrant) return Promise.resolve(json(400, { ok: false, error: "invalid_grant" }));
    return Promise.resolve(json(200, { ok: true, data: tokenGrant }));
  }
  if (headers.authorization !== "Bearer blg_good") {
    return Promise.resolve(json(401, { ok: false, error: "invalid api key" }));
  }
  if (path === "/api/v1/publication") return Promise.resolve(json(200, { ok: true, data: PUBLICATION }));
  if (path === "/api/v1/posts" && method === "POST") {
    if (!body?.title) return Promise.resolve(json(422, { ok: false, error: "title is required" }));
    const existing = stored.get(body.external_id);
    const slug = body.slug ?? body.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const post = existing ?? { id: `post_${stored.size + 1}`, slug };
    stored.set(body.external_id, post);
    return Promise.resolve(
      json(existing ? 200 : 201, {
        ok: true,
        data: { id: post.id, slug: post.slug, channel: body.channel ?? "blog", status: body.status ?? "published", url: `${PUBLICATION.url}/${post.slug}` },
      }),
    );
  }
  if (path.startsWith("/api/v1/posts/") && method === "DELETE") return Promise.resolve(json(200, { ok: true, data: { deleted: true } }));
  return Promise.resolve(json(404, { ok: false, error: "not found" }));
}

beforeEach(() => {
  calls = [];
  stored = new Map();
  tokenGrant = undefined;
  globalThis.fetch = fakeServer as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const account: Account = {
  id: "bl0ggers:riot-notes",
  network: "bl0ggers",
  handle: "riot-notes",
  addedAt: new Date().toISOString(),
  creds: { token: "blg_good" },
  meta: { site: "https://bl0ggers.com", slug: "riot-notes", channels: "blog,newsletter", siteUrl: PUBLICATION.url },
};

const quietCtx = (openUrl: (url: string) => Promise<void>): LoginContext => ({ report: () => {}, openUrl });

test("registered as a blog that only posts when named, with a title", () => {
  expect(getNetwork("bl0ggers")?.id).toBe("bl0ggers");
  expect(getNetwork("bloggers")?.id).toBe("bl0ggers");
  expect(bl0ggers.caps.explicitTarget).toBe(true);
  expect(bl0ggers.caps.needsTitle).toBe(true);
  expect(bl0ggers.auth.docsUrl?.startsWith("https://")).toBe(true);
  expect(skillKindFor("bl0ggers")).toBe("blog");
  const long = "word ".repeat(3000).trim();
  expect(tailor("bl0ggers", { text: long, thread: true })).toEqual([long]);
});

test("a post sends the mapped body with the bearer key and returns the post URL", async () => {
  const result = await bl0ggers.post(account, {
    title: "Release 1.2",
    text: "Release 1.2\n\nThe first paragraph.\n\n## More\nDetails.",
    extra: {
      canonicalUrl: "https://example.com/blog/release-1-2",
      tags: "release, #cli",
      channel: "newsletter",
      imageUrl: "https://example.com/cover.png",
      slug: "release-1-2",
    },
  });
  expect(result.url).toBe("https://riot-notes.bl0ggers.com/release-1-2");
  expect(result.id).toBe("post_1");
  const call = calls[0];
  expect(call.method).toBe("POST");
  expect(call.url).toBe("https://bl0ggers.com/api/v1/posts");
  expect(call.headers.authorization).toBe("Bearer blg_good");
  expect(call.body).toMatchObject({
    title: "Release 1.2",
    // The title line is not repeated in the body.
    markdown: "The first paragraph.\n\n## More\nDetails.",
    status: "published",
    channel: "newsletter",
    slug: "release-1-2",
    excerpt: "The first paragraph.",
    image_url: "https://example.com/cover.png",
    canonical_url: "https://example.com/blog/release-1-2",
    tags: ["release", "cli"],
  });
  expect(call.body.external_id).toMatch(/^myna:[0-9a-f]{32}$/);
});

test("a retry of the same post reuses its external_id, so bl0ggers updates instead of duplicating", async () => {
  const input = { title: "Same post", text: "Same post\n\nBody." };
  const first = await bl0ggers.post(account, input);
  const second = await bl0ggers.post(account, input);
  expect(calls[0].body.external_id).toBe(calls[1].body.external_id);
  expect(second.id).toBe(first.id);
  expect(stored.size).toBe(1);

  // The daemon passes the queue entry; that wins over the title hash, and --external-id over both.
  expect(externalIdFor(account, "Same post", { queueId: "q123" })).toBe("myna:q:q123");
  expect(externalIdFor(account, "Same post", { queueId: "q123", externalId: "mine" })).toBe("mine");
  // A different publication is a different post.
  expect(externalIdFor({ id: "bl0ggers:other" }, "Same post", {})).not.toBe(externalIdFor(account, "Same post", {}));
});

test("the daemon's queue id reaches the body", () => {
  const body = postBody(account, { title: "Queued", text: "Body", extra: { queueId: "abc" } });
  expect(body.external_id).toBe("myna:q:abc");
  // An unset channel is left for bl0ggers to choose.
  expect(body.channel).toBeUndefined();
});

test("a refused key is a 401 with a way forward", async () => {
  const bad = { ...account, creds: { token: "blg_revoked" } };
  await expect(bl0ggers.post(bad, { title: "T", text: "x" })).rejects.toThrow(/401.*invalid api key.*myna login bl0ggers/);
});

test("a channel the publication lacks is refused before anything is sent", async () => {
  await expect(bl0ggers.post(account, { title: "T", text: "x", extra: { channel: "podcast" } })).rejects.toThrow(/podcast channel/);
  await expect(bl0ggers.post(account, { title: "T", text: "x", extra: { channel: "vlog" } })).rejects.toThrow(/not a bl0ggers channel/);
  expect(calls).toHaveLength(0);
});

test("--draft true sends a draft; remove deletes by id", async () => {
  await bl0ggers.post(account, { title: "T", text: "x", extra: { draft: "true" } });
  expect(calls[0].body.status).toBe("draft");
  await bl0ggers.remove!(account, "post_1");
  expect(calls[1]).toMatchObject({ method: "DELETE", url: "https://bl0ggers.com/api/v1/posts/post_1" });
});

test("--token logs in headless, named by the publication slug", async () => {
  const partial = await bl0ggers.login({ token: "blg_good", channel: "blog" }, quietCtx(async () => {}));
  expect(partial.handle).toBe("riot-notes");
  expect(partial.creds).toEqual({ token: "blg_good" });
  expect(partial.meta).toMatchObject({ site: "https://bl0ggers.com", slug: "riot-notes", channel: "blog", channels: "blog,newsletter", siteUrl: PUBLICATION.url });
  await expect(bl0ggers.login({ token: "blg_bad" }, quietCtx(async () => {}))).rejects.toThrow(/401/);
  await expect(bl0ggers.login({ token: "nope" }, quietCtx(async () => {}))).rejects.toThrow(/blg_/);
});

test("browser login: PKCE S256 over a random loopback port, code exchanged with the verifier", async () => {
  tokenGrant = { token: "blg_good", publication: { id: "pub_1", slug: "riot-notes", title: "Riot Notes", url: PUBLICATION.url } };
  let opened = "";
  const partial = await bl0ggers.login(
    {},
    quietCtx(async (url) => {
      opened = url;
      const authorize = new URL(url);
      const redirect = authorize.searchParams.get("redirect_uri")!;
      const state = authorize.searchParams.get("state")!;
      // What the browser does after the person approves.
      const response = await realFetch(`${redirect}?code=c0de&state=${encodeURIComponent(state)}`);
      expect(await response.text()).toContain("Connected");
    }),
  );
  expect(partial.handle).toBe("riot-notes");

  const authorize = new URL(opened);
  expect(authorize.origin + authorize.pathname).toBe("https://bl0ggers.com/cli/authorize");
  expect(authorize.searchParams.get("client")).toBe("myna");
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  const redirect = authorize.searchParams.get("redirect_uri")!;
  expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  expect(redirect).not.toContain(":0/");

  const exchange = calls.find((call) => call.url.endsWith("/api/v1/cli/token"))!;
  expect(exchange.method).toBe("POST");
  expect(exchange.body.grant_type).toBe("authorization_code");
  expect(exchange.body.code).toBe("c0de");
  expect(exchange.body.redirect_uri).toBe(redirect);
  // The verifier sent is the one the challenge was made from.
  const challenge = createHash("sha256").update(exchange.body.code_verifier).digest("base64url");
  expect(challenge).toBe(authorize.searchParams.get("code_challenge")!);
});

test("a callback with the wrong state is refused and nothing is exchanged", async () => {
  tokenGrant = { token: "blg_good", publication: PUBLICATION };
  let page = "";
  await expect(
    bl0ggers.login(
      {},
      quietCtx(async (url) => {
        const redirect = new URL(url).searchParams.get("redirect_uri")!;
        page = await (await realFetch(`${redirect}?code=c0de&state=forged`)).text();
      }),
    ),
  ).rejects.toThrow(/state mismatch/);
  expect(page).toContain("State did not match");
  expect(calls.some((call) => call.url.includes("/cli/token"))).toBe(false);
});

test("access_denied on the authorize page ends the login", async () => {
  await expect(
    bl0ggers.login(
      {},
      quietCtx(async (url) => {
        const authorize = new URL(url);
        await realFetch(`${authorize.searchParams.get("redirect_uri")}?error=access_denied&state=${authorize.searchParams.get("state")}`);
      }),
    ),
  ).rejects.toThrow(/denied/);
});

test("the loopback listener times out rather than waiting forever", async () => {
  const loopback = await listenForCode("s", 50);
  await expect(loopback.code).rejects.toThrow(/timed out/);
});

test("authorize URL and site normalisation", () => {
  const pkce = makePkce();
  expect(pkce.challenge).toBe(createHash("sha256").update(pkce.verifier).digest("base64url"));
  const url = new URL(authorizeUrl("https://bl0ggers.com", "http://127.0.0.1:5555/callback", pkce));
  expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:5555/callback");
  expect(url.searchParams.get("state")).toBe(pkce.state);
  expect(normalizeSite("")).toBe("https://bl0ggers.com");
  expect(normalizeSite("bl0ggers.com/")).toBe("https://bl0ggers.com");
  expect(normalizeSite("http://localhost:3000/")).toBe("http://localhost:3000");
});

test("a non-default site names the account slug@host", async () => {
  const partial = await bl0ggers.login({ token: "blg_good", site: "http://localhost:3000" }, quietCtx(async () => {}));
  expect(partial.handle).toBe("riot-notes@localhost:3000");
  expect(calls[0].url).toBe("http://localhost:3000/api/v1/publication");
});
