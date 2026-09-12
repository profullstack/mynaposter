/**
 * Post types: what a kind of post is, wherever it goes.
 *
 * The network and account skills say where a post may land and how often.
 * A type skill says what the post itself is: a launch announcement, release
 * notes, a bug story, an essay. It lives at skills/types/<type>/skill.md,
 * orthogonal to the network tree, and carries two things myna enforces:
 *
 *   allowedKinds  which network kinds may carry it. A bug story is allowed on
 *                 the socials and a board and never on the blog, which is the
 *                 blog policy written down once instead of remembered.
 *   maxPerDay     posts of this type across every account in a rolling day,
 *                 on top of the network and account caps; stricter wins.
 *
 * `myna post --type <slug>` names one. Without it, a post that reaches a blog
 * or a longform mirror is a launch-announcement and anything else is a
 * social-update. The type is written onto the queue entry and the history
 * entry, and an agent reads the type skill first, then the account's, then
 * the network's.
 */
import type { Account } from "../net/types.ts";
import type { HistoryEntry } from "../store/history.ts";
import type { QueuedPost } from "../store/queue.ts";
import {
  DEFAULT_SKILL_SLUG,
  listTypeSlugs,
  parseSkill,
  readSkillFile,
  removeSkillFile,
  safeSlug,
  typeSkillPath,
  writeSkillFile,
  type SkillFile,
  type SkillKind,
  type TypeFrontmatter,
} from "../store/skills.ts";
import { skillKindFor } from "./skills.ts";

export const TYPE_TEMPLATE_VERSION = "1";

/** The type a post gets when nobody named one. */
export const DEFAULT_BLOG_TYPE = "launch-announcement";
export const DEFAULT_SOCIAL_TYPE = "social-update";

export interface TypeSkill extends SkillFile {
  type: string;
  frontmatter: TypeFrontmatter;
}

interface TypeTemplate {
  description: string;
  allowedKinds: SkillKind[];
  maxPerDay?: number;
  requiresUrl: boolean;
  structure: string[];
  body: string;
}

const HOUSE = `## House style

No em dashes, no en dashes, no curly quotes. No LLM tells. Concrete details over generalities. A real title. Short.`;

