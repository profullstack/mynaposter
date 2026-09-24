/**
 * Newsletters with crawlproof tracking and A/B variants: signed URLs to the
 * letter of the contract (crawlproof.com PR #266), variants that stay put per
 * person, whole sends against a fake SMTP server with crawlproof played by a
 * stubbed fetch, and stats joined through the ledger. No real mail leaves
 * this file.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { createServer, type Socket } from "node:net";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNewsletter, readNewsletters, requireNewsletter } from "../src/store/newsletters.ts";
import {
  buildVariants,
  clickUrl,
  composeNewsletter,
  fetchTrackingEvents,
  newsletterStats,
  openPixelUrl,
  sendNewsletter,
  subscribe,
  syncTrackingUnsubscribes,
  trackedUnsubscribeUrl,
  variantIndex,
  variantsFor,
  type Tracking,
  type TrackingEvent,
} from "../src/core/newsletter.ts";
import { quotedPrintable, buildMime } from "../src/core/smtp.ts";
import { readContacts, recipients } from "../src/store/contacts.ts";
import { readOutreach } from "../src/store/outreach.ts";
import { DEFAULT_CTAS, loadSettings, saveSettings } from "../src/store/settings.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-newsletter-tracking-"));
  process.env.MYNA_HOME = dir;
  const settings = loadSettings();
  settings.newsletter.address = "Profullstack, Inc., 1 Main St, San Jose, CA 95112, USA";
  // No myna cloud here: with tracking the link is crawlproof's; without, this one.
  settings.newsletter.unsubscribeUrl = "https://example.com/u/{token}";
  saveSettings(settings);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
});

const SECRET = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const tracking: Tracking = { id: "0123456789abcdef01234567", secret: SECRET, host: "https://crawlproof.test" };
const hmac32 = (value: string): string => createHmac("sha256", SECRET).update(value).digest("hex").slice(0, 32);
const BASE = "https://crawlproof.test/t/0123456789abcdef01234567";

/** A fake SMTP server that keeps every message, one per connection, dot-stuffing undone. */
function fakeSmtp() {
  const messages: { rcpt: string[]; data: string }[] = [];
  const server = createServer((socket: Socket) => {
    let inData = false;
    let buffer = "";
    let data = "";
    const rcpt: string[] = [];
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
            messages.push({ rcpt: [...rcpt], data });
            socket.write("250 2.0.0 Ok: queued\r\n");
          } else data += `${line.startsWith("..") ? line.slice(1) : line}\n`;
          continue;
        }
        if (line.startsWith("EHLO")) socket.write("250-fake.example\r\n250 8BITMIME\r\n");
        else if (line.startsWith("MAIL FROM")) socket.write("250 Ok\r\n");
        else if (line.startsWith("RCPT TO")) {
          rcpt.push(line.slice(9, -1));
          socket.write("250 Ok\r\n");
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

const smtp = (port: number) => ({ id: "fake", host: "127.0.0.1", port, secure: "none" as const, user: "", pass: "", from: "Profullstack <news@profullstack.com>" });

/** crawlproof's events endpoint as a fetch: pages of `pageSize`, `next` an absolute URL. */
function fakeCrawlproof(events: TrackingEvent[], options: { status?: number; pageSize?: number } = {}) {
  const calls: { url: string; auth: string | null }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), auth: new Headers(init?.headers as Record<string, string>).get("authorization") });
    if (options.status) return new Response("<html>nope</html>", { status: options.status });
    const type = url.searchParams.get("type");
    const since = url.searchParams.get("since") ?? "";
    const matching = events.filter((event) => (!type || event.type === type) && event.at >= since);
    const cursor = Number(url.searchParams.get("cursor") ?? 0);
    const size = options.pageSize ?? 500;
    const page = matching.slice(cursor, cursor + size);
    const nextUrl = cursor + size < matching.length ? new URL(url) : null;
    nextUrl?.searchParams.set("cursor", String(cursor + size));
    return Response.json({ events: page, next: nextUrl ? nextUrl.toString() : null });
  }) as typeof fetch;
  return { fetcher, calls };
}

