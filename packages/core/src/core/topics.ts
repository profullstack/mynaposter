/**
 * What we are about, read off what we have been posting.
 *
 * The upvoter has to find other people's posts that are worth a vote, and the
 * only honest definition of "worth" is: about the same thing we are. So this
 * reads our own send history, pulls out the terms that keep coming up,
 * weights them by how often and how recently, and hands back both the queries
 * to search with and a way to score whatever comes back.
 *
 * Deliberately plain: counting and decay, no model. The writer is expensive
 * and occasionally wrong, and a topic list is something a person should be
 * able to read and disagree with. `myna upvote topics` prints exactly this.
 */
import type { HistoryEntry } from "../store/history.ts";

/** A term we keep talking about, and the posts of ours it came from. */
export interface Topic {
  /** The word or two-word phrase, lowercased. */
  term: string;
  /** Relative importance, highest first. Frequency times recency. */
  weight: number;
  /** How many of our posts it appeared in. */
  posts: number;
}

/** One of our posts, reduced to what a link drop needs. */
export interface OurPost {
  id?: string;
  url: string;
  text: string;
  at: string;
  terms: Set<string>;
}

export interface TopicIndex {
  topics: Topic[];
  /** Our recent posts that have a URL worth pointing somebody at. */
  posts: OurPost[];
  /** The weight a perfect match is measured against. */
  reference: number;
}

const DAY_MS = 86_400_000;

/**
 * Words that carry no topic. English function words plus the vocabulary of
 * posting itself, which otherwise floats to the top of every list because
 * every announcement contains it.
 */
const STOPWORDS = new Set(
  (
    "a about above after again against all am an and any are aren as at be because been before being below between both but by " +
    "can cannot could couldn did didn do does doesn doing don down during each few for from further had hadn has hasn have haven " +
    "having he her here hers herself him himself his how i if in into is isn it its itself just me more most my myself no nor not " +
    "now of off on once only or other ought our ours ourselves out over own same shan she should shouldn so some such than that " +
    "the their theirs them themselves then there these they this those through to too under until up very was wasn we were weren " +
    "check try via still even back going done say said tell asked ask well right sure maybe thanks please " +
    "what when where which while who whom why will with won would wouldn you your yours yourself yourselves " +
    "new now out ship shipped ships shipping release released releases version update updated updates post posted posting blog " +
    "read more here link thread today week day time make makes made get gets got use used using one two three next last also " +
    "like want need know think see look going come take way thing things lot bit really much many good great best better"
  ).split(/\s+/),
);

