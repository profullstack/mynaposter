/**
 * The writer, for promoting one product: what a promotion app such as
 * DefPromo asks a bridge for over OpenConnection (https://logicsrc.com/openconnection).
 *
 * Three questions, each one call: what is this product (a page read into a
 * brief), what do I say about it here (post or comment variations for one
 * network), and where do I say it (subreddits, hashtags, keywords). The model
 * answers JSON; the parsing is forgiving because models are not.
 */
import { loadSettings } from "../store/settings.ts";
import { getNetwork } from "../net/registry.ts";
import type { PageSummary } from "./extract.ts";
import { providerComplete, extractJson } from "./writer.ts";

/** What a promotion app knows about the thing it promotes. */
export interface ProjectBrief {
  name: string;
  description: string;
  audience?: string;
  features?: string[];
  tone?: string;
  url?: string;
}

export const TONES = ["professional", "casual", "enthusiastic", "technical", "friendly"] as const;

/**
 * Names a promotion app uses for networks, mapped to myna's ids. Anything
 * unknown is kept as given with no limit applied, since a wrong ceiling is
 * worse than none.
 */
export const NETWORK_ALIASES: Record<string, string> = {
  twitter: "x",
  primal: "nostr",
  "stacker news": "tsbb",
  stacker: "tsbb",
};

export interface NetworkShape {
  id: string;
  name: string;
  charLimit: number;
  needsTitle: boolean;
}

/** The network behind an app's name for it, or null when myna has none. */
export function resolveNetwork(id?: string | null): NetworkShape | null {
  if (!id) return null;
  const key = id.trim().toLowerCase();
  const network = getNetwork(NETWORK_ALIASES[key] ?? key);
  if (!network) return null;
  return { id: network.id, name: network.name, charLimit: network.caps.charLimit, needsTitle: Boolean(network.caps.needsTitle) };
}

const PROMOTE_SYSTEM = `You help someone promote their own product on social networks without sounding like marketing.

Rules, all of them load-bearing:
- Write like a knowledgeable person sharing something they made or use. No hype, no "game changer", no "excited to announce", no rhetorical questions as openers.
- Comments answer the post they are under first. The product comes up only where it genuinely helps, in one clause, never as the point of the comment.
- Respect a network's character limit exactly. The limit is a hard ceiling, not a target.
- Hashtags only where the network uses them, lowercase, specific, at most three. No #innovation, #tech, #future.
- Return only the JSON described. No preamble, no code fences.`;

