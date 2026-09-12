/**
 * Skills: the rules for each place myna posts to, written down where both a
 * person and an agent can read them, and enforced by the scheduler.
 *
 * Three layers, each one a Markdown file with frontmatter:
 *
 *   built-in template          one per kind of network, in this file
 *   skills/<network>/skill.md  the network's rules, generated once, yours to edit
 *   skills/<network>/<account>/skill.md
 *                              one account's rules on top of the network's;
 *                              more files beside it are skills to rotate through
 *
 * A post to an account resolves the account's selected skill (its pinned
 * default, or the next one in rotation), which inherits from the network
 * skill, which inherits from the template. Limits merge with the stricter
 * value winning, so a rotated skill can tighten the blog's four a day and
 * never loosen it. The body an agent reads is the account skill followed by
 * the network skill.
 *
 * This came out of a blog that had turned spammy: the same release announced
 * three times, every bug fix a post. The blog template says four a day and
 * major features only, and the scheduler holds a post to the next day rather
 * than let a fifth one through.
 */
import type { Account } from "../net/types.ts";
import { getNetwork } from "../net/registry.ts";
import { getDirectory } from "../directories/registry.ts";
import type { DirectoryAccount } from "../directories/types.ts";
import type { HistoryEntry } from "../store/history.ts";
import { loadSettings, saveSettings, type Settings } from "../store/settings.ts";
import {
  DEFAULT_SKILL_SLUG,
  accountSkillDir,
  accountSkillPath,
  handleSlug,
  listSkillFiles,
  networkSkillPath,
  parseSkill,
  readSkillFile,
  removeSkillFile,
  safeSlug,
  writeSkillFile,
  type SkillFile,
  type SkillFrontmatter,
  type SkillKind,
  type SkillLimits,
} from "../store/skills.ts";
import { textKey } from "./pacing.ts";
import { deriveTitle } from "../util/text.ts";
import { readTypeSkill, type TypeSkill } from "./post-types.ts";

/** Bump when a template changes in a way worth re-materialising with --force. */
export const TEMPLATE_VERSION = "1";

/* ---------------------------------------------------------------- kinds */

const KIND_BY_NETWORK: Record<string, SkillKind> = {
  gitblog: "blog",
  htmlblog: "blog",
  youtube: "youtube",
  // Tumblr is filed under "minor" but takes a whole article and a source URL.
  tumblr: "longform",
  // A calendar entry is not a post of any kind; the template stays generic.
  gcal: "other",
};

/** Which template a network gets. Unknown (plugin) networks are read off their category. */
export function skillKindFor(networkId: string): SkillKind {
  const known = KIND_BY_NETWORK[networkId];
  if (known) return known;
  const network = getNetwork(networkId);
  if (!network) return getDirectory(networkId) ? "directory" : "other";
  if (network.category === "blog") return "longform";
  if (network.category === "forum") return "forum";
  if (network.category === "major" || network.category === "fediverse" || network.category === "chat") return "social";
  // "minor" covers a lot: a status post is social, a page or an event is not.
  if (network.category === "minor") return network.caps.explicitTarget ? "other" : "social";
  return "other";
}

/** Per-network character caps a person would expect to see named. */
const CHAR_CAPS: Record<string, number> = { bluesky: 300, mastodon: 500, linkedin: 3000, x: 280, threads: 500 };

/**
 * What the built-in template says for a kind, before any file or setting.
 *
 * The daily caps sit at or above what the default pacing already allows, so
 * turning skills on changes nothing for a queue that was fine; the blog's
 * four a day is the one that bites, and it is the one that was asked for.
 * `minGapMinutes` is left out where the global gap should rule: a template
 * gap wider than `myna pace --gap` would silently slow every account down.
 * The forum is the exception. A board reads a burst of topics from one
 * member as spam whatever the global gap says, and it did: bbs.hqtui.com
 * got two topics 29 minutes apart and three inside ten minutes on a day the
 * gap had been set to 2h. So a board is four hours apart and six a day,
 * whatever `myna pace` says, and a file can only tighten that.
 */
