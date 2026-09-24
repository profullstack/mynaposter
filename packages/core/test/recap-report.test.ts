import { test, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRecap,
  recapAddress,
  renderRecapHtml,
  renderRecapText,
  resolveRecapSettings,
  sendRecap,
  DEFAULT_RECAP,
  RECAP_DAYS,
} from "../src/core/recap.ts";
import { effectiveRecap, loadSettings, saveSettings } from "../src/store/settings.ts";
import type { HistoryEntry } from "../src/store/history.ts";
import type { QueuedPost } from "../src/store/queue.ts";

// 0.33.0: the nightly summary is on by default, and drawn as a report.

let home = "";
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "myna-recap-report-"));
  process.env.MYNA_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
});

const NOW = new Date("2026-09-06T18:00:00Z");
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString();
const hoursAhead = (n: number) => new Date(NOW.getTime() + n * 3_600_000).toISOString();

const entry = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  at: hoursAgo(1),
  accountId: "bluesky:chovy",
  network: "bluesky",
  handle: "chovy",
  text: "hello",
  ok: true,
  ...over,
});

const queued = (over: Partial<QueuedPost> = {}): QueuedPost => ({
  id: "abc123",
  createdAt: hoursAgo(2),
  scheduledFor: hoursAhead(3),
  targets: ["mastodon:chovy"],
  text: "later",
  status: "pending",
  ...over,
});

test("a new install gets the nightly summary on", () => {
  expect(resolveRecapSettings(undefined).enabled).toBe(true);
  expect(loadSettings().recap.enabled).toBe(true);
});

test("an old file's enabled:false with no address was the old default, not a choice", () => {
  // Every save wrote the whole settings file, so this is what an install that
  // never touched the recap has on disk.
  expect(resolveRecapSettings({ enabled: false, to: "", at: "08:00", command: "mail" }).enabled).toBe(true);
});

test("an old file that was turned on and then off stays off", () => {
  // `recap on` refused to run without an address, so an address plus off is
  // somebody's decision.
  expect(resolveRecapSettings({ enabled: false, to: "me@example.com", at: "08:00", command: "mail" }).enabled).toBe(false);
});

test("once saved under the new default, off means off even with no address", () => {
  const settings = loadSettings();
  settings.recap.enabled = false;
  saveSettings(settings);
  expect(loadSettings().recap.enabled).toBe(false);
  expect(effectiveRecap().enabled).toBe(false);
});

test("the address falls back to the profile email, then the cloud login", () => {
  const base = { ...DEFAULT_RECAP };
  expect(recapAddress({ ...base, to: "a@x.com" }, { profile: "b@x.com" })).toEqual({ to: "a@x.com", source: "recap.to" });
  expect(recapAddress(base, { profile: "b@x.com", cloud: "c@x.com" })).toEqual({ to: "b@x.com", source: "profile" });
  expect(recapAddress(base, { profile: " ", cloud: "c@x.com" })).toEqual({ to: "c@x.com", source: "cloud" });
  expect(recapAddress(base, {})).toEqual({ to: "", source: "none" });

  const settings = loadSettings();
  settings.profile.email = "me@example.com";
  saveSettings(settings);
  expect(effectiveRecap()).toMatchObject({ enabled: true, to: "me@example.com", toSource: "profile" });
});

test("seven windows end now; the last is the sent tile and the one before is its delta", () => {
  const recap = buildRecap({
    now: NOW,
    history: [
      entry({ at: hoursAgo(1) }),
      entry({ at: hoursAgo(24) }), // exactly one window old: still this one
      entry({ at: hoursAgo(25) }),
      entry({ at: hoursAgo(26), accountId: "mastodon:chovy", network: "mastodon" }),
      entry({ at: hoursAgo(30), ok: false, error: "nope" }),
      entry({ at: hoursAgo(24 * 6 + 1) }),
      entry({ at: hoursAgo(24 * 8) }), // outside the chart
    ],
    queue: [],
    handoffs: [],
  });
  expect(recap.days).toHaveLength(RECAP_DAYS);
  expect(recap.days!.map((d) => d.sent)).toEqual([1, 0, 0, 0, 0, 2, 2]);
  expect(recap.days![RECAP_DAYS - 1]!.end).toBe(NOW.toISOString());
  expect(recap.sent).toBe(2);
  expect(recap.prev).toMatchObject({ sent: 2, failed: 1 });
});

test("channels group accounts by network, busiest first, with their own strip", () => {
  const recap = buildRecap({
    now: NOW,
    history: [
      entry({ accountId: "bluesky:a" }),
      entry({ accountId: "bluesky:b" }),
      entry({ accountId: "mastodon:chovy", network: "mastodon" }),
      entry({ accountId: "mastodon:chovy", network: "mastodon", at: hoursAgo(30) }),
      entry({ accountId: "mastodon:chovy", network: "mastodon", at: hoursAgo(31) }),
    ],
    queue: [queued({ targets: ["tsbb:me"] }), queued({ id: "later", targets: ["mastodon:chovy"], scheduledFor: hoursAhead(40) })],
    handoffs: [],
  });
  expect(recap.channels!.map((c) => c.network)).toEqual(["bluesky", "mastodon", "tsbb"]);
  expect(recap.channels![0]).toMatchObject({ sent: 2, prevSent: 0, accounts: ["bluesky:a", "bluesky:b"] });
  const mastodon = recap.channels![1]!;
  expect(mastodon).toMatchObject({ sent: 1, prevSent: 2, upcoming: 0, pending: 1 });
  expect(mastodon.strip.slice(-2)).toEqual([2, 1]);
  expect(recap.channels![2]).toMatchObject({ network: "tsbb", sent: 0, upcoming: 1, pending: 1 });
});

