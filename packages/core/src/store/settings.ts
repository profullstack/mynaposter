/** User preferences. Plain JSON — no secrets here except by the user's choice. */
import { readJson, writeJson } from "../util/json.ts";
import { SETTINGS_FILE } from "../util/paths.ts";
import { DEFAULT_PACING, type PacingSettings } from "../core/pacing.ts";
import { DEFAULT_EVERGREEN, type EvergreenSettings } from "../core/evergreen.ts";
import { DEFAULT_RECAP, recapAddress, resolveRecapSettings, type RecapSettings } from "../core/recap.ts";
import { session as cloudSession } from "./cloud.ts";
import { DEFAULT_BRAND, type NewsletterBrand } from "../core/newsletter-layout.ts";
import { DEFAULT_UTM, type UtmSettings } from "../core/utm.ts";

export interface Settings {
  /** Default `--to` value when none is given. "all" posts everywhere. */
  defaultTargets: string;
  /** Appended to every post unless it is empty. */
  signature: string;
  theme: string;
  /** Split over-limit text into a reply chain instead of truncating. */
  threadByDefault: boolean;
  ai: {
    provider: "anthropic" | "openai" | "ollama";
    model: string;
    /** Voice instructions handed to the writer on every draft. */
    voice: string;
    maxHashtags: number;
  };
  infographic: {
    accent: string;
    background: string;
    footer: string;
  };
  /** The follow graph: read who your seeds follow, then follow the people they agree on. */
  graph: {
    /** Off until a person turns it on. Following people is not something to do by accident. */
    enabled: boolean;
    /** Ceiling per account. Networks throttle well below their published limits for new accounts. */
    followsPerHour: number;
    followsPerDay: number;
    /** How many of each seed's follows to read. */
    perSeed: number;
    /** Re-read a seed's list after this long. */
    expandEveryHours: number;
    /** Follow the seeds themselves as well as who they follow. */
    followSeeds: boolean;
    /** A candidate needs this many seeds following them before it is followed. 1 means any. */
    minSeeds: number;
    /** Which networks the daemon follows on: "all" or a comma list. */
    networks: string;
    /**
     * Which of a seed's lists to read: who they follow ("following", the
     * default), who follows them ("followers"), or both. Followers are the
     * noisier list, so they count for `followerWeight` of a follow.
     */
    expand: "following" | "followers" | "both";
    followerWeight: number;
    /**
     * Hand every account followed to OutreachGraph for assessment, the way
     * `--outreachgraph` does for one command. Needs `myna outreachgraph login`.
     */
    outreachgraph: boolean;
  };
  /**
   * How fast posts go out. Nothing is sent at the rate it was asked for:
   * one post per network per `minGap`, a multi-account post dripped over
   * `drip`, the same text to the same account not inside `repostGap`.
   */
  pacing: PacingSettings;
  /** Old pages from a blog account, re-posted on a slow cadence with an ad. */
  evergreen: EvergreenSettings;
  /** One email a day: what went out, what failed, what is booked next. */
  recap: RecapSettings;
  /**
   * Caps that live outside the skill files. `maxPerDay` here stands in for the
   * blog template's default when no skill file names a value; a value in a
   * skill file always wins over it.
   */
  blog: { maxPerDay?: number };
  /**
   * Campaign tags added to the links in a post, so the site a post drives
   * people to can see which network sent them. See core/utm.ts.
   */
  utm: UtmSettings;
  /** Which skill each account uses, and where its rotation stands. */
  skills: SkillSettings;
  /** Who you are, for `myna profile`: the OpenProfile.md myna writes when there is no hand-written one. */
  profile: ProfileSettings;
  /** The reshare network: what you offer to reshare for others, and what you ask for your own posts. */
  reshare: ReshareSettings;
  /** Follow-ups: who replied, reposted or followed, and what to send them back. */
  engage: EngageSettings;
  /** The upvoter: finding posts worth a vote, and what myna may do about them. */
  upvote: UpvoteSettings;
  /** Where a DID is proved: the CoinPay origin and the OAuth client myna is registered as there. */
  did: DidSettings;
  /** Direct mail and texts: the most that go out in a rolling day. */
  outreach: OutreachSettings;
  /** `myna newsletter`: the postal address every issue carries, and where unsubscribes land. */
  newsletter: NewsletterSettings;
  /** Settings sync with myna cloud (@profullstack/synconfig): settings.json, OpenProfile, skills. */
  synconfig: SynconfigSettings;
  /** Plugin specs: an absolute path, or a package name installed by `myna plugins add`. */
  plugins: string[];
  /**
   * Directories added by URL with `myna directory add`. Not secret — the id,
   * the endpoint and a name. The API key for each lives in the vault, like
   * every other credential.
   */
  directories: CustomDirectorySetting[];
}

