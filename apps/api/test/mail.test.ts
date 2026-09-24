/**
 * Hosted sending without a database or a network: the verified-from rule,
 * what a request may carry, the daily cap with an in-memory ledger, and the
 * Resend batch call against a stubbed fetch. Nothing is sent.
 */
import { test, expect } from "bun:test";
import { hostedConfig, hostedSend, parseBatch, verifiedFrom, type HostedConfig, type MailLedger } from "../src/mail.ts";

const account = { id: "u1", email: "Anthony@Example.org" };
const config: HostedConfig = { ...hostedConfig({ RESEND_API_KEY: "re_server", MYNA_MAIL_FROM: "myna <mail@mynaposter.com>", MYNA_MAIL_DAILY_CAP: "3" }), resendUrl: "https://resend.test" };

/** The ledger the server keeps in Postgres, as a list. */
function memoryLedger() {
  const rows: { id: string; user: string; count: number }[] = [];
  const ledger: MailLedger = {
    async reserve(userId, n) {
      const id = String(rows.length + 1);
      rows.push({ id, user: userId, count: n });
      return { id, used: rows.filter((row) => row.user === userId).reduce((sum, row) => sum + row.count, 0) };
    },
    async release(id, unsent) {
      const row = rows.find((entry) => entry.id === id);
      if (row) row.count = Math.max(0, row.count - unsent);
    },
  };
  return { rows, ledger, used: (user = "u1") => rows.filter((row) => row.user === user).reduce((sum, row) => sum + row.count, 0) };
}

function resend(status: number, body: unknown) {
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, fetch: fetcher };
}

const one = (overrides: Record<string, unknown> = {}) => ({
  from: "Anthony Ettinger <anthony@profullstack.com>",
  to: ["reader@example.com"],
  subject: "Hi",
  text: "Hello",
  html: "<p>Hello</p>",
  headers: { "List-Unsubscribe": "<https://u.example/x>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click", Bcc: "everyone@example.com", "X-Evil": "1" },
  ...overrides,
});

test("the config reads the environment; the sending domain defaults to MYNA_MAIL_FROM's", () => {
  expect(config.apiKey).toBe("re_server");
  expect(config.domains).toEqual(["mynaposter.com"]);
  expect(config.dailyCap).toBe(3);
  expect(hostedConfig({}).dailyCap).toBe(100);
  expect(hostedConfig({ MYNA_MAIL_DOMAINS: "a.com, B.com" }).domains).toEqual(["a.com", "b.com"]);
});

test("verified-from: everyone sends as <name> via myna from the service address, replies to themselves", () => {
  expect(verifiedFrom("Anthony Ettinger <anthony@profullstack.com>", account, config)).toEqual({ from: '"Anthony Ettinger via myna" <mail@mynaposter.com>', replyTo: "anthony@example.org" });
  expect(verifiedFrom("ceo@mynaposter.com", account, config)).toEqual({ from: '"ceo via myna" <mail@mynaposter.com>', replyTo: "anthony@example.org" });
  expect(verifiedFrom('Evil"\r\nBcc: x <a@b.co>', account, config).from).toBe('"EvilBcc: x via myna" <mail@mynaposter.com>');
  expect(verifiedFrom(undefined, account, config).from).toBe('"anthony via myna" <mail@mynaposter.com>');
  const trusted = { ...config, trusted: ["anthony@example.org"] };
  expect(verifiedFrom("News <news@mynaposter.com>", account, trusted).from).toBe("News <news@mynaposter.com>");
  // Trusted, but not on a verified domain: rewritten like anyone else's.
  expect(verifiedFrom("News <news@gmail.com>", account, trusted).from).toBe('"News via myna" <mail@mynaposter.com>');
});

