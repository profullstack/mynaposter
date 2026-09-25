/**
 * Plan items: a subject and an angle on a date, before anyone has written the
 * copy.
 *
 * The queue holds posts — finished text with a send time. A plan item is the
 * step before that: "the licensing argument, from the maintainer's side, some
 * time in the week of the 14th". It has no text, so there is nothing to delete
 * when you change your mind, and the writer runs later with the brand loaded
 * rather than up front when nobody has read it yet.
 *
 * Not secret, so this is a plain JSON file beside queue.json.
 */
import { randomUUID } from "node:crypto";
import { readJson, writeJson } from "../util/json.ts";
import { PLAN_FILE } from "../util/paths.ts";

export type PlanStatus = "open" | "drafted" | "queued" | "done" | "dropped";

export interface PlanSource {
  url?: string;
  title?: string;
  /** A local file, for a source that never had a URL. */
  path?: string;
}

export interface PlanItem {
  id: string;
  createdAt: string;
  /** The day this is for, as YYYY-MM-DD. A plan is not precise to the minute. */
  forDate: string;
  /** Which pillar it came from, or "" for an item atomized out of a source. */
  pillar: string;
  /** What this post argues. One line. The writer turns it into copy. */
  angle: string;
  source?: PlanSource;
  /** Where it should go when it is drafted. Empty means settings.defaultTargets. */
  targets?: string[];
  status: PlanStatus;
  /** Set once the writer has drafted it, so a second pass does not rewrite it. */
  text?: string;
  /** The queue entry it became. */
  queuedPostId?: string;
  /** Why it was dropped, when a person or the autopilot dropped it. */
  note?: string;
}

interface PlanFile {
  items: PlanItem[];
}

const read = (): PlanFile => readJson<PlanFile>(PLAN_FILE, { items: [] });
const write = (file: PlanFile): void => writeJson(PLAN_FILE, file);

export function listPlan(): PlanItem[] {
  return read().items.sort((a, b) => a.forDate.localeCompare(b.forDate) || a.createdAt.localeCompare(b.createdAt));
}

export function getPlanItem(id: string): PlanItem | undefined {
  return read().items.find((item) => item.id === id);
}

export function addPlanItems(items: Array<Omit<PlanItem, "id" | "createdAt" | "status"> & { status?: PlanStatus }>): PlanItem[] {
  const file = read();
  const created = items.map((item) => ({
    ...item,
    id: randomUUID().slice(0, 8),
    createdAt: new Date().toISOString(),
    status: item.status ?? ("open" as PlanStatus),
  }));
  file.items.push(...created);
  write(file);
  return created;
}

export function updatePlanItem(id: string, patch: Partial<PlanItem>): PlanItem | undefined {
  const file = read();
  const item = file.items.find((entry) => entry.id === id);
  if (!item) return undefined;
  Object.assign(item, patch);
  write(file);
  return item;
}

export function removePlanItem(id: string): boolean {
  const file = read();
  const before = file.items.length;
  file.items = file.items.filter((item) => item.id !== id);
  if (file.items.length === before) return false;
  write(file);
  return true;
}

/** Clear everything that never became a post. Used by `myna plan clear`. */
export function clearOpenPlan(): number {
  const file = read();
  const before = file.items.length;
  file.items = file.items.filter((item) => item.status !== "open" && item.status !== "drafted");
  write(file);
  return before - file.items.length;
}

const day = (at: Date): string => at.toISOString().slice(0, 10);

/**
 * Items that are still waiting to become posts, oldest slot first.
 *
 * `through` includes items dated in the past: a plan item whose day went by
 * without anyone posting it is exactly what the autopilot is for, so it stays
 * eligible rather than silently expiring.
 */
export function openPlan(through = new Date()): PlanItem[] {
  const limit = day(through);
  return listPlan().filter((item) => (item.status === "open" || item.status === "drafted") && item.forDate <= limit);
}

/** Every open item, regardless of date, for the ones a person is browsing. */
export function pendingPlan(): PlanItem[] {
  return listPlan().filter((item) => item.status === "open" || item.status === "drafted");
}

/** Whether this angle is already in the plan, so a second atomize run does not double it. */
export function planHasAngle(angle: string): boolean {
  const normal = angle.toLowerCase().replace(/\s+/g, " ").trim();
  return read().items.some((item) => item.angle.toLowerCase().replace(/\s+/g, " ").trim() === normal);
}