export function templateLimits(kind: SkillKind, networkId: string, settings?: Pick<Settings, "blog">): SkillLimits {
  const charLimit = CHAR_CAPS[networkId] ?? getNetwork(networkId)?.caps.charLimit ?? 0;
  switch (kind) {
    case "blog":
      return {
        maxPerDay: settings?.blog?.maxPerDay ?? 4,
        minGapMinutes: 60,
        contentPolicy: "major-features-only",
        requiresCanonical: false,
      };
    case "longform":
      return { maxPerDay: 4, contentPolicy: "mirror-of-blog", requiresCanonical: true };
    case "forum":
      return { maxPerDay: 6, minGapMinutes: 240, contentPolicy: "announcements-and-replies" };
    case "youtube":
      return { maxPerDay: 5, minGapMinutes: 30, maxChars: 500, contentPolicy: "short-comments" };
    case "directory":
      return { maxPerDay: 1, minGapMinutes: 1440, contentPolicy: "one-listing-per-product" };
    case "social":
      return { maxPerDay: 12, maxChars: charLimit || undefined, contentPolicy: "launches-and-updates" };
    default:
      return { maxPerDay: 12, contentPolicy: "as-configured" };
  }
}

/* ------------------------------------------------------------ templates */

const HOUSE_STYLE = `## House style

- No em dashes, no en dashes, no curly quotes. Use a period, a comma or parentheses.
- No LLM tells: no "not just X, but Y", no rule-of-three lists for their own sake, no "here's the thing", no summary flourish at the end of a section.
- Concrete details over generalities. Real numbers, real commands, real gotchas.
- A real title that says what shipped, not a teaser.
- Short. Say it once and stop.`;

const NETWORK_BODY: Record<SkillKind, (network: string, limits: SkillLimits) => string> = {
  blog: (network, limits) => `## What this blog is for

This blog carries major feature announcements and launches only. A post here is a page that stays up and gets indexed, so it has to earn its place.

- Post when something shipped that a reader can use: a new product, a major feature, a release with a real change in it.
- No bug-fix stories, no "every little update", no build logs. Those belong on the socials, or nowhere.
- One post can bundle several related features from the same week. Prefer one good post over three thin ones.
- Never re-send a title that is already in the history for this blog. myna refuses a duplicate title outright unless you pass --allow-duplicate, and it should almost never be passed.
- At most ${limits.maxPerDay} posts a day. myna holds a fifth one to the next day rather than sending it.

## Canonical URL

This blog is the original. Every syndicated copy (dev.to, Hashnode, Ghost, Tumblr) must be posted with --canonical-url pointing at the page here, so search engines rank this page and not the mirror. Never post a mirror first.

${HOUSE_STYLE}

## Blog or socials

The blog gets the announcement; the socials get a short line with the link. A fix, a patch release, a small quality-of-life change goes to the socials only. If you are unsure whether it is a major feature, it is not, and it does not go on the blog.

## Posting

    myna post --to ${network} --title "..." --description "..." < post.md

The first line of post.md is the title when --title is not given.`,

  social: (network, limits) => `## What goes here

Short posts about launches and real updates, one post per launch. A launch is announced once here; the reposts and cross-account copies are queued by the drip, so do not send them by hand.

- ${limits.maxChars ? `At most ${limits.maxChars} characters on ${network}; myna truncates or threads past that.` : `No hard character cap on ${network}, but keep it to a few lines.`}
- The URL goes last, on its own, after the text.
- No hashtag spam: two or three at most, and only where they are idiomatic. None on LinkedIn.
- Reposts and repeats keep to the pacing settings (myna pace): one post per network per gap, the same text to the same account not inside the repost gap.
- At most ${limits.maxPerDay} posts a day to this account.

${HOUSE_STYLE}

## Posting

    myna post --to ${network} "what shipped, in one or two lines"

Use --to all for every social account at once; myna spreads them over the drip.`,

  forum: (network, limits) => `## What goes here

A post on a board opens a topic that other people reply to, so it should be something worth a thread: a release with a real change, a tool people on this board would use, a question with substance.

- Posts cycle through the forums chosen at login, one forum per post. Use --forum <slug> for a one-off detour without moving the cursor.
- A title is required. myna derives one from the first sentence when none is given, so make the first sentence the headline.
- Reply etiquette: answer replies in the thread rather than opening a new topic; do not bump your own topic; one topic per release, not one per forum.
- At most ${limits.maxPerDay} new topics a day, and at least ${Math.round((limits.minGapMinutes ?? 240) / 60)} hours apart, whatever the global gap is. Announcements go out through the drip like any social post.

${HOUSE_STYLE}

## Posting

    myna post --to ${network} --title "..." "the body"
    myna post --to ${network} --forum announcements "..."`,

  longform: (network, limits) => `## What goes here

${network} is a mirror, never an original. A post here is a copy of a page that already exists on one of our own blogs, published with the canonical URL pointing back at that page.

- Always pass --canonical-url <our blog page>. Without it the mirror can outrank the original. requiresCanonical in this file is the rule an agent checks before posting here.
- Publish here only after the blog post is live, and use the exact Markdown that was published there (myna history --json has it).
- Same content rules as the blog: major features and launches only, no duplicate titles, no bug-fix stories.
- At most ${limits.maxPerDay} articles a day.

${HOUSE_STYLE}

## Posting

    myna post --to ${network} --title "..." --canonical-url https://our.blog/page < post.md`,

  directory: (network, limits) => `## What goes here

${network} lists the product itself, not a post about it. One listing per product, kept current, never resubmitted.

- Short: a name, one sentence, a category and a few tags. The directory's own vocabulary wins (myna directory categories ${network}).
- Update an existing listing rather than submitting a second one.
- At most ${limits.maxPerDay} submission a day.

## Posting

    myna directory ${network} https://product.example --dry-run
    myna directory listings ${network}`,

  youtube: (network, limits) => `## What goes here

A post to ${network} is a comment on someone's video, found with myna search. It is short, on topic for the video, and useful to the people watching it.

- Find the video first: myna search youtube "<topic>", then post with --video <id>.
- Keep it under ${limits.maxChars} characters. One link at most, and only when it answers the video.
- Never comment the same text on several videos. That is spam and gets the channel flagged.
- At most ${limits.maxPerDay} comments a day.

${HOUSE_STYLE}

## Posting

    myna post --to ${network} "a useful comment" --video <id>`,

  other: (network, limits) => `## What goes here

${network} has no built-in rules yet. Edit this file to say what belongs here and how often.

- At most ${limits.maxPerDay} posts a day.

${HOUSE_STYLE}`,
};