/**
 * Skill selection per account id. The skills themselves are files under
 * skills/; this is only the pointer into them, kept here so editing a skill
 * never moves the cursor and moving the cursor never rewrites a skill.
 */
export interface SkillSettings {
  /** Pinned default slug per account. Absent means the generated `skill`. */
  defaults: Record<string, string>;
  /** Accounts that rotate through every skill they have, in order. */
  rotate: Record<string, boolean>;
  /** The slug each rotating account used last. */
  cursor: Record<string, string>;
}

/** A directory reached generically over MCP, as it is stored. */
export interface CustomDirectorySetting {
  id: string;
  url: string;
  name?: string;
  homepage?: string;
  blurb?: string;
}

export interface ProfileSettings {
  name: string;
  kind: "" | "person" | "agent" | "organization";
  handle: string;
  web: string;
  email: string;
  avatar: string;
  /** Where money for you goes: a CAIP-10 account, an address, a payment page. */
  pay: string;
  /** An OpenResume.md URL. */
  resume: string;
  headline: string;
  /** Comma list. What you write about; the reshare network matches on it. */
  topics: string;
  /** For an agent: who is answerable for it. */
  operatorName: string;
  operatorProfile: string;
  operatorEmail: string;
}

export interface ReshareSettings {
  /** Ask the network to reshare every post as it goes out. Off until turned on. */
  auto: boolean;
  /** The most reshares this install does for other people in a rolling day. */
  perDay: number;
  /** On a network with no repost API, post the link instead. */
  quote: boolean;
  /** Networks you will reshare on: "all" or a comma list of network ids. */
  networks: string;
  /** Comma list of topics you will reshare. Empty means your profile topics. */
  topics: string;
  /** Comma list of topics you refuse. */
  not: string;
  /** What one reshare by you costs the author, in USD. 0 is free. */
  rateUsd: number;
  /** What you offer per reshare of your own posts, in USD. 0 asks for free reshares only. */
  bountyUsd: number;
  /** How many people may reshare one of your posts. */
  maxSharers: number;
}

export const DEFAULT_PROFILE: ProfileSettings = {
  name: "",
  kind: "",
  handle: "",
  web: "",
  email: "",
  avatar: "",
  pay: "",
  resume: "",
  headline: "",
  topics: "",
  operatorName: "",
  operatorProfile: "",
  operatorEmail: "",
};

export const DEFAULT_RESHARE: ReshareSettings = {
  auto: false,
  perDay: 5,
  quote: true,
  networks: "all",
  topics: "",
  not: "",
  rateUsd: 0,
  bountyUsd: 0,
  maxSharers: 10,
};

export interface EngageSettings {
  /** Off until a person turns it on. Replying to people is not something to do by accident. */
  enabled: boolean;
  /** Follow-ups sent per account in a rolling day. */
  maxPerDay: number;
  /** Least time between two follow-ups from the same account. */
  gapMinutes: number;
  /** One follow-up per person per account inside this window. */
  cooldownDays: number;
  /** Follow whoever replied, reposted or followed. */
  followBack: boolean;
  /** Answer a reply, mention or quote with a drafted reply. */
  replyToMentions: boolean;
  /** Thank a repost under the post they shared. */
  thankReposts: boolean;
  /** Follow people who only liked. Off: a like is not a conversation. */
  followLikers: boolean;
  /** Which networks to engage on: "all" or a comma list. */
  networks: string;
  /** How far back a scan reads, per account. */
  scanLimit: number;
}