test("a request: one recipient per message, at most 100, a newsletter must carry List-Unsubscribe, only list headers pass", () => {
  expect(parseBatch({ messages: [] })).toEqual({ error: "messages: a non-empty array." });
  expect(parseBatch({ messages: [one({ to: ["a@example.com", "b@example.com"] })] })).toMatchObject({ error: expect.stringContaining("exactly one recipient") });
  expect(parseBatch({ messages: [one({ to: ["not an address"] })] })).toMatchObject({ error: expect.stringContaining("not an email") });
  expect(parseBatch({ messages: Array.from({ length: 101 }, () => one()) })).toMatchObject({ error: expect.stringContaining("100") });
  expect(parseBatch({ kind: "bulk", messages: [one({ headers: {} })] })).toMatchObject({ error: expect.stringContaining("List-Unsubscribe") });
  const parsed = parseBatch({ kind: "bulk", messages: [one({ subject: "Line\r\nBcc: x" })] });
  if ("error" in parsed) throw new Error(parsed.error);
  expect(parsed.kind).toBe("bulk");
  expect(parsed.messages[0]?.subject).toBe("Line Bcc: x");
  expect(parsed.messages[0]?.headers).toEqual({ "List-Unsubscribe": "<https://u.example/x>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
});

test("a batch goes to Resend's batch endpoint with the server key, the rewritten From and the list headers", async () => {
  const { ledger, used } = memoryLedger();
  const api = resend(200, { data: [{ id: "r1" }, { id: "r2" }] });
  const reply = await hostedSend(account, { kind: "bulk", messages: [one(), one({ to: ["second@example.com"] })] }, { config, ledger, fetch: api.fetch, idempotencyKey: "k1" });
  expect(reply.status).toBe(200);
  expect(reply.body).toEqual({ ok: true, results: [{ ok: true, id: "r1" }, { ok: true, id: "r2" }], used: 2, cap: 3 });
  expect(api.calls[0]?.url).toBe("https://resend.test/emails/batch");
  expect(api.calls[0]?.headers.authorization).toBe("Bearer re_server");
  expect(api.calls[0]?.headers["idempotency-key"]).toBe("u1:k1");
  expect((api.calls[0]?.body as unknown[])[0]).toEqual({
    from: '"Anthony Ettinger via myna" <mail@mynaposter.com>',
    to: ["reader@example.com"],
    subject: "Hi",
    text: "Hello",
    html: "<p>Hello</p>",
    reply_to: "anthony@example.org",
    headers: { "List-Unsubscribe": "<https://u.example/x>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  });
  expect(used()).toBe(2);

  // Two more would pass the cap of 3: refused whole, retryable, and nothing reserved.
  const capped = await hostedSend(account, { messages: [one(), one()] }, { config, ledger, fetch: api.fetch });
  expect(capped.status).toBe(429);
  expect(capped.body).toMatchObject({ ok: false, retryable: true });
  expect((capped.body as { error: string }).error).toContain("1 are left");
  expect(used()).toBe(2);
  expect(api.calls).toHaveLength(1);
  // Another account has its own cap.
  const other = await hostedSend({ id: "u2", email: "b@example.org" }, { messages: [one()] }, { config, ledger, fetch: resend(200, { data: [{ id: "x" }] }).fetch });
  expect(other.status).toBe(200);
});

test("without RESEND_API_KEY it is off; Resend's 429 is retryable and gives the reservation back; its 401 is ours", async () => {
  const { ledger, used } = memoryLedger();
  expect((await hostedSend(account, { messages: [one()] }, { config: { ...config, apiKey: "" }, ledger })).status).toBe(503);
  const limited = await hostedSend(account, { messages: [one()] }, { config, ledger, fetch: resend(429, { message: "Too many requests" }).fetch });
  expect(limited.status).toBe(429);
  expect(limited.body).toMatchObject({ ok: false, retryable: true });
  expect(used()).toBe(0);
  const invalid = await hostedSend(account, { messages: [one()] }, { config, ledger, fetch: resend(422, { message: "Invalid `to` field." }).fetch });
  expect(invalid.status).toBe(400);
  expect(invalid.body).toMatchObject({ ok: false, retryable: false, error: "Resend 422: Invalid `to` field." });
  const ours = await hostedSend(account, { messages: [one()] }, { config, ledger, fetch: resend(401, { message: "API key is invalid" }).fetch });
  expect(ours.status).toBe(503);
  expect((ours.body as { error: string }).error).not.toContain("API key");
  const bad = await hostedSend(account, { messages: [one({ to: [] })] }, { config, ledger });
  expect(bad.status).toBe(400);
});
