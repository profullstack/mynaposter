/**
 * Mail and texts to people: SMTP against a fake server on a local port,
 * Telnyx against a fake fetch, and the contacts store with its importer.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { createServer, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendSmtp, buildMime, dotStuff, addressOf, SmtpError } from "../src/core/smtp.ts";
import { sendSms, e164 } from "../src/core/sms.ts";
import { readContacts, upsertContact, addToList, recipients, optOut, removeContact } from "../src/store/contacts.ts";
import { importFromAgenticjobs } from "../src/core/contacts-import.ts";
import type { Account } from "../src/net/types.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-outreach-"));
  process.env.MYNA_HOME = dir;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
});

/** A fake SMTP server: records every line, refuses one address, answers like a real one. */
function fakeSmtp(options: { refuse?: string } = {}) {
  const lines: string[] = [];
  let data = "";
  const server = createServer((socket: Socket) => {
    let inData = false;
    let buffer = "";
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
            socket.write("250 2.0.0 Ok: queued as ABC123\r\n");
          } else data += `${line}\n`;
          continue;
        }
        lines.push(line);
        if (line.startsWith("EHLO")) socket.write("250-fake.example\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
        else if (line.startsWith("AUTH PLAIN")) socket.write(line.endsWith(Buffer.from("\0ada\0secret").toString("base64")) ? "235 2.7.0 Authentication successful\r\n" : "535 5.7.8 Authentication credentials invalid\r\n");
        else if (line.startsWith("MAIL FROM")) socket.write("250 2.1.0 Ok\r\n");
        else if (line.startsWith("RCPT TO")) socket.write(options.refuse && line.includes(options.refuse) ? "550 5.1.1 No such user\r\n" : "250 2.1.5 Ok\r\n");
        else if (line === "DATA") {
          inData = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (line === "QUIT") {
          socket.write("221 Bye\r\n");
          socket.end();
        } else socket.write("500 what\r\n");
      }
    });
  });
  return {
    lines,
    data: () => data,
    listen: () => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port))),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("a message goes out over SMTP: EHLO, AUTH PLAIN, one RCPT per recipient, dot-stuffed multipart DATA, QUIT", async () => {
  const fake = fakeSmtp();
  const port = await fake.listen();
  try {
    const result = await sendSmtp(
      { id: "t", host: "127.0.0.1", port, secure: "none", user: "ada", pass: "secret", from: "Ada <ada@example.com>" },
      { to: ["bob@example.com", "Carol <carol@example.com>"], subject: "Hello there", text: "Plain.\n.starts with a dot", html: "<p>Hello</p>", replyTo: "reply@example.com" },
    );
    expect(result.accepted).toEqual(["bob@example.com", "Carol <carol@example.com>"]);
    expect(result.response).toContain("queued as ABC123");
    expect(result.messageId).toMatch(/^<[a-f0-9]+@example\.com>$/);
    expect(fake.lines.filter((line) => line.startsWith("RCPT TO"))).toEqual(["RCPT TO:<bob@example.com>", "RCPT TO:<carol@example.com>"]);
    expect(fake.lines.some((line) => line.startsWith("MAIL FROM:<ada@example.com>"))).toBe(true);
    expect(fake.lines[fake.lines.length - 1]).toBe("QUIT");
    const body = fake.data();
    expect(body).toContain("Subject: Hello there");
    expect(body).toContain("Reply-To: reply@example.com");
    expect(body).toContain("multipart/alternative");
    expect(body).toContain("..starts with a dot");
    expect(body).toContain("<p>Hello</p>");
  } finally {
    await fake.close();
  }
});

test("a refused recipient and a wrong password are the server's own words", async () => {
  const fake = fakeSmtp({ refuse: "nobody@example.com" });
  const port = await fake.listen();
  try {
    await expect(sendSmtp({ id: "t", host: "127.0.0.1", port, secure: "none", user: "ada", pass: "secret", from: "ada@example.com" }, { to: ["nobody@example.com"], subject: "x", text: "y" })).rejects.toThrow(/RCPT TO nobody@example.com: 5\.1\.1 No such user/);
    await expect(sendSmtp({ id: "t", host: "127.0.0.1", port, secure: "none", user: "ada", pass: "wrong", from: "ada@example.com" }, { to: ["bob@example.com"], subject: "x", text: "y" })).rejects.toThrow(SmtpError);
  } finally {
    await fake.close();
  }
});

test("mime and address helpers", () => {
  expect(addressOf("Ada <ada@example.com>")).toBe("ada@example.com");
  expect(dotStuff("a\n.b\r\nc")).toBe("a\r\n..b\r\nc");
  const mime = buildMime({ id: "t", host: "h", port: 25, secure: "none", user: "", from: "a@b.c" }, { to: ["d@e.f"], subject: "Héllo", text: "t" }, "<id@b.c>", new Date(0));
  expect(mime).toContain("Subject: =?utf-8?B?");
  expect(mime).toContain("Content-Type: text/plain; charset=utf-8");
  expect(mime).toContain("Date: Thu, 01 Jan 1970");
});