const KIND_NAMES: Record<SkillKind, string> = {
  blog: "blog",
  social: "social network",
  forum: "board",
  longform: "longform mirror",
  directory: "directory",
  youtube: "video comments",
  other: "target",
};

function networkLabel(networkId: string): string {
  return getNetwork(networkId)?.name ?? getDirectory(networkId)?.name ?? networkId;
}

/** Best guess at where an account lives on the web, for the header. */
export function profileUrlFor(account: Pick<Account, "network" | "handle" | "meta">): string | undefined {
  const handle = account.handle.replace(/^@/, "");
  const meta = account.meta ?? {};
  switch (account.network) {
    case "bluesky":
      return `https://bsky.app/profile/${handle}`;
    case "x":
      return `https://x.com/${handle}`;
    case "devto":
      return `https://dev.to/${handle}`;
    case "threads":
      return `https://www.threads.net/@${handle}`;
    case "instagram":
      return `https://www.instagram.com/${handle}`;
    case "tiktok":
      return `https://www.tiktok.com/@${handle}`;
    case "mastodon":
    case "misskey":
    case "pixelfed": {
      const [user, host] = handle.split("@");
      const instance = meta.instance?.replace(/\/+$/, "");
      if (instance && user) return `${instance}/@${user}`;
      if (host && user) return `https://${host}/@${user}`;
      return undefined;
    }
    case "gitblog":
      return meta.siteUrl || meta.htmlUrl || undefined;
    case "htmlblog":
      return meta.siteUrl || undefined;
    case "tsbb":
    case "agenticjobs":
      return meta.instance || undefined;
    default:
      return meta.siteUrl || meta.url || meta.instance || meta.homeserver || undefined;
  }
}

