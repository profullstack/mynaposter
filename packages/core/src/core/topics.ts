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
  /**
   * Relative importance, highest first. Distinctiveness times recency, not
   * frequency: see `topicIndex` for why the most frequent word we use is the
   * least useful thing about us.
   */
  weight: number;
  /** How many of our posts it appeared in. */
  posts: number;
  /** True for a two-word phrase, which is a far stronger signal than a word. */
  phrase: boolean;
  /**
   * True when hitting this term alone is evidence enough: a phrase, or a word
   * narrow enough that a stranger using it is probably talking about our
   * subject rather than brushing past it.
   */
  strong: boolean;
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
    "across within without around toward towards along upon per plus versus unless whether though although " +
    "what when where which while who whom why will with won would wouldn you your yours yourself yourselves " +
    "new now out ship shipped ships shipping release released releases version update updated updates post posted posting blog " +
    "read more here link thread today week day time make makes made get gets got use used using one two three next last also " +
    "like want need know think see look going come take way thing things lot bit really much many good great best better"
  ).split(/\s+/),
);

/**
 * Ordinary English that cannot be a subject on its own, and cannot make a
 * phrase into one either.
 *
 * This is the second half of the lesson that `topicIndex` documents. Inverse
 * document frequency correctly demotes a word we use in every post, but it
 * cannot see that a phrase is meaningless: post the same marketing sentence
 * twelve times and "costs money", "nothing costs" and "anyone playing" are
 * rare enough across the whole history to look highly distinctive, while
 * matching any stranger who ever mentioned the price of anything. On a real
 * install those three queued posts about the cost of living, satellite
 * streaks, rural plumbing and a waiter's story.
 *
 * So a topic has to contain at least one word from outside this list. "free
 * browser" survives on "browser"; "costs money" does not survive at all.
 */
const COMMON = new Set(
  (
    "free cost costs money price paid pay pays cheap expensive worth spend spent buy bought sell sold " +
    "play playing played game games anyone someone everyone nobody everybody people person folks " +
    "thing things stuff bit lots plenty part parts side sides place places home house world life lives living " +
    "week weeks month months year years day days hour hours minute minutes today tomorrow yesterday " +
    "big small large little long short high low easy hard simple quick fast slow early late " +
    "full empty half whole every each both few many much more most less least " +
    "old young real true false right wrong sure certain clear obvious " +
    "start starts started stop stops stopped keep keeps kept turn turns turned " +
    "help helps helped need needs needed want wants wanted try tries tried " +
    "made makes making take takes taken give gives given come comes coming " +
    "look looks looking feel feels felt seem seems find finds found " +
    "built build builds open opens opened close closed closes run running " +
    "work works working done doing goes going gone " +
    "talk talks said says saying tell tells told ask asks asked " +
    "call calls called move moves moved change changes changed " +
    "problem problems question questions answer answers idea ideas reason reasons " +
    "actually probably maybe perhaps definitely honestly literally basically " +
    "anything something nothing everything someone anybody " +
    "better best worse worst great good bad nice cool awesome amazing"
  ).split(/\s+/),
);

/** True when a term carries a subject: at least one word that is not ordinary English. */
export function contentful(term: string): boolean {
  return term.split(" ").some((word) => word && !COMMON.has(word));
}

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
 * Only successful posts count, and only their text: a failed send says nothing
 * about what we are about.
 *
 * The scoring is deliberately not frequency. An install that posts about a
 * dozen different products says "every", "page", "first" and "live" in most of
 * them, and those are the *least* distinctive things it says — rank by raw
 * count and the engine goes looking for strangers who used the word "first".
 * So a term is weighted by how concentrated it is: inverse document frequency
 * against our own corpus, which pushes filler down and a real subject up.
 *
 * Three rules fall out of that:
 *
 *   - A term in more than `MAX_DF` of our posts is our own filler, whatever it
 *     is, and is dropped outright.
 *   - A term in only one post is a coincidence, so two is the floor.
 *   - A two-word phrase beats either of its words, because "rope data" is a
 *     subject and "data" is not.
 *
 * Recency still applies, as a halving every `days/2`, so this month's campaign
 * outranks last month's without erasing it.
 */
/**
 * A term in more than this fraction of our own posts is filler, not a subject.
 * At 1000 posts about a dozen products, anything above roughly one post in ten
 * is vocabulary rather than topic.
 */
export const MAX_DF = 0.12;
/** A term in fewer posts than this is a coincidence, not a subject. */
export const MIN_POSTS = 2;
/** Below this many posts there is no filler to find, so none is filtered. */
export const SMALL = 10;
/**
 * A word in fewer than this fraction of our posts is narrow enough to stand on
 * its own as evidence. On a real install "desktop" sits at 7% and is about our
 * subject; "key" at 11% is a word we happen to use. The line is drawn between
 * them, and well under MAX_DF, so a term can pass the filler test and still
 * not be evidence on its own.
 */