test("tracking URLs follow the crawlproof contract, signatures included", () => {
  const ids = { m: "abc123", c: "moshcode-001", v: "C" };
  expect(openPixelUrl(tracking, ids)).toBe(`${BASE}/o.png?m=abc123&c=moshcode-001&v=C`);
  const url = "https://moshcode.com/thing?a=1&b=2";
  const click = clickUrl(tracking, url, ids);
  expect(click).toBe(`${BASE}/c?u=${encodeURIComponent(url)}&m=abc123&c=moshcode-001&v=C&s=${hmac32(url)}`);
  expect(new URL(click).searchParams.get("u")).toBe(url);
  expect(trackedUnsubscribeUrl(tracking, { m: "abc123", c: "moshcode-001", email: "Ada@Example.com" })).toBe(
    `${BASE}/u?m=abc123&c=moshcode-001&e=ada%40example.com&s=${hmac32("ada@example.com")}`,
  );
  expect(openPixelUrl({ id: "x", secret: "y" }, ids).startsWith("https://crawlproof.com/t/x/o.png")).toBe(true);
});

test("variants are subjects x CTAs, and each person keeps theirs, split evenly", () => {
  const variants = buildVariants(["A subject", "B subject"], DEFAULT_CTAS);
  expect(variants.map((v) => v.key)).toEqual(["A", "B", "C", "D", "E", "F", "G", "H"]);
  expect(variants[0]).toMatchObject({ subjectKey: "A", subject: "A subject", cta: { label: "Book a demo" } });
  expect(variants[1]).toMatchObject({ subjectKey: "B", cta: { label: "Book a demo" } });
  expect(variants[7]).toMatchObject({ subjectKey: "B", cta: { label: "Support us" } });
  expect(buildVariants(["only"], [null]).map((v) => v.key)).toEqual(["A"]);
  expect(variantIndex("c1", "Ada@Example.com", 8)).toBe(variantIndex("c1", "ada@example.com", 8));
  const counts = new Array(8).fill(0);
  for (let i = 0; i < 8000; i++) counts[variantIndex("c1", `user${i}@example.com`, 8)]++;
  for (const count of counts) expect(Math.abs(count - 1000)).toBeLessThan(150);
  expect(variantsFor({ subject: "s", subjectB: null, ctaSet: null })).toHaveLength(1);
  expect(variantsFor({ subject: "s", subjectB: "t", ctaSet: "default" })).toHaveLength(8);
  expect(() => variantsFor({ subject: "s", subjectB: null, ctaSet: "nope" })).toThrow(/No CTA set/);
});

