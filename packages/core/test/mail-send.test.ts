/**
 * Mail providers in use: where their config and secrets are kept, which one
 * a send picks, and a newsletter going out through a batch provider with
 * its per-recipient ledger, pacing, and retryable failures. A fake sender
 * stands in for the provider; nothing is sent.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveMailProvider, removeMailProvider, mailProviderSecret, readOutreach, saveSmtpServer, readOutreach as outreach } from "../src/store/outreach.ts";
import { getPluginSecrets, resetAccountCache } from "../src/store/accounts.ts";
import { loadSettings, saveSettings } from "../src/store/settings.ts";
import { listMailProviders, resolveSender } from "../src/core/mail/index.ts";
import { createNewsletter, readNewsletters } from "../src/store/newsletters.ts";
import { sendNewsletter, subscribe } from "../src/core/newsletter.ts";
import type { MailMessage, MailResult, MailSender } from "../src/core/mail/types.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-mail-"));
  process.env.MYNA_HOME = dir;
  resetAccountCache();
  const settings = loadSettings();
  settings.newsletter.address = "Profullstack, Inc.\n1 Main St, San Jose, CA 95112, USA";
  settings.newsletter.unsubscribeUrl = "https://example.com/u/{token}";
  saveSettings(settings);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
  resetAccountCache();
});

test("a provider's key goes to the vault, never outreach.json; rm takes both", () => {
  saveMailProvider({ id: "rs", type: "resend", from: "News <news@example.com>" }, "re_supersecret");
  const onDisk = readFileSync(join(dir, "outreach.json"), "utf8");
  expect(onDisk).toContain('"resend"');
  expect(onDisk).not.toContain("re_supersecret");
  expect(getPluginSecrets("mail").rs).toBe("re_supersecret");
  expect(mailProviderSecret("rs")).toBe("re_supersecret");
  expect(readOutreach().mail).toEqual([{ id: "rs", type: "resend", from: "News <news@example.com>" }]);
  expect(removeMailProvider("rs")).toBe(true);
  expect(mailProviderSecret("rs")).toBe("");
  expect(readOutreach().mail).toEqual([]);
});

test("which provider a send uses: --via, then the default setting, then the first SMTP server, then the first provider", () => {
  expect(() => resolveSender()).toThrow(/No way to send mail yet/);
  saveMailProvider({ id: "pm", type: "postmark", from: "a@example.com" }, "t");
  expect(resolveSender().id).toBe("pm");
  saveSmtpServer({ id: "box", host: "127.0.0.1", port: 25, secure: "none", user: "", from: "b@example.com" }, "");
  expect(resolveSender().id).toBe("box");
  expect(resolveSender().type).toBe("smtp");
  const settings = loadSettings();
  settings.outreach.mailProvider = "pm";
  saveSettings(settings);
  expect(resolveSender().type).toBe("postmark");
  expect(resolveSender("box").type).toBe("smtp");
  expect(() => resolveSender("nope")).toThrow(/No mail provider "nope"/);
  expect(listMailProviders().map((entry) => `${entry.id}:${entry.type}`)).toEqual(["pm:postmark", "box:smtp"]);
  expect(outreach().smtp).toHaveLength(1);
});

/** A batch provider that records each call and answers from a script. */
function fakeSender(script: (message: MailMessage, call: number) => MailResult, batchSize = 2) {
  const calls: MailMessage[][] = [];
  const sender: MailSender = {
    id: "fake-resend",
    type: "resend",
    from: "Myna News <news@example.com>",
    batchSize,
    send: async (message) => {
      calls.push([message]);
      return script(message, calls.length);
    },
    sendBatch: async (messages) => {
      calls.push(messages);
      return messages.map((message) => script(message, calls.length));
    },
  };
  return { sender, calls };
}

const people = ["a", "b", "c", "d", "e"].map((name) => ({ email: `${name}@example.com` }));

