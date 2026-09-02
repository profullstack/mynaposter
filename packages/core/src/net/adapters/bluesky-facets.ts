/**
 * Bluesky rich-text facets.
 *
 * Bluesky parses nothing out of post text. A URL posted as plain text stays
 * plain text and a hashtag is just a word beginning with '#'. Anything that
 * should be clickable has to be described by a facet giving its byte range and
 * what it points at. There is no auto-parse flag to turn on.
 *
 * The part that bites: those offsets are UTF-8 *bytes*, while JavaScript string
 * indices are UTF-16 code units. One emoji, accented character or CJK word
 * before a link shifts the two apart and the facet highlights the wrong span.
 *
 * Ported from crawlproof.com's lib/sp/blueskyFacets.ts, which had already found
 * the edge cases myna's first version got wrong: facets have to arrive sorted
 * and non-overlapping or the API rejects them, and a hashtag matched inside a
 * URL produces exactly such an overlap.
 */

export interface BlueskyFacet {
  index: { byteStart: number; byteEnd: number };
  features: (
    | { $type: "app.bsky.richtext.facet#link"; uri: string }
    | { $type: "app.bsky.richtext.facet#tag"; tag: string }
  )[];
}

/** Bluesky counts 300 graphemes, and separately caps the record at 3000 bytes. */
export const MAX_GRAPHEMES = 300;
export const MAX_BYTES = 3000;

const URL_RE = /https?:\/\/[^\s<>"']+/g;

// A '#' starting a word. The lookbehind stops it firing inside a URL fragment
// or an identifier like `foo#bar`.
const TAG_RE = /(?<![\w/])#([^\s#.,;:!?()[\]{}<>"']+)/g;

/** Trailing characters that are almost always sentence punctuation, not URL. */
const TRAILING_PUNCT = /[.,;:!?)\]}'"]+$/;

const byteLen = (value: string): number => Buffer.byteLength(value, "utf8");

/** Byte offset of a UTF-16 index, which is what a facet index actually means. */
const byteOffsetOf = (text: string, charIndex: number): number => byteLen(text.slice(0, charIndex));

/**
 * Build the facets for a post.
 *
 * Sorted by start offset and non-overlapping, which is what the API expects; an
 * unsorted or overlapping set is rejected or renders wrong.
 */
export function buildFacets(text: string): BlueskyFacet[] {
  const facets: BlueskyFacet[] = [];
  const taken: [number, number][] = [];
  const overlaps = (start: number, end: number) => taken.some(([s, e]) => start < e && end > s);

  for (const match of text.matchAll(URL_RE)) {
    const raw = match[0];
    // "Read https://example.com." should link the URL, not the full stop.
    // A closing bracket only comes off when unbalanced, so a URL that
    // legitimately ends in ')' -- Wikipedia does this -- survives.
    let url = raw.replace(TRAILING_PUNCT, "");
    if (url.includes("(") && !url.includes(")") && raw.startsWith(`${url})`)) url = `${url})`;
    if (!url) continue;

    const start = match.index ?? 0;
    const end = start + url.length;
    if (overlaps(start, end)) continue;
    taken.push([start, end]);

    facets.push({
      index: { byteStart: byteOffsetOf(text, start), byteEnd: byteOffsetOf(text, end) },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: url }],
    });
  }

  for (const match of text.matchAll(TAG_RE)) {
    const tag = match[1].replace(TRAILING_PUNCT, "");
    // Bluesky rejects an empty tag and caps them at 64 characters. A purely
    // numeric one is nearly always "#1" in prose rather than a tag.
    if (!tag || tag.length > 64 || /^\d+$/.test(tag)) continue;

    const start = match.index ?? 0;
    const end = start + 1 + tag.length;
    if (overlaps(start, end)) continue;
    taken.push([start, end]);

    facets.push({
      index: { byteStart: byteOffsetOf(text, start), byteEnd: byteOffsetOf(text, end) },
      features: [{ $type: "app.bsky.richtext.facet#tag", tag }],
    });
  }

  return facets.sort((a, b) => a.index.byteStart - b.index.byteStart);
}

/**
 * Length as Bluesky counts it: graphemes, not UTF-16 code units.
 * `"🚀".length` is 2, so a naive check rejects posts the API would accept.
 */
export function graphemeLength(text: string): number {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;
  }
  return [...text].length;
}

/**
 * Trim a post to Bluesky's limits without corrupting it.
 *
 * `text.slice(0, 300)` is wrong twice: it counts UTF-16 code units, so an emoji
 * spends two of the 300, and it can cut between the halves of a surrogate pair,
 * producing a lone surrogate that is not valid UTF-8.
 */
export function truncateForBluesky(text: string): string {
  let out = text;

  const segmenter =
    typeof Intl !== "undefined" && "Segmenter" in Intl
      ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
      : null;

  if (segmenter) {
    const graphemes = [...segmenter.segment(out)].map((piece) => piece.segment);
    if (graphemes.length > MAX_GRAPHEMES) out = graphemes.slice(0, MAX_GRAPHEMES).join("");
  } else {
    const points = [...out];
    if (points.length > MAX_GRAPHEMES) out = points.slice(0, MAX_GRAPHEMES).join("");
  }

  // Byte ceiling. Drop whole code points so the result stays valid UTF-8.
  while (byteLen(out) > MAX_BYTES) {
    const points = [...out];
    points.pop();
    out = points.join("");
  }

  return out;
}

/** The post record, facets included, ready for com.atproto.repo.createRecord. */
export function buildPostRecord(text: string, createdAt: string): Record<string, unknown> {
  const trimmed = truncateForBluesky(text);
  const facets = buildFacets(trimmed);
  return {
    $type: "app.bsky.feed.post",
    text: trimmed,
    createdAt,
    // Omitted entirely when empty: an empty array is legal but noise.
    ...(facets.length ? { facets } : {}),
  };
}
