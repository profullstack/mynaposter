/**
 * Asks: finding people who asked for a site that does X, Y and Z, adding up
 * how many asked for the same thing, answering them, and watching what the
 * answer did.
 *
 * Four parts.
 *
 *   scan     read each subreddit's feed, keep the posts that are somebody
 *            asking for a tool (`classifyAsk`), pull out what they want it to
 *            do, and group them into ideas by what they share.
 *   ideas    one ask is an anecdote. An idea that `asks.buildAt` different
 *            people asked for inside `asks.windowDays` is flagged `build`.
 *   reply    a drafted answer, on a hand-off card a person pastes: Reddit has
 *            no account here and no API we may post through, so the card is
 *            the adapter. When one of our products answers the ask, the reply
 *            points at it with a UTM-tagged link and says we work on it.
 *   stats    the thread's score and comments, and once we have replied, our
 *            comment's score and the answers it got, re-read on a schedule.
 *
 * Where the data comes from, and why: Reddit blocks this box and every
 * datacenter address outright, so posts are read from RSS Amplifier's
 * subreddit mirrors (`/r/<sub>.json`, which the crawler there fills) and the
 * numbers from the Arctic Shift archive, which answers anonymously. A sub RSS
 * Amplifier has not read yet falls back to the archive's newest posts.
 */
import { getJson } from "../util/http.ts";
import { loadSettings, type AsksSettings } from "../store/settings.ts";
import {
  findIn,
  readAsks,
  writeAsks,
  type Ask,
  type AskProduct,
  type AskStats,
  type AsksFile,
  type AskStatus,
  type Idea,
  type IdeaStatus,
} from "../store/asks.ts";
import { addHandoff, attachCloud, cloudSignedIn, getHandoff, publishHandoff, type Handoff } from "../store/handoffs.ts";
import { askJudge, askReplyDraft, writerAvailable, type AskJudgeInput, type AskJudgement, type AskReplyRequest } from "../ai/writer.ts";
import { contentful, termsOf } from "./topics.ts";
import { runAfterDiscover } from "../plugins/hooks.ts";

const DAY_MS = 86_400_000;

// ------------------------------------------------------------------ detection

/** The things a person asks for. "Is there a ___" only counts when the blank is one of these. */
const NOUN =
  "(?:web ?apps?|apps?|sites?|websites?|tools?|services?|software|platforms?|programs?|extensions?|plugins?|add-?ons?|bots?|apis?|saas|" +
  "solutions?|alternatives?|products?|marketplaces?|directory|directories|trackers?|dashboards?|cli|utility|utilities|providers?|subscriptions?|" +
  "managers?|editors?|generators?|planners?|organi[sz]ers?|schedulers?|readers?|players?|launchers?|converters?|downloaders?|clients?|viewers?|" +
  "calculators?|finders?|builders?|makers?|blockers?|recorders?|scanners?|monitors?|notifiers?|aggregators?|crm|erp|widgets?|keyboards?|browsers?)";
/** Up to five words between the article and the noun: "a free open source self-hosted ___". */
const GAP = "(?:[\\w'+-]+\\s+){0,5}?";
const ART = "(?:a|an|any|some|good|decent)";

const rx = (source: string): RegExp => new RegExp(source, "i");

/** Each pattern: the name an ask is filed under, how sure it makes us, and the shape. Strongest first. */
const PATTERNS: Array<[kind: string, weight: number, pattern: RegExp]> = [
  ["is-there", 0.65, rx(`\\b(?:is|are) there (?:${ART}\\s+)?${GAP}${NOUN}\\b`)],
  ["does-it-exist", 0.6, rx(`\\bdoes (?:this|something like this|such an? \\w+|a \\w+ like this) (?:even )?exist\\b`)],
  ["anyone-know", 0.65, rx(`\\b(?:does|do) (?:anyone|anybody|any of you|you guys|y'?all) know (?:of )?${ART}?\\s*${GAP}${NOUN}\\b`)],
  ["anyone-know", 0.6, rx(`\\b(?:anyone|anybody) (?:know|knows|recommend|use) (?:of )?${ART}\\s+${GAP}${NOUN}\\b`)],
  ["looking-for", 0.6, rx(`\\b(?:looking|searching|hunting) for ${ART}?\\s*${GAP}${NOUN}\\b`)],
  ["wish", 0.6, rx(`\\b(?:i )?wish (?:there (?:was|were|existed)|someone (?:would|made|built)|i could find)\\b`)],
  ["someone-build", 0.6, rx(`\\b(?:someone|somebody) (?:should|needs to|please|pls) (?:make|build|create)\\b`)],
  ["recommend", 0.55, rx(`\\b(?:recommendations?|suggestions?|recs) (?:for|on) ${ART}?\\s*${GAP}${NOUN}\\b`)],
  ["recommend", 0.55, rx(`\\bcan (?:anyone|someone|you|somebody) (?:recommend|suggest|point me to) ${ART}?\\s*${GAP}${NOUN}\\b`)],
  ["need", 0.5, rx(`\\bi(?:'m| am)? (?:need|want|looking for) (?:a|an|some)\\s+${GAP}${NOUN} (?:that|which|to|for|where|with)\\b`)],
  ["what-do-you-use", 0.5, rx(`\\bwhat (?:app|tool|site|software|service|platform)s? (?:do|does|are|should) (?:you|everyone|people|i|y'?all)\\b`)],
  ["recommend", 0.55, rx(`\\b${NOUN} (?:recommendations?|suggestions?|recs)\\b`)],
  ["best-for", 0.5, rx(`\\b(?:best|any good|good) ${GAP}${NOUN}(?:\\s+(?:for|to|that|with)\\b|\\s*\\?)`)],
  ["how-do-you-manage", 0.4, rx(`\\bhow (?:do|does|are) (?:you|everyone|people|y'?all|small businesses|agencies|teams|others) (?:keep track of|track|manage|handle|organi[sz]e|automate|monitor|schedule)\\b`)],
  ["alternative", 0.45, rx(`\\b(?:alternatives?|replacement) (?:to|for) [\\w.-]+`)],
  ["would-pay", 0.45, rx(`\\bi(?:'d| would) (?:happily |gladly )?pay for ${ART}?\\s*\\w+`)],
];

