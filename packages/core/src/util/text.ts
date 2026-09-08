/** Counting, splitting and hashtag handling — the parts every adapter shares. */

const URL_PATTERN = /https?:\/\/[^\s<>"]+/g;

/**
 * Characters a network will bill you for.
 * X counts every URL as 23 characters regardless of length; most others count
 * what you typed. Bluesky counts UTF-8 graphemes, so we count graphemes too.
 */
export function countChars(text: string, options: { urlWeight?: number } = {}): number {
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;
  const weight = options.urlWeight;
  if (!weight) return graphemes;
  let count = graphemes;
  for (const url of text.match(URL_PATTERN) ?? []) {
    count -= [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(url)].length;
    count += weight;
  }
  return count;
}

/**
 * Split long text into thread-sized parts, preferring paragraph then sentence
 * then word boundaries, and never cutting mid-word. When `numbered` is set the
 * "(1/3)" suffix is reserved out of the limit rather than pushing parts over it.
 */
export function splitThread(text: string, limit: number, numbered = true): string[] {
  const trimmed = text.trim();
  if (limit <= 0 || countChars(trimmed) <= limit) return [trimmed];

  // Two passes: the suffix width depends on the part count, which depends on
  // the suffix width. Start with a guess and re-split if the count grows.
  let reserve = numbered ? 8 : 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = chunk(trimmed, limit - reserve);
    const needed = numbered ? ` (${parts.length}/${parts.length})`.length : 0;
    if (needed <= reserve) {
      return numbered ? parts.map((part, i) => `${part} (${i + 1}/${parts.length})`) : parts;
    }
    reserve = needed;
  }
  return chunk(trimmed, Math.max(1, limit - reserve));
}

function chunk(text: string, size: number): string[] {
  if (size <= 0) return [text];
  const parts: string[] = [];
  let rest = text;

  while (countChars(rest) > size) {
    const window = rest.slice(0, size + 1);
    const cut =
      lastIndexOfAny(window, ["\n\n"], size) ??
      lastIndexOfAny(window, [". ", "! ", "? ", ".\n", "!\n", "?\n"], size) ??
      lastIndexOfAny(window, [" ", "\n"], size) ??
      size;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts.length ? parts : [text];
}

function lastIndexOfAny(haystack: string, needles: string[], limit: number): number | null {
  let best = -1;
  for (const needle of needles) {
    const index = haystack.lastIndexOf(needle);
    if (index > best && index > 0 && index <= limit) best = index + needle.length;
  }
  return best > 0 ? best : null;
}

export function extractHashtags(text: string): string[] {
  return [...new Set((text.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((tag) => tag.toLowerCase()))];
}

/** "Terminal UI" -> "#terminalui". Hashtags cannot contain spaces or punctuation. */
export function toHashtag(phrase: string): string {
  const cleaned = phrase
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim()
    .split(/\s+/)
    // Capitalise the joint, but keep the rest of each word as written so
    // acronyms survive: "Terminal UI" -> "#terminalUI", not "#terminalUi".
    .map((word, index) => (index === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1)))
    .join("");
  return cleaned ? `#${cleaned}` : "";
}

/**
 * Append as many hashtags as fit under the limit, skipping any already present.
 * Returns the text unchanged when none fit — a truncated hashtag is worse than
 * no hashtag.
 */
export function appendHashtags(text: string, tags: string[], limit: number, urlWeight?: number): string {
  const existing = new Set(extractHashtags(text));
  const candidates = tags
    .map((tag) => (tag.startsWith("#") ? tag : toHashtag(tag)))
    .filter((tag) => tag && !existing.has(tag.toLowerCase()));
  if (!candidates.length) return text;

  const body = text.trimEnd();
  const accepted: string[] = [];
  for (const tag of candidates) {
    const candidate = `${body}\n\n${[...accepted, tag].join(" ")}`;
    if (limit > 0 && countChars(candidate, { urlWeight }) > limit) break;
    accepted.push(tag);
  }
  return accepted.length ? `${body}\n\n${accepted.join(" ")}` : text;
}

export function truncateTo(text: string, limit: number, urlWeight?: number): string {
  if (limit <= 0 || countChars(text, { urlWeight }) <= limit) return text;
  let result = text;
  while (result.length > 1 && countChars(`${result}…`, { urlWeight }) > limit) {
    result = result.slice(0, -1);
  }
  return `${result.trimEnd()}…`;
}

/** Longest derived title worth sending. Boards and blogs truncate past this. */
const TITLE_CAP = 90;
/** Below this, a "sentence" is a fragment and the next one belongs in the title too. */
const TITLE_FLOOR = 24;

/**
 * A title for a post that was written without one.
 *
 * Forums, blogs and link aggregators reject an untitled post, so a fan-out to
 * `--to all` has to make a headline out of body text written for networks that
 * never asked for one. Taking the first line and cutting it at N characters is
 * what put "myna 0.15.1: a forum post fanned out with --to all now gets a real
 * title. It takes whole sentences instead of slicing the first line mid-clause,
 * drops a trailin" on a real board's front page.
 *
 * So: a markdown heading when the text has one, otherwise whole sentences up to
 * a cap, and a word boundary rather than a character count when even the first
 * sentence is too long.
 */
export function deriveTitle(text: string): string {
  const firstLine = text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";

  // A post's own H1 is a better title than anything derived from its prose.
  const heading = /^#{1,6}\s+(.+)$/.exec(firstLine);
  if (heading) return trimTitle(heading[1]);

  // A trailing link is how a social post ends and never how a title should.
  const withoutUrl = firstLine.replace(/\s*https?:\/\/\S+\s*$/, "").trim() || firstLine;

  // Sentence ends are ". " and friends. A period inside 0.15.2 is followed by a
  // digit rather than a space, so version numbers survive the split.
  let title = "";
  for (const sentence of withoutUrl.split(/(?<=[.!?])\s+/)) {
    const candidate = title ? `${title} ${sentence}` : sentence;
    if (title && candidate.length > TITLE_CAP) break;
    title = candidate;
    if (title.length >= TITLE_FLOOR) break;
  }

  return trimTitle(title || withoutUrl);
}

/** Cap on a word boundary, and do not leave dangling punctuation behind. */
function trimTitle(raw: string): string {
  const text = raw.replace(/\s+/g, " ").trim().replace(/[.,;:]+$/, "");
  if (text.length <= TITLE_CAP) return text;
  const cut = text.slice(0, TITLE_CAP);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > TITLE_CAP / 2 ? cut.slice(0, boundary) : cut).replace(/[.,;:]+$/, "")}…`;
}

/**
 * The body to send under a derived title.
 *
 * When the title came from the text's own heading, repeating that heading as
 * the first line of the post is just the title twice.
 */
export function bodyUnderTitle(text: string, title: string): string {
  const lines = text.split("\n");
  const first = lines.findIndex((line) => line.trim());
  if (first < 0) return text;
  const heading = /^#{1,6}\s+(.+)$/.exec(lines[first].trim());
  if (!heading || trimTitle(heading[1]) !== title) return text;
  return lines.slice(first + 1).join("\n").replace(/^\s+/, "");
}
