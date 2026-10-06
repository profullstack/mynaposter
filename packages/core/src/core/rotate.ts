/**
 * `myna post <targets> --rotate`: one account per post, taking turns, instead
 * of every account at once. The point is the daily caps: a blog at its 4 a day
 * holds a post to tomorrow while the other blogs sit idle, so rotation hands
 * the post to the next account with room today.
 *
 *   cycle   round-robin over the targets (sorted by id), per target group,
 *           skipping accounts with no room today
 *   random  any account with room today
 *
 * When every account is at its cap, the pick is the one that frees up
 * first, and the post queues there as usual. Every pick is recorded, so the
 * cycle carries on across runs and `myna rotation` shows who got what.
 */
import type { Account } from "../net/types.ts";
import { readJson, writeJson } from "../util/json.ts";
import { ROTATION_FILE } from "../util/paths.ts";

export type RotateMode = "cycle" | "random";

export interface RotationPick {
  at: string;
  group: string;
  account: string;
  mode: RotateMode;
  /** How the pick went: "room" today, or the "cap" was full everywhere. */
  why: "room" | "cap";
  text: string;
}

export interface RotationState {
  /** Per target group (its sorted account ids, comma-joined): the next index. */
  cursor: Record<string, number>;
  picks: RotationPick[];
}

const PICK_LIMIT = 500;

export const loadRotation = (): RotationState => {
  const state = readJson<Partial<RotationState>>(ROTATION_FILE, {});
  return { cursor: state.cursor ?? {}, picks: state.picks ?? [] };
};
export const saveRotation = (state: RotationState): void =>
  writeJson(ROTATION_FILE, { cursor: state.cursor, picks: state.picks.slice(-PICK_LIMIT) });

export const rotationGroup = (accounts: Account[]): string => [...new Set(accounts.map((a) => a.id))].sort().join(",");

export interface PickInput {
  accounts: Account[];
  mode: RotateMode;
  state: RotationState;
  now: number;
  /**
   * When this post would go out on the account, per the planner itself
   * (poster's slotsFor: gaps, daily caps, the queue). Asking the planner is
   * the point: 0.44.0 counted past posts only, called an account with a full
   * day of queued posts "free", and the planner then held the post to the
   * next day.
   */
  slot: (account: Account) => number;
  random?: () => number;
}

export interface PickResult {
  account: Account;
  why: "room" | "cap";
  /** When it will go out (now, or the planner's later slot). */
  at: number;
  group: string;
  /** The cursor to store for the group after this pick (cycle mode). */
  nextCursor: number;
  /** Who is next in line after this pick, for the report. */
  upNext?: Account;
}

/** Choose the account for this post. Pure: state is read, not written. */
export function pickRotation(input: PickInput): PickResult {
  const order = [...new Map(input.accounts.map((a) => [a.id, a])).values()].sort((a, b) => a.id.localeCompare(b.id));
  if (!order.length) throw new Error("--rotate needs at least one target account.");
  const group = order.map((a) => a.id).join(",");
  const slots = new Map(order.map((a) => [a.id, input.slot(a)]));
  const at = (account: Account) => slots.get(account.id) ?? Number.POSITIVE_INFINITY;
  const start = ((input.state.cursor[group] ?? 0) % order.length + order.length) % order.length;
  const turn = order.map((_, i) => order[(start + i) % order.length]);
  const withRoom = turn.filter((a) => at(a) <= input.now);

  let account: Account;
  let why: "room" | "cap";
  if (withRoom.length) {
    why = "room";
    account = input.mode === "random" ? withRoom[Math.floor((input.random ?? Math.random)() * withRoom.length)] : withRoom[0];
  } else {
    why = "cap";
    // Nobody can take it now: whoever the planner would send it on first,
    // ties in turn order.
    account = turn.reduce((best, a) => (at(a) < at(best) ? a : best), turn[0]);
  }
  const nextCursor = (order.indexOf(account) + 1) % order.length;
  return { account, why, at: Math.max(input.now, at(account)), group, nextCursor, upNext: order.length > 1 ? order[nextCursor] : undefined };
}

/** Record a pick and advance the group's turn. */
export function recordRotation(state: RotationState, pick: PickResult, mode: RotateMode, text: string, now: number): RotationState {
  return {
    cursor: { ...state.cursor, [pick.group]: pick.nextCursor },
    picks: [
      ...state.picks,
      { at: new Date(now).toISOString(), group: pick.group, account: pick.account.id, mode, why: pick.why, text: text.replace(/\s+/g, " ").trim().slice(0, 80) },
    ].slice(-PICK_LIMIT),
  };
}
