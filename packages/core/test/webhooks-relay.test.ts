/**
 * The webhook relay: this machine telling myna cloud what it posted.
 *
 * What has to hold: nothing is sent unless the relay is on AND this machine
 * is signed in; a post becomes one event per target (published or failed,
 * with the error); the plugin reports quietly and never throws when the
 * server is down; the CLI-side client hits /v1/webhooks with the cloud token.
 */
import { test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveSession } from "../src/store/cloud.ts";
import { addWebhook, listWebhooks, postEvents, relayEvents, relayOn, setRelay } from "../src/store/webhooks.ts";
import { webhooksPlugin } from "../src/plugins/webhooks-plugin.ts";
import type { PostedEvent } from "../src/plugins/types.ts";
import type { Account } from "../src/net/types.ts";

const seen: Array<{ method: string; path: string; auth: string | null; body: string }> = [];
let answer: (path: string) => Response = () => Response.json({ ok: true, queued: 2 });
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const path = new URL(request.url).pathname;
    seen.push({ method: request.method, path, auth: request.headers.get("authorization"), body: await request.text() });
    return answer(path);
  },
});
afterAll(() => server.stop(true));

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-webhooks-"));
  process.env.MYNA_HOME = dir;
  seen.length = 0;
  answer = () => Response.json({ ok: true, queued: 2 });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
});

const signIn = () => saveSession({ server: `http://127.0.0.1:${server.port}/api`, email: "me@example.com", token: "tok", since: new Date().toISOString() });

const account = (network: string, handle: string): Account => ({ id: `${network}:${handle}`, network, handle }) as Account;

const posted: PostedEvent = {
  text: "Shipped webhooks",
  title: "Webhooks",
  targets: [
    { account: account("bluesky", "me"), category: "major", ok: true, url: "https://bsky.app/p/1", id: "at://1" },
    { account: account("mastodon", "me"), category: "fediverse", ok: false, error: "401 token revoked" },
  ],
};

test("a post becomes one event per target: published where it worked, failed with the error where not", () => {
  const events = postEvents(posted);
  expect(events.map((event) => event.type)).toEqual(["post.published", "post.failed"]);
  expect(events[0]).toEqual({
    type: "post.published",
    subject: "account:bluesky:me",
    data: { account: "bluesky:me", network: "bluesky", handle: "me", url: "https://bsky.app/p/1", post_id: "at://1", title: "Webhooks", text: "Shipped webhooks" },
  });
  expect(events[1].data.error).toBe("401 token revoked");
  expect(events[1].data.url).toBeUndefined();
});

test("nothing is sent with the relay off, or when not signed in", async () => {
  expect(relayOn()).toBe(false);
  expect(await relayEvents(postEvents(posted))).toBeNull();
  setRelay(true);
  expect(relayOn()).toBe(false); // on, but not signed in
  expect(await relayEvents(postEvents(posted))).toBeNull();
  signIn();
  setRelay(false);
  expect(await webhooksPlugin.afterPost!(posted, {} as never)).toBeUndefined();
  expect(seen).toEqual([]);
});

test("with the relay on, the plugin reports the post to /v1/events with the cloud token", async () => {
  signIn();
  setRelay(true);
  expect(await webhooksPlugin.afterPost!(posted, {} as never)).toBe("queued 2 webhook deliveries");
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ method: "POST", path: "/api/v1/events", auth: "Bearer tok" });
  expect((JSON.parse(seen[0].body) as { events: unknown[] }).events).toHaveLength(2);
});

test("a server that is down or refuses never throws; the plugin says so in one line", async () => {
  signIn();
  setRelay(true);
  answer = () => Response.json({ ok: false, error: "nope" }, { status: 500 });
  expect(await relayEvents(postEvents(posted))).toBeNull();
  expect(await webhooksPlugin.afterPost!(posted, {} as never)).toMatch(/could not reach myna cloud/);
});

test("the client manages endpoints at /v1/webhooks with the cloud token", async () => {
  signIn();
  answer = (path) =>
    path === "/api/v1/webhooks"
      ? Response.json({ endpoints: [], event_types: ["post.published"] })
      : Response.json({ error: "not found" }, { status: 404 });
  expect(await listWebhooks()).toEqual({ endpoints: [], event_types: ["post.published"] });
  expect(seen[0]).toMatchObject({ method: "GET", path: "/api/v1/webhooks", auth: "Bearer tok" });
  answer = () => Response.json({ error: "url must be https" }, { status: 400 });
  await expect(addWebhook({ url: "http://x" })).rejects.toThrow(/url must be https/);
});