/** The built-in types. Order is the order `myna skill list` prints them. */
export const TYPE_TEMPLATES: Record<string, TypeTemplate> = {
  "launch-announcement": {
    description: "A major feature or product launch: what it is, who it is for, what changed, one link. The blog is the canonical original; the socials get the one-liner and the URL.",
    allowedKinds: ["blog", "longform", "social", "forum"],
    requiresUrl: true,
    structure: ["what-it-is", "who-it-is-for", "what-changed", "how-to-use-it", "link"],
    body: `## What this is

Something shipped that a reader can use today: a new product, a major feature, a release with a real change in it. This is the one type that belongs on the blog, and the blog post is the canonical original. Everything else derives from it.

## Structure

1. **What it is.** One or two sentences. Name the thing and say what it does.
2. **Who it is for.** The person with the problem, in one sentence.
3. **What changed.** The concrete change, with the real numbers, commands or screens. Several related features from the same week can share one announcement.
4. **How to use it.** The command, the URL, the setting. Enough to try it.
5. **The link.** One link, last. The product page or the blog post, never a tracking redirect.

## Where it goes

- The blog carries the full post and is the canonical original.
- dev.to and the other longform mirrors carry the same post with --canonical-url pointing at the blog page, after the blog is live.
- The socials get one or two lines: what it is, what changed, the link last. One post per launch; the drip and the reposts take care of the rest.
- A board gets the announcement as a topic with the blog link.

## Not a launch

A patch release, a fix, a small quality-of-life change, a lesson learned. Those are release-notes, bug-story or social-update, and none of them goes on the blog.

${HOUSE}`,
  },
  "release-notes": {
    description: "A version and what changed in it, with an upgrade note. Socials and boards only, unless it is a major release, which is a launch-announcement.",
    allowedKinds: ["social", "forum", "longform"],
    requiresUrl: true,
    structure: ["version", "what-changed", "upgrade-note", "link"],
    body: `## What this is

A version number and what changed in it. Minor and patch releases live here. A major release with a headline feature is a launch-announcement and goes through the blog instead.

## Structure

1. **Version.** The package or product and the version, first: "myna 0.18.0".
2. **What changed.** Two to five short lines, the user-visible changes only. Internal refactors do not make the list.
3. **Upgrade note.** Anything a person has to do: a flag that moved, a migration, a re-login. "Nothing to do" is a fine note.
4. **Link.** The release page or the changelog, last.

## Where it goes

The socials and a board. Not the blog: the blog carries major features only. A longform mirror only when there is a blog post to mirror.

${HOUSE}`,
  },
  "bug-story": {
    description: "A postmortem or a lesson learned. Socials and boards at most; never the blog, which carries major features only.",
    allowedKinds: ["social", "forum"],
    requiresUrl: false,
    structure: ["what-broke", "why", "the-fix", "the-lesson"],
    body: `## What this is

Something broke, or nearly did, and there is a lesson in it worth a few lines. A postmortem, a gotcha, a "this cost me an afternoon".

## Structure

1. **What broke.** The symptom, as a person saw it.
2. **Why.** The actual cause, with the specific detail: the header, the default, the off-by-one.
3. **The fix.** What was changed, in one line.
4. **The lesson.** The one thing to remember. Skip it if it is obvious from the fix.

## Where it goes

The socials, or a board thread where people will reply. Never the blog: the blog policy is major feature announcements only, and myna refuses a bug-story aimed at a blog target. If the story is big enough to be a page, it has become an essay.

${HOUSE}`,
  },
  essay: {
    description: "Opinion or long-form thinking. Allowed on the blog at most once a day, and on the socials as the one-line take with the link.",
    allowedKinds: ["blog", "longform", "social", "forum"],
    maxPerDay: 1,
    requiresUrl: false,
    structure: ["the-claim", "the-evidence", "the-counter", "so-what"],
    body: `## What this is

A point of view, argued. Not an announcement and not a changelog. It earns a page because the argument needs the room.

## Structure

1. **The claim.** State it in the first paragraph. The reader should be able to disagree by the end of it.
2. **The evidence.** What you saw, measured or built that makes you think so. Specifics, not vibes.
3. **The counter.** The best case against your claim, taken seriously.
4. **So what.** What a reader should do differently.

## Where it goes

The blog carries it, at most one essay a day across every account, so it never crowds out a launch. Longform mirrors carry it with --canonical-url. The socials get the claim in one line and the link.

${HOUSE}`,
  },
  repost: {
    description: "A mirror of a post that already exists on our own blog, published elsewhere with the canonical URL pointing home.",
    allowedKinds: ["longform"],
    requiresUrl: true,
    structure: ["canonical-url", "same-body"],
    body: `## What this is

The same article, published on a longform network (dev.to, Hashnode, Ghost, Tumblr) after it is live on our own blog. The blog page is the original; the mirror says so.

## Rules

1. **Canonical first.** Always --canonical-url <the blog page>. A mirror without it can outrank the original.
2. **Same body.** Use the exact Markdown that went to the blog; myna history --json has it. Do not rewrite for the mirror.
3. **After, not before.** The blog post is live before the mirror is published.
4. **Once per network.** One mirror per article per network. A mirror of a mirror is spam.

## Where it goes

Longform networks only. The socials do not mirror; they link.

${HOUSE}`,
  },
  promo: {
    description: "An ad or an offer: a price, a deal, a deadline, one link.",
    allowedKinds: ["social", "forum"],
    maxPerDay: 2,
    requiresUrl: true,
    structure: ["the-offer", "for-whom", "the-deadline", "link"],
    body: `## What this is

A paid thing, plainly: a price, a plan, a discount, a deadline. It says what it is and it does not pretend to be news.

## Structure

1. **The offer.** What you get and what it costs, in one line.
2. **For whom.** Who it is worth it for, honestly.
3. **The deadline.** If there is one. If there is not, do not invent one.
4. **Link.** The page where the offer is, last.

## Where it goes

The socials, and a board only where the board allows it. Never the blog. At most two promos a day across every account, so the feeds stay mostly not ads.

${HOUSE}`,
  },
  reply: {
    description: "An answer in someone else's thread: a forum reply, a comment, a response to a mention.",
    allowedKinds: ["forum", "social", "youtube"],
    requiresUrl: false,
    structure: ["the-answer", "the-detail", "optional-link"],
    body: `## What this is

A reply to a thread, a comment on a video, an answer to a mention. It exists because somebody asked, so it answers them and stops.

## Structure

1. **The answer.** First sentence. Yes, no, here is how.
2. **The detail.** The command, the setting, the reason. As much as the question needs and no more.
3. **A link, optionally.** Only when it answers the question better than the reply does. Never a link to something for sale.

## Where it goes

The thread it belongs to: a board topic, a social reply, a YouTube comment found with myna search. Never a new topic and never the blog.

${HOUSE}`,
  },
  event: {
    description: "Something with a date: a stream, a talk, a meetup, a deadline. The date and the time zone are the point.",
    allowedKinds: ["social", "forum", "other"],
    requiresUrl: true,
    structure: ["what", "when", "where", "link"],
    body: `## What this is

A scheduled thing people can attend or watch: a stream, a talk, a launch time, a deadline.

## Structure

1. **What.** The event, in a few words.
2. **When.** Date, time and time zone, written out. "Tuesday 2026-09-15, 10:00 PT". A time without a zone is a mistake.
3. **Where.** The URL to join, or the address.
4. **Link.** The event page, last, if it is not the same as where.

## Where it goes

The socials and a board ahead of time, and the calendar network with --at. Post it once when it is announced and once shortly before; more than that is nagging.

${HOUSE}`,
  },
  "social-update": {
    description: "A short line about something that shipped or happened, for the socials and a board. The default type when no blog is targeted.",
    allowedKinds: ["social", "forum", "youtube", "other"],
    requiresUrl: false,
    structure: ["what-happened", "link"],
    body: `## What this is

The everyday post: something shipped, something got fixed, something is worth a look. One or two lines and, usually, a link. This is what myna assumes a post is when no --type is given and no blog is among the targets.

## Structure

1. **What happened.** One or two lines, the concrete thing first.
2. **Link.** Last, when there is one.

## Where it goes

The socials and a board. Never the blog: a blog post is a launch-announcement or an essay, and myna refuses a social-update aimed at a blog target.

${HOUSE}`,
  },
};