/**
 * The upvoter: what myna is allowed to do with somebody else's post.
 *
 * Every number here is a brake. The engine finds far more that it could vote
 * on than it should, and these decide how much of that actually goes out:
 * how close a match has to be, how fast an account may act, and how rarely a
 * reply is allowed to carry a link. The defaults are deliberately timid.
 */
export interface UpvoteSettings {
  /** Off until a person turns it on. Voting on strangers' posts is not something to do by accident. */
  enabled: boolean;
  /** Votes and shares cast per account in a rolling day. */
  maxPerDay: number;
  /** Least time between two actions from the same account. */
  gapMinutes: number;
  /** One action per author per account inside this window, however many of their posts match. */
  cooldownDays: number;
  /** Which networks to amplify on: "all" or a comma list. */
  networks: string;
  /**
   * Networks that are found and queued but never acted on without a person,
   * whatever `networks` says. Reddit's API terms forbid automated voting, so
   * it ships here: the queue fills, and `myna upvote send --network reddit`
   * is a decision somebody makes.
   */
  manualOnly: string;
  /** Results asked of each network per query. */
  searchLimit: number;
  /** Queries built per scan, strongest topics first. */
  queriesPerScan: number;
  /** How far back our own posts are read to work out what we are about. */
  topicDays: number;
  /** A post older than this is stale; the vote reads as a sweep rather than a reader. */
  maxAgeHours: number;
  /** 0-1. How well a post must match our topics before it is worth a vote. */
  minScore: number;
  /** 0-1. Of the posts voted on, the share also shared onward. 0 turns resharing off. */
  repostRatio: number;
  /** 0-1. Of the posts voted on, the share that also gets a reply carrying one of our links. */
  linkRatio: number;
  /** A link drop has to be a better match than a bare vote does. */
  linkMinScore: number;
  /** Replies carrying a link, per account, in a rolling day. The hard cap under `linkRatio`. */
  linkPerDay: number;
  /**
   * Hand everybody the upvoter finds to the plugins that collect people, as
   * leads. The upvoter does not know what a lead is: it fires `afterDiscover`
   * and whatever is installed decides. OutreachGraph reads this one.
   */
  leads: boolean;
}

export interface DidSettings {
  server: string;
  /** A public OAuth client (PKCE, loopback redirect) registered at the server with the `did` scope. */
  clientId: string;
}

export interface OutreachSettings {
  maxEmailsPerDay: number;
  maxSmsPerDay: number;
  /**
   * The mail provider `myna email` and newsletters use when none is named:
   * a `myna mail provider` id or an SMTP server id. Empty means the first
   * SMTP server, then the first mail provider.
   */
  mailProvider: string;
}

export const DEFAULT_OUTREACH: OutreachSettings = { maxEmailsPerDay: 200, maxSmsPerDay: 100, mailProvider: "" };

export interface NewsletterSettings {
  /**
   * The sender's physical postal address, printed at the foot of every issue.
   * CAN-SPAM requires one; a newsletter will not send without it.
   */
  address: string;
  /**
   * Your own one-click unsubscribe endpoint, with `{token}` where the
   * subscriber's token goes. Empty means myna cloud hosts it at
   * mynaposter.com, which needs `myna cloud login`.
   */
  unsubscribeUrl: string;
  /**
   * The crawlproof.com tracking id (24 hex). Set, every issue gets signed
   * click links, an open pixel and crawlproof's signed unsubscribe link. Its
   * secret is in the vault, never here.
   */
  trackingId: string;
  /** Where tracking lives. Only a test or a staging host changes it. */
  trackingHost: string;
  /** Milliseconds between two messages of one send. */
  paceMs: number;
  /** Named sets of calls to action; an issue with a set rotates through it, one per variant. */
  ctaSets: Record<string, NewsletterCta[]>;
  /** The links every issue's footer carries: book a demo, plans, shop, support us. */
  footerLinks: NewsletterCta[];
  /** Logo, name and accent colour. With a name or a logo set, issues go out in the branded layout. */
  brand: NewsletterBrand;
}

/** A call to action in a newsletter: the button text and where it goes. */
export interface NewsletterCta {
  label: string;
  url: string;
}

