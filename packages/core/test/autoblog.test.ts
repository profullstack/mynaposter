/**
 * The autoblog target: a signed webhook to any receiver that speaks the
 * `@profullstack/autoblog` protocol, and guest posts via `--canonical-url`.
 *
 * Driven against a stubbed fetch: the thing worth asserting is that a real
 * CloudEvents envelope carrying the rendered post is delivered to the
 * configured webhook URL, signed, with the canonical set for a guest post
 * and omitted for an original.
 */
import { test, expect } from "bun:test";
import { verifyAndParse } from "@profullstack/autoblog";
import { autoblog } from "../src/net/adapters/autoblog.ts";
import type { Account, PostInput } from "../src/net/types.ts";

const WEBHOOK = "https://logicsrc.com/api/webhooks/blog";
const SECRET = "whsec_test_secret";
const SOURCE = "https://dev.profullstack.com/~anthony/blog/117-post.html";

function acct(meta: Record<string, string> = {}): Account {
  return {
    id: "autoblog:logicsrc",
    network: "autoblog",
    handle: "logicsrc",
    addedAt: new Date().toISOString(),
    creds: { secret: SECRET },
    meta: { webhookUrl: WEBHOOK, siteUrl: "https://logicsrc.com", ...meta },
  } as unknown as Account;
}

/** Capture the single webhook the adapter sends, headers and raw body. */
async function deliver(account: Account, input: PostInput): Promise<{ url: string; headers: Record<string, string>; body: string }> {
  let captured: { url: string; headers: Record<string, string>; body: string } | null = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    captured = { url: String(url), headers, body: String(init?.body ?? "") };
    return new Response(JSON.stringify({ received: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await autoblog.post(account, input);
  } finally {
    globalThis.fetch = realFetch;
  }
  if (!captured) throw new Error("no webhook was sent");
  return captured;
}

test("a guest post is delivered as a signed webhook, canonical pointing at the source, and verifies", async () => {
  const input: PostInput = {
    title: "I shipped a lossless stream standard in a day",
    text: "# Ignored h1\n\nThe **body** with a [link](https://logicsrc.com/docs/openstream).\n\nSecond paragraph.",
    extra: { canonicalUrl: SOURCE, tags: "openstream, compression", author: "Anthony Ettinger", description: "A summary." },
  };
  const sent = await deliver(acct(), input);
  expect(sent.url).toBe(WEBHOOK);
  // Standard Webhooks signed the delivery.
  expect(sent.headers["webhook-signature"]).toBeTruthy();
  expect(sent.headers["webhook-id"]).toBeTruthy();

  // The receiver's own verifier accepts it and returns the post.
  const parsed = verifyAndParse({ headers: sent.headers, body: sent.body, opts: { secret: SECRET } });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.reason);
  const post = parsed.post;
  expect(post.title).toBe("I shipped a lossless stream standard in a day");
  expect(post.canonical_url).toBe(SOURCE);
  expect(post.slug).toBe("i-shipped-a-lossless-stream-standard-in-a-day");
  expect(post.status).toBe("published");
  expect(post.tags).toEqual(["openstream", "compression"]);
  expect(post.author?.name).toBe("Anthony Ettinger");
  expect(post.excerpt).toBe("A summary.");
  // Body rendered to HTML; the h1 became an h2 (title owns the page's h1).
  expect(post.html).toContain("<strong>body</strong>");
  expect(post.html).toContain("<h2>Ignored h1</h2>");
  expect(post.html).not.toContain("<h1>");
  expect(post.markdown).toContain("Second paragraph.");
});

test("an original post omits canonical and takes its own URL on the blog", async () => {
  const sent = await deliver(acct(), { title: "Native here", text: "Body." });
  const parsed = verifyAndParse({ headers: sent.headers, body: sent.body, opts: { secret: SECRET } });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.reason);
  expect(parsed.post.canonical_url).toBeUndefined();
  expect(parsed.post.url).toBe("https://logicsrc.com/blog/native-here");
});

test("a wrong secret is rejected by the receiver's verifier", async () => {
  const sent = await deliver(acct(), { title: "X", text: "Body." });
  const parsed = verifyAndParse({ headers: sent.headers, body: sent.body, opts: { secret: "whsec_wrong" } });
  expect(parsed.ok).toBe(false);
});

test("login validates the URL and secret and defaults the handle to the host", async () => {
  const ctx = { report() {}, async openUrl() {} };
  const ok = await autoblog.login({ url: WEBHOOK, secret: SECRET }, ctx);
  expect(ok.handle).toBe("logicsrc.com");
  expect(ok.meta.webhookUrl).toBe(WEBHOOK);
  expect(ok.creds.secret).toBe(SECRET);
  await expect(autoblog.login({ url: "not-a-url", secret: SECRET }, ctx)).rejects.toThrow();
  await expect(autoblog.login({ url: WEBHOOK, secret: "" }, ctx)).rejects.toThrow();
});

test("a failed delivery surfaces as an error, not a silent success", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("nope", { status: 401 })) as typeof fetch;
  try {
    await expect(autoblog.post(acct(), { title: "X", text: "Body." })).rejects.toThrow(/rejected the post/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("autoblog never posts as part of `all`", () => {
  expect(autoblog.caps.explicitTarget).toBe(true);
  expect(autoblog.caps.needsTitle).toBe(true);
});