/** The network-level skill, as generated. */
export function networkTemplate(networkId: string, settings?: Pick<Settings, "blog">): { frontmatter: SkillFrontmatter; body: string } {
  const kind = skillKindFor(networkId);
  const limits = templateLimits(kind, networkId, settings);
  const label = networkLabel(networkId);
  const frontmatter: SkillFrontmatter = {
    name: `myna-${networkId}`,
    description: `How myna posts to ${label}: what belongs there, how often, and the house style. Read before posting to any ${networkId} account.`,
    kind,
    network: networkId,
    ...limits,
    generatedFrom: `${kind}@${TEMPLATE_VERSION}`,
  };
  const body = `# ${label}

The rules for every ${networkId} account on this machine. Each account has its own skill beside this one that adds to it; the stricter limit always wins. Change this file to change the rules; myna never overwrites a file you have edited.

${NETWORK_BODY[kind](networkId, limits)}`;
  return { frontmatter, body };
}

/** The per-account default skill, as generated. */
export function accountTemplate(
  account: Pick<Account, "id" | "network" | "handle" | "addedAt" | "meta" | "displayName">,
  settings?: Pick<Settings, "blog">,
): { frontmatter: SkillFrontmatter; body: string } {
  const kind = skillKindFor(account.network);
  const limits = templateLimits(kind, account.network, settings);
  const label = networkLabel(account.network);
  const profile = profileUrlFor(account);
  const connected = account.addedAt ? account.addedAt.slice(0, 10) : undefined;
  const frontmatter: SkillFrontmatter = {
    name: `myna-${account.network}-${handleSlug(account.handle)}`,
    description: `The rules for ${account.id}: a ${KIND_NAMES[kind]} on ${label}. Read this and the ${account.network} skill before posting there.`,
    kind,
    network: account.network,
    account: account.id,
    ...(profile ? { profileUrl: profile } : {}),
    ...(connected ? { connectedAt: connected } : {}),
    ...limits,
    generatedFrom: `${kind}@${TEMPLATE_VERSION}`,
  };
  const header = [
    `# ${account.id}`,
    "",
    `- Network: ${label} (${account.network})`,
    `- Username: ${account.handle}${account.displayName && account.displayName !== account.handle ? ` (${account.displayName})` : ""}`,
    ...(profile ? [`- Profile: ${profile}`] : []),
    ...(connected ? [`- Connected: ${connected}`] : []),
    "",
    `This file adds to the ${account.network} skill (skills/${account.network}/skill.md), which carries the full rules for the network. Limits here and there merge with the stricter one winning. Put anything specific to this account below: its voice, what it covers, what it never mentions.`,
    "",
  ].join("\n");
  const body = `${header}\n${ACCOUNT_BODY[kind](account.network, limits)}`;
  return { frontmatter, body };
}

const ACCOUNT_BODY: Record<SkillKind, (network: string, limits: SkillLimits) => string> = {
  blog: (_network, limits) => `## The short version

- Major feature announcements and launches only. No bug-fix stories, no small updates, no re-sends.
- At most ${limits.maxPerDay} posts a day; one post may bundle several related features.
- Never a title that is already in this blog's history.
- This page is the canonical original; every mirror points back here with --canonical-url.
- No em dashes, no LLM tells, concrete details, a real title.

## Voice

Plain and specific. First person is fine. Say what shipped, what it does and how to use it.`,
  social: (_network, limits) => `## The short version

- One post per launch, ${limits.maxChars ? `under ${limits.maxChars} characters, ` : ""}URL last.
- Reposts are spaced by the pacing settings; do not send them by hand.
- No hashtag spam.

## Voice

Plain and specific. A launch line reads: what it is, what changed, the link.`,
  forum: () => `## The short version

- One topic per release, cycling through the chosen forums.
- A real headline in the first sentence; answer replies in the thread.

## Voice

Written for people who will reply. Enough detail to start a conversation.`,
  longform: () => `## The short version

- A mirror of a blog post, never an original. Always --canonical-url.
- Same rules as the blog: major features only, no duplicate titles.`,
  directory: () => `## The short version

- One listing per product. Update it, never resubmit.`,
  youtube: (_network, limits) => `## The short version

- A comment on a video found with myna search, under ${limits.maxChars} characters, on topic.
- Never the same comment on several videos.`,
  other: () => `## Notes

Nothing account-specific yet.`,
};

/* ------------------------------------------------------- materialising */

export interface InitResult {
  written: string[];
  kept: string[];
}

