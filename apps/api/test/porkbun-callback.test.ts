/**
 * Porkbun webhooks, the parts with no database: the signature recipe Porkbun
 * documents, the optional route and its secret, and what happens with no
 * secret at all.
 */
import { test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { receive, secretFor, secretVar, verifySignature, type StoredEvent } from "../src/porkbun-callback.ts";

const NOW = 1_791_300_000;
const body = JSON.stringify({ event: "domain.registered", id: "018f9c2a-7b3e-7c41-9b8a-2f1e6d4c5a90", createdAt: "2026-10-06T14:00:00Z", data: { domain: "wx93.me", tld: "me" } });
const sign = (secret: string, ts: number, raw = body) => `sha256=${createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex")}`;
const headers = (secret: string, ts = NOW, raw = body) => ({ "x-porkbun-signature": sign(secret, ts, raw), "x-porkbun-webhook-timestamp": String(ts) });

/** A store that remembers ids, like the table's primary key. */
function memoryStore() {
  const rows: StoredEvent[] = [];
  return { rows, store: async (row: StoredEvent) => (rows.some((r) => r.id === row.id) ? false : (rows.push(row), true)) };
}

test("the signature is Porkbun's recipe: sha256= + hex HMAC of timestamp.body", () => {
  expect(verifySignature("s3cret", String(NOW), body, sign("s3cret", NOW), NOW)).toEqual({ ok: true });
  expect(verifySignature("other", String(NOW), body, sign("s3cret", NOW), NOW).ok).toBe(false);
  // one changed byte in the body is a different signature
  expect(verifySignature("s3cret", String(NOW), body.replace("wx93", "wx94"), sign("s3cret", NOW), NOW).ok).toBe(false);
});

test("an old or future timestamp is a replay, even with a valid signature", () => {
  const old = NOW - 301;
  expect(verifySignature("s3cret", String(old), body, sign("s3cret", old), NOW)).toEqual({ ok: false, reason: "timestamp outside the five minute window" });
  expect(verifySignature("s3cret", String(NOW + 301), body, sign("s3cret", NOW + 301), NOW).ok).toBe(false);
  expect(verifySignature("s3cret", undefined, body, sign("s3cret", NOW), NOW).ok).toBe(false);
});

test("a route has its own secret, and falls back to the default", () => {
  const env = { PORKBUN_WEBHOOK_SECRET: "default", [secretVar("acme-co")]: "acme" };
  expect(secretVar("acme-co")).toBe("PORKBUN_WEBHOOK_SECRET_ACME_CO");
  expect(secretFor("acme-co", env)).toBe("acme");
  expect(secretFor("other", env)).toBe("default");
  expect(secretFor(undefined, env)).toBe("default");
  expect(secretFor(undefined, {})).toBeUndefined();
});

test("with a secret, a signed delivery is stored verified and an unsigned one is refused", async () => {
  const env = { PORKBUN_WEBHOOK_SECRET: "s3cret" };
  const mem = memoryStore();
  const good = await receive({ rawBody: body, headers: headers("s3cret") }, { env, now: NOW, store: mem.store });
  expect(good.status).toBe(200);
  expect(good.body).toMatchObject({ ok: true, event: "domain.registered", verified: true, duplicate: false });

  const unsigned = await receive({ rawBody: body, headers: {} }, { env, now: NOW, store: mem.store });
  expect(unsigned.status).toBe(401);
  const forged = await receive({ rawBody: body, headers: headers("wrong") }, { env, now: NOW, store: mem.store });
  expect(forged.status).toBe(401);
  expect(mem.rows).toHaveLength(1);
});

test("the route picks the secret: a delivery signed for another route is refused", async () => {
  const env = { PORKBUN_WEBHOOK_SECRET_ACME: "acme", PORKBUN_WEBHOOK_SECRET_OTHER: "other" };
  const mem = memoryStore();
  expect((await receive({ route: "acme", rawBody: body, headers: headers("acme") }, { env, now: NOW, store: mem.store })).status).toBe(200);
  expect((await receive({ route: "other", rawBody: body, headers: headers("acme") }, { env, now: NOW, store: mem.store })).status).toBe(401);
  expect(mem.rows[0]!.route).toBe("acme");
});

test("with no secret the event is still taken, and marked unverified", async () => {
  const mem = memoryStore();
  const r = await receive({ rawBody: body, headers: {} }, { env: {}, now: NOW, store: mem.store });
  expect(r.status).toBe(200);
  expect(r.body.verified).toBe(false);
  expect(mem.rows[0]!.verified).toBe(false);
});

test("the same event id twice is stored once and reported as a duplicate", async () => {
  const env = { PORKBUN_WEBHOOK_SECRET: "s3cret" };
  const mem = memoryStore();
  await receive({ rawBody: body, headers: headers("s3cret") }, { env, now: NOW, store: mem.store });
  const again = await receive({ rawBody: body, headers: headers("s3cret") }, { env, now: NOW, store: mem.store });
  expect(again.body.duplicate).toBe(true);
  expect(mem.rows).toHaveLength(1);
});

test("a bad route or a body that is not an event envelope is refused", async () => {
  const mem = memoryStore();
  expect((await receive({ route: "../etc", rawBody: body, headers: {} }, { env: {}, store: mem.store })).status).toBe(404);
  expect((await receive({ rawBody: "not json", headers: {} }, { env: {}, store: mem.store })).status).toBe(400);
  expect((await receive({ rawBody: JSON.stringify({ event: "x" }), headers: {} }, { env: {}, store: mem.store })).status).toBe(400);
  expect(mem.rows).toHaveLength(0);
});
