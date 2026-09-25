/**
 * Atomize: one long thing becomes many small ones, spread over the calendar.
 *
 * The practice is old — content atomization, named in 2008, long before a
 * model could do the splitting. A blog post, a whitepaper, a talk transcript
 * or a release note carries five or ten separate arguments; published once it
 * gets read for a day. This pulls the arguments out and dates them.
 *
 * What it produces is plan items, not posts. Twelve finished drafts is twelve
 * things to delete; twelve angles is a month of prompts worth writing against,
 * and the writer runs later with the brand loaded.
 */
import { existsSync, readFileSync } from "node:fs";
import { addPlanItems, planHasAngle, type PlanItem } from "../store/plan.ts";
import { extractJson, providerComplete, writerAvailable } from "../ai/writer.ts";
import { fetchPage } from "../ai/extract.ts";
import { brandPrompt, loadBrand } from "./brand.ts";
import { isoDay } from "./plan.ts";

const DAY_MS = 86_400_000;
const MAX_SOURCE = 12_000;

const ATOMIZE_SYSTEM = `You are reading one long piece and listing the separate arguments inside it.

Rules:
- Each angle is one line naming a claim the source actually makes. Not a summary of the source, and not a topic.
- Only what is in the text. Never add a claim, a number, a quote or a feature the source does not contain. This is the rule that matters most: the source is the only evidence.
- No two angles may produce the same post. Prefer the specific, arguable ones over the throat-clearing at the top.
- If the source carries fewer real arguments than asked for, return fewer. A short list of good angles beats a padded one.
- Where a pillar list is given, tag each angle with the pillar it belongs to, or "" when none fits.
Return only the JSON described. No preamble, no code fences.`;

interface AtomizedAngle {
  pillar: string;
  angle: string;
}

export interface AtomizeOptions {
  /** A URL, or a path to a local file. */
  source: string;
  /** How many angles to ask for. */
  angles?: number;
  /** Spread them over this many days from `from`. */
  overDays?: number;
  from?: Date;
  targets?: string[];
  /** Work out the angles and return them without writing anything. */
  dryRun?: boolean;
  log?: (line: string) => void;
}

export interface AtomizeResult {
  title: string;
  url?: string;
  path?: string;
  /** Written to the plan, unless dryRun. */
  items: PlanItem[];
  /** What the model returned, including anything already planned. */
  angles: AtomizedAngle[];
  duplicates: number;
}

interface LoadedSource {
  title: string;
  text: string;
  url?: string;
  path?: string;
}

async function loadSource(source: string, log: (line: string) => void): Promise<LoadedSource> {
  if (/^https?:\/\//i.test(source)) {
    const page = await fetchPage(source);
    log(`read ${page.url} (${page.text.length} characters)`);
    if (!page.text.trim()) throw new Error(`${page.url} had no readable text`);
    return { title: page.title || page.url, text: page.text, url: page.url };
  }
  if (!existsSync(source)) throw new Error(`no such file: ${source}`);
  const text = readFileSync(source, "utf8");
  if (!text.trim()) throw new Error(`${source} is empty`);
  log(`read ${source} (${text.length} characters)`);
  // A Markdown file usually opens with its title; fall back to the filename.
  const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
  return { title: heading || source.split("/").pop() || source, text, path: source };
}

/** Split one source into dated angles. */
export async function atomize(options: AtomizeOptions): Promise<AtomizeResult> {
  const { log = () => {} } = options;
  const ready = writerAvailable();
  if (!ready.ok) throw new Error(`the writer is not available: ${ready.reason}`);

  const wanted = Math.max(1, Math.min(40, options.angles ?? 12));
  const overDays = Math.max(1, options.overDays ?? 30);
  const from = options.from ?? new Date();
  const loaded = await loadSource(options.source, log);
  const brand = loadBrand();

  const prompt = [
    `Source: ${loaded.title}`,
    loaded.url ? `URL: ${loaded.url}` : "",
    brand?.pillars.length ? `\nPillars to tag against: ${brand.pillars.map((pillar) => pillar.name).join(", ")}` : "",
    "",
    "Text:",
    loaded.text.slice(0, MAX_SOURCE),
    "",
    `List up to ${wanted} angles.`,
    'Return JSON: {"angles":[{"pillar":"","angle":""}]}',
  ]
    .filter(Boolean)
    .join("\n");

  log(`splitting into up to ${wanted} angles`);
  const raw = await providerComplete(`${ATOMIZE_SYSTEM}${brandPrompt(brand)}`, prompt, 3000);
  const angles = (extractJson<{ angles: AtomizedAngle[] }>(raw).angles ?? []).filter((entry) => entry?.angle?.trim());

  const fresh = angles.filter((entry) => !planHasAngle(entry.angle));
  const duplicates = angles.length - fresh.length;

  if (options.dryRun) {
    log(`${angles.length} angle${angles.length === 1 ? "" : "s"}, nothing written`);
    return { title: loaded.title, url: loaded.url, path: loaded.path, items: [], angles, duplicates };
  }

  const step = fresh.length > 1 ? (overDays - 1) / (fresh.length - 1) : 0;
  const items = addPlanItems(
    fresh.map((entry, index) => ({
      forDate: isoDay(new Date(from.getTime() + Math.round(index * step) * DAY_MS)),
      pillar: entry.pillar?.trim() ?? "",
      angle: entry.angle.trim(),
      source: { url: loaded.url, title: loaded.title, path: loaded.path },
      targets: options.targets,
    })),
  );
  log(`${items.length} planned over ${overDays} days${duplicates ? `, ${duplicates} already in the plan` : ""}`);
  return { title: loaded.title, url: loaded.url, path: loaded.path, items, angles, duplicates };
}