/** Write the network skill when it is absent (or --force). Returns the path and whether it was written. */
export function ensureNetworkSkill(networkId: string, options: { force?: boolean; settings?: Settings } = {}): { path: string; written: boolean } {
  const path = networkSkillPath(networkId);
  const existing = readSkillFile(path);
  if (existing && !options.force) return { path, written: false };
  const { frontmatter, body } = networkTemplate(networkId, options.settings ?? loadSettings());
  writeSkillFile(path, frontmatter, body);
  return { path, written: true };
}

/** Write the account's default skill when it is absent (or --force). Never touches other skills beside it. */
export function ensureAccountSkill(
  account: Pick<Account, "id" | "network" | "handle" | "addedAt" | "meta" | "displayName">,
  options: { force?: boolean; settings?: Settings } = {},
): { path: string; written: boolean } {
  const path = accountSkillPath(account.network, account.handle);
  const existing = readSkillFile(path);
  if (existing && !options.force) return { path, written: false };
  const { frontmatter, body } = accountTemplate(account, options.settings ?? loadSettings());
  writeSkillFile(path, frontmatter, body);
  return { path, written: true };
}

/** A directory account, seen as something with a skill: the directory id is its "network". */
export function directoryAsAccount(account: DirectoryAccount): Pick<Account, "id" | "network" | "handle" | "addedAt" | "meta" | "displayName"> {
  return { id: `${account.directory}:${account.handle}`, network: account.directory, handle: account.handle, addedAt: account.addedAt, meta: account.meta, displayName: account.handle };
}

/**
 * Materialise every skill that is missing: one per network that has an
 * account, one per account. A file that exists is left exactly as it is,
 * edited or not, unless `force` is set.
 */
export function initSkills(
  accounts: Array<Pick<Account, "id" | "network" | "handle" | "addedAt" | "meta" | "displayName">>,
  options: { force?: boolean } = {},
): InitResult {
  const settings = loadSettings();
  const result: InitResult = { written: [], kept: [] };
  const networks = [...new Set(accounts.map((account) => account.network))].sort();
  for (const network of networks) {
    const done = ensureNetworkSkill(network, { force: options.force, settings });
    (done.written ? result.written : result.kept).push(done.path);
  }
  for (const account of accounts.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    const done = ensureAccountSkill(account, { force: options.force, settings });
    (done.written ? result.written : result.kept).push(done.path);
  }
  return result;
}

/* --------------------------------------------------------------- reading */

/** The network skill from disk, or the template when there is no file yet. */
export function readNetworkSkill(networkId: string, options: { materialise?: boolean } = {}): SkillFile {
  const path = networkSkillPath(networkId);
  if (options.materialise) ensureNetworkSkill(networkId);
  const file = readSkillFile(path);
  if (file) return file;
  const { frontmatter, body } = networkTemplate(networkId, loadSettings());
  return { slug: DEFAULT_SKILL_SLUG, path, frontmatter, body, raw: "" };
}

/** Every skill an account has, default first. Empty when nothing was materialised and `materialise` is off. */
export function listAccountSkills(
  account: Pick<Account, "id" | "network" | "handle" | "addedAt" | "meta" | "displayName">,
  options: { materialise?: boolean } = {},
): SkillFile[] {
  if (options.materialise) ensureAccountSkill(account);
  const files = listSkillFiles(accountSkillDir(account.network, account.handle));
  if (files.some((file) => file.slug === DEFAULT_SKILL_SLUG)) return files;
  const { frontmatter, body } = accountTemplate(account, loadSettings());
  return [{ slug: DEFAULT_SKILL_SLUG, path: accountSkillPath(account.network, account.handle), frontmatter, body, raw: "" }, ...files];
}

export function readAccountSkill(
  account: Pick<Account, "id" | "network" | "handle" | "addedAt" | "meta" | "displayName">,
  slug = DEFAULT_SKILL_SLUG,
  options: { materialise?: boolean } = {},
): SkillFile | undefined {
  return listAccountSkills(account, options).find((file) => file.slug === safeSlug(slug));
}

/* ------------------------------------------------- adding and removing */