test("a newsletter through a batch provider: batches of its size, paced between calls, one ledger row per person", async () => {
  subscribe("news", people);
  createNewsletter({ subject: "Issue", body: "Hello", list: "news", id: "i1" });
  const { sender, calls } = fakeSender((message) => ({ ok: true, id: `id-${(message.to as string[])[0]}` }));
  const sleeps: number[] = [];
  const report = await sendNewsletter("i1", { sender, paceMs: 700, sleep: async (ms) => void sleeps.push(ms), tracking: null });
  expect(calls.map((batch) => batch.length)).toEqual([2, 2, 1]);
  expect(sleeps).toEqual([700, 700]);
  expect(report.sent).toHaveLength(5);
  expect(report.status).toBe("sent");
  expect(report.via).toBe("fake-resend");
  // Every person got their own message: their address, their unsubscribe link, the one-click headers.
  const first = calls[0]?.[0] as MailMessage;
  expect(first.to).toEqual(["a@example.com"]);
  expect(first.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  expect(first.headers?.["List-Unsubscribe"]).toContain("https://example.com/u/");
  const ledger = readNewsletters().deliveries.i1 ?? {};
  expect(Object.values(ledger).map((entry) => [entry.state, entry.messageId, entry.via])).toEqual(people.map((p) => ["sent", `id-${p.email}`, "fake-resend"]));
  // A second run mails nobody.
  const again = await sendNewsletter("i1", { sender, tracking: null });
  expect(again.sent).toHaveLength(0);
  expect(again.alreadySent).toBe(5);
});

test("a retryable failure stops the run and is tried again on the next one by itself; a final one waits for --retry-failed", async () => {
  subscribe("news", people);
  createNewsletter({ subject: "Issue", body: "Hello", list: "news", id: "i1" });
  let limited = true;
  const { sender, calls } = fakeSender((message, call) => {
    const to = (message.to as string[])[0];
    if (to === "b@example.com") return { ok: false, retryable: false, error: "invalid address", status: 422 };
    if (call === 2 && limited) return { ok: false, retryable: true, error: "429 slow down", status: 429 };
    return { ok: true, id: `id-${to}` };
  });
  const first = await sendNewsletter("i1", { sender, tracking: null, sleep: async () => undefined });
  // Call 1: a sent, b refused for good. Call 2: c and d rate limited, so the run stops before e.
  expect(calls.map((batch) => batch.length)).toEqual([2, 2]);
  expect(first.sent).toEqual(["a@example.com"]);
  expect(first.failed.map((entry) => entry.to)).toEqual(["b@example.com", "c@example.com", "d@example.com"]);
  expect(first.remaining).toBe(1);
  expect(first.status).toBe("sending");
  const ledger = readNewsletters().deliveries.i1 ?? {};
  expect(ledger["b@example.com"]).toMatchObject({ state: "failed" });
  expect(ledger["b@example.com"]?.retryable).toBeUndefined();
  expect(ledger["c@example.com"]).toMatchObject({ state: "failed", retryable: true });
  expect(ledger["e@example.com"]).toBeUndefined();

  limited = false;
  const second = await sendNewsletter("i1", { sender, tracking: null, sleep: async () => undefined });
  expect(second.retrying).toBe(2);
  expect(second.previouslyFailed).toBe(1);
  expect(second.sent.sort()).toEqual(["c@example.com", "d@example.com", "e@example.com"]);
  expect(second.status).toBe("sent");
});

test("a connection that died leaves the batch pending (uncertain), never failed", async () => {
  subscribe("news", people.slice(0, 2));
  createNewsletter({ subject: "Issue", body: "Hello", list: "news", id: "i1" });
  const { sender } = fakeSender(() => ({ ok: false, retryable: true, status: 0, error: "no answer in 30s" }));
  const report = await sendNewsletter("i1", { sender, tracking: null });
  expect(report.sent).toHaveLength(0);
  const ledger = readNewsletters().deliveries.i1 ?? {};
  expect(Object.values(ledger).map((entry) => entry.state)).toEqual(["pending", "pending"]);
  const next = await sendNewsletter("i1", { sender, tracking: null });
  expect(next.uncertain).toBe(2);
  expect(next.sent).toHaveLength(0);
});

test("a test copy goes through the provider as bulk; a provider with no sender cannot send a newsletter", async () => {
  subscribe("news", people.slice(0, 1));
  createNewsletter({ subject: "Issue", body: "Hello", list: "news", id: "i1" });
  const { sender, calls } = fakeSender(() => ({ ok: true, id: "t1" }));
  const copy = await sendNewsletter("i1", { sender, tracking: null, test: "me@example.com" });
  expect(copy.sent).toEqual(["me@example.com"]);
  expect(calls[0]?.[0]?.subject).toBe("[test] Issue");
  const nameless: MailSender = { ...sender, from: undefined };
  await expect(sendNewsletter("i1", { sender: nameless, tracking: null })).rejects.toThrow(/no sender address/);
});
