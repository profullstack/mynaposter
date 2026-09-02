/**
 * The AI writer.
 *
 * Optional throughout: myna is a perfectly good poster with the writer switched
 * off. When it is on, it drafts copy — it never posts on its own, and every
 * draft lands in the compose box for you to edit first.
 */
import { loadSettings } from "../store/settings.ts";
import { requireNetwork } from "../net/registry.ts";
import { fetchPage, type PageSummary } from "./extract.ts";
import { complete as completeAnthropic, hasCredentials as hasAnthropic } from "./anthropic.ts";
import { completeOpenAI, completeOllama } from "./openai.ts";

export interface Draft {
  /** Network id, or "" for a single draft meant for everywhere. */
  network: string;
  text: string;
  hashtags: string[];
}

export interface DraftRequest {
  /** What to write about. Ignored when `url` is set and this is empty. */
  prompt?: string;
  /** A link to read and write a post about. */
  url?: string;
  /** Networks to tailor for. Empty means one shared draft. */
  networks?: string[];
  /** Overrides the saved voice for this draft only. */
  voice?: string;
  maxHashtags?: number;
}

const SYSTEM = `You write social media posts for someone who despises marketing voice.

Rules, all of them load-bearing:
- Write what a knowledgeable person would actually say. No hype, no "game changer", no "excited to announce", no rhetorical questions as openers.
- No em dashes. Use a comma, a full stop, or a new sentence.
- Do not open with a one-word hook line. Do not end with a call to action unless asked.
- Never invent facts, numbers, quotes or features. If the source does not say it, it does not go in the post.
- Respect each network's character limit exactly. The limit is a hard ceiling, not a target.
- Hashtags only where the network uses them, lowercase, specific, at most the number requested. No #innovation, #tech, #future.
- Return only the JSON described. No preamble, no code fences.`;

function providerComplete(system: string, prompt: string, maxTokens = 4000): Promise<string> {
  const { ai } = loadSettings();
  switch (ai.provider) {
    case "openai":
      return completeOpenAI({ system, prompt, model: ai.model, maxTokens });
    case "ollama":
      return completeOllama({ system, prompt, model: ai.model, maxTokens });
    default:
      return completeAnthropic({ system, prompt, model: ai.model, maxTokens });
  }
}

/** True when the configured provider has what it needs to run. */
export function writerAvailable(): { ok: boolean; reason?: string } {
  const { ai } = loadSettings();
  if (ai.provider === "anthropic" && !hasAnthropic()) {
    return { ok: false, reason: "ANTHROPIC_API_KEY is not set. Run `myna config ai.provider ollama` to use a local model instead." };
  }
  if (ai.provider === "openai" && !process.env.OPENAI_API_KEY) {
    return { ok: false, reason: "OPENAI_API_KEY is not set." };
  }
  return { ok: true };
}

/**
 * Models wrap JSON in prose or fences no matter how firmly you ask them not to.
 * Pull the first balanced object or array out rather than trusting the shape.
 */