export function addAccountSkill(
  account: Pick<Account, "id" | "network" | "handle" | "addedAt" | "meta" | "displayName">,
  slug: string,
  source: string,
  options: { force?: boolean } = {},
): SkillFile {
  const clean = safeSlug(slug);
  if (clean === DEFAULT_SKILL_SLUG) throw new Error(`"${DEFAULT_SKILL_SLUG}" is the generated default. Edit it in place, or pick another name.`);
  const path = accountSkillPath(account.network, account.handle, clean);
  if (readSkillFile(path) && !options.force) throw new Error(`${account.id} already has a skill called "${clean}". Pass --force to replace it.`);
  ensureAccountSkill(account);
  const parsed = source.trim().startsWith("---") ? parseFrontmatter(source) : { frontmatter: undefined, body: source };
  const kind = skillKindFor(account.network);
  const frontmatter: SkillFrontmatter = {
    name: `myna-${account.network}-${handleSlug(account.handle)}-${clean}`,
    description: `A skill for ${account.id}. Rotates with the others when rotation is on.`,
    kind,
    network: account.network,
    account: account.id,
    ...(parsed.frontmatter ?? {}),
  };
  writeSkillFile(path, frontmatter, parsed.body);
  return readSkillFile(path) as SkillFile;
}

function parseFrontmatter(source: string): { frontmatter: SkillFrontmatter; body: string } {
  // A file pasted in whole keeps its own frontmatter; we only fill in what it left out.
  const { frontmatter, body } = parseSkill(source);
  const trimmed: SkillFrontmatter = { ...frontmatter };
  if (!trimmed.name) delete (trimmed as Record<string, unknown>).name;
  if (!trimmed.description) delete (trimmed as Record<string, unknown>).description;
  return { frontmatter: trimmed, body };
}


export function removeAccountSkill(account: Pick<Account, "network" | "handle" | "id">, slug: string): boolean {
  const clean = safeSlug(slug);
  if (clean === DEFAULT_SKILL_SLUG) throw new Error(`The default skill is not removed; myna would only generate it again. Edit it instead.`);
  const removed = removeSkillFile(accountSkillPath(account.network, account.handle, clean));
  if (removed) {
    const settings = loadSettings();
    let changed = false;
    if (settings.skills.defaults[account.id] === clean) {
      delete settings.skills.defaults[account.id];
      changed = true;
    }
    if (settings.skills.cursor[account.id] === clean) {
      delete settings.skills.cursor[account.id];
      changed = true;
    }
    if (changed) saveSettings(settings);
  }
  return removed;
}

/* --------------------------------------------------- default + rotation */

export function pinDefaultSkill(account: Pick<Account, "id" | "network" | "handle" | "addedAt" | "meta" | "displayName">, slug: string): void {
  const clean = safeSlug(slug);
  if (!readAccountSkill(account, clean)) throw new Error(`${account.id} has no skill called "${clean}". Run: myna skill list`);
  const settings = loadSettings();
  if (clean === DEFAULT_SKILL_SLUG) delete settings.skills.defaults[account.id];
  else settings.skills.defaults[account.id] = clean;
  saveSettings(settings);
}

export function setRotation(account: Pick<Account, "id">, on: boolean): void {
  const settings = loadSettings();
  if (on) settings.skills.rotate[account.id] = true;
  else delete settings.skills.rotate[account.id];
  saveSettings(settings);
}

export interface Selection {
  skill: SkillFile;
  /** Every skill the account has, in rotation order. */
  all: SkillFile[];
  rotating: boolean;
  pinned?: string;
  /** What was used last, when rotating. */
  last?: string;
}

/**
 * Which skill a post to this account would use right now. Pure with respect
 * to the cursor: this is what the dashboard and MCP show without moving it.
 */
export function selectSkill(
  account: Pick<Account, "id" | "network" | "handle" | "addedAt" | "meta" | "displayName">,
  settings: Settings = loadSettings(),
): Selection {
  const all = listAccountSkills(account);
  const rotating = settings.skills.rotate[account.id] === true;
  const pinned = settings.skills.defaults[account.id];
  const fallback = all.find((file) => file.slug === DEFAULT_SKILL_SLUG) ?? all[0];
  if (rotating && all.length > 1) {
    const last = settings.skills.cursor[account.id];
    const index = last ? all.findIndex((file) => file.slug === last) : -1;
    const next = all[(index + 1) % all.length];
    return { skill: next, all, rotating, pinned, last };
  }
  const chosen = (pinned && all.find((file) => file.slug === pinned)) || fallback;
  return { skill: chosen, all, rotating, pinned };
}

