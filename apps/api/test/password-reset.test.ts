/**
 * Forgot password, the parts with no database: the link keeps the token out
 * of the query string, the mail says what it is, the Resend call is shaped
 * right, and a server with no RESEND_API_KEY says so instead of pretending.
 */
import { test, expect } from "bun:test";
import { forgotPassword, resetLink, resetMail, sendResetMail } from "../src/password-reset.ts";
import { hostedConfig } from "../src/mail.ts";

test("the reset link carries the token in the fragment, never the query", () => {
  const link = resetLink("myna_abc-_123", "https://mynaposter.com");
  expect(link).toBe("https://mynaposter.com/dashboard#reset=myna_abc-_123");
  expect(new URL(link).search).toBe("");
});

test("the mail has the link in both bodies and says what to do if it was not you", () => {
  const mail = resetMail("a@example.com", "https://mynaposter.com/dashboard#reset=t&x");
  expect(mail.subject).toBe("Reset your myna password");
  expect(mail.text).toContain("https://mynaposter.com/dashboard#reset=t&x");
  expect(mail.html).toContain('href="https://mynaposter.com/dashboard#reset=t&amp;x"');
  expect(mail.text).toContain("If that was not you");
});

test("sendResetMail posts one message to Resend from MYNA_MAIL_FROM", async () => {
  const config = hostedConfig({ RESEND_API_KEY: "re_test", MYNA_MAIL_FROM: "myna <mail@mynaposter.com>" });
  let seen: { url: string; init: RequestInit } | null = null;
  const fake = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(JSON.stringify({ id: "x" }), { status: 200 });
  }) as unknown as typeof fetch;
  await sendResetMail("a@example.com", "https://mynaposter.com/dashboard#reset=t", { config, fetch: fake });
  expect(seen!.url).toBe("https://api.resend.com/emails");
  expect((seen!.init.headers as Record<string, string>).authorization).toBe("Bearer re_test");
  const body = JSON.parse(String(seen!.init.body));
  expect(body.from).toBe("myna <mail@mynaposter.com>");
  expect(body.to).toEqual(["a@example.com"]);
});

test("sendResetMail throws on a Resend error", async () => {
  const config = hostedConfig({ RESEND_API_KEY: "re_test" });
  const fake = (async () => new Response("domain not verified", { status: 403 })) as unknown as typeof fetch;
  await expect(sendResetMail("a@example.com", "l", { config, fetch: fake })).rejects.toThrow("Resend 403");
});

test("no RESEND_API_KEY: forgot answers 503 before touching the database", async () => {
  const reply = await forgotPassword("a@example.com", { config: hostedConfig({}) });
  expect(reply.status).toBe(503);
});

test("a malformed address is a 400", async () => {
  const reply = await forgotPassword("not an email", { config: hostedConfig({ RESEND_API_KEY: "re_test" }) });
  expect(reply.status).toBe(400);
});