/**
 * Posts that use the words of an ask but are somebody selling. The commonest
 * false positive by far is a founder's "I built a tool that…, is there a
 * market for this?", which is supply, not demand.
 */
const PITCHES: Array<[weight: number, pattern: RegExp]> = [
  [0.35, /\b(?:i|we)(?:'ve| have)? (?:just |finally |recently |solo-?|also )?(?:built|made|launched|created|shipped|released|coded|developed)\b/i],
  [0.3, /\b(?:so i|so we|and i|and we) (?:\w+-)?(?:built|made|launched|created)\b/i],
  [0.3, /\b(?:i'?m|we'?re|i am|we are) (?:building|making|launching|creating|developing|working on)\b/i],
  [0.3, /\bmy (?:app|tool|saas|startup|side ?project|product|extension|platform|website|site|mvp)\b/i],
  [0.3, /\b(?:roast my|feedback on my|check out my|beta testers?|waitlist|promo code|discount code)\b/i],
  [0.5, /\[(?:hiring|for hire|task|offer)\]|\b(?:we'?re hiring|for hire)\b/i],
  // Builders researching what to build: the shape of an ask, asked of everyone else.
  [0.45, /\b(?:would you (?:\w+ ){0,3}(?:use|pay|buy)|willing to pay|is there (?:a )?(?:market|demand)|like mine|my idea|what (?:kind of )?(?:apps?|problems?|software|tools?)\b.{0,40}\b(?:would|do) you|brainstorm(?:ing)?|(?:startup|saas|app) ideas|looking for (?:real )?problems|validat(?:e|ing|ion) (?:my|an|the|this) idea)\b/i],
  // Announcements: "free alternative to X, sharing in case anyone needs it".
  [0.35, /\b(?:in case anyone (?:needs|wants) it|weekend project|introducing|i present|open-?sourced? (?:my|our))\b/i],
];

export interface AskVerdict {
  /** 0-1. */
  score: number;
  kind: string;
  wants: string[];
}

/** Words of a request that say nothing about what is wanted. */
const GENERIC = new Set(
  (
    "app apps site sites website websites tool tools service services software platform platforms program programs extension " +
    "extensions plugin plugins addon addons bot bots api apis saas solution solutions alternative alternatives product products " +
    "web online free paid open source anyone anybody someone somebody looking search searching recommend recommendation " +
    "recommendations suggestion suggestions exist exists existing wish thanks reddit subreddit help question similar " +
    "basically simple easy able allow allows lets let"
  ).split(/\s+/),
);

/** Words cut from the front of a want: "it can", "be able to", "the". */
const LEAD = /^(?:(?:that|which|where|to|for|so|lets?|let me|allows?(?: me| you| us)?(?: to)?|allowing|with|can|could|will|would|also|and|or|it|me|you|us|i|we|be able to|is able to|helps?(?: me| you)?(?: to)?|the|a|an|my|your|just|actually|automatically|both)\s+)+/i;

/** How a body says what the thing must do. */
const BODY_WISH =
  /\b(?:i (?:want|need|would like|'d like) (?:it|something|one|an? \w+) to|it (?:should|must|needs to|has to)(?: be able to)?|should be able to|must (?:be able to|have|support)|needs to (?:be able to|support)|ideally(?: it)?(?: would)?|bonus (?:if|points if) it)\b/i;

const CONNECTOR = /\b(?:that|which|where|to|for|so i can|lets? (?:me|you|us|users)|allows? (?:me|you|us)|with)\b/i;

/** Split a clause into the things it lists. */
function splitWants(clause: string): string[] {
  return clause
    .split(/\s*(?:,|;|:|\band\b|\bor\b|&|\+|\/|\bplus\b|\bas well as\b|\bthen\b)\s*/i)
    .map((part) =>
      part
        .replace(LEAD, "")
        .replace(/[\s"'`*_)(.?!-]+$/g, "")
        .replace(/^[\s"'`*_(-]+/g, "")
        .trim(),
    )
    .filter((part) => part.length >= 3 && part.length <= 80 && termsOf(part).some((term) => contentful(term) && !GENERIC.has(term)));
}

const sentenceAround = (text: string, index: number): { start: number; end: number } => {
  const before = text.slice(0, index);
  const start = Math.max(before.lastIndexOf(". "), before.lastIndexOf("? "), before.lastIndexOf("! "), before.lastIndexOf("\n")) + 1;
  const rest = text.slice(index);
  const ends = [rest.search(/[.?!](?:\s|$)/), rest.indexOf("\n")].filter((value) => value >= 0);
  const end = ends.length ? index + Math.min(...ends) : text.length;
  return { start, end };
};

/**
 * What they want the thing to do, in their own words.
 *
 * The clause after the request ("a site THAT tracks prices, alerts me and
 * exports to csv") split on its list separators, plus any bulleted list in the
 * body, which is how people who know exactly what they want write it.
 */
export function extractWants(source: string, matchEnd: number, body = ""): string[] {
  const { end } = sentenceAround(source, Math.max(0, matchEnd - 1));
  let clause = source.slice(matchEnd, end);
  const connector = clause.search(CONNECTOR);
  if (connector >= 0 && connector < 40) clause = clause.slice(connector);
  const wants = splitWants(clause);

  for (const line of body.split("\n")) {
    const bullet = /^\s*(?:[-*•]|\d+[.)])\s+(.{3,120})$/.exec(line);
    if (bullet?.[1]) wants.push(...splitWants(bullet[1]).slice(0, 2));
  }

  // "I want it to warn me before renewals and export to csv": the feature
  // list people write in the body once the title has asked the question.
  for (const sentence of body.split(/(?<=[.?!])\s+|\n/).slice(0, 40)) {
    const wish = BODY_WISH.exec(sentence);
    if (wish) wants.push(...splitWants(sentence.slice(wish.index + wish[0].length)).slice(0, 4));
  }

  const seen = new Set<string>();
  return wants
    .filter((want) => {
      const key = want.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
}

/** The words of asking, cut out of a title to leave what is being asked for. */
const ASKING =
  /\b(?:is there|are there|does (?:anyone|anybody) know(?: of)?|anyone know(?: of)?|looking for|searching for|can (?:anyone|someone|you) (?:recommend|suggest)|any(?:one)? (?:recommend(?:ations?)?|suggestions?)|recommend(?:ations?)?|suggestions?|you can recommend(?: to me)?|i need|i want|i wish there (?:was|were)|someone (?:should|please) (?:make|build)|does (?:this|such a thing|something like this) exist|(?:some|any)(?:one|body) (?:should |pls |please )?(?:make|build|create)|help|please|pls|thanks)\b/gi;

/**
 * The title as a want: "Is there a free habit tracker that syncs?" becomes
 * "free habit tracker that syncs". Undefined when nothing specific is left.
 */
export function titleWant(title: string): string | undefined {
  const left = title
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/\bi will not promote\b/gi, " ")
    .replace(ASKING, " ")
    .replace(/[?!.:]+/g, " ")
    .replace(/^\s*(?:a|an|any|some|the|me|for|to|of)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:(?:a|an|any|some|the|for|good|decent)\s+)+/i, "")
    .trim();
  if (left.length < 4 || left.length > 80) return undefined;
  return termsOf(left).some((term) => contentful(term) && !GENERIC.has(term)) ? left : undefined;
}

/**
 * Is this post somebody asking for a tool, how sure are we, and what do they want?
 *
 * Patterns, not a model: this runs over every post of a dozen subreddits
 * every half hour, and the shapes people use to ask are few. The title counts
 * for more than the body, because that is where the question is when it is
 * the point of the post.
 */
export function classifyAsk(title: string, body = ""): AskVerdict {
  const cleanBody = body.replace(/\r/g, "").slice(0, 4000);
  let best: { kind: string; weight: number; inTitle: boolean; end: number; source: string } | undefined;

  for (const [kind, weight, pattern] of PATTERNS) {
    for (const [source, inTitle] of [[title, true], [cleanBody, false]] as const) {
      const match = pattern.exec(source);
      if (!match) continue;
      const total = weight + (inTitle ? 0.15 : 0);
      if (!best || total > best.weight + (best.inTitle ? 0.15 : 0)) {
        best = { kind, weight, inTitle, end: match.index + match[0].length, source };
      }
    }
  }
  if (!best) return { score: 0, kind: "", wants: [] };

  let score = best.weight + (best.inTitle ? 0.15 : 0) + (/\?\s*$/.test(title.trim()) ? 0.1 : 0);
  let penalty = 0;
  const whole = `${title}\n${cleanBody}`;
  for (const [weight, pattern] of PITCHES) if (pattern.test(whole)) penalty += weight;
  score -= Math.min(0.6, penalty);
  score = Math.max(0, Math.min(1, score));

  let wants = extractWants(best.source, best.end, cleanBody);
  if (!wants.length && best.inTitle && cleanBody) {
    // "Is there a tool for this?" in the title, and the "this" in the body.
    const first = cleanBody.split(/(?<=[.?!])\s+|\n/).find((sentence) => CONNECTOR.test(sentence)) ?? "";
    const at = first.search(CONNECTOR);
    if (at >= 0) wants = splitWants(first.slice(at)).slice(0, 6);
  }
  // The title as a want, unless a want already says it more precisely.
  const fromTitle = titleWant(title);
  if (fromTitle && !wants.some((want) => fromTitle.toLowerCase().includes(want.toLowerCase()))) wants = [fromTitle, ...wants].slice(0, 8);
  if (!wants.length) wants = [title.replace(/\s+/g, " ").trim().slice(0, 80)];
  return { score: Number(score.toFixed(3)), kind: best.kind, wants };
}

// ------------------------------------------------------------------ grouping

const stem = (word: string): string => (word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word);

/** What an ask is about, as single words, with the words of asking taken out. */
export function askTerms(ask: Pick<Ask, "title" | "wants"> & { label?: string }): string[] {
  const words = termsOf(`${ask.label ?? ""} ${ask.wants.join(" ")} ${ask.title}`)
    .filter((term) => !term.includes(" ") && contentful(term) && !GENERIC.has(term))
    .map(stem);
  return [...new Set(words)];
}

const IDEA_TERMS = 15;

/** The terms an idea's asks share, most shared first. */
function ideaTermsOf(asks: Ask[]): string[] {
  const counts = new Map<string, number>();
  for (const ask of asks) for (const term of askTerms(ask)) counts.set(term, (counts.get(term) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, IDEA_TERMS)
    .map(([term]) => term);
}

/**
 * How alike an ask and an idea are: shared terms over the smaller of the two
 * sets, so a short ask is not punished for the long tail of a big idea.
 */
export function similarity(terms: string[], ideaTerms: string[]): { shared: number; score: number } {
  const set = new Set(ideaTerms);
  const shared = terms.filter((term) => set.has(term)).length;
  const smaller = Math.min(terms.length, ideaTerms.length);
  return { shared, score: smaller ? shared / smaller : 0 };
}

const newIdeaId = (): string => `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** The words of a label that name the thing. */
const labelTerms = (label: string | undefined): Set<string> =>
  new Set(
    termsOf(label ?? "")
      .filter((term) => !term.includes(" ") && contentful(term) && !GENERIC.has(term))
      .map(stem),
  );

/**
 * File an ask under the idea it best matches, or start a new one. Returns the idea.
 *
 * When the writer has named both the ask and the idea, the names must share a
 * word as well: "playlist video downloader" and "digital signage software"
 * share "video" and "playlist" in their wants and are still not one thing.
 */
export function assignIdea(file: AsksFile, ask: Ask, at: string): Idea {
  const terms = askTerms(ask);
  const named = labelTerms(ask.label);
  let best: { idea: Idea; score: number } | undefined;
  for (const idea of file.ideas) {
    if (named.size && idea.named) {
      const theirs = labelTerms(idea.label);
      if (![...named].some((term) => theirs.has(term))) continue;
    }
    const match = similarity(terms, idea.terms);
    if (match.shared >= 2 && match.score >= 0.34 && (!best || match.score > best.score)) best = { idea, score: match.score };
  }
  const idea: Idea = best?.idea ?? {
    id: newIdeaId(),
    label: (ask.label || ask.wants[0] || ask.title).slice(0, 80),
    ...(ask.label ? { named: true } : {}),
    terms,
    askIds: [],
    status: "watching",
    firstAt: at,
    lastAt: at,
  };
  if (!best) file.ideas.push(idea);
  if (!idea.askIds.includes(ask.id)) idea.askIds.push(ask.id);
  if (at < idea.firstAt) idea.firstAt = at;
  if (at > idea.lastAt) idea.lastAt = at;
  ask.ideaId = idea.id;
  const members = file.asks.filter((entry) => idea.askIds.includes(entry.id));
  if (!members.some((entry) => entry.id === ask.id)) members.push(ask);
  idea.terms = ideaTermsOf(members);
  return idea;
}

/** One of our products that answers this ask, if any does. */
export function matchProduct(products: AskProduct[], ask: Pick<Ask, "title" | "text" | "wants">): AskProduct | undefined {
  const text = `${ask.title}\n${ask.wants.join("\n")}\n${ask.text}`.toLowerCase();
  const terms = new Set(askTerms({ title: `${ask.title} ${ask.text.slice(0, 600)}`, wants: ask.wants }));
  let best: { product: AskProduct; points: number } | undefined;
  for (const product of products) {
    let points = 0;
    for (const keyword of product.keywords) {
      if (keyword.includes(" ")) {
        if (text.includes(keyword)) points += 2;
      } else if (terms.has(stem(keyword))) {
        points += 1;
      }
    }
    if (points >= 2 && (!best || points > best.points)) best = { product, points };
  }
  return best?.product;
}

export interface IdeaSummary {
  idea: Idea;
  /** Asks inside `windowDays`. */
  asks: number;
  /** Distinct people asking inside the window: the number `buildAt` is about. */
  askers: number;
  subs: string[];
  /** Summed from each ask's newest stats. */
  score: number;
  comments: number;
  /** One number to sort by: people count most, then attention. */
  demand: number;
  replied: number;
}

const latest = (ask: Ask): AskStats | undefined => ask.stats[ask.stats.length - 1];

export function summarizeIdea(file: AsksFile, idea: Idea, settings: AsksSettings, now = Date.now()): IdeaSummary {
  const since = now - settings.windowDays * DAY_MS;
  const members = file.asks.filter((ask) => idea.askIds.includes(ask.id) && ask.status !== "skipped");
  const inWindow = members.filter((ask) => Date.parse(ask.postedAt) >= since);
  const askers = new Set(inWindow.map((ask) => ask.author.toLowerCase())).size;
  let score = 0;
  let comments = 0;
  for (const ask of inWindow) {
    score += Math.max(0, latest(ask)?.score ?? 0);
    comments += latest(ask)?.comments ?? 0;
  }
  const attention = inWindow.reduce(
    (sum, ask) => sum + Math.log2(1 + Math.max(0, latest(ask)?.score ?? 0)) + Math.log2(1 + (latest(ask)?.comments ?? 0)),
    0,
  );
  return {
    idea,
    asks: inWindow.length,
    askers,
    subs: [...new Set(members.map((ask) => ask.sub))],
    score,
    comments,
    demand: Number((askers * 10 + attention).toFixed(1)),
    replied: members.filter((ask) => ask.status === "replied").length,
  };
}

/** Every idea with its numbers, most wanted first. */
export function rankIdeas(file: AsksFile, settings: AsksSettings, now = Date.now()): IdeaSummary[] {
  return file.ideas.map((idea) => summarizeIdea(file, idea, settings, now)).sort((a, b) => b.demand - a.demand);
}

/** Flag the ideas that crossed the line. Returns the ones flagged just now. */
export function flagIdeas(file: AsksFile, settings: AsksSettings, now = Date.now()): Idea[] {
  const flagged: Idea[] = [];
  for (const idea of file.ideas) {
    if (idea.status !== "watching") continue;
    if (summarizeIdea(file, idea, settings, now).askers < settings.buildAt) continue;
    idea.status = "build";
    idea.flaggedAt = new Date(now).toISOString();
    flagged.push(idea);
  }
  return flagged;
}

// ------------------------------------------------------------------ reading

export type Fetcher = (url: string) => Promise<unknown>;

const defaultFetch: Fetcher = (url) => getJson(url, { timeoutMs: 30_000 });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The archive is a free service and says so: two requests back to back get a
 * 422 "Timeout. Maybe slow down a bit". Every request to it waits out `gapMs`
 * since the last, and one that is told to slow down waits longer and tries
 * once more. RSS Amplifier is ours and is not paced.
 */
export function pacedFetch(fetchJson: Fetcher, statsBase: string, gapMs: number): Fetcher {
  const base = statsBase.replace(/\/+$/, "");
  let last = 0;
  const wait = async (): Promise<void> => {
    const due = last + gapMs - Date.now();
    if (due > 0) await sleep(due);
    last = Date.now();
  };
  return async (url) => {
    if (!url.startsWith(base) || gapMs <= 0) return fetchJson(url);
    await wait();
    try {
      return await fetchJson(url);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 422 && status !== 429 && !/slow down/i.test((error as Error).message)) throw error;
      await sleep(gapMs * 4);
      await wait();
      return fetchJson(url);
    }
  };
}

/** A subreddit post, from whichever source had it. */
export interface FeedPost {
  id: string;
  sub: string;
  title: string;
  text: string;
  url: string;
  author: string;
  postedAt: string;
  score?: number;
  comments?: number;
}

export const subsOf = (settings: AsksSettings): string[] =>
  [
    ...new Set(
      settings.subs
        .split(",")
        .map((sub) => sub.trim().replace(/^\/?r\//i, ""))
        .filter((sub) => /^[A-Za-z0-9_]{2,21}$/.test(sub)),
    ),
  ];

const bareId = (id: unknown): string => String(id ?? "").replace(/^t3_/, "");
const bareUser = (name: unknown): string => String(name ?? "").replace(/^\/?u\//, "").trim();

interface ArchivePost {
  id?: string;
  title?: string;
  selftext?: string;
  author?: string;
  subreddit?: string;
  created_utc?: number;
  permalink?: string;
  score?: number;
  num_comments?: number;
  upvote_ratio?: number;
}

interface ArchiveComment {
  id?: string;
  author?: string;
  parent_id?: string;
  link_id?: string;
  score?: number;
  permalink?: string;
  created_utc?: number;
  body?: string;
}

const dataOf = <T>(reply: unknown): T[] => {
  const data = (reply as { data?: unknown })?.data;
  return Array.isArray(data) ? (data as T[]) : [];
};

const fromArchive = (post: ArchivePost, sub: string): FeedPost => ({
  id: bareId(post.id),
  sub: post.subreddit ?? sub,
  title: String(post.title ?? ""),
  text: post.selftext && post.selftext !== "[removed]" && post.selftext !== "[deleted]" ? post.selftext : "",
  url: post.permalink ? `https://www.reddit.com${post.permalink}` : `https://www.reddit.com/r/${sub}/comments/${bareId(post.id)}/`,
  author: bareUser(post.author),
  postedAt: new Date((post.created_utc ?? 0) * 1000).toISOString(),
  ...(typeof post.score === "number" ? { score: post.score } : {}),
  ...(typeof post.num_comments === "number" ? { comments: post.num_comments } : {}),
});

/**
 * One subreddit's newest posts.
 *
 * RSS Amplifier first. A sub it does not list answers 404, and one it lists
 * but has not crawled yet answers an empty feed; either way, with `fallback`
 * on, the archive's newest posts stand in, and `note` says which happened so
 * a person can add the sub over there.
 */
export async function readSub(sub: string, settings: AsksSettings, fetchJson: Fetcher = defaultFetch): Promise<{ posts: FeedPost[]; via: string; note?: string }> {
  const feedBase = settings.feedBase.replace(/\/+$/, "");
  let note: string | undefined;
  try {
    const feed = (await fetchJson(`${feedBase}/r/${encodeURIComponent(sub)}.json?limit=100`)) as {
      items?: Array<{ id?: string; title?: string; url?: string; summary?: string; content_text?: string; date_published?: string; authors?: Array<{ name?: string }> }>;
    };
    const items = Array.isArray(feed?.items) ? feed.items : [];
    if (items.length) {
      return {
        via: "rssamplifier",
        posts: items
          .map((item) => ({
            id: bareId(item.id ?? /\/comments\/([a-z0-9]+)/i.exec(item.url ?? "")?.[1]),
            sub: /\/r\/([^/]+)\//.exec(item.url ?? "")?.[1] ?? sub,
            title: String(item.title ?? ""),
            text: String(item.content_text ?? item.summary ?? ""),
            url: String(item.url ?? ""),
            author: bareUser(item.authors?.[0]?.name),
            postedAt: item.date_published ?? new Date(0).toISOString(),
          }))
          .filter((post) => post.id && post.title),
      };
    }
    note = `RSS Amplifier lists r/${sub} but has not read it yet`;
  } catch (error) {
    const status = (error as { status?: number }).status;
    note = status === 404 ? `r/${sub} is not in RSS Amplifier yet (add it at ${feedBase}/r/${sub})` : `RSS Amplifier: ${(error as Error).message}`;
  }
  if (!settings.fallback) return { posts: [], via: "none", note };
  const statsBase = settings.statsBase.replace(/\/+$/, "");
  const reply = await fetchJson(`${statsBase}/api/posts/search?subreddit=${encodeURIComponent(sub)}&limit=100&sort=desc`);
  return { posts: dataOf<ArchivePost>(reply).map((post) => fromArchive(post, sub)).filter((post) => post.id && post.title), via: "archive", note };
}

/** Archive records for these post ids, a hundred to a request. */
export async function archivePosts(ids: string[], settings: AsksSettings, fetchJson: Fetcher = defaultFetch): Promise<Map<string, ArchivePost>> {
  const statsBase = settings.statsBase.replace(/\/+$/, "");
  const found = new Map<string, ArchivePost>();
  for (let index = 0; index < ids.length; index += 100) {
    const page = ids.slice(index, index + 100);
    const reply = await fetchJson(`${statsBase}/api/posts/ids?ids=${page.map(encodeURIComponent).join(",")}`);
    for (const post of dataOf<ArchivePost>(reply)) if (post.id) found.set(bareId(post.id), post);
  }
  return found;
}

// ------------------------------------------------------------------ scanning

export interface AskScanOptions {
  settings?: AsksSettings;
  log?: (line: string) => void;
  fetchJson?: Fetcher;
  /** Hand each asker to the plugins that collect people. Off in tests. */
  handOff?: boolean;
  now?: number;
  /** Read only these subs this time. */
  subs?: string[];
  /** Least time between two archive requests. Tests pass 0. */
  archiveGapMs?: number;
  /**
   * The second look at each candidate (`askJudge`). Defaults to the writer
   * when one is configured and `asks.useWriter` is on; `null` turns it off.
   */
  judge?: ((posts: AskJudgeInput[]) => Promise<AskJudgement[]>) | null;
  /** Candidates the judge reads per scan; the rest wait for the next. */
  judgeLimit?: number;
}

export interface AskScanResult {
  found: Ask[];
  read: number;
  /** Per sub: where its posts came from, and anything worth knowing. */
  sources: Array<{ sub: string; via: string; posts: number; note?: string }>;
  skipped: string[];
  /** Ideas that crossed `buildAt` on this scan. */
  flagged: Idea[];
  /** Candidates the judge said were not asks. */
  rejected: number;
  /** Whether the judge ran, so a person knows how much to trust the list. */
  judged: boolean;
  /** Candidates left for the next scan's judge. */
  deferred: number;
}

/**
 * Read every sub, keep the asks, file them under ideas.
 *
 * Every post read is marked seen whether or not it was an ask, so nothing is
 * judged twice. Posts that pass are re-read from the archive in one batch for
 * their full text (the feed carries a summary) and a first set of numbers.
 */
export async function scanAsks(options: AskScanOptions = {}): Promise<AskScanResult> {
  const settings = options.settings ?? loadSettings().asks;
  const fetchJson = pacedFetch(options.fetchJson ?? defaultFetch, settings.statsBase, options.archiveGapMs ?? 2_500);
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now();
  const at = new Date(now).toISOString();
  const result: AskScanResult = { found: [], read: 0, sources: [], skipped: [], flagged: [], rejected: 0, judged: false, deferred: 0 };
  const judge =
    options.judge === null
      ? undefined
      : (options.judge ?? (settings.useWriter && writerAvailable().ok ? askJudge : undefined));
  const file = readAsks();
  const seen = new Set(file.seen);
  const known = new Set(file.asks.map((ask) => ask.id));
  const us = settings.redditUser.trim().toLowerCase();
  const oldest = now - settings.windowDays * DAY_MS;

  const candidates: Array<{ post: FeedPost; verdict: AskVerdict }> = [];
  for (const sub of options.subs ?? subsOf(settings)) {
    let read: Awaited<ReturnType<typeof readSub>>;
    try {
      read = await readSub(sub, settings, fetchJson);
    } catch (error) {
      result.skipped.push(`r/${sub}: ${(error as Error).message}`);
      continue;
    }
    result.sources.push({ sub, via: read.via, posts: read.posts.length, ...(read.note ? { note: read.note } : {}) });
    result.read += read.posts.length;
    for (const post of read.posts) {
      if (seen.has(post.id) || known.has(post.id)) continue;
      seen.add(post.id);
      file.seen.push(post.id);
      if (us && post.author.toLowerCase() === us) continue;
      if (Date.parse(post.postedAt) < oldest) continue;
      const verdict = classifyAsk(post.title, post.text);
      // The feed's summary is cut short; give a near miss the benefit of the
      // doubt until the full text is in.
      if (verdict.score < settings.minScore - 0.1) continue;
      candidates.push({ post, verdict });
    }
  }

  let full = new Map<string, ArchivePost>();
  if (candidates.length) {
    try {
      full = await archivePosts(
        candidates.map((candidate) => candidate.post.id),
        settings,
        fetchJson,
      );
    } catch (error) {
      result.skipped.push(`archive: ${(error as Error).message}`);
    }
  }

  const kept: Array<{ post: FeedPost; verdict: AskVerdict; body: string; record?: ArchivePost }> = [];
  for (const { post, verdict: first } of candidates) {
    const record = full.get(post.id);
    const body = record?.selftext && record.selftext.length > post.text.length && record.selftext !== "[removed]" ? record.selftext : post.text;
    const verdict = body === post.text ? first : classifyAsk(post.title, body);
    if (verdict.score < settings.minScore) continue;
    kept.push({ post, verdict, body, ...(record ? { record } : {}) });
  }

  // The second look. What the judge has not got to this time is put back as
  // unseen, so the next scan judges it rather than letting it through unread.
  const judgements = new Map<string, AskJudgement>();
  if (judge && kept.length) {
    const limit = options.judgeLimit ?? 30;
    const later = new Set(kept.slice(limit).map((entry) => entry.post.id));
    if (later.size) file.seen = file.seen.filter((id) => !later.has(id));
    result.deferred += later.size;
    kept.length = Math.min(kept.length, limit);
    try {
      for (let index = 0; index < kept.length; index += 10) {
        const page = kept.slice(index, index + 10);
        for (const judgement of await judge(page.map(({ post, body }) => ({ id: post.id, title: post.title, text: body })))) {
          judgements.set(judgement.id.trim().replace(/^t3_/, ""), judgement);
        }
      }
      result.judged = true;
    } catch (error) {
      result.skipped.push(`judge: ${(error as Error).message}; kept the pattern verdicts`);
    }
  }

  for (const { post, verdict, body, record } of kept) {
    const judgement = judgements.get(post.id);
    if (judgement && !judgement.ask) {
      result.rejected += 1;
      continue;
    }
    if (result.judged && !judgement) {
      // The judge ran and said nothing about this one. Judge it next time
      // rather than let the patterns alone decide.
      file.seen = file.seen.filter((id) => id !== post.id);
      result.deferred += 1;
      continue;
    }
    const ask: Ask = {
      id: post.id,
      source: "reddit",
      sub: post.sub,
      title: post.title.slice(0, 300),
      text: body.slice(0, 4000),
      url: post.url,
      author: post.author,
      postedAt: post.postedAt,
      score: verdict.score,
      kind: verdict.kind,
      wants: judgement?.wants.length ? judgement.wants : verdict.wants,
      ...(judgement?.label ? { label: judgement.label } : {}),
      ...(judgement ? { judged: true } : {}),
      ideaId: "",
      status: "new",
      foundAt: at,
      stats: [],
    };
    const score = record?.score ?? post.score;
    const comments = record?.num_comments ?? post.comments;
    if (score !== undefined || comments !== undefined) {
      ask.stats.push({ at, ...(score !== undefined ? { score } : {}), ...(comments !== undefined ? { comments } : {}), ...(record?.upvote_ratio !== undefined ? { ratio: record.upvote_ratio } : {}) });
      ask.statsAt = at;
    }
    const product = matchProduct(file.products, ask);
    if (product) ask.product = { id: product.id, name: product.name, url: product.url };
    file.asks.push(ask);
    assignIdea(file, ask, ask.postedAt);
    result.found.push(ask);
    log(`asks: r/${ask.sub} ${ask.kind} (${ask.score}) ${ask.title.slice(0, 80)}`);
  }

  result.flagged = flagIdeas(file, settings, now);
  writeAsks(file);

  if (options.handOff !== false && settings.leads) {
    for (const ask of result.found) {
      if (!ask.author || ask.author === "[deleted]") continue;
      const idea = file.ideas.find((entry) => entry.id === ask.ideaId);
      try {
        const outcomes = await runAfterDiscover(
          {
            source: "asks",
            network: "reddit",
            handle: ask.author,
            postText: `${ask.title}\n${ask.text}`.slice(0, 600),
            postUrl: ask.url,
            score: ask.score,
            matched: idea?.terms.slice(0, 4) ?? [],
            action: "ask",
            via: `ask:${(idea?.label ?? ask.wants[0] ?? ask.sub).slice(0, 60)}`,
          },
          log,
        );
        for (const outcome of outcomes) if (outcome.error) result.skipped.push(`${outcome.plugin}: ${outcome.error}`);
      } catch (error) {
        result.skipped.push(`handing ${ask.author} over: ${(error as Error).message}`);
      }
    }
  }

  return result;
}

// ------------------------------------------------------------------ replying

/** Tag a link so the site's analytics can tell which ask, and which idea, sent the visit. */
export function tagLink(url: string, ask: Pick<Ask, "ideaId" | "sub">): string {
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has("utm_source")) parsed.searchParams.set("utm_source", "reddit");
    if (!parsed.searchParams.has("utm_medium")) parsed.searchParams.set("utm_medium", "comment");
    if (!parsed.searchParams.has("utm_campaign")) parsed.searchParams.set("utm_campaign", `asks-${ask.ideaId || ask.sub}`);
    return parsed.toString();
  } catch {
    return url;
  }
}

const listOf = (items: string[]): string => {
  const quoted = items.slice(0, 3);
  if (quoted.length <= 1) return quoted[0] ?? "";
  return `${quoted.slice(0, -1).join(", ")} or ${quoted[quoted.length - 1]}`;
};

/**
 * The fixed reply, for when there is no writer. Deliberately short and
 * deliberately honest: it discloses, it does not claim features it was not
 * told about, and with nothing of ours to offer it asks the builder's question.
 */
export function askTemplateReply(ask: Pick<Ask, "wants">, product?: { name: string; url: string; about?: string }): string {
  if (product) {
    const about = product.about ? ` ${product.about.replace(/[.\s]+$/, "")}.` : "";
    return `Disclosure, I work on it, but ${product.name} might fit: ${product.url}${about} If it misses something you listed, tell me which and I will say honestly whether it is coming.`;
  }
  const wants = ask.wants.filter((want) => want.length < 60);
  return wants.length > 1
    ? `I have looked for the same thing and have not found one that does all of it. Of ${listOf(wants)}, which would you drop first, and what are you using in the meantime? I am considering building it.`
    : `I have looked for the same thing and have not found one. What are you using in the meantime, and what is the one part it gets wrong? I am considering building it.`;
}

export type AskDrafter = (request: AskReplyRequest) => Promise<string>;

export interface AskReplyOptions {
  /** The words to paste, instead of a draft. */
  text?: string;
  settings?: AsksSettings;
  drafter?: AskDrafter;
  writerReady?: boolean;
  /** Publish the card to myna cloud when signed in. Default true. */
  publish?: boolean;
  /** Make a new card even when one is already waiting. */
  force?: boolean;
}

export interface AskReplyResult {
  ask: Ask;
  card: Handoff;
  drafted: "given" | "writer" | "template";
}

/**
 * Write the answer and put it on a hand-off card: the reply, the thread to
 * open, the steps. Published to myna cloud when this machine is signed in, so
 * it can be pasted from a phone; the recap lists it until it is marked done.
 */
export async function replyToAsk(ref: string, options: AskReplyOptions = {}): Promise<AskReplyResult> {
  const settings = options.settings ?? loadSettings().asks;
  const file = readAsks();
  const ask = findIn(file.asks, ref);
  if (!ask) throw new Error(`No ask ${ref}. myna asks lists them.`);
  if (ask.handoffId && !options.force && ask.status === "drafted") {
    const existing = getHandoff(ask.handoffId);
    if (existing && !existing.doneAt) return { ask, card: existing, drafted: "given" };
  }

  const stored = ask.product ? file.products.find((entry) => entry.id === ask.product?.id) : undefined;
  const product = ask.product ? { name: ask.product.name, url: tagLink(ask.product.url, ask), ...(stored?.about ? { about: stored.about } : {}) } : undefined;

  let text = options.text?.trim() ?? "";
  let drafted: AskReplyResult["drafted"] = "given";
  if (!text) {
    const writerOk = settings.useWriter && (options.writerReady ?? writerAvailable().ok);
    if (writerOk) {
      text = await (options.drafter ?? askReplyDraft)({ title: ask.title, text: ask.text, wants: ask.wants, ...(product ? { product } : {}) });
      if (!text) throw new Error("The writer declined: it judged the reply would not help. Pass --text to write one yourself, or skip it.");
      drafted = "writer";
    } else {
      text = askTemplateReply(ask, product);
      drafted = "template";
    }
  }

  let card = addHandoff({
    place: `r/${ask.sub}`,
    title: `Reply: ${ask.title}`.slice(0, 200),
    text,
    openUrl: ask.url,
    steps: [
      "Open the thread and read the newest comments first; skip it if someone already answered the same way.",
      "Paste the reply as a top-level comment.",
      "Mark done. myna asks stats then finds the comment and tracks its score and replies.",
    ],
    ...(settings.redditUser ? { account: `u/${settings.redditUser}` } : {}),
  });
  if (options.publish !== false && cloudSignedIn()) {
    try {
      const cloud = await publishHandoff(card);
      card = attachCloud(card.id, cloud.id, cloud.url) ?? card;
    } catch {
      // Kept here; the CLI says so when there is no cloud URL.
    }
  }

  ask.status = "drafted";
  ask.reply = text;
  ask.handoffId = card.id;
  if (card.cloudUrl) ask.handoffUrl = card.cloudUrl;
  else delete ask.handoffUrl;
  writeAsks(file);
  return { ask, card, drafted };
}

/** A card marked done means the reply was pasted. */
export function syncReplies(file: AsksFile): number {
  let changed = 0;
  for (const ask of file.asks) {
    if (ask.status !== "drafted" || !ask.handoffId) continue;
    const card = getHandoff(ask.handoffId);
    if (card?.doneAt) {
      ask.status = "replied";
      ask.repliedAt = card.doneAt;
      changed += 1;
    }
  }
  return changed;
}

/** Set an ask's status by hand: skip it, or say it was replied to outside myna. */
export function setAskStatus(ref: string, status: AskStatus, reason?: string): Ask | undefined {
  const file = readAsks();
  const ask = findIn(file.asks, ref);
  if (!ask) return undefined;
  ask.status = status;
  if (status === "replied" && !ask.repliedAt) ask.repliedAt = new Date().toISOString();
  if (reason) ask.reason = reason;
  writeAsks(file);
  return ask;
}

/** Move an idea by hand: building, shipped (with the product it became), ignored, or back to watching. */
export function setIdea(ref: string, patch: { status?: IdeaStatus; label?: string; note?: string; product?: string }): Idea | undefined {
  const file = readAsks();
  const idea = findIn(file.ideas, ref);
  if (!idea) return undefined;
  if (patch.status) idea.status = patch.status;
  if (patch.label?.trim()) idea.label = patch.label.trim().slice(0, 80);
  if (patch.note !== undefined) idea.note = patch.note.trim() || undefined;
  if (patch.product !== undefined) idea.product = patch.product.trim() || undefined;
  writeAsks(file);
  return idea;
}

/** Fold one idea into another, when the grouping split what is really one thing. */
export function mergeIdeas(intoRef: string, fromRef: string): Idea | undefined {
  const file = readAsks();
  const into = findIn(file.ideas, intoRef);
  const from = findIn(file.ideas, fromRef);
  if (!into || !from || into.id === from.id) return undefined;
  for (const id of from.askIds) if (!into.askIds.includes(id)) into.askIds.push(id);
  for (const ask of file.asks) if (ask.ideaId === from.id) ask.ideaId = into.id;
  if (from.firstAt < into.firstAt) into.firstAt = from.firstAt;
  if (from.lastAt > into.lastAt) into.lastAt = from.lastAt;
  into.terms = ideaTermsOf(file.asks.filter((ask) => into.askIds.includes(ask.id)));
  file.ideas = file.ideas.filter((idea) => idea.id !== from.id);
  writeAsks(file);
  return into;
}

// ------------------------------------------------------------------ stats

export interface AskStatsOptions {
  settings?: AsksSettings;
  fetchJson?: Fetcher;
  now?: number;
  /** Refresh these asks only, whatever their age. */
  ids?: string[];
  log?: (line: string) => void;
}

export interface AskStatsResult {
  refreshed: number;
  /** Replies of ours found in a thread for the first time. */
  foundOurs: Ask[];
  /** Cards marked done since the last look. */
  synced: number;
  errors: string[];
}

/**
 * Re-read the threads still worth watching.
 *
 * One request for every thread's score and comment count. For a thread we
 * replied in, one more for its comments, to find ours by `redditUser` and
 * count the answers to it; a reply found that way also marks a forgotten card
 * as pasted. Oldest refresh first, `statsPerRun` at a time, so a long list is
 * walked over several runs instead of hammering a free archive.
 */
export async function refreshAskStats(options: AskStatsOptions = {}): Promise<AskStatsResult> {
  const settings = options.settings ?? loadSettings().asks;
  const fetchJson = options.fetchJson ?? defaultFetch;
  const now = options.now ?? Date.now();
  const at = new Date(now).toISOString();
  const file = readAsks();
  const result: AskStatsResult = { refreshed: 0, foundOurs: [], synced: syncReplies(file), errors: [] };
  const us = settings.redditUser.trim().toLowerCase().replace(/^u\//, "");

  const wanted = options.ids?.length ? new Set(options.ids.map((id) => id.replace(/^t3_/, ""))) : undefined;
  const due = file.asks
    .filter((ask) =>
      wanted
        ? wanted.has(ask.id)
        : ask.status !== "skipped" && now - Date.parse(ask.postedAt) < settings.trackDays * DAY_MS,
    )
    .sort((a, b) => (a.statsAt ?? "").localeCompare(b.statsAt ?? ""))
    .slice(0, wanted ? undefined : settings.statsPerRun);
  if (!due.length) {
    writeAsks(file);
    return result;
  }

  let posts = new Map<string, ArchivePost>();
  try {
    posts = await archivePosts(
      due.map((ask) => ask.id),
      settings,
      fetchJson,
    );
  } catch (error) {
    result.errors.push(`archive: ${(error as Error).message}`);
  }

  const statsBase = settings.statsBase.replace(/\/+$/, "");
  for (const ask of due) {
    const post = posts.get(ask.id);
    const snapshot: AskStats = { at };
    if (post) {
      if (typeof post.score === "number") snapshot.score = post.score;
      if (typeof post.num_comments === "number") snapshot.comments = post.num_comments;
      if (typeof post.upvote_ratio === "number") snapshot.ratio = post.upvote_ratio;
    }

    if (us && (ask.status === "drafted" || ask.status === "replied")) {
      try {
        const comments = dataOf<ArchiveComment>(await fetchJson(`${statsBase}/api/comments/search?link_id=${encodeURIComponent(ask.id)}&limit=100`));
        snapshot.comments = Math.max(snapshot.comments ?? 0, comments.length);
        const ours = comments
          .filter((comment) => String(comment.author ?? "").toLowerCase() === us)
          .sort((a, b) => (a.created_utc ?? 0) - (b.created_utc ?? 0))[0];
        if (ours?.id) {
          const replies = comments.filter((comment) => comment.parent_id === `t1_${ours.id}`).length;
          snapshot.ours = {
            id: ours.id,
            url: ours.permalink ? `https://www.reddit.com${ours.permalink}` : `${ask.url.replace(/\/?$/, "/")}${ours.id}/`,
            ...(typeof ours.score === "number" ? { score: ours.score } : {}),
            replies,
          };
          const firstTime = !ask.stats.some((stats) => stats.ours);
          if (ask.status === "drafted") {
            ask.status = "replied";
            ask.repliedAt = ours.created_utc ? new Date(ours.created_utc * 1000).toISOString() : at;
          }
          if (firstTime) result.foundOurs.push(ask);
        }
      } catch (error) {
        result.errors.push(`${ask.id} comments: ${(error as Error).message}`);
      }
    }

    if (snapshot.score !== undefined || snapshot.comments !== undefined || snapshot.ours) {
      ask.stats.push(snapshot);
      result.refreshed += 1;
    }
    ask.statsAt = at;
  }

  flagIdeas(file, settings, now);
  writeAsks(file);
  return result;
}

/** What our replies did, summed: the number a person wants on one line. */
export function replyTotals(asks: Ask[]): { replied: number; drafted: number; score: number; replies: number; found: number } {
  let score = 0;
  let replies = 0;
  let found = 0;
  for (const ask of asks) {
    const ours = [...ask.stats].reverse().find((stats) => stats.ours)?.ours;
    if (!ours) continue;
    found += 1;
    score += ours.score ?? 0;
    replies += ours.replies;
  }
  return {
    replied: asks.filter((ask) => ask.status === "replied").length,
    drafted: asks.filter((ask) => ask.status === "drafted").length,
    score,
    replies,
    found,
  };
}
