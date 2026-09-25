/**
 * The brand: one Markdown file that says who you are, who you are talking to,
 * what you keep coming back to, and what you refuse to say.
 *
 * myna had exactly one knob for this — `ai.voice`, a single sentence handed to
 * the writer. That is enough to stop a draft sounding like a press release and
 * nowhere near enough to make two drafts sound like the same person. Everything
 * that writes (the writer, follow-up replies, upvote replies, newsletter issues,
 * infographic copy) reads this instead.
 *
 * It is Markdown, in the config dir, with fixed headings, for the same reason
 * OpenProfile.md is: a person can edit it, git can diff it, and the sync job
 * can carry it between machines without anyone learning a schema.
 *
 * Nothing here asks a question. `learnBrand` reads what you have already posted
 * and the profile you already have, and writes the file. A brand you have to
 * sit an interview for is a brand that never gets written.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { BRAND_FILE, configPath, ensureConfigDir } from "../util/paths.ts";
import { listHistory } from "../store/history.ts";
import { currentProfile } from "../store/profile.ts";
import { topicIndex } from "./topics.ts";
import { extractJson, providerComplete, writerAvailable } from "../ai/writer.ts";
import { fetchPage } from "../ai/extract.ts";

/** One thing you post about, and why anyone cares. */
export interface Pillar {
  name: string;
  /** What this pillar actually argues, in a sentence. Empty is allowed. */
  note: string;
}

export interface Brand {
  name: string;
  /** Who the posts are for, in their own words rather than a demographic. */
  audience: string;
  /** What you claim that a competitor would not. */
  positioning: string;
  /** How it should sound. Longer and more specific than settings.ai.voice. */
  voice: string;
  pillars: Pillar[];
  /** Words, claims and habits that never go out. */
  avoid: string[];
  /** Pages worth linking when a post needs somewhere to point. */
  links: string[];
  /** The file as it was read, so a hand-written section survives a round trip. */
  raw: string;
}

export const EMPTY_BRAND: Brand = {
  name: "",
  audience: "",
  positioning: "",
  voice: "",
  pillars: [],
  avoid: [],
  links: [],
  raw: "",
};

export function brandPath(): string {
  return configPath(BRAND_FILE);
}

export function hasBrand(): boolean {
  return existsSync(brandPath());
}

const bullets = (block: string): string[] =>
  block
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s+/, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

/**
 * The body under a `## Heading`, up to the next heading of the same level.
 *
 * `$(?![\s\S])` is the end of the whole document: JS has no `\Z`, and plain
 * `$` under /m is the end of any line, which would cut every section short.
 * The heading line ends with `[ \t]*` rather than `\s*` for the same reason —
 * `\s` matches a newline, so a greedy run of it eats into the body.
 */
function section(markdown: string, heading: string): string {
  const pattern = new RegExp(`^##[ \\t]+${heading}[ \\t]*$([\\s\\S]*?)(?=^##[ \\t]|$(?![\\s\\S]))`, "im");
  return pattern.exec(markdown)?.[1]?.trim() ?? "";
}

/** A `**Key**: value` line from the header block. */
function field(markdown: string, key: string): string {
  const pattern = new RegExp(`^[-*]\\s*\\*\\*${key}\\*\\*:\\s*(.+)$`, "im");
  return pattern.exec(markdown)?.[1]?.trim() ?? "";
}

export function parseBrand(markdown: string): Brand {
  const pillars = bullets(section(markdown, "Pillars")).map((line) => {
    // "Name — what it argues", or just "Name". An em dash, a hyphen or a colon
    // all separate the two, because people write all three.
    const split = /^(.+?)\s*(?:[—–:]|\s-\s)\s*(.+)$/.exec(line);
    return split ? { name: split[1].trim(), note: split[2].trim() } : { name: line, note: "" };
  });
  return {
    name: /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? "",
    audience: section(markdown, "Audience") || field(markdown, "Audience"),
    positioning: section(markdown, "Positioning") || field(markdown, "Positioning"),
    voice: section(markdown, "Voice"),
    pillars,
    avoid: bullets(section(markdown, "Avoid")),
    links: bullets(section(markdown, "Links")).map((line) => {
      // Accept a bare URL or a Markdown link; the prompt only wants the target.
      return /\]\((\S+?)\)/.exec(line)?.[1] ?? line;
    }),
    raw: markdown,
  };
}