test("a tracked message: CTA where {{cta}} was, every link signed, the pixel, crawlproof's unsubscribe, the account footer", () => {
  const cta = DEFAULT_CTAS[2]!;
  const ids = { m: "m1", c: "moshcode-001", v: "E" };
  const link = trackedUnsubscribeUrl(tracking, { m: "m1", c: "moshcode-001", email: "ada@example.com" });
  const message = composeNewsletter(
    { subject: "Issue", body: "Intro https://moshcode.com/a.\n\n{{cta}}\n\nMore at [docs](https://moshcode.com/docs?x=1&y=2).", list: "moshcode-users", replyTo: null, service: "moshcode" },
    { link, address: "1 Main St", from: "News <news@profullstack.com>", token: "tok", subject: "Subject B", cta, tracking: { tracking, ids } },
  );
  const amp = (value: string): string => value.replace(/&/g, "&amp;");
  expect(message.subject).toBe("Subject B");
  expect(message.html).not.toContain("{{cta}}");
  expect(message.html).toContain(`href="${amp(clickUrl(tracking, "https://profullstack.com/plans", ids))}"`);
  expect(message.html).toContain(">See our plans</a>");
  expect(message.html).toContain(`href="${amp(clickUrl(tracking, "https://moshcode.com/docs?x=1&y=2", ids))}"`);
  expect(message.html).not.toContain('href="https://moshcode.com');
  expect(message.html!.indexOf("See our plans")).toBeLessThan(message.html!.indexOf("More at"));
  expect(message.html).toContain(`<img src="${amp(openPixelUrl(tracking, ids))}"`);
  expect(message.html).toContain(`<a href="${amp(link)}">Unsubscribe</a>`);
  expect(message.html).toContain("You get this because you have an account at moshcode; our Terms say we may email news and updates.");
  expect(message.text).toContain(`Intro ${clickUrl(tracking, "https://moshcode.com/a", ids)}.`);
  expect(message.text).toContain(`See our plans: ${clickUrl(tracking, "https://profullstack.com/plans", ids)}`);
  expect(message.text).toContain(`Unsubscribe with one click: ${link}`);
  expect(message.headers?.["List-Unsubscribe"]).toBe(`<${link}>, <mailto:news@profullstack.com?subject=unsubscribe%20tok>`);
  expect(message.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  expect(message.headers?.Precedence).toBe("bulk");
  expect(message.text).not.toContain("\u2014");
  expect(message.html).not.toContain("\u2014");
});

test("without {{cta}} the CTA goes last before the footer; with no CTA a stray marker is dropped; untracked links stay as they are", () => {
  const base = { subject: "S", list: "moshcode-users", replyTo: null };
  const opts = { link: "https://example.com/u/t", address: "1 Main St", from: "news@profullstack.com", token: "t" };
  const appended = composeNewsletter({ ...base, body: "Just text, see https://moshcode.com" }, { ...opts, cta: DEFAULT_CTAS[0] });
  expect(appended.text.indexOf("Book a demo: https://profullstack.com/book")).toBeGreaterThan(appended.text.indexOf("Just text"));
  expect(appended.text.indexOf("Book a demo")).toBeLessThan(appended.text.indexOf("Unsubscribe"));
  expect(appended.text).toContain("see https://moshcode.com");
  expect(appended.html).not.toContain("<img");
  expect(appended.text).toContain("because you subscribed to moshcode-users");
  const plain = composeNewsletter({ ...base, body: "A\n\n{{cta}}\n\nB" }, opts);
  expect(plain.text).not.toContain("{{cta}}");
  expect(plain.html).not.toContain("{{cta}}");
});

test("a tracked A/B send: crawlproof unsubscribes first, variants per person, resumable, paced", async () => {
  const fake = fakeSmtp();
  const port = await fake.listen();
  try {
    subscribe("moshcode-users", ["one", "two", "three", "four", "gone"].map((x) => ({ email: `${x}@example.com` })));
    createNewsletter({ id: "moshcode-001", subject: "Subject A", subjectB: "Subject B", ctaSet: "default", service: "moshcode", body: "# News\n\nWe shipped [it](https://moshcode.com/it).\n\n{{cta}}", list: "moshcode-users" });
    const crawlproof = fakeCrawlproof([{ type: "unsubscribe", email: "GONE@example.com", m: "old", c: "aug", at: "2026-09-20T00:00:00.000Z" }]);
    const sleeps: number[] = [];
    const common = { server: smtp(port), tracking, fetcher: crawlproof.fetcher, paceMs: 1000, sleep: async (ms: number) => void sleeps.push(ms) };

    const first = await sendNewsletter("moshcode-001", { ...common, limit: 2 });
    expect(readContacts().contacts.find((c) => c.id === "gone@example.com")?.optedOut).toBe(true);
    expect(crawlproof.calls[0]?.auth).toBe(`Bearer ${SECRET}`);
    expect(crawlproof.calls[0]?.url).toContain("https://crawlproof.test/api/v1/tracking/0123456789abcdef01234567/events?since=");
    expect(crawlproof.calls[0]?.url).toContain("type=unsubscribe");
    expect(first.audience).toBe(4);
    expect(first.sent).toHaveLength(2);
    expect(first.remaining).toBe(2);
    expect(first.status).toBe("sending");
    expect(first.variants).toHaveLength(8);
    expect(Object.values(first.split).reduce((a, b) => a + b, 0)).toBe(4);
    expect(sleeps).toEqual([1000]);
    // The next pull asks only for what is new.
    await sendNewsletter("moshcode-001", common);
    expect(crawlproof.calls[1]?.url).toContain(`since=${encodeURIComponent("2026-09-20T00:00:00.000Z")}`);
    const third = await sendNewsletter("moshcode-001", common);
    expect(third.sent).toEqual([]);
    expect(third.alreadySent).toBe(4);
    expect(requireNewsletter("moshcode-001").status).toBe("sent");
    expect(fake.messages).toHaveLength(4);

    const variants = variantsFor(requireNewsletter("moshcode-001"));
    const ledger = readNewsletters().deliveries["moshcode-001"]!;
    expect(Object.keys(ledger).sort()).toEqual(["four@example.com", "one@example.com", "three@example.com", "two@example.com"]);
    expect(new Set(Object.values(ledger).map((d) => d.msgId)).size).toBe(4);
    for (const [email, delivery] of Object.entries(ledger)) {
      const variant = variants[variantIndex("moshcode-001", email, 8)]!;
      expect(delivery).toMatchObject({ state: "sent", variant: variant.key, subjectKey: variant.subjectKey, cta: variant.cta?.label });
      const data = fake.messages.find((m) => m.rcpt[0] === email)!.data;
      expect(data).toContain(`Subject: ${variant.subject}`);
      expect(data).toContain(`o.png?m=${delivery.msgId}&amp;c=moshcode-001&amp;v=${variant.key}`);
      expect(data).toContain(`List-Unsubscribe: <${trackedUnsubscribeUrl(tracking, { m: delivery.msgId!, c: "moshcode-001", email })}>`);
      expect(data).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
      expect(data).toContain("an account at moshcode");
      expect(data).not.toContain("example.com/u/");
    }
    expect(readOutreach().sent.filter((row) => row.ok)).toHaveLength(4);
  } finally {
    await fake.close();
  }
});

test("a crawlproof outage stops a tracked send before anyone is mailed; --max-per-day overrides the cap", async () => {
  const fake = fakeSmtp();
  const port = await fake.listen();
  try {
    subscribe("moshcode-users", ["a", "b", "c"].map((x) => ({ email: `${x}@example.com` })));
    createNewsletter({ id: "i1", subject: "S", body: "b", list: "moshcode-users" });
    await expect(sendNewsletter("i1", { server: smtp(port), tracking, fetcher: fakeCrawlproof([], { status: 503 }).fetcher })).rejects.toThrow(/crawlproof events: 503\); not sending/);
    expect(fake.messages).toHaveLength(0);
    expect(readNewsletters().deliveries.i1).toBeUndefined();

    const settings = loadSettings();
    settings.outreach.maxEmailsPerDay = 1;
    saveSettings(settings);
    const ok = fakeCrawlproof([]).fetcher;
    const capped = await sendNewsletter("i1", { server: smtp(port), tracking, fetcher: ok });
    expect(capped.sent).toHaveLength(1);
    const raised = await sendNewsletter("i1", { server: smtp(port), tracking, fetcher: ok, maxPerDay: 10 });
    expect(raised.sent).toHaveLength(2);
    expect(raised.status).toBe("sent");
  } finally {
    await fake.close();
  }
});

