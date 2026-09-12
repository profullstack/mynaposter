/** User preferences. Plain JSON — no secrets here except by the user's choice. */
import { readJson, writeJson } from "../util/json.ts";
import { SETTINGS_FILE } from "../util/paths.ts";
import { DEFAULT_PACING, type PacingSettings } from "../core/pacing.ts";
import { DEFAULT_EVERGREEN, type EvergreenSettings } from "../core/evergreen.ts";
import { DEFAULT_RECAP, type RecapSettings } from "../core/recap.ts";

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
  /** Which skill each account uses, and where its rotation stands. */
  skills: SkillSettings;
  /** Who you are, for `myna profile`: the OpenProfile.md myna writes when there is no hand-written one. */
  profile: ProfileSettings;
  /** The reshare network: what you offer to reshare for others, and what you ask for your own posts. */
  reshare: ReshareSettings;
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
  },
  pacing: { ...DEFAULT_PACING },
  evergreen: { ...DEFAULT_EVERGREEN },
  recap: { ...DEFAULT_RECAP },
  blog: {},
  skills: { defaults: {}, rotate: {}, cursor: {} },
  profile: { ...DEFAULT_PROFILE },
  reshare: { ...DEFAULT_RESHARE },
  plugins: [],
  directories: [],
};

export function loadSettings(): Settings {
  const stored = readJson<Partial<Settings>>(SETTINGS_FILE, {});
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    ai: { ...DEFAULT_SETTINGS.ai, ...stored.ai },
    infographic: { ...DEFAULT_SETTINGS.infographic, ...stored.infographic },
    graph: { ...DEFAULT_SETTINGS.graph, ...stored.graph },
    pacing: { ...DEFAULT_SETTINGS.pacing, ...stored.pacing },
    evergreen: { ...DEFAULT_SETTINGS.evergreen, ...stored.evergreen },
    recap: { ...DEFAULT_SETTINGS.recap, ...stored.recap },
    blog: { ...DEFAULT_SETTINGS.blog, ...stored.blog },
    profile: { ...DEFAULT_PROFILE, ...stored.profile },
    reshare: { ...DEFAULT_RESHARE, ...stored.reshare },
    skills: {
      defaults: { ...(stored.skills?.defaults ?? {}) },
      rotate: { ...(stored.skills?.rotate ?? {}) },
      cursor: { ...(stored.skills?.cursor ?? {}) },
    },
    plugins: Array.isArray(stored.plugins) ? stored.plugins.filter((entry) => typeof entry === "string") : [],
  };
}

export function saveSettings(settings: Settings): void {
  writeJson(SETTINGS_FILE, settings);
}