export const STRONG_DF = 0.08;

export function topicIndex(entries: HistoryEntry[], options: TopicOptions = {}): TopicIndex {
  const days = options.days ?? 14;
  const now = options.now ?? Date.now();
  const limit = options.limit ?? 40;
  const cutoff = now - days * DAY_MS;
  const halfLife = Math.max(1, days / 2) * DAY_MS;

  const recencyOf = new Map<string, number>();
  const counts = new Map<string, number>();
  const posts: OurPost[] = [];
  let documents = 0;

  for (const entry of entries) {
    if (!entry.ok) continue;
    const at = Date.parse(entry.at);
    if (!Number.isFinite(at) || at < cutoff) continue;
    const text = `${entry.title ? `${entry.title} ` : ""}${entry.text}`;
    const terms = termSet(text);
    if (!terms.size) continue;
    documents += 1;

    // Halve the contribution for every half-life of age. Recency is summed
    // separately from the count, because the count is what decides whether a
    // term is a subject at all and must not be skewed by when it was said.
    const recency = Math.pow(0.5, (now - at) / halfLife);
    for (const term of terms) {
      recencyOf.set(term, (recencyOf.get(term) ?? 0) + recency);
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
    if (entry.url) posts.push({ id: entry.postId, url: entry.url, text, at: entry.at, terms });
  }

  // Distinctiveness: how much this term narrows down which of our posts it is.
  // A term spread across most of them narrows nothing.
  //
  // None of that applies to an install that has barely posted. With five posts
  // there is no such thing as filler, every term is rare, and a document
  // frequency ceiling would throw away the only subject there is, so below
  // `SMALL` the corpus is taken as it comes.
  const small = documents < SMALL;
  const floor = small ? 1 : MIN_POSTS;
  const ceiling = small ? documents : Math.max(MIN_POSTS, Math.floor(documents * MAX_DF));

  const weights = new Map<string, number>();
  for (const [term, count] of counts) {
    if (count < floor || count > ceiling) continue;
    // A phrase made only of ordinary words is rare in our corpus and
    // meaningless outside it, which is the worst possible combination.
    if (!contentful(term)) continue;
    // Smoothed, so a term in every post of a tiny corpus still has a weight
    // rather than being zeroed out of existence by log(1).
    const idf = Math.log((documents + 1) / count) + 0.25;
    // A phrase is worth more than either of its words on its own.
    const phrase = term.includes(" ") ? 2.2 : 1;
    weights.set(term, idf * phrase * (recencyOf.get(term) ?? 0));
  }

  const strongAt = Math.max(1, documents * STRONG_DF);
  const kept = [...weights.entries()]
    .map(([term, weight]): Topic => {
      const posts = counts.get(term) ?? 0;
      const phrase = term.includes(" ");
      return { term, weight, posts, phrase, strong: phrase || posts <= strongAt };
    })
    .sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term))
    .slice(0, limit);

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

  // Phrases first: they are already good queries.
  for (const topic of index.topics) {
    if (queries.length >= limit) break;
    if (topic.phrase) add(topic.term);
  }

  // A single word is a bad search on its own however distinctive it looks, so
  // the strongest words are paired with each other rather than sent bare. Two
  // narrow words find people talking about both; one finds the whole network.
  const words = index.topics.filter((topic) => !topic.phrase).map((topic) => topic.term);
  for (let i = 0; i + 1 < words.length && queries.length < limit; i += 2) {
    add(`${words[i]} ${words[i + 1]}`);
  }
  // Only if there was nothing else at all.
  if (!queries.length && words[0]) add(words[0]);
  return queries.slice(0, limit);
}

export interface Match {
  /** 0-1. How much of our subject this post is about. */
  score: number;
  /** Which of our topics it hit, strongest first. */
  matched: string[];
}

/**
 * Score somebody else's post against what we are about.
 *
 * Matching one of our words is usually a coincidence: a long post will brush
 * against somebody's vocabulary by chance. So a post has to hit either one
 * term narrow enough to be evidence on its own (a phrase, or a word we use in
 * only a small fraction of our posts) or two distinct terms. Anything less
 * scores nothing at all, which is the right answer far more often than not.
 */
export function scoreAgainst(text: string, index: TopicIndex): Match {
  const terms = termSet(text);
  if (!terms.size || !index.topics.length) return { score: 0, matched: [] };

  let weight = 0;
  let strong = 0;
  const matched: { term: string; weight: number }[] = [];
  for (const topic of index.topics) {
    if (!terms.has(topic.term)) continue;
    weight += topic.weight;
    if (topic.strong) strong += 1;
    matched.push(topic);
  }

  if (!strong && matched.length < 2) return { score: 0, matched: [] };
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
