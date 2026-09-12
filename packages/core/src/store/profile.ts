/**
 * This install's own OpenProfile.md.
 *
 * Two sources, and the hand-written one wins. `~/.config/myna/openprofile.md`
 * is a file a person edits like any other; when it exists it is the profile,
 * verbatim, and nothing here rewrites it. When it does not, `myna profile`
 * builds one from settings and the connected accounts, so there is always a
 * profile to show and to publish.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { configPath, ensureConfigDir, PROFILE_FILE } from "../util/paths.ts";
import { listAccounts } from "./accounts.ts";
import { loadSettings, type Settings } from "./settings.ts";
import { parseOpenProfile, parseTopics, renderOpenProfile, type OpenProfile } from "../core/openprofile.ts";
import type { Account } from "../net/types.ts";

export function profilePath(): string {
  return configPath(PROFILE_FILE);
}

export function hasWrittenProfile(): boolean {
  return existsSync(profilePath());
}

/** Networks whose accounts are posting surfaces, not people: left out of Accounts. */
const NOT_PUBLIC = new Set(["slack", "discord", "matrix", "mattermost", "telegram", "tsbb", "gcal", "agenticjobs"]);

/** The profile settings and accounts would produce, as Markdown. */
export function buildProfile(settings: Settings = loadSettings(), accounts: Account[] = listAccounts()): string {
  const { profile, reshare } = settings;
  const shown = accounts.filter((account) => !NOT_PUBLIC.has(account.network));
  const name = profile.name || shown.find((account) => account.displayName)?.displayName || shown[0]?.handle || "Unnamed";
  const willing =
    reshare.networks.trim() && reshare.networks.trim() !== "all"
      ? reshare.networks.split(",").map((id) => id.trim().toLowerCase()).filter(Boolean)
      : [];

  return renderOpenProfile({
    name,
    kind: profile.kind,
    handle: profile.handle || shown[0]?.handle || "",
    web: profile.web,
    email: profile.email,
    avatar: profile.avatar,
    pay: profile.pay,
    resume: profile.resume,
    headline: profile.headline,
    accounts: shown,
    topics: parseTopics(profile.topics),
    reshare: {
      networks: willing,
      topics: parseTopics(reshare.topics),
      not: parseTopics(reshare.not),
      rateUsd: reshare.rateUsd,
      perNetwork: false,
      limitPerDay: reshare.perDay,
    },
    operator:
      profile.operatorName || profile.operatorProfile || profile.operatorEmail
        ? {
            ...(profile.operatorName ? { name: profile.operatorName } : {}),
            ...(profile.operatorProfile ? { profile: profile.operatorProfile } : {}),
            ...(profile.operatorEmail ? { email: profile.operatorEmail } : {}),
          }
        : null,
  });
}

/** The profile as it stands: the written file, else the built one. */
export function readProfile(): { markdown: string; source: "file" | "built" } {
  if (hasWrittenProfile()) return { markdown: readFileSync(profilePath(), "utf8"), source: "file" };
  return { markdown: buildProfile(), source: "built" };
}

export function currentProfile(): OpenProfile {
  return parseOpenProfile(readProfile().markdown);
}

/** Write the built profile to disk. Refuses to replace a hand-written one unless told to. */
export function writeProfile(options: { force?: boolean } = {}): { path: string; written: boolean } {
  const path = profilePath();
  if (existsSync(path) && !options.force) return { path, written: false };
  ensureConfigDir();
  writeFileSync(path, buildProfile(), "utf8");
  return { path, written: true };
}
