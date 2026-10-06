/**
 * Asks: people asking, in public, for a site or an app that does X, Y and Z.
 *
 * `asks.json` holds three things. The asks themselves: a Reddit post the
 * detector judged to be somebody asking for a thing, what they want from it,
 * and what we did about it (nothing yet, a reply card waiting on a person, a
 * reply pasted), with a stats snapshot every time the thread is re-read. The
 * ideas those asks add up to, because one person asking is an anecdote and
 * eight people asking for the same thing in two months is a product. And our
 * own products, so an ask that something we already run answers gets a reply
 * pointing at it instead of counting toward something new.
 *
 * `seen` keeps every post id already judged, ask or not, so a scan never
 * reconsiders a post.
 */
import { readJson, writeJson } from "../util/json.ts";
import { ASKS_FILE } from "../util/paths.ts";

/**
 * Where an ask stands.
 *
 *   new       found, nothing done
 *   drafted   a reply card exists and is waiting on a person to paste it
 *   replied   the card was marked done, or stats found our comment in the thread
 *   skipped   a person dropped it
 */
export type AskStatus = "new" | "drafted" | "replied" | "skipped";

/**
 * Where an idea stands. `build` is set by the numbers; every other move is a
 * person's: `building` once work starts, `shipped` with the product it became,
 * `ignored` for a thing we will never make.
 */
export type IdeaStatus = "watching" | "build" | "building" | "shipped" | "ignored";

/** One read of a thread, and of our reply in it when there is one. */
export interface AskStats {
  at: string;
  /** The thread's score and comment count, as the archive last saw them. */
  score?: number;
  comments?: number;
  ratio?: number;
  /** Our comment, found by `asks.redditUser`. */
  ours?: { id: string; url: string; score?: number; replies: number };
}

export interface Ask {
  /** The Reddit post id, without `t3_`. */
  id: string;
  source: "reddit";
  sub: string;
  title: string;
  /** The body, trimmed. */
  text: string;
  url: string;
  /** The Reddit username, without `/u/`. */
  author: string;
  postedAt: string;
  /** 0-1, how sure the detector is that this is somebody asking for a thing. */
  score: number;
  /** Which pattern made it an ask: `is-there`, `looking-for`, `wish`… The honest answer to "why this one". */
  kind: string;
  /** What they want it to do, as their own phrases. */
  wants: string[];
  /** A short name for the thing, from the writer's second look. What ideas are grouped by first. */
  label?: string;
  /** True when the writer confirmed it is an ask, not only the patterns. */
  judged?: boolean;
  /** The idea it was grouped into. */
  ideaId: string;
  /** One of our products that answers it, when one does. */
  product?: { id: string; name: string; url: string };
  status: AskStatus;
  foundAt: string;
  /** The reply, the card it went out on, and when it was pasted. */
  reply?: string;
  handoffId?: string;
  handoffUrl?: string;
  repliedAt?: string;
  /** Newest last. */
  stats: AskStats[];
  statsAt?: string;
  /** Why it was skipped. */
  reason?: string;
}

export interface Idea {
  id: string;
  /** A short name for it, the strongest phrase its asks share. */
  label: string;
  /** True when the label came from the writer rather than from a want, so it can be trusted for grouping. */
  named?: boolean;
  /** The terms its asks share, strongest first. What a new ask is matched against. */
  terms: string[];
  askIds: string[];
  status: IdeaStatus;
  firstAt: string;
  lastAt: string;
  /** When the numbers first crossed `asks.buildAt`. */
  flaggedAt?: string;
  /** What it became, once shipped: the product id. */
  product?: string;
  note?: string;
}

/** Something we already run, so an ask it answers gets pointed at it. */
export interface AskProduct {
  id: string;
  name: string;
  url: string;
  /** Phrases that mean an ask is about this: "screen sharing", "remote control". */
  keywords: string[];
  /** One line on what it does, which the writer reads before it mentions it. */
  about?: string;
}

export interface AsksFile {
  seen: string[];
  asks: Ask[];
  ideas: Idea[];
  products: AskProduct[];
}

const SEEN_LIMIT = 20_000;
const ASK_LIMIT = 5_000;
export const STATS_KEEP = 30;

export function readAsks(): AsksFile {
  const file = readJson<Partial<AsksFile>>(ASKS_FILE, {});
  return {
    seen: Array.isArray(file.seen) ? file.seen : [],
    asks: Array.isArray(file.asks) ? file.asks : [],
    ideas: Array.isArray(file.ideas) ? file.ideas : [],
    products: Array.isArray(file.products) ? file.products : [],
  };
}

export function writeAsks(file: AsksFile): void {
  file.seen = file.seen.slice(-SEEN_LIMIT);
  if (file.asks.length > ASK_LIMIT) {
    // Drop the oldest that nobody acted on. A reply is history worth keeping:
    // it is what the stats are about.
    const keep = new Set(
      file.asks
        .filter((ask) => ask.status === "new" || ask.status === "skipped")
        .sort((a, b) => a.foundAt.localeCompare(b.foundAt))
        .slice(0, file.asks.length - ASK_LIMIT)
        .map((ask) => ask.id),
    );
    file.asks = file.asks.filter((ask) => !keep.has(ask.id));
    const live = new Set(file.asks.map((ask) => ask.id));
    for (const idea of file.ideas) idea.askIds = idea.askIds.filter((id) => live.has(id));
    file.ideas = file.ideas.filter((idea) => idea.askIds.length || idea.status !== "watching");
  }
  for (const ask of file.asks) ask.stats = ask.stats.slice(-STATS_KEEP);
  writeJson(ASKS_FILE, file);
}

/** By id, or by an unambiguous prefix. */
export function findIn<T extends { id: string }>(list: T[], ref: string): T | undefined {
  const needle = ref.trim().replace(/^t3_/, "");
  if (!needle) return undefined;
  const exact = list.find((entry) => entry.id === needle);
  if (exact) return exact;
  const matches = list.filter((entry) => entry.id.startsWith(needle));
  return matches.length === 1 ? matches[0] : undefined;
}

export function listAsks(): Ask[] {
  return readAsks().asks;
}

export function listIdeas(): Idea[] {
  return readAsks().ideas;
}

export function listProducts(): AskProduct[] {
  return readAsks().products;
}

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

/** Add or replace one of our products. Keyed by a slug of its name. */
export function saveProduct(input: { name: string; url: string; keywords?: string[]; about?: string }): AskProduct {
  const name = input.name.trim();
  if (!name) throw new Error("A product needs a name.");
  let url: URL;
  try {
    url = new URL(input.url.trim());
  } catch {
    throw new Error(`Not a URL: ${input.url}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("A product URL must be http(s).");
  const keywords = (input.keywords ?? []).map((word) => word.trim().toLowerCase()).filter(Boolean);
  const product: AskProduct = {
    id: slug(name),
    name,
    url: url.toString(),
    keywords: keywords.length ? keywords : [name.toLowerCase()],
    ...(input.about?.trim() ? { about: input.about.trim() } : {}),
  };
  const file = readAsks();
  file.products = [...file.products.filter((entry) => entry.id !== product.id), product];
  writeAsks(file);
  return product;
}

export function removeProduct(ref: string): boolean {
  const file = readAsks();
  const found = findIn(file.products, ref);
  if (!found) return false;
  file.products = file.products.filter((entry) => entry.id !== found.id);
  writeAsks(file);
  return true;
}

export function clearAsks(): void {
  const file = readAsks();
  // Products are configuration; the rest is what a scan found.
  writeAsks({ seen: [], asks: [], ideas: [], products: file.products });
}
