/**
 * Newsletters end to end against a fake SMTP server: the issue store, who a
 * send reaches, the per-recipient ledger that makes a second send a no-op,
 * the daily cap, the one-click unsubscribe on every message, and the hosted
 * unsubscribes coming back as permanent opt-outs.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { createServer, type Socket } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNewsletter,
  editNewsletter,
  readNewsletters,
  recordDelivery,
  removeNewsletter,
  requireNewsletter,
  tokenFor,
  writeNewsletters,
} from "../src/store/newsletters.ts";
import {
  composeNewsletter,
  parseSubscribers,
  readSubscriberFile,
  runDueNewsletters,
  sendNewsletter,
  subscribe,
  subscribers,
  syncUnsubscribes,
  unsubscribe,
  linkMaker,
} from "../src/core/newsletter.ts";
import { optOut, readContacts, recipients } from "../src/store/contacts.ts";
import { readOutreach } from "../src/store/outreach.ts";
import { loadSettings, saveSettings } from "../src/store/settings.ts";
import { saveSession } from "../src/store/cloud.ts";

let dir = "";
const realFetch = globalThis.fetch;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-newsletter-"));
  process.env.MYNA_HOME = dir;
  const settings = loadSettings();
  settings.newsletter.address = "Profullstack, Inc.\n1 Main St, San Jose, CA 95112, USA";
  settings.newsletter.unsubscribeUrl = "https://example.com/u/{token}";
  saveSettings(settings);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
});

/** A fake SMTP server that keeps each message whole, and refuses one address. */
function fakeSmtp(options: { refuse?: string } = {}) {
  const messages: { rcpt: string[]; data: string }[] = [];
  const server = createServer((socket: Socket) => {
    let inData = false;
    let buffer = "";
    let rcpt: string[] = [];
    let data = "";
    socket.write("220 fake.example ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let index: number;
      while ((index = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            messages.push({ rcpt, data });
            socket.write("250 2.0.0 Ok: queued\r\n");
          } else data += `${line}\n`;
          continue;
        }
        if (line.startsWith("EHLO")) socket.write("250-fake.example\r\n250 8BITMIME\r\n");
        else if (line.startsWith("MAIL FROM")) {
          rcpt = [];
          data = "";
          socket.write("250 2.1.0 Ok\r\n");
        } else if (line.startsWith("RCPT TO")) {
          if (options.refuse && line.includes(options.refuse)) socket.write("550 5.1.1 No such user\r\n");
          else {
            rcpt.push(line.slice(9, -1));
            socket.write("250 2.1.5 Ok\r\n");
          }
        } else if (line === "DATA") {
          inData = true;
          socket.write("354 go ahead\r\n");
        } else if (line === "QUIT") {
          socket.write("221 Bye\r\n");
          socket.end();
        } else socket.write("500 what\r\n");
      }
    });
  });
  return {
    messages,
    listen: () => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port))),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const smtp = (port: number) => ({ id: "fake", host: "127.0.0.1", port, secure: "none" as const, user: "", pass: "", from: "Myna News <news@example.com>" });

function issue(list = "moshcode") {
  return createNewsletter({ subject: "Issue one", body: "# Hello\n\nThe first issue.", list });
}

test("an issue is written, edited, scheduled and removed; a sent one cannot change", () => {
  const n = issue();
  expect(n.id).toBe("issue-one");
  expect(n.status).toBe("draft");
  expect(createNewsletter({ subject: "Issue one", body: "x", list: "moshcode" }).id).toBe("issue-one-2");

  const at = new Date(Date.now() + 3_600_000).toISOString();
  expect(editNewsletter("issue-one", { scheduledFor: at }).status).toBe("scheduled");
  expect(editNewsletter("issue-one", { draft: true }).status).toBe("draft");
  expect(editNewsletter("issue-one", { subject: "Line\r\nBcc: evil@example.com" }).subject).toBe("Line Bcc: evil@example.com");

  recordDelivery("issue-one", "a@example.com", { state: "sent", at: new Date().toISOString(), to: "a@example.com" });
  expect(() => removeNewsletter("issue-one")).toThrow(/--force/);
  const file = readNewsletters();
  (file.newsletters[0] as { status: string }).status = "sent";
  writeNewsletters(file);
  expect(() => editNewsletter("issue-one", { subject: "late" })).toThrow(/has been sent/);
  expect(removeNewsletter("issue-one", { force: true })).toBe(true);
  expect(readNewsletters().deliveries["issue-one"]).toBeUndefined();
});

