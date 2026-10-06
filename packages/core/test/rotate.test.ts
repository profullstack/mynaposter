import { test, expect } from "bun:test";
import type { Account } from "../src/net/types.ts";
import { pickRotation, recordRotation, type RotationState } from "../src/core/rotate.ts";

const acct = (id: string): Account => ({ id, network: id.split(":")[0], handle: "x", addedAt: "", creds: {}, meta: {} }) as Account;
const blogs = [acct("htmlblog:a"), acct("devto:chovy"), acct("bl0ggers:chovy")];
const NOW = Date.parse("2026-10-07T12:00:00Z");
const HOUR = 3600_000;
const empty = (): RotationState => ({ cursor: {}, picks: [] });

function run(state: RotationState, opts: { capped?: Record<string, number[]>; mode?: "cycle" | "random"; random?: () => number } = {}) {
  return pickRotation({
    accounts: blogs,
    mode: opts.mode ?? "cycle",
    state,
    now: NOW,
    bookings: new Map(Object.entries(opts.capped ?? {})),
    maxPerDay: () => 2,
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
  expect(Object.keys(state.cursor)).toEqual(["bl0ggers:chovy,devto:chovy,htmlblog:a"]);
});

test("an account at its daily cap is skipped; its turn goes to the next with room", () => {
  const full = { "bl0ggers:chovy": [NOW - 2 * HOUR, NOW - HOUR] }; // 2 of 2 today
  const pick = run(empty(), { capped: full });
  expect(pick.account.id).toBe("devto:chovy");
  expect(pick.why).toBe("room");
  expect(pick.upNext?.id).toBe("htmlblog:a");
});

test("when every account is capped, the one that frees up first gets it", () => {
  const capped = {
    "bl0ggers:chovy": [NOW - 2 * HOUR, NOW - HOUR],
    "devto:chovy": [NOW - 20 * HOUR, NOW - 10 * HOUR], // frees first: 4h from now
    "htmlblog:a": [NOW - 5 * HOUR, NOW - 3 * HOUR],
  };
  const pick = run(empty(), { capped });
  expect(pick.account.id).toBe("devto:chovy");
  expect(pick.why).toBe("cap");
});

test("random picks among the accounts with room only", () => {
  const full = { "devto:chovy": [NOW - 2 * HOUR, NOW - HOUR] };
  expect(run(empty(), { mode: "random", capped: full, random: () => 0 }).account.id).toBe("bl0ggers:chovy");
  expect(run(empty(), { mode: "random", capped: full, random: () => 0.99 }).account.id).toBe("htmlblog:a");
});

test("a single target always gets the post and has no 'next'", () => {
  const pick = pickRotation({ accounts: [blogs[0]], mode: "cycle", state: empty(), now: NOW, bookings: new Map(), maxPerDay: () => undefined });
  expect(pick.account.id).toBe("htmlblog:a");
  expect(pick.upNext).toBeUndefined();
});