/** Strip the things that are never a topic: URLs, mentions, punctuation, our own UTM tags. */
function clean(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/@[\w.@-]+/g, " ")
    .replace(/[`*_~>#\[\]()|]/g, " ")
    .toLowerCase();
}

const isTerm = (word: string): boolean => word.length >= 3 && word.length <= 32 && !STOPWORDS.has(word) && !/^\d+$/.test(word);

/** The words of a post, in order, with the noise gone. Hashtags keep their word. */
export function termsOf(text: string): string[] {
  const words = clean(text)
    .split(/[^a-z0-9+#.-]+/)
    .map((word) => word.replace(/^[#.-]+|[.-]+$/g, ""))
    .filter(Boolean);
  return words.filter(isTerm);
}

/**
 * The terms of a post as a set, single words plus adjacent pairs. The pairs
 * are what stop "open" and "source" from matching things that are neither.
 */
export function termSet(text: string): Set<string> {
  const words = termsOf(text);
  const set = new Set(words);
  for (let i = 0; i + 1 < words.length; i += 1) set.add(`${words[i]} ${words[i + 1]}`);
  return set;
}

export interface TopicOptions {
  /** How far back to read. */
  days?: number;
  now?: number;
  /** Most topics to keep. */
  limit?: number;
}

/**
 * Read our history into a topic index.
 *
 * Only successful posts count, and only their text: a failed send says
 * nothing about what we are about. Recency is a halving every `days/2`, so a
 * campaign from last week outranks one from a month ago without erasing it.
 */
export function topicIndex(entries: HistoryEntry[], options: TopicOptions = {}): TopicIndex {
  const days = options.days ?? 14;
  const now = options.now ?? Date.now();
  const limit = options.limit ?? 40;
  const cutoff = now - days * DAY_MS;
  const halfLife = Math.max(1, days / 2) * DAY_MS;

  const weights = new Map<string, number>();
  const counts = new Map<string, number>();
  const posts: OurPost[] = [];

  for (const entry of entries) {
    if (!entry.ok) continue;
    const at = Date.parse(entry.at);
    if (!Number.isFinite(at) || at < cutoff) continue;
    const text = `${entry.title ? `${entry.title} ` : ""}${entry.text}`;
    const terms = termSet(text);
    if (!terms.size) continue;

    // Halve the weight for every half-life of age.
    const recency = Math.pow(0.5, (now - at) / halfLife);
    for (const term of terms) {
      // A two-word phrase is a stronger signal than either word alone.
      const bonus = term.includes(" ") ? 1.6 : 1;
      weights.set(term, (weights.get(term) ?? 0) + recency * bonus);
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
    if (entry.url) posts.push({ id: entry.postId, url: entry.url, text, at: entry.at, terms });
  }

  const topics = [...weights.entries()]
    .map(([term, weight]): Topic => ({ term, weight, posts: counts.get(term) ?? 0 }))
    // A term from a single post is a coincidence; two is a subject. Single-post
    // terms are kept only when nothing else cleared the bar.
    .sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term))
    .slice(0, limit);

  const repeated = topics.filter((topic) => topic.posts > 1);
  const kept = repeated.length >= 3 ? repeated : topics;

  // A candidate that hits our three strongest topics is as on-subject as we
  // can ask for, so that is what a score of 1 means.
  const reference = kept.slice(0, 3).reduce((sum, topic) => sum + topic.weight, 0) || 1;
  return { topics: kept, posts: posts.sort((a, b) => b.at.localeCompare(a.at)), reference };
}

/**
 * The searches to run, strongest first.
 *
 * A two-word topic goes out as it is, because that is already a good query. A
 * single word is too broad alone, so it is paired with the strongest other
 * term it actually co-occurs with, and falls back to going out bare.
 */
export function queriesFor(index: TopicIndex, limit: number): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();
  const add = (query: string) => {
    const key = query.toLowerCase().trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    queries.push(key);
  };

  for (const topic of index.topics) {
    if (queries.length >= limit) break;
    if (topic.term.includes(" ")) add(topic.term);
  }
  for (const topic of index.topics) {
    if (queries.length >= limit) break;
    if (!topic.term.includes(" ")) add(topic.term);
  }
  return queries.slice(0, limit);
}

export interface Match {
  /** 0-1. How much of our subject this post is about. */
  score: number;
  /** Which of our topics it hit, strongest first. */
  matched: string[];
}

/** Score somebody else's post against what we are about. */
export function scoreAgainst(text: string, index: TopicIndex): Match {
  const terms = termSet(text);
  if (!terms.size || !index.topics.length) return { score: 0, matched: [] };

  let weight = 0;
  const matched: { term: string; weight: number }[] = [];
  for (const topic of index.topics) {
    if (!terms.has(topic.term)) continue;
    weight += topic.weight;
    matched.push(topic);
  }
  return {
    score: Math.min(1, weight / index.reference),
    matched: matched.sort((a, b) => b.weight - a.weight).map((topic) => topic.term),
  };
}

/**
 * Which of our posts to link, given what theirs is about.
 *
 * The one with the most terms in common, newest wins a tie. Returns nothing
 * when there is no real overlap, which is the case where a link would be an
 * advert rather than an answer — and then no link is dropped at all.
 */
export function bestLink(text: string, index: TopicIndex): OurPost | undefined {
  const terms = termSet(text);
  let best: { post: OurPost; overlap: number } | undefined;
  for (const post of index.posts) {
    let overlap = 0;
    for (const term of post.terms) if (terms.has(term)) overlap += term.includes(" ") ? 2 : 1;
    if (overlap < 2) continue;
    if (!best || overlap > best.overlap) best = { post, overlap };
  }
  return best?.post;
}
