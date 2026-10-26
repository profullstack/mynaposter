import { test, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLinks, headline, linksSubject, loadLinksState, renderLinksHtml, renderLinksText, runLinks, DEFAULT_LINKS, LINKS_MAX_WINDOW_MS } from "../src/core/links.ts";
import { effectiveLinks, loadSettings } from "../src/store/settings.ts";
import type { HistoryEntry } from "../src/store/history.ts";

// Nothing here may read the machine's own ~/.config/myna.
let home = "";
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "myna-links-"));
  process.env.MYNA_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
});

const NOW = new Date("2026-10-26T05:00:00Z");
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString();
const entry = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  at: hoursAgo(1),
  accountId: "bluesky:chovy",
  network: "bluesky",
  handle: "chovy",
  text: "hello world",
  ok: true,
  url: "https://bsky.app/profile/chovy/post/1",
  ...over,
});

test("lists live posts with links in the window, newest first, by account", () => {
  const r = buildLinks({
    now: NOW,
    history: [
      entry({ at: hoursAgo(2), url: "https://bsky.app/p/2" }),
      entry({ at: hoursAgo(1), accountId: "mastodon:chovy", network: "mastodon", url: "https://mastodon.social/@chovy/9" }),
      entry({ at: hoursAgo(3), url: "https://bsky.app/p/3" }),
      entry({ at: hoursAgo(1), ok: false, url: undefined, error: "rate limited" }),
      entry({ at: hoursAgo(30), url: "https://bsky.app/old" }),
      entry({ at: hoursAgo(1), accountId: "tsbb:member", network: "tsbb", url: undefined }),
    ],
  });
  expect(r.posts.map((p) => p.url)).toEqual(["https://mastodon.social/@chovy/9", "https://bsky.app/p/2", "https://bsky.app/p/3"]);
  expect(r.accounts.map((a) => [a.accountId, a.posts.length])).toEqual([["bluesky:chovy", 2], ["mastodon:chovy", 1]]);
  // Sent, but the network gave no link back.
  expect(r.unlinked).toBe(1);
});

test("the window starts at the last send, and never reaches back more than a week", () => {
  const history = [entry({ at: hoursAgo(5) }), entry({ at: hoursAgo(40), url: "https://bsky.app/p/40" }), entry({ at: hoursAgo(24 * 9), url: "https://bsky.app/p/9d" })];
  expect(buildLinks({ now: NOW, since: new Date(hoursAgo(48)), history }).posts).toHaveLength(2);
  expect(buildLinks({ now: NOW, since: new Date(hoursAgo(4)), history }).posts).toHaveLength(0);
  const far = buildLinks({ now: NOW, since: new Date(0), history });
  expect(new Date(far.since).getTime()).toBe(NOW.getTime() - LINKS_MAX_WINDOW_MS);
  expect(far.posts.map((p) => p.url)).not.toContain("https://bsky.app/p/9d");
});

test("headline: the title, else the first real line, trimmed", () => {
  expect(headline({ title: "Shipping notes", text: "body" })).toBe("Shipping notes");
  expect(headline({ text: "\n\n  First line here\nsecond" })).toBe("First line here");
  expect(headline({ text: "x".repeat(200) }, 20)).toBe(`${"x".repeat(19)}…`);
});

test("the mail lists every link, and escapes what it shows", () => {
  const r = buildLinks({ now: NOW, history: [entry({ text: "<b>bold</b> & more", url: "https://bsky.app/p/1?a=1&b=2" })] });
  expect(linksSubject(r, "UTC")).toBe("myna — Monday, October 26: 1 post live");
  const text = renderLinksText(r, "UTC");
  expect(text).toContain("bluesky:chovy (1)");
  expect(text).toContain("https://bsky.app/p/1?a=1&b=2");
  const html = renderLinksHtml(r, "UTC");
  expect(html).toContain('href="https://bsky.app/p/1?a=1&amp;b=2"');
  expect(html).toContain("&lt;b&gt;bold&lt;/b&gt; &amp; more");
  expect(html).not.toContain("<b>bold</b>");
  const empty = buildLinks({ now: NOW, history: [] });
  expect(linksSubject(empty, "UTC")).toBe("myna — Monday, October 26: nothing posted");
  expect(renderLinksText(empty, "UTC")).toContain("Nothing went live in the last 24 hours.");
});

test("off by default, and the address falls back to the recap's", () => {
  expect(DEFAULT_LINKS.enabled).toBe(false);
  const settings = loadSettings();
  const withRecap = { ...settings, recap: { ...settings.recap, to: "me@example.com" } };
  expect(effectiveLinks(withRecap)).toMatchObject({ to: "me@example.com", toSource: "recap" });
  const own = { ...withRecap, links: { ...withRecap.links, to: "links@example.com" } };
  expect(effectiveLinks(own)).toMatchObject({ to: "links@example.com", toSource: "links.to" });
});

test("a send stamps the night, so the next window starts there and nothing is sent twice", async () => {
  // A stand-in for the `mail` CLI that keeps what it was given.
  const log = join(home, "mail.log");
  const cmd = join(home, "fake-mail");
  writeFileSync(cmd, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >> ${log}\nwhile [ $# -gt 0 ]; do [ "$1" = "--file" ] && cat "$2" >> ${log}; shift; done\n`);
  chmodSync(cmd, 0o755);
  const settings = { ...DEFAULT_LINKS, enabled: true, to: "me@example.com", at: "04:00", command: cmd };
  const history = [entry({ at: hoursAgo(2), url: "https://bsky.app/p/tonight" })];

  expect((await runLinks({ ...settings, enabled: false }, { now: NOW, history })).idle).toBe("not due");
  const turn = await runLinks(settings, { now: NOW, history });
  expect(turn.result).toMatchObject({ sent: true, count: 1 });
  expect(loadLinksState().lastSentAt).toBe(NOW.toISOString());
  const mail = readFileSync(log, "utf8");
  expect(mail).toContain("me@example.com");
  expect(mail).toContain("https://bsky.app/p/tonight");
  // Ten minutes later the daemon ticks again: already sent tonight.
  expect((await runLinks(settings, { now: new Date(NOW.getTime() + 600_000), history })).idle).toBe("not due");
  // A forced send now starts from the stamp, so last night's link is not repeated.
  const again = await runLinks(settings, { now: new Date(NOW.getTime() + 3_600_000), force: true, history });
  expect(again.result?.count).toBe(0);
});
