/**
 * OpenConnection without a database: the token encoding, the scopes, the
 * descriptor (which must be the same bytes the site serves), the forums
 * lookup over a fake nichedb, and the limiter.
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import {
  encodeSetupToken,
  decodeSetupToken,
  parseScopes,
  DEFAULT_SCOPES,
  descriptor,
  claimUrlFor,
  accessUrlFor,
  accountsFromProfile,
  forumsFor,
  RateLimiter,
} from "../src/openconnection.ts";

test("a setup token is the claim URL in base64url and decodes back to it", () => {
  const url = claimUrlFor("abc123", "https://mynaposter.com");
  expect(url).toBe("https://mynaposter.com/api/openconnection/claim/abc123");
  const token = encodeSetupToken(url);
  expect(token).not.toContain("=");
  expect(decodeSetupToken(token).toString()).toBe(url);
  expect(decodeSetupToken(` ${token}\n`).pathname).toBe("/api/openconnection/claim/abc123");
  expect(accessUrlFor("https://mynaposter.com")).toBe("https://mynaposter.com/api/openconnection/v1");
});

test("a token that is not a URL, or not https, is refused before any request", () => {
  expect(() => decodeSetupToken("bm90IGEgdXJs")).toThrow(/not a setup token/);
  expect(() => decodeSetupToken(encodeSetupToken("http://bridge.example/claim/x"))).toThrow(/https/);
});

test("scopes: empty means every scope, a comma list or an array is kept, an unknown one is refused", () => {
  expect(parseScopes(undefined)).toEqual(DEFAULT_SCOPES);
  expect(parseScopes("")).toEqual(DEFAULT_SCOPES);
  expect(parseScopes("write:create, accounts:read")).toEqual(["write:create", "accounts:read"]);
  expect(parseScopes(["write:create", "write:create"])).toEqual(["write:create"]);
  expect(() => parseScopes("posts:create")).toThrow(/Unknown scope posts:create/);
});

test("the descriptor the API answers is the file the site serves", () => {
  const served = JSON.parse(readFileSync(new URL("../../web/assets/.well-known/openconnection.json", import.meta.url), "utf8"));
  expect(descriptor("https://mynaposter.com")).toEqual(served);
  expect(served.setup).toBe("https://mynaposter.com/connect");
  expect(Object.keys(served.scopes)).toEqual(DEFAULT_SCOPES);
  expect(served.posts).toBeUndefined();
});

test("accounts come out of an OpenProfile.md: one per account URL, network resolved, handle from the path", () => {
  const markdown = `# Chovy

Kind: person
Web: https://chovy.com

## Accounts

- Bluesky: https://bsky.app/profile/chovy.bsky.social
- Mastodon: https://mastodon.social/@chovy
- Bluesky: https://bsky.app/profile/chovy.bsky.social
- Nowhere: not-a-url
`;
  const accounts = accountsFromProfile(markdown);
  expect(accounts.map((a) => a.id)).toEqual(["bluesky:chovy.bsky.social", "mastodon:chovy"]);
  expect(accounts[0]).toMatchObject({ kind: "social", network: "bluesky", handle: "chovy.bsky.social", name: "Chovy", org: { name: "Bluesky", url: "https://bsky.app" } });
  expect(accounts[1].handle).toBe("chovy");
});

test("forums come from nichedb's forums collection, one per board and forum, and an outage is an empty list", async () => {
  const fake = (async (input: string | URL | Request) => {
    const url = String(input);
    expect(url).toContain("collection=forums");
    expect(url).toContain("q=self%20hosting%20podcast");
    return new Response(
      JSON.stringify({
        items: [
          { data: { board: "https://tsbb.dev", forum: "announcements", forumName: "Announcements" } },
          { data: { board: "https://tsbb.dev", forum: "announcements", forumName: "Announcements" } },
          { data: { board: "https://bbs.hqtui.com/", forum: "news", forumName: "News" } },
          { data: { board: "ftp://x", forum: "y" } },
          { data: {} },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  expect(await forumsFor(["self hosting", "podcast"], fake)).toEqual([
    { name: "Announcements on tsbb.dev", url: "https://tsbb.dev/f/announcements" },
    { name: "News on bbs.hqtui.com", url: "https://bbs.hqtui.com/f/news" },
  ]);
  expect(await forumsFor([], fake)).toEqual([]);
  const down = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
  expect(await forumsFor(["x"], down)).toEqual([]);
});

test("the limiter admits `limit` calls per window per key and then says how long to wait", () => {
  const limiter = new RateLimiter(2, 10_000);
  expect(limiter.take("a", 1_000).ok).toBe(true);
  expect(limiter.take("a", 2_000).ok).toBe(true);
  const refused = limiter.take("a", 3_000);
  expect(refused.ok).toBe(false);
  expect(refused.retryAfter).toBe(8);
  expect(limiter.take("b", 3_000).ok).toBe(true);
  expect(limiter.take("a", 11_001).ok).toBe(true);
});
