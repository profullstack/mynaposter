/**
 * Pain phrases: the words people use when the problem hits them.
 *
 * "SaaS" and "startup" find people talking about products. "can't find
 * communities" and "nobody sees my posts" find people who have the problem
 * right now and already want a fix, which is the thread where an answer is
 * welcome. So each product carries a short list of complaint phrases,
 * written by the writer from what the product does and edited by a person,
 * and a post that matches one ranks above any keyword match.
 *
 * Two uses. Every post a scan reads anyway is checked against the phrases
 * (free), and each scan spends a few archive searches on a phrase inside a
 * sub (Arctic Shift needs a subreddit or an author for a text query), taking
 * turns so every phrase gets read.
 */
import { painPhrasesDraft, writerAvailable, type PainPhraseRequest } from "../ai/writer.ts";
import { findIn, readAsks, writeAsks, type AskProduct } from "../store/asks.ts";

/** What every complaint phrase is checked against: lower case, straight apostrophes, single spaces. */
export function normalizePain(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/\bcan ?not\b/g, "can't")
    .replace(/\b(can|don|won|isn|doesn|didn|aren)t\b/g, "$1't")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const FILLER = new Set("a an the my our your i we to of for in on is are it me".split(" "));

/**
 * The phrase a text matches, if any. A literal match first; failing that,
 * every content word of the phrase inside one sentence, in order, so
 * "I can't seem to find any good communities" still matches "can't find
 * communities".
 */
export function matchPain(phrases: string[], text: string): string | undefined {
  const sentences = text.split(/(?<=[.!?\n])\s+/).map(normalizePain).filter(Boolean);
  const whole = normalizePain(text);
  for (const phrase of phrases) {
    const needle = normalizePain(phrase);
    if (needle && ` ${whole} `.includes(` ${needle} `)) return phrase;
  }
  for (const phrase of phrases) {
    const words = normalizePain(phrase).split(" ").filter((word) => word && !FILLER.has(word));
    if (words.length < 2) continue;
    for (const sentence of sentences) {
      const tokens = sentence.split(" ");
      let at = 0;
      let gap = 0;
      for (const token of tokens) {
        if (at >= words.length) break;
        const word = words[at]!;
        if (token === word || (word.length > 4 && token.startsWith(word.replace(/s$/, "")))) {
          at += 1;
          gap = 0;
        } else if (at > 0 && ++gap > 4) {
          at = 0;
          gap = 0;
        }
      }
      if (at >= words.length) return phrase;
    }
  }
  return undefined;
}

/** Tidy a list: lower case, 2-6 words, no category words, no duplicates, at most 20. */
export function cleanPhrases(phrases: string[], product?: Pick<AskProduct, "name">): string[] {
  const banned = /\b(?:saas|startup|startups|platform|software|solution)\b/;
  const name = product?.name.toLowerCase();
  const out: string[] = [];
  for (const raw of phrases) {
    const phrase = normalizePain(String(raw));
    const words = phrase.split(" ").filter(Boolean);
    if (words.length < 2 || words.length > 6) continue;
    if (banned.test(phrase) || (name && phrase.includes(name))) continue;
    if (!out.includes(phrase)) out.push(phrase);
  }
  return out.slice(0, 20);
}

/**
 * Phrases with no writer: the product's own keywords turned into the
 * complaints that most often carry them. Weak, and said so, but a starting
 * list a person can edit beats an empty one.
 */
export function templatePhrases(product: Pick<AskProduct, "name" | "keywords">): string[] {
  const out: string[] = [];
  for (const keyword of product.keywords.slice(0, 5)) {
    out.push(`can't find ${keyword}`, `${keyword} is too hard`, `struggling with ${keyword}`);
  }
  return cleanPhrases(out, product);
}

export type PhraseWriter = (request: PainPhraseRequest) => Promise<string[]>;

/** Draft the phrases for one product: the writer when there is one, the template otherwise. */
export async function draftPainPhrases(
  product: Pick<AskProduct, "name" | "url" | "about" | "keywords">,
  writer?: PhraseWriter | null,
): Promise<{ phrases: string[]; by: "writer" | "template" }> {
  const use = writer === null ? undefined : (writer ?? (writerAvailable().ok ? painPhrasesDraft : undefined));
  if (use) {
    const phrases = cleanPhrases(await use({ name: product.name, url: product.url, ...(product.about ? { about: product.about } : {}), keywords: product.keywords }), product);
    if (phrases.length) return { phrases, by: "writer" };
  }
  return { phrases: templatePhrases(product), by: "template" };
}

/**
 * Change one product's phrases. `set` replaces the list, `add` and `remove`
 * edit it, `generate` asks the writer (and merges with what a person kept
 * unless `set` came too).
 */
export async function editPainPhrases(
  ref: string,
  edit: { set?: string[]; add?: string[]; remove?: string[]; generate?: boolean; writer?: PhraseWriter | null },
): Promise<{ product: AskProduct; by?: "writer" | "template" }> {
  const file = readAsks();
  const product = findIn(file.products, ref);
  if (!product) throw new Error(`No product ${ref}. myna asks product list`);
  let phrases = edit.set ? cleanPhrases(edit.set, product) : [...(product.painPhrases ?? [])];
  let by: "writer" | "template" | undefined;
  if (edit.generate) {
    const drafted = await draftPainPhrases(product, edit.writer);
    by = drafted.by;
    phrases = cleanPhrases([...phrases, ...drafted.phrases], product);
  }
  if (edit.add?.length) phrases = cleanPhrases([...phrases, ...edit.add], product);
  if (edit.remove?.length) {
    const drop = new Set(edit.remove.map(normalizePain));
    phrases = phrases.filter((phrase) => !drop.has(normalizePain(phrase)));
  }
  product.painPhrases = phrases;
  writeAsks(file);
  return { product, ...(by ? { by } : {}) };
}

/** One archive search: a phrase, inside a sub, for a product. */
export interface PainQuery {
  product: string;
  phrase: string;
  sub: string;
}

/**
 * The next `limit` searches, taking turns over every product, phrase and
 * sub from `cursor` on, so a short budget per scan still reaches all of them.
 */
export function painQueries(products: AskProduct[], subs: string[], cursor: number, limit: number): { queries: PainQuery[]; next: number } {
  const all: PainQuery[] = [];
  for (const product of products) {
    const where = product.painSubs?.length ? product.painSubs : subs;
    for (const phrase of product.painPhrases ?? []) for (const sub of where) all.push({ product: product.id, phrase, sub });
  }
  if (!all.length || limit <= 0) return { queries: [], next: 0 };
  const start = ((cursor % all.length) + all.length) % all.length;
  const queries: PainQuery[] = [];
  for (let index = 0; index < Math.min(limit, all.length); index += 1) queries.push(all[(start + index) % all.length]!);
  return { queries, next: (start + queries.length) % all.length };
}

/** The product whose phrase a text matches, and the phrase. */
export function painOf(products: AskProduct[], text: string): { product: AskProduct; phrase: string } | undefined {
  for (const product of products) {
    const phrase = product.painPhrases?.length ? matchPain(product.painPhrases, text) : undefined;
    if (phrase) return { product, phrase };
  }
  return undefined;
}