test("--to: one tracked test copy as variant A, outside the ledger; an opted-out address is refused", async () => {
  const fake = fakeSmtp();
  const port = await fake.listen();
  try {
    subscribe("moshcode-users", [{ email: "one@example.com" }]);
    createNewsletter({ id: "moshcode-001", subject: "Subject A", subjectB: "Subject B", ctaSet: "default", body: "Hi {{cta}}", list: "moshcode-users" });
    const lines: string[] = [];
    const copy = await sendNewsletter("moshcode-001", { server: smtp(port), tracking, test: "owner@profullstack.com", log: (line) => lines.push(line) });
    expect(copy.sent).toEqual(["owner@profullstack.com"]);
    expect(lines.some((line) => line.includes("as variant A"))).toBe(true);
    const data = fake.messages[0]!.data;
    expect(data).toContain("Subject: [test] Subject A");
    expect(data).toContain("Book a demo");
    expect(data).toContain("&amp;v=A");
    expect(data).toContain(`${BASE}/u?`);
    expect(readNewsletters().deliveries["moshcode-001"]).toBeUndefined();
    expect(requireNewsletter("moshcode-001").status).toBe("draft");

    const { fetcher } = fakeCrawlproof([{ type: "unsubscribe", email: "owner@profullstack.com", at: "2026-09-24T00:00:00.000Z" }]);
    expect((await syncTrackingUnsubscribes(tracking, { fetcher })).optedOut).toEqual(["owner@profullstack.com"]);
    await expect(sendNewsletter("moshcode-001", { server: smtp(port), tracking, test: "owner@profullstack.com" })).rejects.toThrow(/opted out/);
  } finally {
    await fake.close();
  }
});