export const DEFAULT_CTAS: NewsletterCta[] = [
  { label: "Book a demo", url: "https://profullstack.com/book" },
  { label: "Schedule a call", url: "https://profullstack.com/contact" },
  { label: "See our plans", url: "https://profullstack.com/plans" },
  { label: "Support us", url: "https://profullstack.com/support-us" },
  { label: "Get the Power Key", url: "https://profullstack.com/shop" },
];

/**
 * The links every issue carries in its footer, whatever variant the reader
 * got: the standard Profullstack row.
 */
export const DEFAULT_FOOTER_LINKS: NewsletterCta[] = [
  { label: "Book a demo", url: "https://profullstack.com/book" },
  { label: "Schedule a call", url: "https://profullstack.com/contact" },
  { label: "Plans", url: "https://profullstack.com/plans" },
  { label: "Shop", url: "https://profullstack.com/shop" },
  { label: "Support us", url: "https://profullstack.com/support-us" },
];

export const DEFAULT_NEWSLETTER: NewsletterSettings = {
  address: "",
  unsubscribeUrl: "",
  trackingId: "",
  trackingHost: "https://crawlproof.com",
  paceMs: 1000,
  ctaSets: { default: DEFAULT_CTAS },
  footerLinks: DEFAULT_FOOTER_LINKS,
  brand: DEFAULT_BRAND,
};

/** Stored over the defaults, with the CTA sets copied so an edit never reaches the defaults. */
function newsletterSettings(stored: Partial<NewsletterSettings> | undefined): NewsletterSettings {
  const sets = stored?.ctaSets && typeof stored.ctaSets === "object" ? stored.ctaSets : DEFAULT_NEWSLETTER.ctaSets;
  const footerLinks = Array.isArray(stored?.footerLinks) ? stored.footerLinks : DEFAULT_FOOTER_LINKS;
  return { ...DEFAULT_NEWSLETTER, ...stored, ctaSets: structuredClone(sets), footerLinks: structuredClone(footerLinks), brand: { ...DEFAULT_BRAND, ...stored?.brand } };
}

export interface SynconfigSettings {
  /** Let the daemon pull and push on a schedule. On by default; it only runs once signed in to myna cloud. */
  auto: boolean;
  everyMinutes: number;
}

export const DEFAULT_SYNCONFIG: SynconfigSettings = { auto: true, everyMinutes: 5 };

export const DEFAULT_DID: DidSettings = {
  server: "https://coinpayportal.com",
  // myna's public OAuth client at CoinPay: PKCE, loopback redirect, scopes openid profile did.
  clientId: "cp_3aedc5cd194ff147d86341a2",
};

export const DEFAULT_ENGAGE: EngageSettings = {
  enabled: false,
  maxPerDay: 20,
  gapMinutes: 10,
  cooldownDays: 7,
  followBack: true,
  replyToMentions: true,
  thankReposts: true,
  followLikers: false,
  networks: "all",
  scanLimit: 40,
};

export const DEFAULT_UPVOTE: UpvoteSettings = {
  enabled: false,
  maxPerDay: 30,
  gapMinutes: 4,
  cooldownDays: 3,
  networks: "all",
  manualOnly: "reddit",
  searchLimit: 25,
  queriesPerScan: 6,
  topicDays: 14,
  maxAgeHours: 48,
  // Scoring returns a hard zero for anything that is not on subject, so this
  // only decides how strong a match has to be, not whether it is one at all.
  // One narrow term on its own lands near 0.24 and is worth a vote.
  minScore: 0.2,
  repostRatio: 0.15,
  // Roughly one reply in sixteen, and never more than `linkPerDay` of them.
  linkRatio: 0.06,
  linkMinScore: 0.5,
  linkPerDay: 2,
  leads: true,
};