export function extractJson<T>(raw: string): T {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    /* fall through to scanning */
  }

  const start = cleaned.search(/[[{]/);
  if (start === -1) throw new Error(`The model returned no JSON:\n${raw.slice(0, 300)}`);

  const open = cleaned[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < cleaned.length; i++) {
    const char = cleaned[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') inString = !inString;
    if (inString) continue;
    if (char === open) depth++;
    if (char === close) depth--;
    if (depth === 0) {
      return JSON.parse(cleaned.slice(start, i + 1)) as T;
    }
  }
  throw new Error(`The model returned unbalanced JSON:\n${raw.slice(0, 300)}`);
}

function describeNetworks(ids: string[]): string {
  return ids
    .map((id) => {
      const network = requireNetwork(id);
      const limit = network.caps.charLimit ? `${network.caps.charLimit} characters max` : "no character limit";
      const title = network.caps.needsTitle ? ", needs a separate title" : "";
      return `- ${network.id} (${network.name}): ${limit}${title}`;
    })
    .join("\n");
}

function sourceBlock(page: PageSummary): string {
  return [
    `URL: ${page.url}`,
    page.title && `Title: ${page.title}`,
    page.siteName && `Site: ${page.siteName}`,
    page.author && `Author: ${page.author}`,
    page.description && `Description: ${page.description}`,
    "",
    "Page text:",
    page.text,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Draft one post per network, or a single shared draft when no networks are
 * given. When `url` is set the page is fetched first and the link is kept in
 * the post, since a post about a link that omits the link is useless.
 */
export async function draft(request: DraftRequest): Promise<Draft[]> {
  const settings = loadSettings();
  const voice = request.voice ?? settings.ai.voice;
  const maxHashtags = request.maxHashtags ?? settings.ai.maxHashtags;
  const networks = request.networks ?? [];

  let source = "";
  if (request.url) {
    const page = await fetchPage(request.url);
    source = `\n\nWrite about this page. Include the URL in every post.\n\n${sourceBlock(page)}`;
  }

  const instruction = request.prompt?.trim();
  const task = instruction
    ? `What to write about:\n${instruction}`
    : "Write a post about the page below.";

  const shape = networks.length
    ? `Return a JSON array with one object per network, in this order: ${networks.join(", ")}.\n` +
      `Each object: {"network": "<id>", "text": "<the post>", "hashtags": ["#tag"]}\n\n` +
      `Networks and their limits:\n${describeNetworks(networks)}`
    : `Return a JSON array with exactly one object: [{"network": "", "text": "<the post>", "hashtags": ["#tag"]}]`;

  const prompt = [
    task,
    source,
    "",
    `Voice: ${voice}`,
    `Hashtags: at most ${maxHashtags} per post, or an empty array if none fit naturally.`,
    "",
    shape,
  ].join("\n");

  const raw = await providerComplete(SYSTEM, prompt);
  const parsed = extractJson<Draft[]>(raw);
  const drafts = Array.isArray(parsed) ? parsed : [parsed];

  return drafts
    .filter((entry) => entry && typeof entry.text === "string")
    .map((entry) => ({
      network: entry.network ?? "",
      text: entry.text.trim(),
      hashtags: Array.isArray(entry.hashtags) ? entry.hashtags.slice(0, maxHashtags) : [],
    }));
}

export interface InfographicCopy {
  title: string;
  subtitle: string;
  /** 3 to 6 short points. Each is a label and an optional figure. */
  points: { label: string; value?: string }[];
  footer: string;
  /** A post to publish alongside the graphic. */
  caption: string;
  hashtags: string[];
}

/**
 * Pick the words for an infographic. Deliberately separate from rendering:
 * the model chooses the copy, myna draws it, so the text on the image is
 * exactly the text here.
 */
export async function infographicCopy(request: DraftRequest): Promise<InfographicCopy> {
  const settings = loadSettings();
  let source = "";
  if (request.url) {
    const page = await fetchPage(request.url);
    source = `\n\n${sourceBlock(page)}`;
  }

  const prompt = [
    request.prompt?.trim() || "Summarize the page below as an infographic.",
    source,
    "",
    `Voice: ${request.voice ?? settings.ai.voice}`,
    "",
    "Return JSON:",
    `{"title": "<6 words max>", "subtitle": "<12 words max, or empty>",`,
    ` "points": [{"label": "<8 words max>", "value": "<a number or short figure, or omit>"}],`,
    ` "footer": "<source or url>", "caption": "<the post to publish with the image>", "hashtags": ["#tag"]}`,
    "",
    "Between 3 and 6 points. Every figure must come from the source; never invent one.",
  ].join("\n");

  const raw = await providerComplete(SYSTEM, prompt, 2000);
  const copy = extractJson<InfographicCopy>(raw);

  return {
    title: copy.title ?? "",
    subtitle: copy.subtitle ?? "",
    points: (copy.points ?? []).slice(0, 6).filter((point) => point?.label),
    footer: copy.footer ?? "",
    caption: copy.caption ?? "",
    hashtags: (copy.hashtags ?? []).slice(0, settings.ai.maxHashtags),
  };
}

/** Rewrite an existing draft — shorter, warmer, different angle. */
export async function revise(text: string, instruction: string, network?: string): Promise<string> {
  const limit = network ? requireNetwork(network).caps.charLimit : 0;
  const prompt = [
    `Rewrite this post. ${instruction}`,
    limit ? `Hard limit: ${limit} characters.` : "",
    "",
    "Post:",
    text,
    "",
    `Return JSON: {"network": "${network ?? ""}", "text": "<the rewrite>", "hashtags": []}`,
  ]
    .filter(Boolean)
    .join("\n");

  const raw = await providerComplete(SYSTEM, prompt, 2000);
  return extractJson<Draft>(raw).text.trim();
}

/**
 * Ask the model for the infographic as HTML/CSS.
 *
 * This is the `html` backend: the model gets to make design decisions, but the
 * text is still text — rendered by a browser, not painted by an image model —
 * so it cannot come out misspelled or invented.
 */
export async function infographicHtml(copy: InfographicCopy, width: number, height: number): Promise<string> {
  const settings = loadSettings();
  const prompt = [
    `Design an infographic as a single HTML fragment, exactly ${width}x${height} pixels.`,
    "",
    "Content, to be used verbatim. Do not reword, add or drop anything:",
    JSON.stringify({ title: copy.title, subtitle: copy.subtitle, points: copy.points, footer: copy.footer }, null, 2),
    "",
    "Requirements:",
    `- One root <div> with inline <style>, sized exactly ${width}px by ${height}px.`,
    `- Dark background around ${settings.infographic.background}, accent colour ${settings.infographic.accent}.`,
    "- System font stack only. No external fonts, images, scripts or network requests.",
    "- Everything must fit without scrolling or clipping. Leave generous margins.",
    "- No emoji. No fake charts with invented numbers; only the figures given above.",
    "",
    'Return JSON: {"network": "", "text": "<the HTML fragment>", "hashtags": []}',
  ].join("\n");

  const raw = await providerComplete(
    "You are a designer who writes clean, self-contained HTML and CSS. Return only the JSON described.",
    prompt,
    8000,
  );
  return extractJson<Draft>(raw).text.trim();
}