test("events follow `next` as an absolute URL; an unsubscribe without an email is found by msgId", async () => {
  subscribe("moshcode-users", [{ email: "one@example.com" }, { email: "two@example.com" }]);
  createNewsletter({ id: "i1", subject: "S", body: "b", list: "moshcode-users" });
  const file = readNewsletters();
  file.deliveries.i1 = { "one@example.com": { state: "sent", at: "2026-09-21T00:00:00.000Z", to: "one@example.com", msgId: "m-one", variant: "A" } };
  (await import("../src/store/newsletters.ts")).writeNewsletters(file);
  const events: TrackingEvent[] = [
    { type: "unsubscribe", m: "m-one", c: "i1", at: "2026-09-22T00:00:00.000Z" },
    ...Array.from({ length: 5 }, (_, i) => ({ type: "unsubscribe", email: `stranger${i}@example.com`, at: `2026-09-23T00:00:0${i}.000Z` })),
  ];
  const crawlproof = fakeCrawlproof(events, { pageSize: 2 });
  expect(await fetchTrackingEvents(tracking, { fetcher: crawlproof.fetcher })).toHaveLength(6);
  expect(crawlproof.calls).toHaveLength(3);
  expect(crawlproof.calls[1]?.url).toContain("cursor=2");
  const synced = await syncTrackingUnsubscribes(tracking, { fetcher: fakeCrawlproof(events).fetcher });
  expect(synced.optedOut).toContain("one@example.com");
  expect(synced.optedOut).toHaveLength(6);
  expect(recipients({ list: "moshcode-users" }).map((c) => c.id)).toEqual(["two@example.com"]);
  expect(readNewsletters().trackingSince).toBe("2026-09-23T00:00:04.000Z");
});

