/**
 * Autopilot: keep a cadence without taking the keyboard away.
 *
 * The rule is *gap-fill only*. It counts what you have posted in the last week
 * and what is already booked for the next one, and does nothing at all while
 * that meets your cadence. Post enough yourself and it never runs. Fall short
 * and it takes the next angle off the plan, drafts it, and books it.
 *
 * Nothing it books is ever due sooner than `holdHours` away, so there is
 * always a window in which `myna queue` shows it and `myna cancel` removes it.
 * An autopilot that can publish inside the next minute is one you have to
 * watch, which defeats the point of having one.
 *
 * One item per turn. The daemon calls this hourly; filling a week's deficit in
 * a single burst is exactly the posting pattern that gets accounts flagged,
 * and re-reading the deficit each hour means a post you write yourself at noon
 * cancels the fill that would have gone out that evening.
 */
import { listHistory } from "../store/history.ts";
import { listQueue } from "../store/queue.ts";
import { loadSettings, type AutopilotSettings } from "../store/settings.ts";
import { openPlan, pendingPlan, type PlanItem } from "../store/plan.ts";
import { draftPlanItem, generatePlan, queuePlanItem } from "./plan.ts";
import { loadBrand } from "./brand.ts";
import { writerAvailable } from "../ai/writer.ts";

export type { AutopilotSettings };

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;


/** One piece of content, however many accounts it reached. */
const key = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 120);

export interface Cadence {
  /** Distinct posts sent in the last seven days. */
  sent: number;
  /** Distinct posts booked for the next seven days. */
  booked: number;
  /** sent + booked, against which the cadence is judged. */
  total: number;
  target: number;
  /** How many short. Zero or less means nothing to do. */
  deficit: number;
}

/**
 * Where the cadence stands, over a rolling fortnight centred on now.
 *
 * Counted by distinct text rather than by history entry: a post that fanned
 * out to six accounts is one post, and counting the sends would have the
 * autopilot believe a single Tuesday covered the whole week.
 */
export function cadence(now = new Date(), settings = loadSettings()): Cadence {
  const target = Math.max(1, settings.autopilot.perWeek);
  const since = now.getTime() - WEEK_MS;
  const until = now.getTime() + WEEK_MS;

  const sent = new Set<string>();
  for (const entry of listHistory()) {
    if (!entry.ok || !entry.text.trim()) continue;
    const at = Date.parse(entry.at);
    if (Number.isNaN(at) || at < since || at > now.getTime()) continue;
    sent.add(key(entry.text));
  }

  const booked = new Set<string>();
  for (const post of listQueue()) {
    if (post.status !== "pending" || !post.text.trim()) continue;
    const at = Date.parse(post.scheduledFor);
    if (Number.isNaN(at) || at < now.getTime() || at > until) continue;
    const id = key(post.text);
    // A fan-out already queued under one text should not also count as sent.
    if (!sent.has(id)) booked.add(id);
  }

  const total = sent.size + booked.size;
  return { sent: sent.size, booked: booked.size, total, target, deficit: target - total };
}

export interface AutopilotTurn {
  /** True when it decided to do nothing, which is the common case. */
  idle: boolean;
  reason: string;
  cadence: Cadence;
  item?: PlanItem;
  /** The queue entries it booked. */
  queued?: Array<{ id: string; scheduledFor: string; targets: string[] }>;
  /** Set when it topped the plan up on this turn. */
  planned?: number;
}

export interface AutopilotOptions {
  now?: Date;
  log?: (line: string) => void;
  /** Work out what it would do and book nothing. */
  dryRun?: boolean;
}

/**
 * One turn. Books at most one post.
 *
 * Every early return is a reason, not a silent no-op: the daemon logs them and
 * `myna autopilot status` prints the same sentence, so "why has it not posted"
 * always has an answer that does not require reading this file.
 */
export async function runAutopilot(options: AutopilotOptions = {}): Promise<AutopilotTurn> {
  const { log = () => {} } = options;
  const now = options.now ?? new Date();
  const settings = loadSettings();
  const state = cadence(now, settings);

  const idle = (reason: string, extra: Partial<AutopilotTurn> = {}): AutopilotTurn => ({
    idle: true,
    reason,
    cadence: state,
    ...extra,
  });

  if (!settings.autopilot.enabled) return idle("autopilot is off (myna autopilot on)");

  if (state.deficit <= 0) {
    return idle(`at cadence: ${state.total} of ${state.target} a week (${state.sent} sent, ${state.booked} booked)`);
  }

  const ready = writerAvailable();
  if (!ready.ok) return idle(`the writer is not available: ${ready.reason}`);

  let planned: number | undefined;
  let next = openPlan(now)[0];
  if (!next) {
    if (!settings.autopilot.refillPlan) return idle("nothing open in the plan (myna plan generate)");
    if (!loadBrand()?.pillars.length) return idle("nothing in the plan and no brand to plan from (myna brand learn)");
    log("plan is empty, topping it up");
    try {
      const result = await generatePlan({
        from: now,
        days: settings.autopilot.planAheadDays,
        perWeek: settings.autopilot.perWeek,
        log,
      });
      planned = result.items.length;
    } catch (error) {
      return idle(`could not top up the plan: ${(error as Error).message}`);
    }
    next = openPlan(now)[0] ?? pendingPlan()[0];
    if (!next) return idle("the planner returned nothing", { planned });
  }

  if (options.dryRun) {
    return {
      idle: false,
      reason: `would book ${next.id} (${state.total} of ${state.target} a week)`,
      cadence: state,
      item: next,
      planned,
    };
  }

  let item = next;
  if (!item.text) {
    log(`drafting ${item.id}: ${item.angle}`);
    try {
      item = await draftPlanItem(item);
    } catch (error) {
      return idle(`could not draft ${item.id}: ${(error as Error).message}`, { item, planned });
    }
  }

  const from = now.getTime() + Math.max(1, settings.autopilot.holdHours) * 3_600_000;
  try {
    const result = await queuePlanItem(item, { from, targets: settings.autopilot.to ? [settings.autopilot.to] : undefined, log });
    if (!result.queued.length) {
      const why = result.skipped.map((entry) => `${entry.id}: ${entry.reason}`).join("; ") || "the pacing rules held every account back";
      return idle(`nothing booked for ${item.id} (${why})`, { item: result.item, planned });
    }
    return {
      idle: false,
      reason: `booked ${item.id} for ${result.queued[0].scheduledFor.slice(0, 16).replace("T", " ")} (${state.total} of ${state.target} a week)`,
      cadence: state,
      item: result.item,
      queued: result.queued.map((post) => ({ id: post.id, scheduledFor: post.scheduledFor, targets: post.targets })),
      planned,
    };
  } catch (error) {
    return idle(`could not book ${item.id}: ${(error as Error).message}`, { item, planned });
  }
}