/**
 * The skill a post is about to use, with the cursor moved past it when the
 * account rotates. Settings are written only when something changed, so a
 * non-rotating account never touches the file.
 */
export function takeSkill(
  account: Pick<Account, "id" | "network" | "handle" | "addedAt" | "meta" | "displayName">,
  settings: Settings = loadSettings(),
): SkillFile {
  const selection = selectSkill(account, settings);
  if (selection.rotating && settings.skills.cursor[account.id] !== selection.skill.slug) {
    settings.skills.cursor[account.id] = selection.skill.slug;
    saveSettings(settings);
  }
  return selection.skill;
}

/* ----------------------------------------------------------- resolving */

export interface ResolvedLimits extends SkillLimits {
  /** Which layer each value came from, for `myna skill show`. */
  sources: Partial<Record<keyof SkillLimits, "template" | "settings" | "network" | "account" | "selected">>;
}

export interface ResolvedSkill {
  account: string;
  network: string;
  kind: SkillKind;
  selected: SkillFile;
  networkSkill: SkillFile;
  /** The post type's skill, when one was asked for. */
  typeSkill?: TypeSkill;
  limits: ResolvedLimits;
  /** What an agent reads: the type skill, then the account skill, then the network skill. */
  body: string;
}

function limitsOf(file: SkillFile | undefined): SkillLimits {
  if (!file) return {};
  const fm = file.frontmatter;
  const out: SkillLimits = {};
  if (typeof fm.maxPerDay === "number") out.maxPerDay = fm.maxPerDay;
  if (typeof fm.minGapMinutes === "number") out.minGapMinutes = fm.minGapMinutes;
  if (typeof fm.maxChars === "number") out.maxChars = fm.maxChars;
  if (typeof fm.requiresCanonical === "boolean") out.requiresCanonical = fm.requiresCanonical;
  if (typeof fm.contentPolicy === "string" && fm.contentPolicy) out.contentPolicy = fm.contentPolicy;
  return out;
}

type Layer = { name: "network" | "account" | "selected"; limits: SkillLimits };

/**
 * Merge the layers with the stricter value winning. A value in any file beats
 * the template (a person who writes 6 in the blog's own file meant 6), and
 * between files the tighter one wins, so an account or a rotated skill can
 * narrow the network's rule and never widen it. `settings.blog.maxPerDay`
 * stands in for the template on a blog when no file names a value.
 */
export function mergeLimits(template: SkillLimits, layers: Layer[], settingsBlogMax?: number, kind?: SkillKind): ResolvedLimits {
  const out: ResolvedLimits = { sources: {} };
  const pick = <K extends keyof SkillLimits>(key: K, stricter: (a: NonNullable<SkillLimits[K]>, b: NonNullable<SkillLimits[K]>) => NonNullable<SkillLimits[K]>) => {
    let value: SkillLimits[K] | undefined;
    let source: ResolvedLimits["sources"][K] | undefined;
    for (const layer of layers) {
      const candidate = layer.limits[key];
      if (candidate === undefined) continue;
      if (value === undefined) {
        value = candidate;
        source = layer.name;
        continue;
      }
      const chosen = stricter(value as NonNullable<SkillLimits[K]>, candidate as NonNullable<SkillLimits[K]>);
      if (chosen !== value) {
        value = chosen;
        source = layer.name;
      }
    }
    if (value === undefined) {
      if (key === "maxPerDay" && kind === "blog" && settingsBlogMax !== undefined) {
        value = settingsBlogMax as SkillLimits[K];
        source = "settings";
      } else if (template[key] !== undefined) {
        value = template[key];
        source = "template";
      }
    }
    if (value !== undefined) {
      (out as SkillLimits)[key] = value;
      out.sources[key] = source;
    }
  };
  pick("maxPerDay", (a, b) => Math.min(a, b));
  pick("minGapMinutes", (a, b) => Math.max(a, b));
  pick("maxChars", (a, b) => Math.min(a, b));
  pick("requiresCanonical", (a, b) => a || b);
  // A policy is not a number: the most specific layer that names one wins.
  pick("contentPolicy", (_a, b) => b);
  return out;
}

