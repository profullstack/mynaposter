/**
 * Forgot password against a real Postgres. Skipped unless DATABASE_URL is
 * set, like the other integration tests here.
 *
 * What has to hold: an unknown address gets the same answer and no mail; a
 * known one gets one mail with a working link; the link sets the password,
 * signs the browser in and works once; the old password and every old token
 * stop working; asking again retires the earlier link; and the hourly cap
 * stops mailing while still answering ok.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { migrate, closeDatabase, hasDatabase } from "../src/db/index.ts";
import * as cloud from "../src/cloud.ts";
import { forgotPassword, resetPassword, RESET_HOURLY_CAP } from "../src/password-reset.ts";
import { hostedConfig } from "../src/mail.ts";
import { COOKIE, readCookie } from "../src/session.ts";

const enabled = hasDatabase();
const it = enabled ? test : test.skip;

const PASSWORD = "a long enough password";
const NEW_PASSWORD = "a brand new long password";
const unique = () => `r${Date.now()}${Math.random().toString(36).slice(2, 8)}@example.com`;
const config = hostedConfig({ RESEND_API_KEY: "re_test" });

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

/** Capture mails instead of sending them; the token is whatever follows #reset=. */
function outbox() {
  const sent: { to: string; token: string }[] = [];
  const send = async (to: string, link: string) => {
    sent.push({ to, token: decodeURIComponent(link.split("#reset=")[1] ?? "") });
  };
  return { sent, send };
}

it("an unknown address gets the same answer and no mail", async () => {
  const box = outbox();
  const reply = await forgotPassword(unique(), { config, send: box.send });
  expect(reply).toEqual({ status: 200, body: { ok: true } });
  expect(box.sent).toHaveLength(0);
});

it("resets the password once, signs in, and kills the old password and tokens", async () => {
  const email = unique();
  const { token: cliToken } = await cloud.signup(email, PASSWORD);
  const box = outbox();

  expect((await forgotPassword(email.toUpperCase(), { config, send: box.send })).status).toBe(200);
  expect(box.sent).toHaveLength(1);
  expect(box.sent[0]!.to).toBe(email);

  const short = await call("/v1/cloud/password/reset", json({ token: box.sent[0]!.token, password: "short" }));
  expect(short.status).toBe(400);

  const done = await call("/v1/cloud/password/reset", json({ token: box.sent[0]!.token, password: NEW_PASSWORD }));
  expect(done.status).toBe(200);
  expect(await done.json()).toEqual({ ok: true, email });
  const session = readCookie((done.headers.get("set-cookie") ?? "").split(";")[0]);
  expect(session.startsWith("myna_")).toBe(true);

  const me = await call("/v1/cloud/me", { headers: { cookie: `${COOKIE}=${session}` } });
  expect(me.status).toBe(200);

  // The CLI token from before the reset is dead.
  expect(await cloud.whoami(cliToken)).toBeNull();
  await expect(cloud.login(email, PASSWORD)).rejects.toThrow("Wrong email or password.");
  expect((await cloud.login(email, NEW_PASSWORD)).user.email).toBe(email);

  // The link works once.
  await expect(resetPassword(box.sent[0]!.token, "yet another long password")).rejects.toThrow("expired or was already used");
});

it("asking again retires the earlier link", async () => {
  const email = unique();
  await cloud.signup(email, PASSWORD);
  const box = outbox();
  await forgotPassword(email, { config, send: box.send });
  await forgotPassword(email, { config, send: box.send });
  expect(box.sent).toHaveLength(2);
  await expect(resetPassword(box.sent[0]!.token, NEW_PASSWORD)).rejects.toThrow("expired or was already used");
  expect((await resetPassword(box.sent[1]!.token, NEW_PASSWORD)).user.email).toBe(email);
});

it("stops mailing past the hourly cap but still answers ok", async () => {
  const email = unique();
  await cloud.signup(email, PASSWORD);
  const box = outbox();
  for (let i = 0; i < RESET_HOURLY_CAP + 2; i++) {
    expect((await forgotPassword(email, { config, send: box.send })).status).toBe(200);
  }
  expect(box.sent).toHaveLength(RESET_HOURLY_CAP);
});

it("a made-up token is refused", async () => {
  const reply = await call("/v1/cloud/password/reset", json({ token: "myna_nope", password: NEW_PASSWORD }));
  expect(reply.status).toBe(400);
});