test("stats join events to variants by msgId: human opens, all opens, human clicks, CTR, unsubscribes, a leader", () => {
  const d = (msgId: string, variant: string, state: "sent" | "failed" = "sent") => ({ state, at: "2026-09-24T00:00:00.000Z", to: `${msgId}@x.co`, msgId, variant, subjectKey: variant === "A" ? "A" : "B", cta: "Book a demo" });
  const deliveries = { a1: d("a1", "A"), a2: d("a2", "A"), b1: d("b1", "B"), b2: d("b2", "B"), f1: d("f1", "B", "failed") };
  const at = "2026-09-24T01:00:00.000Z";
  const events: TrackingEvent[] = [
    { type: "open", m: "a1", at },
    { type: "open", m: "a1", at },
    { type: "open", m: "a2", machine: true, at },
    { type: "open", m: "b1", at },
    { type: "click", m: "b1", url: "https://profullstack.com/book", at },
    { type: "click", m: "b1", url: "https://profullstack.com/book", at },
    { type: "click", m: "a2", machine: true, at },
    { type: "unsubscribe", m: "b2", at },
    { type: "open", m: "test-copy", at },
  ];
  const stats = newsletterStats("i1", events, deliveries);
  expect(stats.rows).toEqual([
    { variant: "A", subjectKey: "A", cta: "Book a demo", sent: 2, opens: 1, opensTotal: 2, clicks: 0, ctr: 0, unsubscribes: 0 },
    { variant: "B", subjectKey: "B", cta: "Book a demo", sent: 2, opens: 1, opensTotal: 1, clicks: 1, ctr: 0.5, unsubscribes: 1 },
  ]);
  expect(stats).toMatchObject({ leader: "B", basis: "clicks" });
  expect(newsletterStats("i1", events.filter((e) => e.type === "open"), deliveries)).toMatchObject({ leader: "A", basis: "opens" });
  expect(newsletterStats("i1", [], deliveries).leader).toBeNull();
});

test("a line past 998 octets goes quoted-printable, and decodes back to itself", () => {
  const long = `<p>${"x".repeat(1200)} = done é</p>\n.dot line `;
  const encoded = quotedPrintable(long);
  for (const line of encoded.split("\n")) expect(line.length).toBeLessThanOrEqual(76);
  const decoded = Buffer.from(
    encoded.replace(/=\n/g, "").replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))),
    "latin1",
  ).toString("utf8");
  expect(decoded).toBe(long);
  const mime = buildMime({ id: "t", host: "h", port: 25, secure: "none", user: "", from: "a@b.c" }, { to: ["d@e.f"], subject: "s", text: "short", html: long }, "<id@b.c>");
  expect(mime).toContain("Content-Transfer-Encoding: quoted-printable");
  expect(mime).toContain("Content-Transfer-Encoding: 8bit");
});

test("settings: tracking off by default, the default CTA set, copied rather than shared", () => {
  const settings = loadSettings();
  expect(settings.newsletter.trackingId).toBe("");
  expect(settings.newsletter.paceMs).toBe(1000);
  expect(settings.newsletter.ctaSets.default?.map((cta) => cta.label)).toEqual(["Book a demo", "Schedule a call", "See our plans", "Support us"]);
  settings.newsletter.ctaSets.default!.push({ label: "x", url: "https://x" });
  expect(loadSettings().newsletter.ctaSets.default).toHaveLength(4);
});

// ---------------------------------------------------------------- fail closed on myna cloud too

