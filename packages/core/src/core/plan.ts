/**
 * The planner: turn the brand's pillars into dated angles, then turn an angle
 * into a queued post when its turn comes.
 *
 * Three steps, kept apart on purpose:
 *
 *   generatePlan   pillars -> open plan items, spread over the coming weeks
 *   draftPlanItem  one angle -> copy, written with the brand loaded
 *   queuePlanItem  copy -> the pacing queue, which owns when it actually goes
 *
 * Splitting them is what makes the whole thing reviewable. A month generated
 * as finished posts is a month of copy nobody asked for; a month generated as
 * angles is a list of prompts you can read in thirty seconds and delete half of.
 */
import { loadSettings } from "../store/settings.ts";
import { resolveTargets } from "../store/accounts.ts";
import { addPlanItems, planHasAngle, updatePlanItem, type PlanItem } from "../store/plan.ts";
import { listHistory } from "../store/history.ts";
import { draft } from "../ai/writer.ts";
import { extractJson, providerComplete, writerAvailable } from "../ai/writer.ts";
import { brandPrompt, loadBrand, type Brand } from "./brand.ts";
import { postPaced } from "./poster.ts";
import type { QueuedPost } from "../store/queue.ts";

const DAY_MS = 86_400_000;

export const isoDay = (at: Date): string => at.toISOString().slice(0, 10);

const PLAN_SYSTEM = `You are planning somebody's posts for the weeks ahead, from their brand's pillars.

You are producing angles, not posts. An angle is one line naming the specific argument a post would make. Rules:
- Every angle must be arguable. "Our thoughts on licensing" is a topic and is useless. "Dual licensing punishes the contributors it is meant to protect" is an angle.
- No two angles may restate each other. If two would produce the same post, drop one.
- Spread across the pillars given. Do not spend the whole plan on the first one.
- Never invent a product feature, a customer, a number or an event. Angles are positions, not announcements.
- Do not repeat an angle from the "already said" list.
Return only the JSON described. No preamble, no code fences.`;

interface PlannedAngle {
  pillar: string;
  angle: string;
}

export interface GenerateOptions {
  /** First day the plan covers. Today by default. */
  from?: Date;
  /** How many days forward to spread over. */
  days?: number;
  /** Slots a week. The plan holds days * perWeek / 7 items. */
  perWeek?: number;
  /** Where these should go when drafted. Empty means settings.defaultTargets. */
  targets?: string[];
  log?: (line: string) => void;
}

export interface GenerateResult {
  items: PlanItem[];
  /** Angles the model returned that were already in the plan. */
  duplicates: number;
}

/**
 * Fill the calendar with angles from the brand's pillars.
 *
 * Dates are spread evenly rather than randomly: an even spread is what a
 * cadence means, and the pacing rules move the actual send time anyway.
 */
export async function generatePlan(options: GenerateOptions = {}): Promise<GenerateResult> {
  const { log = () => {} } = options;
  const ready = writerAvailable();
  if (!ready.ok) throw new Error(`the writer is not available: ${ready.reason}`);

  const brand = loadBrand();
  if (!brand || !brand.pillars.length) {
    throw new Error("no brand pillars to plan from. Run: myna brand learn");
  }

  const from = options.from ?? new Date();
  const days = Math.max(1, options.days ?? 30);
  const perWeek = Math.max(1, options.perWeek ?? 5);
  const wanted = Math.max(1, Math.round((days * perWeek) / 7));

  // What has already gone out, so the plan does not re-argue last week.
  const said = listHistory()
    .filter((entry) => entry.ok)
    .slice(0, 60)
    .map((entry) => entry.text.replace(/\s+/g, " ").slice(0, 160));

  const prompt = [
    `Pillars:`,
    ...brand.pillars.map((pillar) => `- ${pillar.name}${pillar.note ? `: ${pillar.note}` : ""}`),
    brand.audience ? `\nAudience: ${brand.audience}` : "",
    brand.positioning ? `Positioning: ${brand.positioning}` : "",
    said.length ? `\nAlready said, do not repeat:\n${said.map((line) => `- ${line}`).join("\n")}` : "",
    "",
    `Produce exactly ${wanted} angles.`,
    'Return JSON: {"angles":[{"pillar":"","angle":""}]}',
  ]
    .filter(Boolean)
    .join("\n");

  log(`planning ${wanted} angle${wanted === 1 ? "" : "s"} across ${brand.pillars.length} pillars`);
  const raw = await providerComplete(`${PLAN_SYSTEM}${brandPrompt(brand)}`, prompt, 3000);
  const planned = extractJson<{ angles: PlannedAngle[] }>(raw).angles ?? [];

  const fresh = planned.filter((entry) => entry?.angle?.trim() && !planHasAngle(entry.angle));
  const duplicates = planned.length - fresh.length;

  // An even spread over the window. `step` is fractional so a 30-day, 5-a-week
  // plan lands on 21 distinct days rather than bunching at the start.
  const step = fresh.length > 1 ? (days - 1) / (fresh.length - 1) : 0;
  const items = addPlanItems(
    fresh.map((entry, index) => ({
      forDate: isoDay(new Date(from.getTime() + Math.round(index * step) * DAY_MS)),
      pillar: entry.pillar?.trim() ?? "",
      angle: entry.angle.trim(),
      targets: options.targets,
    })),
  );
  log(`${items.length} planned${duplicates ? `, ${duplicates} already in the plan` : ""}`);
  return { items, duplicates };
}