export function briefBlock(project: ProjectBrief): string {
  return [
    `Product: ${project.name}`,
    `Description: ${project.description}`,
    project.audience && `Audience: ${project.audience}`,
    project.features?.length && `Features: ${project.features.join("; ")}`,
    project.tone && `Tone: ${project.tone}`,
    project.url && `Link: ${project.url}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export interface VariationsRequest {
  kind: "post" | "comment";
  /** The app's name for the network; resolved through NETWORK_ALIASES. */
  network?: string | null;
  count?: number;
  project: ProjectBrief;
  /** The post being replied to, when kind is comment. */
  context?: { title?: string; content?: string; url?: string } | null;
  includeLink?: boolean;
  /** Ask for a title too, for networks that want one. */
  title?: boolean;
  voice?: string;
}

export interface Variations {
  title: string | null;
  variations: string[];
  network: string | null;
}

const clamp = (value: unknown, low: number, high: number, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(high, Math.max(low, Math.round(n))) : fallback;
};

/**
 * The model's answer as variations. JSON first; when a model answers prose
 * anyway, paragraphs separated by blank lines, the way a person would list them.
 */
export function parseVariations(raw: string, count: number): { title: string | null; variations: string[] } {
  try {
    const parsed = extractJson<{ title?: unknown; variations?: unknown } | unknown[]>(raw);
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.variations) ? parsed.variations : null;
    if (list) {
      const variations = list.map((entry) => (typeof entry === "string" ? entry : typeof (entry as { text?: string })?.text === "string" ? (entry as { text: string }).text : "")).map((text) => text.trim()).filter(Boolean).slice(0, count);
      const title = !Array.isArray(parsed) && typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : null;
      if (variations.length) return { title, variations };
    }
  } catch {
    // Prose. Fall through.
  }
  const titleMatch = raw.match(/^TITLE:\s*(.+?)(?:\n|$)/im);
  const body = titleMatch ? raw.slice(raw.indexOf(titleMatch[0]) + titleMatch[0].length) : raw;
  const variations = body
    .split(/\n\s*\n+|\n\d+\.\s+/)
    .map((entry) => entry.replace(/^\s*[-*]\s+/, "").trim())
    .filter((entry) => entry.length > 10)
    .slice(0, count);
  return { title: titleMatch ? titleMatch[1].trim() : null, variations: variations.length ? variations : [raw.trim()].filter(Boolean) };
}

/** N posts, or N comments under a given post, for one network. */
export async function variations(request: VariationsRequest): Promise<Variations> {
  const settings = loadSettings();
  const count = clamp(request.count, 1, 10, 5);
  const network = resolveNetwork(request.network);
  const voice = request.voice ?? settings.ai.voice;
  const wantTitle = Boolean(request.title) || Boolean(network?.needsTitle);
  const link = request.includeLink && request.project.url ? request.project.url : null;

  const where = network
    ? `Network: ${network.name}${network.charLimit ? ` (${network.charLimit} characters max per ${request.kind})` : " (no character limit)"}.`
    : request.network
      ? `Network: ${request.network}.`
      : "";

  const task =
    request.kind === "comment"
      ? [
          "You are replying to this post:",
          request.context?.title && `Title: ${request.context.title}`,
          request.context?.url && `URL: ${request.context.url}`,
          `Content: ${request.context?.content?.slice(0, 4000) || "(not given)"}`,
          "",
          `Write ${count} different comments that answer the post on its own terms, and mention ${request.project.name} only where it genuinely helps the poster${link ? `, with the link ${link} woven in naturally` : ", without a link"}.`,
        ]
          .filter(Boolean)
          .join("\n")
      : `Write ${count} different posts about the product below, each from a different angle (what it does, who it is for, a specific detail, a problem it removes, a plain announcement)${link ? `. Include the link ${link} in each` : ""}.`;

  const shape = wantTitle
    ? `Return JSON: {"title": "<one title under 100 characters>", "variations": ["<text>", ...]} with exactly ${count} variations.`
    : `Return JSON: {"variations": ["<text>", ...]} with exactly ${count} variations.`;

  const prompt = [task, "", briefBlock(request.project), "", where, `Voice: ${voice}`, "", shape].filter((line) => line !== undefined).join("\n");

  const raw = await providerComplete(PROMOTE_SYSTEM, prompt, 3000);
  const parsed = parseVariations(raw, count);
  const limit = network?.charLimit ?? 0;
  return {
    title: wantTitle ? parsed.title : null,
    variations: limit ? parsed.variations.map((text) => (text.length > limit ? text.slice(0, limit).replace(/\s+\S*$/, "") : text)) : parsed.variations,
    network: network?.id ?? request.network ?? null,
  };
}

export interface ProjectCopyRequest {
  page: PageSummary;
  /** The site's own OpenProfile.md, when it serves one. */
  openprofile?: string | null;
  /** The site's llms.txt, when it serves one. */
  llms?: string | null;
}

export interface ProjectCopy {
  name: string;
  description: string;
  audience: string;
  features: string[];
  tone: (typeof TONES)[number];
}

/** A page, and what the site says about itself, read into a brief. */
export async function projectCopy(request: ProjectCopyRequest): Promise<ProjectCopy> {
  const { page } = request;
  const source = [
    request.openprofile && `The site's own OpenProfile.md (trust this over the page):\n${request.openprofile.slice(0, 6000)}`,
    request.llms && `The site's llms.txt (what it wants a model to know):\n${request.llms.slice(0, 6000)}`,
    [
      `URL: ${page.url}`,
      page.title && `Title: ${page.title}`,
      page.siteName && `Site: ${page.siteName}`,
      page.description && `Description: ${page.description}`,
      "",
      "Page text:",
      page.text.slice(0, 6000),
    ]
      .filter(Boolean)
      .join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");

  const prompt = `Read this and describe the product for someone who will promote it.

${source}

Return JSON:
{"name": "<product name, 2 to 6 words>",
 "description": "<what it does and for whom, 100 to 200 characters, no adjectives that could describe anything>",
 "audience": "<who it is for, 50 to 100 characters>",
 "features": ["<3 to 5 concrete features or benefits, 20 to 50 characters each>"],
 "tone": "<one of: ${TONES.join(", ")}>"}`;

  const raw = await providerComplete(PROMOTE_SYSTEM, prompt, 1200);
  const parsed = extractJson<Partial<ProjectCopy>>(raw);
  const tone = TONES.includes(parsed.tone as (typeof TONES)[number]) ? (parsed.tone as (typeof TONES)[number]) : "professional";
  return {
    name: String(parsed.name ?? page.title ?? page.siteName).trim().slice(0, 120),
    description: String(parsed.description ?? page.description ?? "").trim().slice(0, 600),
    audience: String(parsed.audience ?? "").trim().slice(0, 200),
    features: Array.isArray(parsed.features) ? parsed.features.map(String).map((entry) => entry.trim()).filter(Boolean).slice(0, 6) : [],
    tone,
  };
}

export interface PlaceSuggestions {
  subreddits: string[];
  hashtags: string[];
  keywords: string[];
}

const cleanList = (value: unknown, strip: RegExp, max = 10): string[] =>
  Array.isArray(value) ? [...new Set(value.map(String).map((entry) => entry.trim().replace(strip, "")).filter(Boolean))].slice(0, max) : [];

/** Where to talk about it: subreddits without r/, hashtags without #, and search keywords. */
export async function suggestPlaces(project: ProjectBrief): Promise<PlaceSuggestions> {
  const prompt = `Suggest where to promote this product without being a nuisance.

${briefBlock(project)}

Return JSON:
{"subreddits": ["<up to 10 subreddit names without r/, where the audience actually is and self-promotion is tolerated when useful>"],
 "hashtags": ["<up to 10 hashtags without #, specific, lowercase, in use on X, Bluesky and Threads>"],
 "keywords": ["<up to 10 search phrases people type when they have the problem this solves>"]}`;

  const raw = await providerComplete(PROMOTE_SYSTEM, prompt, 1200);
  const parsed = extractJson<Partial<PlaceSuggestions>>(raw);
  return {
    subreddits: cleanList(parsed.subreddits, /^\/?r\//i),
    hashtags: cleanList(parsed.hashtags, /^#+/),
    keywords: cleanList(parsed.keywords, /^$/),
  };
}