export function renderBrand(brand: Brand): string {
  const lines: string[] = [`# ${brand.name || "Brand"}`, ""];
  if (brand.audience) lines.push("## Audience", "", brand.audience, "");
  if (brand.positioning) lines.push("## Positioning", "", brand.positioning, "");
  if (brand.voice) lines.push("## Voice", "", brand.voice, "");
  if (brand.pillars.length) {
    lines.push("## Pillars", "");
    for (const pillar of brand.pillars) lines.push(pillar.note ? `- ${pillar.name}: ${pillar.note}` : `- ${pillar.name}`);
    lines.push("");
  }
  if (brand.avoid.length) {
    lines.push("## Avoid", "");
    for (const item of brand.avoid) lines.push(`- ${item}`);
    lines.push("");
  }
  if (brand.links.length) {
    lines.push("## Links", "");
    for (const link of brand.links) lines.push(`- ${link}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function loadBrand(): Brand | null {
  const path = brandPath();
  if (!existsSync(path)) return null;
  try {
    return parseBrand(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function saveBrand(brand: Brand): string {
  ensureConfigDir();
  const path = brandPath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, renderBrand(brand), { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  return path;
}

/**
 * The block handed to anything that writes.
 *
 * Deliberately short. A system prompt that carries three pages of brand
 * guidance produces copy that reads like it is reciting brand guidance.
 */
export function brandPrompt(brand: Brand | null = loadBrand()): string {
  if (!brand) return "";
  const parts: string[] = [];
  if (brand.name) parts.push(`You write as ${brand.name}.`);
  if (brand.audience) parts.push(`Audience: ${brand.audience}`);
  if (brand.positioning) parts.push(`What we claim: ${brand.positioning}`);
  if (brand.voice) parts.push(`Voice: ${brand.voice}`);
  if (brand.pillars.length) {
    parts.push(`Subjects we return to: ${brand.pillars.map((pillar) => pillar.name).join(", ")}`);
  }
  if (brand.avoid.length) parts.push(`Never: ${brand.avoid.join("; ")}`);
  return parts.length ? `\n\nBrand:\n${parts.join("\n")}` : "";
}

const LEARN_SYSTEM = `You are reading somebody's actual published posts and writing the brand document those posts imply.

You are describing what is already there, not proposing a rebrand. Rules:
- Infer only from the evidence given. If the posts do not support a claim, leave the field short rather than inventing one.
- Voice: describe how they already write, in specifics a writer could follow. Name habits, sentence length, what they never do. Not adjectives like "authentic" or "approachable".
- Pillars: 3 to 6 subjects they genuinely keep returning to, each with a sentence on what they argue about it. Not categories, arguments.
- Avoid: words, tics and claims absent from their writing that would read as false if added. Draw these from what the posts conspicuously do not do.
- Audience: who these posts are evidently for, in plain words.
- Positioning: the claim these posts make that a competitor would not.
Return only the JSON described. No preamble, no code fences.`;

interface LearnedBrand {
  name: string;
  audience: string;
  positioning: string;
  voice: string;
  pillars: { name: string; note: string }[];
  avoid: string[];
}

export interface LearnOptions {
  /** Read this page too, for a product the posts only allude to. */
  url?: string;
  /** How many sent posts to read. */
  limit?: number;
  log?: (line: string) => void;
}

export interface LearnResult {
  brand: Brand;
  path: string;
  /** How many of your own posts the model read. */
  read: number;
  /** Pages fetched for context. */
  sources: string[];
}

/**
 * Write brand.md from evidence: what you have posted, your OpenProfile, and
 * optionally your site. Asks nothing.
 *
 * Keeps any `## ` section of an existing file that this does not own, so a
 * paragraph somebody wrote by hand is not lost on the next run.
 */
export async function learnBrand(options: LearnOptions = {}): Promise<LearnResult> {
  const { log = () => {} } = options;
  const ready = writerAvailable();
  if (!ready.ok) throw new Error(`the writer is not available: ${ready.reason}`);

  const sent = listHistory().filter((entry) => entry.ok && entry.text.trim().length > 0);
  if (sent.length < 3) {
    throw new Error(
      `only ${sent.length} sent post${sent.length === 1 ? "" : "s"} to learn from. Post a few times first, or write ~/.config/myna/brand.md by hand.`,
    );
  }
  const limit = Math.max(20, options.limit ?? 120);
  const posts = sent.slice(0, limit);
  log(`reading ${posts.length} of your own posts`);

  const profile = currentProfile();
  const index = topicIndex(posts);
  const sources: string[] = [];

  let page = "";
  const url = options.url || profile.web || "";
  if (url) {
    try {
      const summary = await fetchPage(url);
      page = `\n\nTheir site (${summary.url}):\n${summary.title}\n${summary.description}\n${summary.text.slice(0, 3000)}`;
      sources.push(summary.url);
      log(`read ${summary.url}`);
    } catch (error) {
      // A site that will not load is not a reason to abandon the brand: the
      // posts are the better evidence anyway.
      log(`could not read ${url}: ${(error as Error).message}`);
    }
  }

  const corpus = posts
    .map((entry) => `[${entry.network}] ${entry.text.replace(/\s+/g, " ").slice(0, 400)}`)
    .join("\n");
  const terms = index.topics
    .slice(0, 20)
    .map((topic) => topic.term)
    .join(", ");

  const prompt = [
    profile.name ? `Name: ${profile.name}` : "",
    profile.headline ? `Headline: ${profile.headline}` : "",
    profile.topics.length ? `Topics they list: ${profile.topics.join(", ")}` : "",
    terms ? `Terms that recur in their posts: ${terms}` : "",
    page,
    "",
    "Their posts, newest first:",
    corpus,
    "",
    'Return JSON: {"name":"","audience":"","positioning":"","voice":"","pillars":[{"name":"","note":""}],"avoid":[""]}',
  ]
    .filter(Boolean)
    .join("\n");

  const raw = await providerComplete(LEARN_SYSTEM, prompt, 2000);
  const learned = extractJson<LearnedBrand>(raw);

  const existing = loadBrand();
  const brand: Brand = {
    name: learned.name?.trim() || profile.name || "Brand",
    audience: learned.audience?.trim() ?? "",
    positioning: learned.positioning?.trim() ?? "",
    voice: learned.voice?.trim() ?? "",
    pillars: (learned.pillars ?? [])
      .filter((pillar) => pillar?.name?.trim())
      .map((pillar) => ({ name: pillar.name.trim(), note: (pillar.note ?? "").trim() })),
    avoid: (learned.avoid ?? []).map((item) => item.trim()).filter(Boolean),
    // Links are ours to keep: the model has no business inventing URLs, and
    // whatever was in the file was put there on purpose.
    links: existing?.links ?? (profile.web ? [profile.web] : []),
    raw: "",
  };
  const path = saveBrand(brand);
  log(`wrote ${path}`);
  return { brand, path, read: posts.length, sources };
}