export interface DraftPlanOptions {
  /** Tailor per network. Empty writes one draft for everywhere. */
  networks?: string[];
  brand?: Brand | null;
}

/**
 * Write the copy for one angle.
 *
 * Stored on the item rather than queued, so the autopilot can draft ahead of
 * time and a person still gets to read it before it is booked.
 */
export async function draftPlanItem(item: PlanItem, options: DraftPlanOptions = {}): Promise<PlanItem> {
  if (item.text) return item;
  const brand = options.brand ?? loadBrand();
  const source = item.source?.url ? `\n\nIt comes from ${item.source.url}${item.source.title ? ` (${item.source.title})` : ""}. Link it.` : "";
  const drafts = await draft({
    prompt: `Make this argument, as a post: ${item.angle}${item.pillar ? `\n\nIt belongs to the "${item.pillar}" subject.` : ""}${source}`,
    networks: options.networks,
    voice: brand?.voice || undefined,
  });
  const text = drafts[0]?.text?.trim();
  if (!text) throw new Error(`the writer returned nothing for ${item.id}`);
  const hashtags = drafts[0]?.hashtags ?? [];
  const body = hashtags.length ? `${text}\n\n${hashtags.map((tag) => (tag.startsWith("#") ? tag : `#${tag}`)).join(" ")}` : text;
  return updatePlanItem(item.id, { text: body, status: "drafted" }) ?? item;
}

export interface QueuePlanOptions {
  /** Earliest it may go. The pacing rules move it later if they must. */
  from?: number;
  targets?: string[];
  log?: (line: string) => void;
}

export interface QueuePlanResult {
  item: PlanItem;
  queued: QueuedPost[];
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * Book a drafted item into the pacing queue.
 *
 * `postPaced` owns the actual times: it knows the gap per network, the daily
 * cap, the repost window and each account's skill. Passing a future `from`
 * means nothing sends inside this call, which is what keeps the hold window
 * honest.
 */
export async function queuePlanItem(item: PlanItem, options: QueuePlanOptions = {}): Promise<QueuePlanResult> {
  if (!item.text) throw new Error(`${item.id} has no draft yet`);
  const settings = loadSettings();
  const named = options.targets ?? item.targets ?? [];
  const spec = named.length ? named.join(",") : settings.defaultTargets;
  const accounts = resolveTargets(spec);
  if (!accounts.length) throw new Error("no targets. Run: myna login <network>");

  const from = Math.max(options.from ?? Date.now(), Date.now() + 1);
  const paced = await postPaced(
    accounts,
    { text: item.text, thread: settings.threadByDefault, type: "social-update" },
    { from },
  );
  const updated =
    updatePlanItem(item.id, {
      status: paced.queued.length ? "queued" : item.status,
      queuedPostId: paced.queued[0]?.id,
    }) ?? item;
  return {
    item: updated,
    queued: paced.queued,
    skipped: paced.skipped.map((entry) => ({ id: entry.account.id, reason: entry.reason })),
  };
}