test("every message carries one-click unsubscribe headers, a footer link and the postal address", () => {
  const message = composeNewsletter(
    { subject: "Hi", body: "Body **bold**", list: "moshcode", replyTo: null },
    { link: "https://example.com/u/tok123", address: "1 Main St\nSan Jose", from: "News <news@example.com>", token: "tok123" },
  );
  expect(message.headers?.["List-Unsubscribe"]).toBe("<https://example.com/u/tok123>, <mailto:news@example.com?subject=unsubscribe%20tok123>");
  expect(message.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  expect(message.headers?.["List-Id"]).toBe("moshcode <moshcode.example.com>");
  expect(message.text).toContain("Unsubscribe with one click: https://example.com/u/tok123");
  expect(message.text).toContain("1 Main St\nSan Jose");
  expect(message.html).toContain('<a href="https://example.com/u/tok123">Unsubscribe</a>');
  expect(message.html).toContain("1 Main St<br>San Jose");
  expect(message.html).toContain("<strong>bold</strong>");
});

test("a send reaches the list minus opt-outs, once; a second send mails nobody", async () => {
  subscribe("moshcode", [{ email: "ada@example.com", name: "Ada" }, { email: "bob@example.com" }, { email: "cy@example.com" }]);
  optOut("cy@example.com");
  issue();
  const fake = fakeSmtp();
  const port = await fake.listen();
  try {
    const first = await sendNewsletter("issue-one", { server: smtp(port) });
    expect(first.sent.sort()).toEqual(["ada@example.com", "bob@example.com"]);
    expect(first.status).toBe("sent");
    expect(fake.messages).toHaveLength(2);
    const mail = fake.messages.find((m) => m.rcpt.includes("ada@example.com"))!.data;
    const token = readNewsletters().tokens["ada@example.com"];
    expect(mail).toContain(`List-Unsubscribe: <https://example.com/u/${token}>`);
    expect(mail).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    expect(mail).toContain("1 Main St, San Jose, CA 95112, USA");
    expect(mail).not.toContain("cy@example.com");

    const again = await sendNewsletter("issue-one", { server: smtp(port) });
    expect(again.sent).toEqual([]);
    expect(again.alreadySent).toBe(2);
    expect(fake.messages).toHaveLength(2);
    expect(readOutreach().sent.filter((entry) => entry.ok)).toHaveLength(2);
    expect(requireNewsletter("issue-one").sentAt).not.toBeNull();
  } finally {
    await fake.close();
  }
});

test("the daily cap stops a send part way, and the next day's run resumes where it stopped", async () => {
  const settings = loadSettings();
  settings.outreach.maxEmailsPerDay = 2;
  saveSettings(settings);
  subscribe("moshcode", ["a", "b", "c"].map((x) => ({ email: `${x}@example.com` })));
  issue();
  const fake = fakeSmtp();
  const port = await fake.listen();
  try {
    const today = await sendNewsletter("issue-one", { server: smtp(port) });
    expect(today.sent).toHaveLength(2);
    expect(today.remaining).toBe(1);
    expect(today.status).toBe("sending");

    const stillToday = await sendNewsletter("issue-one", { server: smtp(port) });
    expect(stillToday.sent).toHaveLength(0);
    expect(stillToday.remaining).toBe(1);

    const tomorrow = await sendNewsletter("issue-one", { server: smtp(port), now: new Date(Date.now() + 25 * 3_600_000) });
    expect(tomorrow.sent).toHaveLength(1);
    expect(tomorrow.status).toBe("sent");
    expect(new Set(fake.messages.flatMap((m) => m.rcpt)).size).toBe(3);
    expect(fake.messages).toHaveLength(3);
  } finally {
    await fake.close();
  }
});

test("a refused address is written down and retried only when asked; an uncertain one is never mailed again unasked", async () => {
  subscribe("moshcode", [{ email: "ok@example.com" }, { email: "gone@example.com" }, { email: "maybe@example.com" }]);
  issue();
  recordDelivery("issue-one", "maybe@example.com", { state: "pending", at: new Date().toISOString(), to: "maybe@example.com" });
  const fake = fakeSmtp({ refuse: "gone@" });
  const port = await fake.listen();
  try {
    const report = await sendNewsletter("issue-one", { server: smtp(port) });
    expect(report.sent).toEqual(["ok@example.com"]);
    expect(report.failed.map((f) => f.to)).toEqual(["gone@example.com"]);
    expect(report.failed[0]?.error).toMatch(/No such user/);
    expect(report.uncertain).toBe(1);
    expect(report.status).toBe("sent");

    const again = await sendNewsletter("issue-one", { server: smtp(port) });
    expect(again.previouslyFailed).toBe(1);
    expect(again.sent).toEqual([]);

    const retried = await sendNewsletter("issue-one", { server: smtp(port), retryFailed: true, retryUncertain: true });
    expect(retried.sent).toEqual(["maybe@example.com"]);
    expect(retried.failed.map((f) => f.to)).toEqual(["gone@example.com"]);
  } finally {
    await fake.close();
  }
});

test("a dry run and a test copy touch neither the ledger nor the status", async () => {
  subscribe("moshcode", [{ email: "ada@example.com" }]);
  issue();
  const fake = fakeSmtp();
  const port = await fake.listen();
  try {
    const dry = await sendNewsletter("issue-one", { server: smtp(port), dryRun: true });
    expect(dry.wouldSend).toEqual(["ada@example.com"]);
    const copy = await sendNewsletter("issue-one", { server: smtp(port), test: "me@example.com" });
    expect(copy.sent).toEqual(["me@example.com"]);
    expect(fake.messages).toHaveLength(1);
    expect(fake.messages[0]?.data).toContain("Subject: [test] Issue one");
    expect(fake.messages[0]?.data).toContain("List-Unsubscribe-Post");
    expect(readNewsletters().deliveries["issue-one"]).toBeUndefined();
    expect(requireNewsletter("issue-one").status).toBe("draft");
  } finally {
    await fake.close();
  }
});

test("no postal address, or no way to host the link, and nothing is sent", async () => {
  subscribe("moshcode", [{ email: "ada@example.com" }]);
  issue();
  const settings = loadSettings();
  settings.newsletter.address = "";
  saveSettings(settings);
  await expect(sendNewsletter("issue-one", { server: smtp(1) })).rejects.toThrow(/postal address/);

  settings.newsletter.address = "1 Main St";
  settings.newsletter.unsubscribeUrl = "";
  saveSettings(settings);
  await expect(linkMaker()).rejects.toThrow(/myna cloud login/);
  settings.newsletter.unsubscribeUrl = "http://example.com/u/{token}";
  saveSettings(settings);
  await expect(linkMaker()).rejects.toThrow(/https/);
  expect(readNewsletters().deliveries["issue-one"]?.["ada@example.com"]).toBeUndefined();
});

test("the daemon sends a scheduled issue when due and leaves drafts alone", async () => {
  subscribe("moshcode", [{ email: "ada@example.com" }]);
  createNewsletter({ subject: "Draft", body: "d", list: "moshcode" });
  createNewsletter({ subject: "Later", body: "l", list: "moshcode", scheduledFor: new Date(Date.now() + 86_400_000).toISOString() });
  createNewsletter({ subject: "Due", body: "d", list: "moshcode", scheduledFor: new Date(Date.now() - 60_000).toISOString() });
  const fake = fakeSmtp();
  const port = await fake.listen();
  try {
    const reports = await runDueNewsletters(new Date(), { server: smtp(port) });
    expect(reports.map((r) => r.id)).toEqual(["due"]);
    expect(requireNewsletter("due").status).toBe("sent");
    expect(requireNewsletter("draft").status).toBe("draft");
    expect(requireNewsletter("later").status).toBe("scheduled");
  } finally {
    await fake.close();
  }
});

test("subscribers come from CSV and JSON; an opted-out one stays out; unsubscribe is per list or for good", () => {
  const csv = parseSubscribers('Name,Email,Tags\n"Lovelace, Ada",ada@example.com,rust;ai\nBob,bob@example.com,\n', "csv");
  expect(csv).toEqual([
    { email: "ada@example.com", name: "Lovelace, Ada", tags: ["rust", "ai"] },
    { email: "bob@example.com", name: "Bob", tags: [] },
  ]);
  expect(parseSubscribers("cy@example.com,Cy\n", "csv")).toEqual([{ email: "cy@example.com", name: "Cy", tags: [] }]);
  expect(parseSubscribers('["a@example.com", {"email": "b@example.com", "name": "B", "tags": ["x"]}]', "json")).toEqual([
    { email: "a@example.com" },
    { email: "b@example.com", name: "B", tags: ["x"] },
  ]);
  expect(parseSubscribers('{"contacts": [{"email": "c@example.com", "optedOut": true}, {"email": "d@example.com"}]}', "json").map((p) => p.email)).toEqual(["d@example.com"]);

  const path = join(dir, "subs.csv");
  writeFileSync(path, "email\nada@example.com\nnot-an-email\nbob@example.com\n");
  subscribe("other", [{ email: "bob@example.com" }]);
  optOut("bob@example.com");
  const result = subscribe("moshcode", readSubscriberFile(path));
  expect(result.added).toEqual(["ada@example.com"]);
  expect(result.optedOut).toEqual(["bob@example.com"]);
  expect(result.invalid).toEqual(["not-an-email"]);
  expect(subscribe("moshcode", [{ email: "ADA@example.com" }]).already).toEqual(["ada@example.com"]);

  subscribe("other", [{ email: "ada@example.com" }]);
  expect(unsubscribe("ada@example.com", { list: "other" })).toEqual({ id: "ada@example.com", permanent: false });
  expect(subscribers("other").map((s) => s.contact.id)).toEqual(["bob@example.com"]);
  expect(recipients({ list: "moshcode" }).map((c) => c.id)).toEqual(["ada@example.com"]);

  const token = tokenFor("ada@example.com");
  expect(unsubscribe(token)).toEqual({ id: "ada@example.com", permanent: true });
  expect(recipients({ list: "moshcode" })).toEqual([]);
  expect(unsubscribe("nobody@example.com")).toBeNull();
});

test("hosted links: the inbox is opened once, and one-click unsubscribes come back as permanent opt-outs", async () => {
  const settings = loadSettings();
  settings.newsletter.unsubscribeUrl = "";
  saveSettings(settings);
  saveSession({ server: "https://myna.test/api", email: "me@example.com", token: "tok", since: new Date().toISOString() });
  subscribe("moshcode", [{ email: "ada@example.com" }, { email: "bob@example.com" }]);
  const adaToken = tokenFor("ada@example.com");
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
    if (url.endsWith("/v1/newsletter/inbox")) return Response.json({ ok: true, inbox: "INBOXINBOXINBOX1" });
    if (url.includes("/v1/newsletter/unsubscribes")) return Response.json({ ok: true, unsubscribes: [{ token: adaToken, at: "2026-09-24T10:00:00.000Z" }, { token: "someone-else-entirely", at: "2026-09-24T11:00:00.000Z" }] });
    return new Response("nope", { status: 404 });
  }) as typeof fetch;

  const link = await linkMaker();
  expect(link("abc")).toBe("https://myna.test/api/v1/newsletter/u/INBOXINBOXINBOX1/abc");
  await linkMaker();
  expect(calls.filter((c) => c.endsWith("/inbox"))).toHaveLength(1);

  const synced = await syncUnsubscribes();
  expect(synced).toEqual({ pulled: 2, optedOut: ["ada@example.com"], unknown: 1 });
  expect(recipients({ list: "moshcode" }).map((c) => c.id)).toEqual(["bob@example.com"]);
  expect(readNewsletters().unsubscribesSince).toBe("2026-09-24T11:00:00.000Z");
  await syncUnsubscribes();
  expect(calls[calls.length - 1]).toContain("since=2026-09-24T11%3A00%3A00.000Z");
});