export const BUILTIN_TYPES = Object.keys(TYPE_TEMPLATES);

/** The type skill as generated. Throws for a slug without a template. */
export function typeTemplate(type: string): { frontmatter: TypeFrontmatter; body: string } {
  const slug = safeSlug(type);
  const template = TYPE_TEMPLATES[slug];
  if (!template) throw new Error(`No built-in post type "${slug}". Built in: ${BUILTIN_TYPES.join(", ")}. Add your own: myna skill add --type ${slug} --from file.md`);
  const frontmatter: TypeFrontmatter = {
    name: `myna-type-${slug}`,
    description: template.description,
    type: slug,
    allowedKinds: template.allowedKinds,
    ...(template.maxPerDay !== undefined ? { maxPerDay: template.maxPerDay } : {}),
    requiresUrl: template.requiresUrl,
    structure: template.structure,
    generatedFrom: `type@${TYPE_TEMPLATE_VERSION}`,
  };
  const body = `# ${slug}

${template.description}

Allowed on: ${template.allowedKinds.join(", ")}. myna refuses this type on any other kind of target.${template.maxPerDay !== undefined ? ` At most ${template.maxPerDay} a day across every account.` : ""}

${template.body}`;
  return { frontmatter, body };
}

function asTypeSkill(file: SkillFile, slug: string): TypeSkill {
  return { ...file, type: slug, frontmatter: file.frontmatter as TypeFrontmatter };
}

/** Write a built-in type's skill when absent (or --force). */
export function ensureTypeSkill(type: string, options: { force?: boolean } = {}): { path: string; written: boolean } {
  const slug = safeSlug(type);
  const path = typeSkillPath(slug);
  if (readSkillFile(path) && !options.force) return { path, written: false };
  const { frontmatter, body } = typeTemplate(slug);
  writeSkillFile(path, frontmatter, body);
  return { path, written: true };
}

/** Materialise every built-in type. Existing files, edited or not, are kept unless `force`. */
export function initTypeSkills(options: { force?: boolean } = {}): { written: string[]; kept: string[] } {
  const result = { written: [] as string[], kept: [] as string[] };
  for (const slug of BUILTIN_TYPES) {
    const done = ensureTypeSkill(slug, options);
    (done.written ? result.written : result.kept).push(done.path);
  }
  return result;
}

/** The type skill from disk, else the template for a built-in, else undefined. */
export function readTypeSkill(type: string, options: { materialise?: boolean } = {}): TypeSkill | undefined {
  const slug = safeSlug(type);
  if (options.materialise && TYPE_TEMPLATES[slug]) ensureTypeSkill(slug);
  const file = readSkillFile(typeSkillPath(slug));
  if (file) return asTypeSkill(file, slug);
  if (!TYPE_TEMPLATES[slug]) return undefined;
  const { frontmatter, body } = typeTemplate(slug);
  return { slug: DEFAULT_SKILL_SLUG, type: slug, path: typeSkillPath(slug), frontmatter, body, raw: "" };
}

export function requireTypeSkill(type: string): TypeSkill {
  const skill = readTypeSkill(type);
  if (!skill) throw new Error(`No post type "${type}". Run: myna skill list (the TYPES table), or add it: myna skill add --type ${safeSlug(type)} --from file.md`);
  return skill;
}

/** Every type: the built-ins in their order, then anything a person added. */
export function listTypeSkills(): TypeSkill[] {
  const seen = new Set<string>();
  const out: TypeSkill[] = [];
  for (const slug of [...BUILTIN_TYPES, ...listTypeSlugs()]) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    const skill = readTypeSkill(slug);
    if (skill) out.push(skill);
  }
  return out;
}