test("yesterday's queue and hand-offs are rebuilt from their own dates", () => {
  const recap = buildRecap({
    now: NOW,
    history: [entry()],
    queue: [
      queued({ id: "old", createdAt: hoursAgo(48) }), // pending then and now
      queued({ id: "new", createdAt: hoursAgo(2) }), // added today
      queued({ id: "went", createdAt: hoursAgo(48), status: "sent", scheduledFor: hoursAgo(3) }), // was pending then
      queued({ id: "gone", createdAt: hoursAgo(48), status: "sent", scheduledFor: hoursAgo(30) }), // out before then
      queued({ id: "late", createdAt: hoursAgo(48), scheduledFor: hoursAgo(5) }), // overdue from the last window
    ],
    handoffs: [
      { id: "h1", place: "HN", title: "old", text: "", steps: [], createdAt: hoursAgo(48) },
      { id: "h2", place: "HN", title: "done today", text: "", steps: [], createdAt: hoursAgo(48), doneAt: hoursAgo(2) },
      { id: "h3", place: "HN", title: "new", text: "", steps: [], createdAt: hoursAgo(1) },
    ],
  });
  expect(recap.pending).toBe(3);
  // tried in the window (1) + still overdue from it (1)
  expect(recap.prev).toMatchObject({ pending: 3, handoffs: 2, upcoming: 2 });
  expect(recap.handoffs).toHaveLength(2);
});

test("the HTML mail is a table report with the hand-offs as buttons and the off switch in it", () => {
  const recap = buildRecap({
    now: NOW,
    history: [entry(), entry({ ok: false, error: "rate <limited>" })],
    queue: [queued({ text: "<b>soon</b>" })],
    handoffs: [
      { id: "h1", place: "r/rust", title: "Reply to them", text: "", steps: [], createdAt: hoursAgo(3), cloudUrl: "https://mynaposter.com/handoff/abc" },
      { id: "h2", place: "Hacker News", title: "Local only", text: "", steps: [], createdAt: hoursAgo(3) },
    ],
  });
  const html = renderRecapHtml(recap, "UTC");
  expect(html).toContain('href="https://mynaposter.com/handoff/abc"');
  expect(html).toContain("Open card →");
  expect(html).toContain("myna handoff show h2");
  expect(html).toContain("myna recap off");
  expect(html).toContain("Every channel");
  expect(html).toContain("Posts sent, last 7 days");
  // Post text and errors are data, never markup.
  expect(html).toContain("&lt;b&gt;soon&lt;/b&gt;");
  expect(html).toContain("rate &lt;limited&gt;");
  expect(html).not.toContain("<b>soon</b>");
  // Email HTML: no stylesheet, no script, nothing fetched.
  expect(html).not.toMatch(/<script|<link|<style|<img/i);
});

test("the text part carries the change and the week too", () => {
  const recap = buildRecap({
    now: NOW,
    history: [entry(), entry({ at: hoursAgo(30) }), entry({ at: hoursAgo(31) })],
    queue: [],
    handoffs: [],
  });
  const text = renderRecapText(recap, "UTC");
  expect(text).toContain("Sent in the last 24 hours: 1 (−1 on the 24 hours before)");
  expect(text).toMatch(/Last 7 days: .* 2 · .* 1/);
});

const fakeMail = (script: string) => {
  const path = join(home, "fake-mail");
  writeFileSync(path, `#!/bin/sh\necho "$@" >> "${home}/calls"\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
};
const calls = () => readFileSync(join(home, "calls"), "utf8").trim().split("\n");
const empty = () => buildRecap({ now: NOW, history: [], queue: [], handoffs: [] });

test("the mail goes out with the HTML part when the mail command takes --html", async () => {
  const command = fakeMail("exit 0");
  const result = await sendRecap({ ...DEFAULT_RECAP, to: "me@example.com", command }, empty());
  expect(result).toMatchObject({ sent: true, html: true });
  expect(calls()[0]).toContain("--html");
});

test("a mail command without --html still gets the plain recap sent", async () => {
  const command = fakeMail('case "$*" in *--html*) echo "mail: unknown option: --html" >&2; exit 2;; esac; exit 0');
  const result = await sendRecap({ ...DEFAULT_RECAP, to: "me@example.com", command }, empty());
  expect(result).toMatchObject({ sent: true, html: false });
  expect(calls()).toHaveLength(2);
  expect(calls()[1]).not.toContain("--html");
});

test("any other mail failure is reported, not retried as text", async () => {
  const command = fakeMail('echo "smtp: auth failed" >&2; exit 1');
  const result = await sendRecap({ ...DEFAULT_RECAP, to: "me@example.com", command }, empty());
  expect(result.sent).toBe(false);
  expect(calls()).toHaveLength(1);
});
