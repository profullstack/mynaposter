/**
 * Customer webhooks, without a database: the hub on a memory store, a real
 * receiver on localhost, and the pieces server.ts wires together.
 *
 * What has to hold: schema.sql carries exactly the package's DDL; the
 * postgres.js adapter hands the store pg-style rows; the API answers 401
 * with no key and scopes everything to the caller; the session cookie works
 * on a write only from the site's own origin; a relayed post event is
 * accepted only for the relayed types and arrives signed so a Standard
 * Webhooks receiver verifies it.
 */
import { test, expect, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { Webhooks, memoryStore, schemaSql, verifyAndParse } from "@profullstack/webhooks";
import { EVENT_TYPES, RELAYED, pgPool, relay, webhookOwner, webhooksHandler, MAX_RELAY_BATCH } from "../src/webhooks.ts";

const squash = (sql: string): string => sql.replace(/\s+/g, " ").trim().toLowerCase();

test("schema.sql carries every statement of the package's own pg DDL", () => {
  const schema = squash(readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8"));
  for (const statement of schemaSql("pg")) expect(schema).toContain(squash(statement));
});

test("the postgres.js adapter passes text and params through and returns {rows}", async () => {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const fake = { unsafe: async (text: string, params: unknown[]) => (calls.push({ text, params }), [{ id: "a" }, { id: "b" }]) };
  const pool = pgPool(fake as never);
  const reply = await pool.query("select * from t where id = $1", ["a"]);
  expect(reply.rows).toEqual([{ id: "a" }, { id: "b" }]);
  expect(calls).toEqual([{ text: "select * from t where id = $1", params: ["a"] }]);
});

// A receiver on localhost that records what it was sent.
const received: Array<{ headers: Record<string, string>; body: string }> = [];
const receiver = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    received.push({ headers: Object.fromEntries(request.headers), body: await request.text() });
    return new Response(null, { status: 204 });
  },
});
afterAll(() => receiver.stop(true));
const hookUrl = `http://127.0.0.1:${receiver.port}/hook`;

const makeHub = () =>
  new Webhooks({ store: memoryStore(), source: "https://mynaposter.com", eventTypes: EVENT_TYPES, guard: { allowHttp: true, allowPrivate: true } });

test("a relayed post event arrives signed, as a CloudEvent a Standard Webhooks receiver verifies", async () => {
  const hub = makeHub();
  const { endpoint, secret } = await hub.createEndpoint("user-1", { url: hookUrl, events: ["post.*"] });
  expect(endpoint.events).toEqual(["post.*"]);
  received.length = 0;

  const result = await relay(
    "user-1",
    {
      events: [
        { type: "post.published", subject: "account:bluesky:me", data: { network: "bluesky", url: "https://bsky.app/x", text: "hi" } },
        { type: "newsletter.sent", data: { id: "n1" } },
      ],
    },
    hub,
  );
  // newsletter.sent is a real type, but this endpoint only wants post.*.
  expect(result).toEqual({ queued: 1, events: 2 });
  expect(await hub.drain()).toBe(1);
  expect(received).toHaveLength(1);

  const verified = verifyAndParse({ headers: received[0].headers, body: received[0].body, secret });
  expect(verified.ok).toBe(true);
  if (!verified.ok) return;
  expect(verified.event.type).toBe("post.published");
  expect(verified.event.source).toBe("https://mynaposter.com");
  expect(verified.event.subject).toBe("account:bluesky:me");
  expect((verified.event.data as { url: string }).url).toBe("https://bsky.app/x");
  // Another account's endpoints never hear it.
  expect((await relay("user-2", { events: [{ type: "post.failed", data: {} }] }, hub)).queued).toBe(0);
});

test("relay refuses what a myna may not report", async () => {
  const hub = makeHub();
  expect(RELAYED).toEqual(["post.published", "post.failed", "newsletter.sent"]);
  await expect(relay("u", { events: [{ type: "handoff.completed", data: {} }] }, hub)).rejects.toThrow(/type must be one of/);
  await expect(relay("u", { events: [{ type: "webhook.test" }] }, hub)).rejects.toThrow(/type must be one of/);
  await expect(relay("u", {}, hub)).rejects.toThrow(/Send \{events/);
  await expect(relay("u", { events: Array.from({ length: MAX_RELAY_BATCH + 1 }, () => ({ type: "post.failed" })) }, hub)).rejects.toThrow(/At most/);
  await expect(relay("u", { events: [{ type: "post.failed" }] }, null)).rejects.toThrow(/DATABASE_URL/);
});

test("the API answers 401 with no key, and scopes endpoints to the caller", async () => {
  const hub = makeHub();
  const api = webhooksHandler(async (request) => (request.headers.get("authorization") === "Bearer good" ? "user-1" : null), () => hub);
  const at = (path: string, init: RequestInit = {}) => api(new Request(`http://api${path}`, init));

  expect((await at("/v1/webhooks"))?.status).toBe(401);
  expect(await at("/v1/handoff")).toBeNull();

  const auth = { authorization: "Bearer good", "content-type": "application/json" };
  const list = await (await at("/v1/webhooks", { headers: auth }))!.json();
  expect(list).toEqual({ endpoints: [], event_types: EVENT_TYPES });

  const created = await at("/v1/webhooks", { method: "POST", headers: auth, body: JSON.stringify({ url: hookUrl, events: ["handoff.*"] }) });
  expect(created?.status).toBe(201);
  const { endpoint, secret } = (await created!.json()) as { endpoint: { id: string }; secret: string };
  expect(secret).toMatch(/^whsec_/);
  // A pattern that matches no myna event is refused.
  expect((await at("/v1/webhooks", { method: "POST", headers: auth, body: JSON.stringify({ url: hookUrl, events: ["room.joined"] }) }))?.status).toBe(400);

  received.length = 0;
  const tested = (await (await at(`/v1/webhooks/${endpoint.id}/test`, { method: "POST", headers: auth }))!.json()) as { ok: boolean };
  expect(tested.ok).toBe(true);
  expect(received).toHaveLength(1);
  expect(verifyAndParse({ headers: received[0].headers, body: received[0].body, secret }).ok).toBe(true);

  // Nobody else can see or remove it.
  expect(await hub.listEndpoints("user-2")).toEqual([]);
  await expect(hub.deleteEndpoint("user-2", endpoint.id)).rejects.toThrow();
});

test("the owner: bearer always, the session cookie on reads, and on writes only from the site", async () => {
  const site = "https://mynaposter.com";
  const whoami = async (token: string) => (token === "tok" ? { id: "user-1" } : null);
  const owner = (init: RequestInit & { headers?: Record<string, string> }) =>
    webhookOwner(new Request("https://mynaposter.com/api/v1/webhooks", init), site, whoami);

  expect(await owner({ headers: { authorization: "Bearer tok" }, method: "POST" })).toBe("user-1");
  expect(await owner({ headers: { authorization: "Bearer nope" } })).toBeNull();
  expect(await owner({})).toBeNull();

  const cookie = "myna_session=tok";
  expect(await owner({ headers: { cookie } })).toBe("user-1");
  expect(await owner({ method: "POST", headers: { cookie } })).toBeNull();
  expect(await owner({ method: "POST", headers: { cookie, origin: "https://evil.example" } })).toBeNull();
  expect(await owner({ method: "DELETE", headers: { cookie, origin: site } })).toBe("user-1");
});