/** Add a type of your own, or replace one with --force. The file's own frontmatter wins over the defaults. */
export function addTypeSkill(type: string, source: string, options: { force?: boolean } = {}): TypeSkill {
  const slug = safeSlug(type);
  const path = typeSkillPath(slug);
  if (readSkillFile(path) && !options.force) throw new Error(`The post type "${slug}" already exists. Pass --force to replace it, or edit ${path}.`);
  const parsed = source.trim().startsWith("---") ? parseSkill(source) : { frontmatter: {} as TypeFrontmatter, body: source };
  const given = { ...parsed.frontmatter } as Partial<TypeFrontmatter>;
  if (!given.name) delete given.name;
  if (!given.description) delete given.description;
  const frontmatter: TypeFrontmatter = {
    ...given,
    name: given.name ?? `myna-type-${slug}`,
    description: given.description ?? `A post type added by hand: ${slug}.`,
    type: slug,
  };
  if (typeof frontmatter.allowedKinds === "string") frontmatter.allowedKinds = String(frontmatter.allowedKinds).split(",").map((kind) => kind.trim()).filter(Boolean);
  if (typeof frontmatter.structure === "string") frontmatter.structure = String(frontmatter.structure).split(",").map((step) => step.trim()).filter(Boolean);
  writeSkillFile(path, frontmatter, parsed.body.trim() || `# ${slug}\n\nSay what this kind of post is and where it may go.`);
  return readTypeSkill(slug) as TypeSkill;
}

export function removeTypeSkill(type: string): boolean {
  return removeSkillFile(typeSkillPath(safeSlug(type)));
}

/* ---------------------------------------------------------- resolution */

/** The type a post gets when nobody named one: a blog or a mirror among the targets makes it a launch. */
export function defaultTypeFor(accounts: Array<Pick<Account, "network">>): string {
  const kinds = accounts.map((account) => skillKindFor(account.network));
  return kinds.some((kind) => kind === "blog" || kind === "longform") ? DEFAULT_BLOG_TYPE : DEFAULT_SOCIAL_TYPE;
}

/** May this type go to a target of this kind? A type with no allowedKinds goes anywhere. */
export function typeAllows(skill: Pick<TypeSkill, "frontmatter">, kind: SkillKind): boolean {
  const allowed = skill.frontmatter.allowedKinds;
  if (!allowed || !allowed.length) return true;
  return allowed.includes(kind);
}

/**
 * The targets a type may not go to, with the reason each time. The caller
 * turns this into an error before anything is planned: a bug-story aimed at
 * the blog is the exact thing the blog policy forbids.
 */
export function refusedTargets(type: string, accounts: Array<Pick<Account, "id" | "network">>): Array<{ account: Pick<Account, "id" | "network">; kind: SkillKind; reason: string }> {
  const skill = requireTypeSkill(type);
  const out: Array<{ account: Pick<Account, "id" | "network">; kind: SkillKind; reason: string }> = [];
  for (const account of accounts) {
    const kind = skillKindFor(account.network);
    if (typeAllows(skill, kind)) continue;
    out.push({
      account,
      kind,
      reason: `${account.id} is a ${kind} target and a ${skill.type} is allowed on ${(skill.frontmatter.allowedKinds ?? []).join(", ")} only`,
    });
  }
  return out;
}

/** Throw when the type may not go to any of these targets. */
export function refuseTypeMismatch(type: string, accounts: Array<Pick<Account, "id" | "network">>): void {
  const refused = refusedTargets(type, accounts);
  if (!refused.length) return;
  const skill = requireTypeSkill(type);
  const lines = refused.map((row) => `  ${row.reason}`);
  throw new Error(
    `A ${skill.type} cannot go there:\n${lines.join("\n")}\n` +
      `Drop that target, or pass a type it carries (myna skill list shows each type's allowed kinds). ` +
      (refused.some((row) => row.kind === "blog") ? "The blog carries launch-announcement and essay only." : ""),
  );
}

/** Times posts of this type went out or are booked, across every account. */
export function bookingsForType(type: string, history: HistoryEntry[], queue: QueuedPost[]): number[] {
  const times: number[] = [];
  for (const entry of history) {
    if (entry.ok && entry.type === type) {
      const at = new Date(entry.at).getTime();
      if (!Number.isNaN(at)) times.push(at);
    }
  }
  for (const post of queue) {
    if ((post.status === "pending" || post.status === "sending") && post.type === type) {
      const at = new Date(post.scheduledFor).getTime();
      if (!Number.isNaN(at)) times.push(at);
    }
  }
  return times.sort((a, b) => a - b);
}

/** The type's own daily cap, for the planner. Undefined when the type has none. */
export function typeCapFor(type: string): number | undefined {
  const skill = readTypeSkill(type);
  const cap = skill?.frontmatter.maxPerDay;
  return typeof cap === "number" && cap > 0 ? cap : undefined;
}
