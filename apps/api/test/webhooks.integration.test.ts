/**
 * Customer webhooks against a real Postgres, through postgres.js.
 *
 * Skipped unless DATABASE_URL is set, like the other integration tests. What
 * has to hold: schema.sql makes the hub's tables; the postgres.js adapter
 * round-trips endpoints and deliveries (BIGINT times come back as strings and
 * must still work); claimDue hands a due delivery out once; an unsubscribe
 * reports a change once, not on a repeat click.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { postgresStore, verifyAndParse } from "@profullstack/webhooks";
import { migrate, closeDatabase, hasDatabase, db } from "../src/db/index.ts";
import * as cloud from "../src/cloud.ts";
import * as newsletter from "../src/newsletter.ts";
import { createHub, inboxOwner, pgPool, relay } from "../src/webhooks.ts";

const enabled = hasDatabase();
const it = enabled ? test : test.skip;

const received: Array<{ headers: Record<string, string>; body: string }> = [];
let receiver: ReturnType<typeof Bun.serve> | null = null;

beforeAll(async () => {
  if (!enabled) return;
  await migrate();
  receiver = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      received.push({ headers: Object.fromEntries(request.headers), body: await request.text() });
      return new Response(null, { status: 204 });
    },
  });
});
afterAll(async () => {
  receiver?.stop(true);
  if (enabled) await closeDatabase();
});

const unique = () => `w${Date.now()}${Math.random().toString(36).slice(2, 8)}@example.com`;

it("an endpoint is kept in Postgres and a relayed event is delivered once, signed", async () => {
  const { user } = await cloud.signup(unique(), "a long enough password");
  const store = postgresStore(pgPool(db()));
  const hub = createHub({ store, guard: { allowHttp: true, allowPrivate: true } });
  const { endpoint, secret } = await hub.createEndpoint(user.id, { url: `http://127.0.0.1:${receiver!.port}/hook`, events: ["post.published"] });

  expect((await hub.listEndpoints(user.id)).map((entry) => entry.id)).toEqual([endpoint.id]);
  expect((await hub.secret(user.id, endpoint.id)).secret).toBe(secret);

  received.length = 0;
  expect((await relay(user.id, { events: [{ type: "post.published", data: { url: "https://bsky.app/p" } }] }, hub)).queued).toBe(1);
  expect(await hub.drain()).toBeGreaterThanOrEqual(1);
  expect(await hub.drain()).toBe(0);
  const mine = received.filter((entry) => entry.body.includes("https://bsky.app/p"));
  expect(mine).toHaveLength(1);
  expect(verifyAndParse({ headers: mine[0].headers, body: mine[0].body, secret }).ok).toBe(true);

  const deliveries = await hub.deliveries(user.id);
  expect(deliveries[0].status).toBe("delivered");
  expect(deliveries[0].event_type).toBe("post.published");

  await hub.deleteEndpoint(user.id, endpoint.id);
  expect(await hub.listEndpoints(user.id)).toEqual([]);
});

it("an unsubscribe reports its change once, to the inbox's owner", async () => {
  const { user } = await cloud.signup(unique(), "a long enough password");
  const inbox = await newsletter.ensureInbox(user.id);
  expect(await inboxOwner(inbox)).toBe(user.id);
  const token = `t${Date.now()}abcdefghijklmnop`;
  const changes: string[] = [];
  const onChange = (change: { state: string }) => void changes.push(change.state);
  expect(await newsletter.recordUnsubscribe(inbox, token, onChange)).toBe(true);
  expect(await newsletter.recordUnsubscribe(inbox, token, onChange)).toBe(true);
  expect(await newsletter.recordResubscribe(inbox, token, onChange)).toBe(true);
  expect(changes).toEqual(["unsubscribed", "resubscribed"]);
});