/**
 * Everything the scheduler and an agent need for one account: the selected
 * skill, the network skill, the merged limits and the combined body.
 */
export function resolveSkill(
  account: Pick<Account, "id" | "network" | "handle" | "addedAt" | "meta" | "displayName">,
  options: { settings?: Settings; selected?: SkillFile; type?: string } = {},
): ResolvedSkill {
  const settings = options.settings ?? loadSettings();
  const kind = skillKindFor(account.network);
  const networkSkill = readNetworkSkill(account.network);
  const all = listAccountSkills(account);
  const accountDefault = all.find((file) => file.slug === DEFAULT_SKILL_SLUG);
  const selected = options.selected ?? selectSkill(account, settings).skill;
  // The template is the floor the settings override stands on; the files
  // are read raw so a value a person removed from a file falls through.
  const template = templateLimits(kind, account.network);
  const layers: Layer[] = [
    { name: "network", limits: networkSkill.raw ? limitsOf(networkSkill) : {} },
    { name: "account", limits: accountDefault?.raw ? limitsOf(accountDefault) : {} },
  ];
  if (selected.slug !== DEFAULT_SKILL_SLUG) layers.push({ name: "selected", limits: limitsOf(selected) });
  const limits = mergeLimits(template, layers, settings.blog?.maxPerDay, kind);
  const typeSkill = options.type ? readTypeSkill(options.type) : undefined;
  const body = [typeSkill?.body, selected.body, networkSkill.body].filter(Boolean).join("\n\n---\n\n");
  return { account: account.id, network: account.network, kind, selected, networkSkill, typeSkill, limits, body };
}

/** The limits the planner needs, in the units it uses. */
export function planLimitsFor(account: Account, settings?: Settings): { maxPerDay?: number; minGapMs?: number } {
  const { limits } = resolveSkill(account, { settings });
  return {
    maxPerDay: limits.maxPerDay,
    minGapMs: limits.minGapMinutes !== undefined ? limits.minGapMinutes * 60_000 : undefined,
  };
}

/* ------------------------------------------------------ duplicate titles */

/** The title a piece of blog text carries: the one given, else the one the poster would derive from its first line. */
export function titleOf(text: string, title?: string): string {
  if (title?.trim()) return title.trim();
  return deriveTitle(text);
}

/** Is a title already in this account's history? Blog kinds only; the rest repeat titles all the time. */
export function duplicateTitle(account: Pick<Account, "id" | "network">, text: string, title: string | undefined, history: HistoryEntry[]): HistoryEntry | undefined {
  const kind = skillKindFor(account.network);
  if (kind !== "blog" && kind !== "longform") return undefined;
  const wanted = textKey(titleOf(text, title));
  if (!wanted) return undefined;
  return history.find((entry) => entry.accountId === account.id && entry.ok && textKey(titleOf(entry.text, entry.title)) === wanted);
}

/** Every posting target that has a skill tree: connected accounts plus directory logins. */
export function skillTargets(accounts: Account[], directories: DirectoryAccount[] = []): Array<Pick<Account, "id" | "network" | "handle" | "addedAt" | "meta" | "displayName">> {
  return [...accounts, ...directories.map(directoryAsAccount)];
}

/** Find the target an argument names: `network:handle`, `network:handle-slug`, or a bare handle. */
export function findSkillTarget(
  spec: string,
  targets: Array<Pick<Account, "id" | "network" | "handle" | "addedAt" | "meta" | "displayName">>,
): Pick<Account, "id" | "network" | "handle" | "addedAt" | "meta" | "displayName"> | undefined {
  const wanted = spec.trim();
  const colon = wanted.indexOf(":");
  const network = colon > 0 ? wanted.slice(0, colon) : undefined;
  const rest = colon > 0 ? wanted.slice(colon + 1) : wanted;
  return targets.find(
    (target) =>
      target.id === wanted ||
      (network ? target.network === network && (target.handle === rest || handleSlug(target.handle) === rest || handleSlug(target.handle) === handleSlug(rest)) : target.handle === rest || handleSlug(target.handle) === rest),
  );
}

export { handleSlug, DEFAULT_SKILL_SLUG, safeSlug };
export type { SkillFile, SkillFrontmatter, SkillKind, SkillLimits };
