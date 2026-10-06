import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Account } from "../src/net/types.ts";
import { pickRotation, recordRotation, type RotationState } from "../src/core/rotate.ts";
import { slotsFor } from "../src/core/poster.ts";
import { saveAccount } from "../src/store/accounts.ts";
import { recordHistory } from "../src/store/history.ts";
import { enqueue } from "../src/store/queue.ts";

const acct = (id: string): Account => ({ id, network: id.split(":")[0], handle: "x", addedAt: "", creds: {}, meta: {} }) as Account;
const blogs = [acct("htmlblog:a"), acct("devto:chovy"), acct("bl0ggers:chovy")];
const NOW = Date.parse("2026-10-07T12:00:00Z");
const HOUR = 3600_000;
const empty = (): RotationState => ({ cursor: {}, picks: [] });

function run(state: RotationState, opts: { later?: Record<string, number>; mode?: "cycle" | "random"; random?: () => number } = {}) {
  return pickRotation({
    accounts: blogs,
    mode: opts.mode ?? "cycle",
    state,
    now: NOW,
    slot: (a) => opts.later?.[a.id] ?? NOW,
    random: opts.random,
  });
}

test("cycle takes turns in id order, per target group, across runs", () => {
  let state = empty();
  const got: string[] = [];
  for (let i = 0; i < 4; i++) {
    const pick = run(state);
    got.push(pick.account.id);
    state = recordRotation(state, pick, "cycle", `post ${i}`, NOW);
  }
  expect(got).toEqual(["bl0ggers:chovy", "devto:chovy", "htmlblog:a", "bl0ggers:chovy"]);
  expect(state.picks.map((p) => p.text)).toEqual(["post 0", "post 1", "post 2", "post 3"]);
});

test("an account the planner would hold is skipped; its turn goes to the next that goes now", () => {
  const pick = run(empty(), { later: { "bl0ggers:chovy": NOW + 20 * HOUR } });
  expect(pick.account.id).toBe("devto:chovy");
  expect(pick.why).toBe("room");
  expect(pick.at).toBe(NOW);
});

test("when nobody can take it now, the earliest planner slot wins", () => {
  const pick = run(empty(), { later: { "bl0ggers:chovy": NOW + 20 * HOUR, "devto:chovy": NOW + 3 * HOUR, "htmlblog:a": NOW + 9 * HOUR } });
  expect(pick.account.id).toBe("devto:chovy");
  expect(pick.why).toBe("cap");
  expect(pick.at).toBe(NOW + 3 * HOUR);
});

test("random picks among the accounts that go now only", () => {
  const later = { "devto:chovy": NOW + HOUR };
  expect(run(empty(), { mode: "random", later, random: () => 0 }).account.id).toBe("bl0ggers:chovy");
  expect(run(empty(), { mode: "random", later, random: () => 0.99 }).account.id).toBe("htmlblog:a");
});

// The 0.44.0 bug, end to end through the planner: bluesky had posted little
// in the last 24h but had a full day QUEUED, so counting past posts called it
// free and the planner then held the post to the next day.
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-rotate-"));
  process.env.MYNA_HOME = dir;
});
afterEach(() => {
  delete process.env.MYNA_HOME;
  rmSync(dir, { recursive: true, force: true });
});

test("slotsFor counts what is queued, not only what was posted", () => {
  const now = Date.now();
  const bsky = acct("bluesky:me");
  const masto = acct("mastodon:me");
  saveAccount(bsky);
  saveAccount(masto);
  // Bluesky posted 30 minutes ago, so its next slot is past the network gap,
  // and the stretch up to that slot is already full of queued posts (more
  // than any daily cap). Past posts alone (0.44.0) call it free.
  recordHistory([{ at: new Date(now - 30 * 60_000).toISOString(), accountId: "bluesky:me", network: "bluesky", handle: "me", ok: true, text: "recent" }]);
  for (let i = 0; i < 40; i++) {
    enqueue({ scheduledFor: new Date(now + (i + 1) * 2 * 60_000).toISOString(), targets: ["bluesky:me"], text: `booked ${i}` });
  }
  const slots = slotsFor([bsky, masto], { text: "the new post" }, { now, front: true });
  expect(slots.get("mastodon:me")).toBe(now);
  expect(slots.get("bluesky:me")!).toBeGreaterThan(now);
  const pick = pickRotation({ accounts: [bsky, masto], mode: "cycle", state: empty(), now, slot: (a) => slots.get(a.id)! });
  expect(pick.account.id).toBe("mastodon:me");
});
