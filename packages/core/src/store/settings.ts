/** User preferences. Plain JSON — no secrets here except by the user's choice. */
import { readJson, writeJson } from "../util/json.ts";
import { SETTINGS_FILE } from "../util/paths.ts";
import { DEFAULT_PACING, type PacingSettings } from "../core/pacing.ts";
import { DEFAULT_EVERGREEN, type EvergreenSettings } from "../core/evergreen.ts";

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
  /** Plugin specs: an absolute path, or a package name installed by `myna plugins add`. */
  plugins: string[];
}

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
  plugins: [],
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
    plugins: Array.isArray(stored.plugins) ? stored.plugins.filter((entry) => typeof entry === "string") : [],
  };
}

export function saveSettings(settings: Settings): void {
  writeJson(SETTINGS_FILE, settings);
}
