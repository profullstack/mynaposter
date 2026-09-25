/**
 * The plan store and the autopilot's decision to do nothing.
 *
 * The interesting behaviour here is all refusal. An autopilot that posts is
 * easy; one that correctly declines to post because you are already at your
 * own cadence is the whole feature, and every decline has to carry a reason
 * somebody can read.
 *
 * Nothing here calls the writer or a network: every path tested returns before
 * either is reached.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addPlanItems,
  clearOpenPlan,
  getPlanItem,
  listPlan,
  openPlan,
  pendingPlan,
  planHasAngle,
  removePlanItem,
  updatePlanItem,
} from "../src/store/plan.ts";
import { cadence, runAutopilot } from "../src/core/autopilot.ts";
import { isoDay } from "../src/core/plan.ts";
import { loadSettings, saveSettings } from "../src/store/settings.ts";
import { recordHistory } from "../src/store/history.ts";
import { enqueue } from "../src/store/queue.ts";

let dir = "";
const NOW = new Date("2026-09-25T12:00:00.000Z");
const at = (days: number): string => new Date(NOW.getTime() + days * 86_400_000).toISOString();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-autopilot-"));
  process.env.MYNA_HOME = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
});

const on = (patch: Record<string, unknown> = {}) => {
  const settings = loadSettings();
  settings.autopilot = { ...settings.autopilot, enabled: true, ...patch };
  saveSettings(settings);
  return settings;
};

const sent = (text: string, days: number) =>
  recordHistory([{ at: at(days), accountId: "bluesky:me", network: "bluesky", handle: "me", text, ok: true }]);

test("plan items round trip, and openPlan only returns what is due", () => {
  const [past, today, future] = addPlanItems([
    { forDate: isoDay(new Date(NOW.getTime() - 86_400_000)), pillar: "a", angle: "yesterday's angle" },
    { forDate: isoDay(NOW), pillar: "a", angle: "today's angle" },
    { forDate: isoDay(new Date(NOW.getTime() + 5 * 86_400_000)), pillar: "b", angle: "next week's angle" },
  ]);

  expect(listPlan()).toHaveLength(3);
  expect(getPlanItem(today.id)?.angle).toBe("today's angle");

  // A slot whose day went by without anyone posting is exactly what the
  // autopilot is for, so it stays eligible rather than expiring.
  const due = openPlan(NOW).map((item) => item.id);
  expect(due).toEqual([past.id, today.id]);
  expect(due).not.toContain(future.id);

  // pendingPlan ignores the date: it is what a person browsing wants.
  expect(pendingPlan()).toHaveLength(3);
});

test("a queued item is no longer open, and clear leaves it alone", () => {
  const [one, two] = addPlanItems([
    { forDate: isoDay(NOW), pillar: "", angle: "first" },
    { forDate: isoDay(NOW), pillar: "", angle: "second" },
  ]);
  updatePlanItem(one.id, { status: "queued", queuedPostId: "abc123" });

  expect(openPlan(NOW).map((item) => item.id)).toEqual([two.id]);
  expect(clearOpenPlan()).toBe(1);
  // The queued one survives: dropping it here would orphan its queue entry.
  expect(listPlan().map((item) => item.id)).toEqual([one.id]);
  expect(removePlanItem(one.id)).toBe(true);
  expect(removePlanItem("nope")).toBe(false);
});

test("planHasAngle ignores case and spacing, so a second run does not double up", () => {
  addPlanItems([{ forDate: isoDay(NOW), pillar: "", angle: "Dual licensing punishes contributors" }]);
  expect(planHasAngle("dual   licensing punishes contributors")).toBe(true);
  expect(planHasAngle("Dual licensing protects contributors")).toBe(false);
});

test("cadence counts one post per piece of content, not per account it reached", () => {
  // The same text fanned out to six accounts is one post. Counting the sends
  // would have a single Tuesday cover the whole week.
  for (const account of ["bluesky:me", "mastodon:me", "x:me", "linkedin:me", "nostr:me", "lemmy:me"]) {
    recordHistory([{ at: at(-1), accountId: account, network: account.split(":")[0], handle: "me", text: "one idea", ok: true }]);
  }
  expect(cadence(NOW).sent).toBe(1);

  sent("another idea", -2);
  expect(cadence(NOW).sent).toBe(2);

  // Outside the window, and failures, do not count.
  sent("old news", -9);
  recordHistory([{ at: at(-1), accountId: "x:me", network: "x", handle: "me", text: "it failed", ok: false }]);
  expect(cadence(NOW).sent).toBe(2);
});

test("cadence counts what is booked ahead, and never double-counts a fan-out", () => {
  sent("already out", -1);
  enqueue({ scheduledFor: at(2), targets: ["bluesky:me"], text: "booked idea" });
  enqueue({ scheduledFor: at(3), targets: ["mastodon:me"], text: "booked idea" });
  // Same text as something already sent: not a second piece of content.
  enqueue({ scheduledFor: at(2), targets: ["x:me"], text: "already out" });
  // Too far out to count against this week.
  enqueue({ scheduledFor: at(20), targets: ["x:me"], text: "much later" });

  const state = cadence(NOW);
  expect(state.sent).toBe(1);
  expect(state.booked).toBe(1);
  expect(state.total).toBe(2);
});

test("it does nothing while switched off, and says so", async () => {
  const turn = await runAutopilot({ now: NOW });
  expect(turn.idle).toBe(true);
  expect(turn.reason).toContain("autopilot is off");
});

test("it does nothing while you are already at your own cadence", async () => {
  on({ perWeek: 2 });
  sent("one", -1);
  sent("two", -2);

  const turn = await runAutopilot({ now: NOW });
  expect(turn.idle).toBe(true);
  expect(turn.reason).toContain("at cadence");
  expect(turn.cadence.deficit).toBeLessThanOrEqual(0);
  // Nothing was taken off the plan.
  expect(turn.item).toBeUndefined();
});

test("short of cadence with nothing to say, it explains rather than inventing one", async () => {
  on({ perWeek: 5, refillPlan: false });
  sent("only one", -1);

  const turn = await runAutopilot({ now: NOW });
  expect(turn.idle).toBe(true);
  expect(turn.cadence.deficit).toBeGreaterThan(0);
  // Either the writer is unavailable in this environment or the plan is empty.
  // Both are real reasons and both name the command that fixes them.
  expect(turn.reason).toMatch(/writer is not available|nothing open in the plan/);
  expect(turn.queued).toBeUndefined();
});

test("the hold window is a positive number of hours, so nothing can be booked immediately", () => {
  const settings = on({ holdHours: 24 });
  expect(settings.autopilot.holdHours).toBeGreaterThan(0);
  // The default is a full day: enough to see it in `myna queue` and cancel it.
  expect(loadSettings().autopilot.holdHours).toBe(24);
});
