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
