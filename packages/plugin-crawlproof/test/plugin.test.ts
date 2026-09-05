import { test, expect } from "bun:test";
import plugin, { urlsToPromote, firstUrl, createAd, DEFAULT_URL } from "../src/index.ts";
import type { PluginContext, PostedEvent } from "@profullstack/myna-core";

const event = (targets: PostedEvent["targets"], extra?: Record<string, string>, text = "Read https://x.y/post, please."): PostedEvent => ({
  text,
  title: "A post",
  extra,
  targets,
});

const blogTarget = { account: { id: "htmlblog:x", network: "htmlblog", handle: "x", addedAt: "", creds: {}, meta: {} }, category: "blog", ok: true, url: "https://x.y/blog/043-post.html" };
const socialTarget = { account: { id: "bluesky:me", network: "bluesky", handle: "me", addedAt: "", creds: {}, meta: {} }, category: "major", ok: true, url: "https://bsky.app/1" };

function context(secrets: Record<string, string>, flags: Record<string, unknown> = {}): { ctx: PluginContext; lines: string[] } {
  const lines: string[] = [];
  let store = { ...secrets };
  const ctx: PluginContext = {
    out: (line = "") => lines.push(line),
    log: (line) => lines.push(line),
    accounts: () => [],
    settings: () => ({}) as never,
    secrets: { get: () => store, set: (values) => (store = { ...values }), clear: () => (store = {}) },
    graph: { addSeeds: () => ({ added: 0, updated: 0 }) },
    configDir: "/tmp",
    flags,
  };
  return { ctx, lines };
}

async function withFetch<T>(handler: (url: string, init?: RequestInit) => Response | Promise<Response>, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

test("blog pages get an ad; social posts do not, unless --ad true", () => {
  expect(urlsToPromote(event([blogTarget, socialTarget]))).toEqual(["https://x.y/blog/043-post.html"]);
  expect(urlsToPromote(event([socialTarget]))).toEqual([]);
  expect(urlsToPromote(event([socialTarget], { ad: "true" }))).toEqual(["https://x.y/post"]);
  // A blog page wins over the URL in the text even when forced.
  expect(urlsToPromote(event([blogTarget, socialTarget], { ad: "true" }))).toEqual(["https://x.y/blog/043-post.html"]);
  // A failed blog target has no page to promote.
  expect(urlsToPromote(event([{ ...blogTarget, ok: false, url: undefined }]))).toEqual([]);
});

test("the first URL in a post, without trailing punctuation", () => {
  expect(firstUrl("New: https://nichedb.dev. Bots welcome")).toBe("https://nichedb.dev");
  expect(firstUrl("no links")).toBeUndefined();
});

test("afterPost is silent without a token, and when automatic ads are off", async () => {
  expect(await plugin.afterPost!(event([blogTarget]), context({}).ctx)).toBeUndefined();
  expect(await plugin.afterPost!(event([blogTarget]), context({ token: "crp_x", auto: "off" }).ctx)).toBeUndefined();
});

test("afterPost creates a campaign for each blog page and says what happened", async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const line = await withFetch(
    (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ id: "1", ref_slug: "crawlproof-ad-072", name: "A post", status: "active", destination_url: "https://x.y/blog/043-post.html" }), { status: 201 });
    },
    () => plugin.afterPost!(event([blogTarget, socialTarget]), context({ token: "crp_x", budgetCents: "250" }).ctx),
  );
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe(`${DEFAULT_URL}/api/ads/v1/campaigns`);
  expect(calls[0].body).toEqual({ url: "https://x.y/blog/043-post.html", name: "A post", daily_budget_cents: 250, status: "active" });
  expect(line).toBe("active crawlproof-ad-072 for https://x.y/blog/043-post.html");
});

test("a failure names the URL and does not throw out of the hook", async () => {
  const line = await withFetch(
    () => new Response(JSON.stringify({ error: "Invalid or revoked token." }), { status: 401 }),
    () => plugin.afterPost!(event([blogTarget]), context({ token: "crp_x" }).ctx),
  );
  expect(line).toBe("no ad for https://x.y/blog/043-post.html: 401 Invalid or revoked token.");
});

test("createAd marks a campaign CrawlProof already had", async () => {
  const campaign = await withFetch(
    () => new Response(JSON.stringify({ id: "1", ref_slug: "crawlproof-ad-001", name: "x", status: "active", destination_url: "https://x.y", existing: true }), { status: 200 }),
    () => createAd({ token: "crp_x", url: DEFAULT_URL, auto: true, budgetCents: 500 }, "https://x.y", { draft: true }),
  );
  expect(campaign.existing).toBe(true);
});

test("the command refuses a token that is not a CrawlProof token, and stores a good one", async () => {
  const command = plugin.commands![0];
  const bad = context({}, { token: "nope", url: DEFAULT_URL });
  bad.ctx.ask = async () => "";
  await expect(command.run(["login"], bad.ctx)).rejects.toThrow(/crp_/);

  const good = context({}, { token: "crp_abc", url: DEFAULT_URL });
  good.ctx.ask = async () => "";
  const code = await withFetch(() => new Response(JSON.stringify({ campaigns: [] }), { status: 200 }), () => command.run(["login"], good.ctx));
  expect(code).toBe(0);
  expect(good.ctx.secrets.get()).toEqual({ token: "crp_abc", url: DEFAULT_URL });

  await command.run(["auto", "off"], good.ctx);
  expect(good.ctx.secrets.get().auto).toBe("off");
  await command.run(["budget", "300"], good.ctx);
  expect(good.ctx.secrets.get().budgetCents).toBe("300");
  await expect(command.run(["auto", "maybe"], good.ctx)).rejects.toThrow(/on\|off/);
});
