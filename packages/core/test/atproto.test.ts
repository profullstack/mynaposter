/**
 * An atproto server, as the directory sees it: what it answered decides what
 * kind it is, and an unreachable one is offline with the reason.
 */
import { test, expect } from "bun:test";
import { atprotoOrigin, probeAtproto } from "../src/core/atproto.ts";

function server(answers: Record<string, { status: number; body?: unknown }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const key = url.pathname.replace("/xrpc/", "");
    const answer = answers[key] ?? { status: 404 };
    return new Response(answer.body === undefined ? "not found" : JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

test("an origin from whatever was pasted", () => {
  expect(atprotoOrigin("bsky.social")).toBe("https://bsky.social");
  expect(atprotoOrigin("https://pds.example/xrpc/_health")).toBe("https://pds.example");
  expect(atprotoOrigin("http://localhost:2583/")).toBe("http://localhost:2583");
  expect(() => atprotoOrigin("ftp://x")).toThrow();
});

test("a PDS: describeServer says its DID, handle domains and whether invites are needed", async () => {
  const probe = await probeAtproto("bsky.social", {
    fetch: server({
      _health: { status: 200, body: { version: "2e68dbf" } },
      "com.atproto.server.describeServer": { status: 200, body: { did: "did:web:bsky.social", availableUserDomains: [".bsky.social"], inviteCodeRequired: false } },
    }),
  });
  expect(probe).toMatchObject({ url: "https://bsky.social", kind: "pds", online: true, did: "did:web:bsky.social", userDomains: [".bsky.social"], inviteCodeRequired: false, version: "2e68dbf", error: null });
});

test("a relay answers health and nothing else; a feed generator describes its feeds; a labeler serves labels", async () => {
  expect((await probeAtproto("bsky.network", { fetch: server({ _health: { status: 200, body: { status: "ok" } } }) })).kind).toBe("relay");
  const feed = await probeAtproto("feeds.example", {
    fetch: server({ "app.bsky.feed.describeFeedGenerator": { status: 200, body: { did: "did:web:feeds.example", feeds: [{ uri: "at://x/app.bsky.feed.generator/a" }, { uri: "at://x/app.bsky.feed.generator/b" }] } } }),
  });
  expect(feed).toMatchObject({ kind: "feed", online: true, did: "did:web:feeds.example", name: "2 feeds" });
  const labeler = await probeAtproto("labels.example", { fetch: server({ "com.atproto.label.queryLabels": { status: 200, body: { labels: [] } } }) });
  expect(labeler.kind).toBe("labeler");
});

test("nothing answering is offline with the reason, and a dead host says so", async () => {
  const silent = await probeAtproto("nothing.example", { fetch: server({}) });
  expect(silent.online).toBe(false);
  expect(silent.error).toMatch(/nothing at https:\/\/nothing.example answered/);
  const dead = await probeAtproto("dead.example", { fetch: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch });
  expect(dead).toMatchObject({ online: false, error: "ECONNREFUSED" });
});
