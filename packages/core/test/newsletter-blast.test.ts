/**
 * What `myna newsletter status` reports, and the per-issue send lock: the rate
 * and ETA math, per-variant counts from the ledger, a lock that refuses a
 * second live sender and clears a dead one, and a daemon that leaves a locked
 * issue alone.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNewsletter, editNewsletter, readNewsletters, recordDelivery } from "../src/store/newsletters.ts";
import { runDueNewsletters, sendNewsletter, subscribe, variantIndex, variantsFor } from "../src/core/newsletter.ts";
import { formatDuration, sendProgress, sendRate } from "../src/core/newsletter-blast.ts";
import { acquireSendLock, liveSendLock, readSendLock, sendLockPath, SendLockedError } from "../src/core/newsletter-lock.ts";
import { loadSettings, saveSettings } from "../src/store/settings.ts";
import { stateDir } from "../src/util/paths.ts";

let dir = "";
const children: ChildProcess[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-blast-core-"));
  process.env.MYNA_HOME = dir;
  const settings = loadSettings();
  settings.newsletter.address = "Profullstack, Inc., 1 Main St, San Jose, CA 95112, USA";
  settings.newsletter.unsubscribeUrl = "https://example.com/u/{token}";
  saveSettings(settings);
});
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
});

function otherProcess(): number {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  children.push(child);
  return child.pid as number;
}

test("the rate is messages a minute over the recent window, and the ETA is what is left at that rate", () => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  // 11 sends, 6 s apart, ending now: 10 intervals in 60 s.
  const times = Array.from({ length: 11 }, (_, i) => now - (10 - i) * 6_000);
  const { ratePerMin, etaMs } = sendRate(times, 100, now);
  expect(ratePerMin).toBeCloseTo(10, 6);
  expect(etaMs).toBe(10 * 60_000);

  // Sends older than the window do not count.
  const old = [now - 3_600_000, now - 3_590_000];
  expect(sendRate([...old, ...times], 100, now).ratePerMin).toBeCloseTo(10, 6);
  expect(sendRate(old, 100, now)).toEqual({ ratePerMin: null, etaMs: null });
  expect(sendRate([now], 5, now)).toEqual({ ratePerMin: null, etaMs: null });
  expect(sendRate(times, 0, now).etaMs).toBe(0);

  // About 44 a minute, 6000 to go: a little over two hours.
  const steady = Array.from({ length: 45 }, (_, i) => now - (44 - i) * (60_000 / 44));
  const eta = sendRate(steady, 6000, now).etaMs as number;
  expect(formatDuration(eta)).toBe("2h 16m");
  expect(formatDuration(65_000)).toBe("1m 05s");
  expect(formatDuration(9_000)).toBe("9s");
});

test("status counts sent, failed, pending and remaining from the ledger, per variant", () => {
  const people = ["a", "b", "c", "d", "e", "f", "g", "h"].map((x) => ({ email: `${x}@example.com` }));
  subscribe("users", people);
  const n = createNewsletter({ id: "issue-1", subject: "One", subjectB: "Two", body: "Body", list: "users", ctaSet: null });
  const variants = variantsFor(n);
  expect(variants).toHaveLength(2);
  const variantOf = (email: string) => variants[variantIndex(n.id, email, variants.length)]!.key;
  const now = Date.parse("2026-09-24T12:00:00Z");
  const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000).toISOString();

  recordDelivery(n.id, "a@example.com", { state: "sent", at: at(30), to: "a@example.com", variant: variantOf("a@example.com") });
  recordDelivery(n.id, "b@example.com", { state: "sent", at: at(20), to: "b@example.com", variant: variantOf("b@example.com") });
  recordDelivery(n.id, "c@example.com", { state: "sent", at: at(10), to: "c@example.com", variant: variantOf("c@example.com") });
  recordDelivery(n.id, "d@example.com", { state: "failed", at: at(9), to: "d@example.com", error: "550", variant: variantOf("d@example.com") });
  recordDelivery(n.id, "e@example.com", { state: "failed", at: at(8), to: "e@example.com", error: "429", retryable: true, variant: variantOf("e@example.com") });
  recordDelivery(n.id, "f@example.com", { state: "pending", at: at(1), to: "f@example.com" });

  const p = sendProgress(n.id, { now });
  expect(p.audience).toBe(8);
  expect(p.sent).toBe(3);
  expect(p.failed).toBe(1);
  expect(p.pending).toBe(1);
  // g, h (never tried) and e (a retryable failure).
  expect(p.remaining).toBe(3);
  // Three sends 10 s apart: 2 in 20 s is 6 a minute; 3 to go is 30 s.
  expect(p.ratePerMin).toBeCloseTo(6, 6);
  expect(p.etaMs).toBe(30_000);
  expect(p.running).toBeNull();
  expect(p.lastSentAt).toBe(at(10));

  const byKey = Object.fromEntries(p.variants.map((v) => [v.key, v]));
  for (const key of Object.keys(byKey)) {
    const expected = (emails: string[]) => emails.filter((e) => variantOf(e) === key).length;
    expect(byKey[key]!.sent).toBe(expected(["a@example.com", "b@example.com", "c@example.com"]));
    expect(byKey[key]!.failed).toBe(expected(["d@example.com"]));
    expect(byKey[key]!.due).toBe(expected(["e@example.com", "g@example.com", "h@example.com"]));
  }
  expect(p.variants.reduce((sum, v) => sum + v.sent, 0)).toBe(3);
});

test("with a live lock, status shows it running and aims the ETA at this run's batch", () => {
  subscribe("users", ["a", "b", "c", "d"].map((x) => ({ email: `${x}@example.com` })));
  createNewsletter({ id: "issue-2", subject: "One", body: "Body", list: "users" });
  const now = Date.now();
  mkdirSync(stateDir(), { recursive: true });
  const pid = otherProcess();
  writeFileSync(sendLockPath("issue-2"), JSON.stringify({ pid, id: "issue-2", startedAt: new Date(now - 60_000).toISOString(), batch: 3 }));
  recordDelivery("issue-2", "a@example.com", { state: "sent", at: new Date(now - 20_000).toISOString(), to: "a@example.com" });
  recordDelivery("issue-2", "b@example.com", { state: "sent", at: new Date(now - 10_000).toISOString(), to: "b@example.com" });
  const p = sendProgress("issue-2", { now });
  expect(p.running?.pid).toBe(pid);
  expect(p.sentThisRun).toBe(2);
  expect(p.remaining).toBe(2);
  // 6 a minute, and the batch of 3 has 1 left: 10 s.
  expect(p.etaMs).toBe(10_000);
});

test("the send lock refuses a second live holder, is re-entrant, clears a dead or reused pid, and is released", () => {
  const release = acquireSendLock("issue-3", { batch: 5 });
  expect(readSendLock("issue-3")?.pid).toBe(process.pid);
  expect(readSendLock("issue-3")?.batch).toBe(5);
  // The same process again: a no-op whose release leaves the outer lock alone.
  acquireSendLock("issue-3")();
  expect(existsSync(sendLockPath("issue-3"))).toBe(true);
  release();
  expect(existsSync(sendLockPath("issue-3"))).toBe(false);

  const pid = otherProcess();
  writeFileSync(sendLockPath("issue-3"), JSON.stringify({ pid, id: "issue-3", startedAt: new Date().toISOString() }));
  expect(() => acquireSendLock("issue-3")).toThrow(SendLockedError);
  expect(liveSendLock("issue-3")?.pid).toBe(pid);

  // The pid is alive but runs something else now: the lock is stale.
  writeFileSync(sendLockPath("issue-3"), JSON.stringify({ pid, id: "issue-3", startedAt: new Date().toISOString(), cmdline: "myna newsletter _run issue-3 --yes" }));
  if (existsSync(`/proc/${pid}/cmdline`)) expect(liveSendLock("issue-3")).toBeNull();

  // A dead pid: cleared, and the lock is ours.
  writeFileSync(sendLockPath("issue-3"), JSON.stringify({ pid: 2 ** 22 + 999, id: "issue-3", startedAt: new Date().toISOString() }));
  const mine = acquireSendLock("issue-3");
  expect(JSON.parse(readFileSync(sendLockPath("issue-3"), "utf8")).pid).toBe(process.pid);
  mine();
});

test("a list send takes the lock, and the daemon skips an issue another process is sending", async () => {
  subscribe("users", [{ email: "a@example.com" }]);
  createNewsletter({ id: "issue-4", subject: "One", body: "Body", list: "users" });
  editNewsletter("issue-4", { scheduledFor: new Date(Date.now() - 60_000).toISOString() });
  mkdirSync(stateDir(), { recursive: true });
  const pid = otherProcess();
  writeFileSync(sendLockPath("issue-4"), JSON.stringify({ pid, id: "issue-4", startedAt: new Date().toISOString() }));

  await expect(sendNewsletter("issue-4", {})).rejects.toThrow(/already being sent by pid/);
  // The daemon neither sends it nor fails on it.
  expect(await runDueNewsletters(new Date())).toEqual([]);
  expect(readNewsletters().deliveries["issue-4"]).toBeUndefined();
  // A dry run and a test copy never need the lock.
  expect((await sendNewsletter("issue-4", { dryRun: true })).wouldSend).toEqual(["a@example.com"]);
});