export const DEFAULT_SETTINGS: Settings = {
  defaultTargets: "all",
  signature: "",
  theme: "dark",
  threadByDefault: true,
  ai: {
    provider: "anthropic",
    model: "claude-opus-5",
    voice: "Plain, specific, no hype. Never open with a hook cliché.",
    maxHashtags: 3,
  },
  infographic: {
    accent: "#5eead4",
    background: "#0b1020",
    footer: "",
  },
  graph: {
    enabled: false,
    followsPerHour: 10,
    followsPerDay: 80,
    perSeed: 200,
    expandEveryHours: 168,
    followSeeds: true,
    minSeeds: 1,
    networks: "all",
    expand: "following",
    followerWeight: 0.5,
    outreachgraph: false,
  },
  pacing: { ...DEFAULT_PACING },
  evergreen: { ...DEFAULT_EVERGREEN },
  recap: { ...DEFAULT_RECAP },
  blog: {},
  utm: DEFAULT_UTM,
  skills: { defaults: {}, rotate: {}, cursor: {} },
  profile: { ...DEFAULT_PROFILE },
  reshare: { ...DEFAULT_RESHARE },
  engage: { ...DEFAULT_ENGAGE },
  upvote: { ...DEFAULT_UPVOTE },
  did: { ...DEFAULT_DID },
  outreach: { ...DEFAULT_OUTREACH },
  newsletter: newsletterSettings(undefined),
  synconfig: { ...DEFAULT_SYNCONFIG },
  plugins: [],
  directories: [],
};

/**
 * MYNA_AI_PROVIDER and MYNA_AI_MODEL win over settings.json. A hosted API has
 * no settings file and no `myna config`, so the environment is its only knob.
 */
function aiFromEnv(): Partial<Settings["ai"]> {
  const out: Partial<Settings["ai"]> = {};
  const provider = process.env.MYNA_AI_PROVIDER;
  if (provider === "anthropic" || provider === "openai" || provider === "ollama") out.provider = provider;
  if (process.env.MYNA_AI_MODEL) out.model = process.env.MYNA_AI_MODEL;
  return out;
}

export function loadSettings(): Settings {
  const stored = readJson<Partial<Settings>>(SETTINGS_FILE, {});
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    ai: { ...DEFAULT_SETTINGS.ai, ...stored.ai, ...aiFromEnv() },
    infographic: { ...DEFAULT_SETTINGS.infographic, ...stored.infographic },
    graph: { ...DEFAULT_SETTINGS.graph, ...stored.graph },
    pacing: { ...DEFAULT_SETTINGS.pacing, ...stored.pacing },
    evergreen: { ...DEFAULT_SETTINGS.evergreen, ...stored.evergreen },
    recap: resolveRecapSettings(stored.recap),
    blog: { ...DEFAULT_SETTINGS.blog, ...stored.blog },
    utm: { ...DEFAULT_UTM, ...stored.utm },
    profile: { ...DEFAULT_PROFILE, ...stored.profile },
    reshare: { ...DEFAULT_RESHARE, ...stored.reshare },
    engage: { ...DEFAULT_ENGAGE, ...stored.engage },
    did: { ...DEFAULT_DID, ...stored.did },
    outreach: { ...DEFAULT_OUTREACH, ...stored.outreach },
    newsletter: newsletterSettings(stored.newsletter),
    synconfig: { ...DEFAULT_SYNCONFIG, ...stored.synconfig },
    skills: {
      defaults: { ...(stored.skills?.defaults ?? {}) },
      rotate: { ...(stored.skills?.rotate ?? {}) },
      cursor: { ...(stored.skills?.cursor ?? {}) },
    },
    plugins: Array.isArray(stored.plugins) ? stored.plugins.filter((entry) => typeof entry === "string") : [],
  };
}

/**
 * The recap as the daemon sends it: the stored switch, and an address even
 * when none was set — the profile email, else the myna cloud login's — so an
 * install that never ran `myna recap on` still gets its nightly summary.
 */
export function effectiveRecap(settings: Settings = loadSettings()): RecapSettings & { toSource: ReturnType<typeof recapAddress>["source"] } {
  let cloud: string | undefined;
  try {
    cloud = cloudSession()?.email;
  } catch {
    cloud = undefined;
  }
  const address = recapAddress(settings.recap, { profile: settings.profile.email, cloud });
  return { ...settings.recap, to: address.to, toSource: address.source };
}

export function saveSettings(settings: Settings): void {
  writeJson(SETTINGS_FILE, settings);
}
