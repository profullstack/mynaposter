/**
 * The dashboard's sign-in, through the real API routes, against a real
 * Postgres. Skipped unless DATABASE_URL is set, like the other integration
 * tests here.
 *
 * What has to hold: signing in sets the cookie and never puts the token in
 * the body; the cookie lists the owner's hand-off cards; the cookie alone
 * cannot write; a card is marked done and undone with no sign-in, as the
 * card page does; signing out revokes the token, so the old cookie is dead.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { migrate, closeDatabase, hasDatabase } from "../src/db/index.ts";
import * as cloud from "../src/cloud.ts";
import * as handoff from "../src/handoff.ts";
import { COOKIE, readCookie } from "../src/session.ts";

const enabled = hasDatabase();
const it = enabled ? test : test.skip;

const PASSWORD = "a long enough password";
const unique = () => `s${Date.now()}${Math.random().toString(36).slice(2, 8)}@example.com`;

let fetchApp: (request: Request) => Response | Promise<Response>;

beforeAll(async () => {
  if (!enabled) return;
  await migrate();
  fetchApp = (await import("../src/server.ts")).default.fetch;
});
afterAll(async () => {
  if (enabled) await closeDatabase();
});

const call = (path: string, init: RequestInit = {}) => Promise.resolve(fetchApp(new Request(`http://api.test${path}`, init)));
const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

it("signs in with a cookie, lists the cards, marks one done and back, and signs out for good", async () => {
  const email = unique();
  const { user } = await cloud.signup(email, PASSWORD);
  const { user: other } = await cloud.signup(unique(), PASSWORD);
  const mine = await handoff.createHandoff(user.id, { place: "Hacker News", title: "Submit the post", text: "the text", openUrl: "https://news.ycombinator.com/submit" });
  await handoff.createHandoff(other.id, { place: "r/nextjs", title: "Not yours", text: "x" });

  const wrong = await call("/v1/cloud/session", json({ email, password: "not the password at all" }));
  expect(wrong.status).toBe(401);
  expect(wrong.headers.get("set-cookie")).toBeNull();

  const signedIn = await call("/v1/cloud/session", json({ email, password: PASSWORD }));
  expect(signedIn.status).toBe(200);
  const body = (await signedIn.json()) as Record<string, unknown>;
  expect(body).toEqual({ ok: true, email });
  const setCookie = signedIn.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain("HttpOnly");
  const token = readCookie(setCookie.split(";")[0]);
  expect(token.startsWith("myna_")).toBe(true);
  const cookie = `${COOKIE}=${token}`;

  const me = await call("/v1/cloud/me", { headers: { cookie } });
  expect(((await me.json()) as { email: string }).email).toBe(email);

  const listed = (await (await call("/v1/handoff", { headers: { cookie } })).json()) as { handoffs: { id: string; title: string }[] };
  expect(listed.handoffs.map((card) => card.id)).toEqual([mine.id]);

  // The cookie reads; it never writes.
  const write = await call("/v1/handoff", { ...json({ place: "HN", title: "t", text: "x" }), headers: { "content-type": "application/json", cookie } });
  expect(write.status).toBe(401);

  // Done and undone with no sign-in at all, the way the card page does it.
  const done = (await (await call(`/v1/handoff/${mine.id}/done`, json({ done: true }))).json()) as { handoff: { doneAt: string | null } };
  expect(done.handoff.doneAt).not.toBeNull();
  const openList = (await (await call("/v1/handoff", { headers: { cookie } })).json()) as { handoffs: unknown[] };
  expect(openList.handoffs).toHaveLength(0);
  const all = (await (await call("/v1/handoff?all=1", { headers: { cookie } })).json()) as { handoffs: { id: string }[] };
  expect(all.handoffs.map((card) => card.id)).toEqual([mine.id]);
  const undone = (await (await call(`/v1/handoff/${mine.id}/done`, json({ done: false }))).json()) as { handoff: { doneAt: string | null } };
  expect(undone.handoff.doneAt).toBeNull();

  const out = await call("/v1/cloud/session", { method: "DELETE", headers: { cookie } });
  expect(out.status).toBe(200);
  expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(await cloud.whoami(token)).toBeNull();
  expect((await call("/v1/handoff", { headers: { cookie } })).status).toBe(401);
});
