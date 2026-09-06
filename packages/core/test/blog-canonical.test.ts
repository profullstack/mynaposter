/**
 * `--canonical-url` on the long-form networks that have a field for it.
 *
 * Each adapter is driven against a stubbed fetch and the request body is read
 * back, because the thing worth asserting is the field name on the wire: they
 * all differ, and getting one wrong fails silently as a post with no canonical
 * rather than as an error.
 */
import { test, expect } from "bun:test";
import { devto, hashnode, ghost, tumblr } from "../src/net/adapters/blogs.ts";
import type { Account, PostInput } from "../src/net/types.ts";

const CANONICAL = "https://example.com/~me/blog/042-post.html";

/** Run one post against a stubbed fetch and hand back the request bodies. */
async function capture(
  run: () => Promise<unknown>,
  reply: (url: string) => Response,
): Promise<Record<string, any>[]> {
  const bodies: Record<string, any>[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (init?.body) {
      const raw = String(init.body);
      try {
        bodies.push(JSON.parse(raw) as Record<string, any>);
      } catch {
        bodies.push(Object.fromEntries(new URLSearchParams(raw)));
      }
    }
    return reply(String(url));
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = realFetch;
  }
  return bodies;
}

const account = (network: string, creds: Record<string, string>, meta: Record<string, string> = {}): Account =>
  ({
    id: `${network}:me`,
    network,
    handle: "me",
    addedAt: new Date().toISOString(),
    creds,
    meta,
  }) as unknown as Account;

const input = (canonical?: string): PostInput =>
  ({
    text: "Hello\n\nA body.",
    title: "Hello",
    ...(canonical ? { extra: { canonicalUrl: canonical } } : {}),
  }) as PostInput;

/* ------------------------------------------------------------------ dev.to --- */

test("dev.to sends canonical_url, and omits it when there is none", async () => {
  const reply = (): Response => new Response(JSON.stringify({ id: 1, url: "https://dev.to/x" }), { status: 200 });
  const acct = account("devto", { apiKey: "k" });

  const [withUrl] = await capture(() => devto.post(acct, input(CANONICAL)), reply);
  expect(withUrl.article.canonical_url).toBe(CANONICAL);

  const [without] = await capture(() => devto.post(acct, input()), reply);
  expect(without.article).not.toHaveProperty("canonical_url");
});

/* ---------------------------------------------------------------- hashnode --- */

test("hashnode sends originalArticleURL, its own name for the same thing", async () => {
  const reply = (): Response =>
    new Response(JSON.stringify({ data: { publishPost: { post: { id: "1", url: "https://h/x" } } } }), { status: 200 });
  const acct = account("hashnode", { token: "t" }, { publicationId: "p" });

  const [withUrl] = await capture(() => hashnode.post(acct, input(CANONICAL)), reply);
  expect(withUrl.variables.input.originalArticleURL).toBe(CANONICAL);

  const [without] = await capture(() => hashnode.post(acct, input()), reply);
  expect(without.variables.input).not.toHaveProperty("originalArticleURL");
});

/* ------------------------------------------------------------------- ghost --- */

test("ghost sends canonical_url on the post", async () => {
  const reply = (): Response =>
    new Response(JSON.stringify({ posts: [{ id: "1", url: "https://g/x" }] }), { status: 200 });
  // A syntactically valid admin key: it is split on ":" and hex-decoded to sign.
  const acct = account("ghost", { adminApiKey: `${"a".repeat(24)}:${"b".repeat(64)}` }, { url: "https://g" });

  const [withUrl] = await capture(() => ghost.post(acct, input(CANONICAL)), reply);
  expect(withUrl.posts[0].canonical_url).toBe(CANONICAL);

  const [without] = await capture(() => ghost.post(acct, input()), reply);
  expect(without.posts[0]).not.toHaveProperty("canonical_url");
});

/* ------------------------------------------------------------------ tumblr --- */

test("tumblr sends source_url, the attribution link it has instead of a canonical", async () => {
  const reply = (): Response => new Response(JSON.stringify({ response: { id_string: "1" } }), { status: 200 });
  const acct = account(
    "tumblr",
    { consumerKey: "ck", consumerSecret: "cs", token: "t", tokenSecret: "ts" },
    { blog: "me.tumblr.com" },
  );

  const [withUrl] = await capture(() => tumblr.post(acct, input(CANONICAL)), reply);
  expect(withUrl.source_url).toBe(CANONICAL);

  const [without] = await capture(() => tumblr.post(acct, input()), reply);
  expect(without).not.toHaveProperty("source_url");
});

/* ------------------------------------------------------------------- shape --- */

test("every long-form network that claims canonical support actually sends it", async () => {
  // A guard against adding an adapter, documenting canonical support, and
  // wiring nothing: each of these must put the URL somewhere in its request.
  const cases: [string, () => Promise<unknown>, (url: string) => Response][] = [
    [
      "devto",
      () => devto.post(account("devto", { apiKey: "k" }), input(CANONICAL)),
      () => new Response(JSON.stringify({ id: 1, url: "u" }), { status: 200 }),
    ],
    [
      "hashnode",
      () => hashnode.post(account("hashnode", { token: "t" }, { publicationId: "p" }), input(CANONICAL)),
      () => new Response(JSON.stringify({ data: { publishPost: { post: { id: "1", url: "u" } } } }), { status: 200 }),
    ],
    [
      "ghost",
      () =>
        ghost.post(
          account("ghost", { adminApiKey: `${"a".repeat(24)}:${"b".repeat(64)}` }, { url: "https://g" }),
          input(CANONICAL),
        ),
      () => new Response(JSON.stringify({ posts: [{ id: "1", url: "u" }] }), { status: 200 }),
    ],
    [
      "tumblr",
      () =>
        tumblr.post(
          account("tumblr", { consumerKey: "ck", consumerSecret: "cs", token: "t", tokenSecret: "ts" }, { blog: "b" }),
          input(CANONICAL),
        ),
      () => new Response(JSON.stringify({ response: { id_string: "1" } }), { status: 200 }),
    ],
  ];

  for (const [name, run, reply] of cases) {
    const bodies = await capture(run, reply);
    expect(JSON.stringify(bodies), `${name} dropped the canonical URL`).toContain(CANONICAL);
  }
});