/** A signed-in install whose myna cloud unsubscribe inbox answers 503. */
async function cloudDown(): Promise<() => void> {
  const { saveSession } = await import("../src/store/cloud.ts");
  const { writeNewsletters } = await import("../src/store/newsletters.ts");
  saveSession({ server: "https://myna.test/api", email: "me@example.com", token: "tok", since: new Date().toISOString() });
  const file = readNewsletters();
  file.inbox = { id: "INBOXINBOXINBOX1", server: "https://myna.test/api" };
  writeNewsletters(file);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

test("a failed myna cloud pull stops a list send before anyone is mailed, tracked or not", async () => {
  const restore = await cloudDown();
  const fake = fakeSmtp();
  const port = await fake.listen();
  try {
    subscribe("moshcode-users", [{ email: "one@example.com" }, { email: "two@example.com" }]);
    createNewsletter({ id: "i1", subject: "S", body: "b", list: "moshcode-users" });
    await expect(sendNewsletter("i1", { server: smtp(port), tracking: null })).rejects.toThrow(/^Could not read unsubscribes from myna cloud \(.*503.*\); not sending until they are applied\.$/);
    // With crawlproof working, the cloud failure still stops it.
    await expect(sendNewsletter("i1", { server: smtp(port), tracking, fetcher: fakeCrawlproof([]).fetcher })).rejects.toThrow(/myna cloud/);
    // Both down: both named.
    await expect(sendNewsletter("i1", { server: smtp(port), tracking, fetcher: fakeCrawlproof([], { status: 503 }).fetcher })).rejects.toThrow(/myna cloud .* or crawlproof \(crawlproof events: 503\)/);
    expect(fake.messages).toHaveLength(0);
    expect(readNewsletters().deliveries.i1).toBeUndefined();
    expect(requireNewsletter("i1").status).toBe("draft");
  } finally {
    restore();
    await fake.close();
  }
});

test("the daemon fails closed too: a due issue is not sent, and the idle pull reports the failure", async () => {
  const restore = await cloudDown();
  const fake = fakeSmtp();
  const port = await fake.listen();
  try {
    subscribe("moshcode-users", [{ email: "one@example.com" }]);
    createNewsletter({ id: "due", subject: "Due", body: "d", list: "moshcode-users", scheduledFor: new Date(Date.now() - 60_000).toISOString() });
    const { runDueNewsletters } = await import("../src/core/newsletter.ts");
    await expect(runDueNewsletters(new Date(), { server: smtp(port), tracking: null })).rejects.toThrow(/myna cloud/);
    expect(fake.messages).toHaveLength(0);
    expect(requireNewsletter("due").status).toBe("scheduled");

    const { builtinJobs } = await import("../src/core/daemon.ts");
    const job = builtinJobs(() => undefined, 1000).find((entry) => entry.id === "newsletter")!;
    await expect(job.run()).rejects.toThrow(/not sending until they are applied/);
    expect(fake.messages).toHaveLength(0);
    // With nothing scheduled, the job's own pull still fails loudly rather than quietly.
    const { writeNewsletters } = await import("../src/store/newsletters.ts");
    const file = readNewsletters();
    file.newsletters = [];
    writeNewsletters(file);
    await expect(job.run()).rejects.toThrow(/Could not read unsubscribes from myna cloud/);
  } finally {
    restore();
    await fake.close();
  }
});

test("a --to test copy still goes out when a pull fails, with a warning", async () => {
  const restore = await cloudDown();
  const fake = fakeSmtp();
  const port = await fake.listen();
  try {
    subscribe("moshcode-users", [{ email: "one@example.com" }]);
    createNewsletter({ id: "i1", subject: "S", body: "b", list: "moshcode-users" });
    const lines: string[] = [];
    const copy = await sendNewsletter("i1", { server: smtp(port), tracking, fetcher: fakeCrawlproof([]).fetcher, test: "owner@profullstack.com", log: (line) => lines.push(line) });
    expect(copy.sent).toEqual(["owner@profullstack.com"]);
    expect(fake.messages).toHaveLength(1);
    expect(lines.some((line) => line.startsWith("warning: could not read unsubscribes from myna cloud") && line.includes("a list send would stop here"))).toBe(true);
    for (const line of lines) expect(line).not.toContain("\u2014");
  } finally {
    restore();
    await fake.close();
  }
});

test("the newest unsubscribe or re-subscribe wins across myna cloud and crawlproof, whichever arrives first", async () => {
  const { saveSession } = await import("../src/store/cloud.ts");
  const { writeNewsletters, tokenFor } = await import("../src/store/newsletters.ts");
  const { syncAllUnsubscribes } = await import("../src/core/newsletter.ts");
  saveSession({ server: "https://myna.test/api", email: "me@example.com", token: "tok", since: new Date().toISOString() });
  const file = readNewsletters();
  file.inbox = { id: "INBOXINBOXINBOX1", server: "https://myna.test/api" };
  writeNewsletters(file);
  subscribe("moshcode-users", ["ada", "bob", "cy", "di"].map((x) => ({ email: `${x}@example.com` })));
  const token = (who: string): string => tokenFor(`${who}@example.com`);
  let cloudRows: { token: string; at: string; state: "unsubscribed" | "resubscribed" }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ ok: true, unsubscribes: cloudRows })) as unknown as typeof fetch;
  const out = (who: string): boolean => Boolean(readContacts().contacts.find((c) => c.id === `${who}@example.com`)?.optedOut);
  try {
    // One pull, both sources: ada unsubscribed through crawlproof at 10:00, re-subscribed on the cloud page at 11:00.
    // bob re-subscribed on the cloud page at 10:00 (after an earlier cloud unsubscribe), then unsubscribed through crawlproof at 11:00.
    cloudRows = [
      { token: token("bob"), at: "2026-09-24T09:00:00.000Z", state: "unsubscribed" },
      { token: token("bob"), at: "2026-09-24T10:00:00.000Z", state: "resubscribed" },
      { token: token("ada"), at: "2026-09-24T11:00:00.000Z", state: "resubscribed" },
    ];
    await syncAllUnsubscribes({
      tracking,
      fetcher: fakeCrawlproof([
        { type: "unsubscribe", email: "ada@example.com", at: "2026-09-24T10:00:00.000Z" },
        { type: "unsubscribe", email: "bob@example.com", at: "2026-09-24T11:00:00.000Z" },
      ]).fetcher,
    });
    expect(out("ada")).toBe(false);
    expect(out("bob")).toBe(true);

    // Across pulls: cy re-subscribes on the cloud page at 12:00; crawlproof's older 11:30 unsubscribe arrives a pull later.
    cloudRows = [{ token: token("cy"), at: "2026-09-24T12:00:00.000Z", state: "resubscribed" }];
    await syncAllUnsubscribes({ tracking, fetcher: fakeCrawlproof([]).fetcher });
    await syncAllUnsubscribes({ tracking, fetcher: fakeCrawlproof([{ type: "unsubscribe", email: "cy@example.com", at: "2026-09-24T11:30:00.000Z" }]).fetcher });
    expect(out("cy")).toBe(false);

    // The reverse: di unsubscribes through crawlproof at 13:00; an older 12:30 cloud re-subscribe arrives later and does not lift it.
    cloudRows = [];
    await syncAllUnsubscribes({ tracking, fetcher: fakeCrawlproof([{ type: "unsubscribe", email: "di@example.com", at: "2026-09-24T13:00:00.000Z" }]).fetcher });
    expect(out("di")).toBe(true);
    cloudRows = [{ token: token("di"), at: "2026-09-24T12:30:00.000Z", state: "resubscribed" }];
    await syncAllUnsubscribes({ tracking, fetcher: fakeCrawlproof([]).fetcher });
    expect(out("di")).toBe(true);
    expect(readNewsletters().optChanges["di@example.com"]).toEqual({ state: "unsubscribed", at: "2026-09-24T13:00:00.000Z", source: "crawlproof" });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("syncAllUnsubscribes tries every source and names each that failed", async () => {
  const restore = await cloudDown();
  try {
    const { syncAllUnsubscribes } = await import("../src/core/newsletter.ts");
    const result = await syncAllUnsubscribes({
      tracking,
      fetcher: fakeCrawlproof([{ type: "unsubscribe", email: "x@example.com", at: "2026-09-24T00:00:00.000Z" }]).fetcher,
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/^myna cloud \(/);
    // crawlproof still ran and applied its opt-out.
    expect(result.tracking?.optedOut).toEqual(["x@example.com"]);
    const none = await syncAllUnsubscribes({ tracking: null });
    expect(none.errors).toHaveLength(1);
    expect(none.tracking).toBeNull();
  } finally {
    restore();
  }
});