test("a text goes to Telnyx with the numbers normalised, and its refusal is quoted", async () => {
  const calls: Array<{ url: string; auth: string | null; body: Record<string, string> }> = [];
  let status = 200;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), auth: new Headers(init?.headers as Record<string, string>).get("authorization"), body: JSON.parse(String(init?.body)) });
    if (status !== 200) return new Response(JSON.stringify({ errors: [{ title: "Invalid from", detail: "not on a messaging profile" }] }), { status });
    return new Response(JSON.stringify({ data: { id: "msg-1", parts: 2 } }), { status: 200 });
  }) as unknown as typeof fetch;
  expect(e164("(408) 555-0100")).toBe("+14085550100");
  expect(e164("+44 20 7946 0958")).toBe("+442079460958");
  const sent = await sendSms({ apiKey: "k", from: "408-426-9127" }, "4085550100", "hello", { fetch: fetcher });
  expect(sent).toEqual({ id: "msg-1", to: "+14085550100", parts: 2 });
  expect(calls[0]).toMatchObject({ url: "https://api.telnyx.com/v2/messages", auth: "Bearer k", body: { from: "+14084269127", to: "+14085550100", text: "hello" } });
  status = 422;
  await expect(sendSms({ apiKey: "k", from: "+14084269127" }, "+14085550100", "x", { fetch: fetcher })).rejects.toThrow(/Telnyx answered 422: Invalid from: not on a messaging profile/);
});

test("contacts: upsert merges, lists select, opt-out wins, remove clears everywhere", () => {
  const ada = upsertContact({ name: "Ada", email: "Ada@Example.com", phone: null, handles: [], openprofile: null, source: "manual", tags: ["Math"] });
  expect(ada.id).toBe("ada@example.com");
  const again = upsertContact({ name: null, email: "ada@example.com", phone: "+15550100", handles: ["bluesky:ada"], openprofile: "https://a/op.md", source: "agenticjobs:ada", tags: ["rust"] });
  expect(again).toMatchObject({ id: "ada@example.com", name: "Ada", phone: "+15550100", handles: ["bluesky:ada"], openprofile: "https://a/op.md", source: "manual", tags: ["math", "rust"] });
  const bob = upsertContact({ name: "Bob", email: null, phone: "(555) 010-0200", handles: [], openprofile: null, source: "manual", tags: [] });
  expect(bob.id).toBe("5550100200");
  expect(addToList("Launch", ["ada@example.com", "5550100200"], readContacts())).toBe(2);
  expect(addToList("launch", ["ada@example.com"], readContacts())).toBe(0);
  expect(() => addToList("launch", ["nobody"], readContacts())).toThrow(/No contact nobody/);
  expect(recipients({ list: "launch" }).map((c) => c.id)).toEqual(["ada@example.com", "5550100200"]);
  expect(recipients({ tag: "rust" }).map((c) => c.id)).toEqual(["ada@example.com"]);
  expect(optOut("5550100200")).toBe(true);
  expect(recipients({ list: "launch" }).map((c) => c.id)).toEqual(["ada@example.com"]);
  expect(removeContact("ada@example.com")).toBe(true);
  expect(readContacts().lists.launch).toEqual(["5550100200"]);
});

test("the agenticjobs importer keeps published contact info as the account sees it, and skips the withheld", async () => {
  const account: Account = { id: "agenticjobs:me", network: "agenticjobs", handle: "me", addedAt: "", creds: { token: "tok" }, meta: { instance: "https://board.example" } };
  const seen: string[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push(`${new Headers(init?.headers as Record<string, string>).get("authorization")} ${url}`);
    if (url.endsWith("/api/v1/candidates?limit=100")) return new Response(JSON.stringify({ items: [{ slug: "ada", name: "Ada", headline: "Mathematician", skills: ["Rust", "Poetry"] }, { slug: "eve", name: "Eve", headline: null }, { slug: "mute", name: "Mute", headline: null }] }));
    if (url.endsWith("/candidates/ada")) return new Response(JSON.stringify({ candidate: { slug: "ada", name: "Ada" }, parsed: { contact: [{ key: "Email", value: "ada@example.com", href: "mailto:ada@example.com" }, { key: "Phone", value: "+1 (408) 555-0100", href: "tel:+14085550100" }, { key: "GitHub", value: "GitHub", href: "https://github.com/ada" }] }, openprofile: "https://board.example/candidates/ada/openprofile.md" }));
    if (url.endsWith("/candidates/eve")) return new Response(JSON.stringify({ candidate: { slug: "eve", name: "Eve" }, parsed: { contact: [] }, contactRedacted: true }));
    return new Response(JSON.stringify({ candidate: { slug: "mute", name: "Mute" }, parsed: { contact: [{ key: "Location", value: "London", href: null }] } }));
  }) as unknown as typeof fetch;

  const result = await importFromAgenticjobs(account, { fetch: fetcher, tags: ["candidates"], list: "board" });
  expect(result.read).toBe(3);
  expect(result.imported.map((c) => c.id)).toEqual(["ada@example.com"]);
  expect(result.imported[0]).toMatchObject({ name: "Ada", email: "ada@example.com", phone: "+14085550100", handles: ["github:https://github.com/ada"], openprofile: "https://board.example/candidates/ada/openprofile.md", source: "agenticjobs:ada", tags: ["agenticjobs", "candidates", "rust", "poetry"], note: "Mathematician" });
  expect(result.skipped).toEqual(["eve: contact withheld (sign in to the board with myna login agenticjobs)", "mute: nothing published to reach them by"]);
  expect(seen.every((line) => line.startsWith("Bearer tok "))).toBe(true);
  expect(readContacts().lists.board).toEqual(["ada@example.com"]);
});
