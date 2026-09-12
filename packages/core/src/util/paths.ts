import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

/** ~/.config/myna, or $MYNA_HOME / $XDG_CONFIG_HOME when set. */
export function configDir(): string {
  const override = process.env.MYNA_HOME;
  if (override) return override;
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg || join(homedir(), ".config"), "myna");
}

export function configPath(...parts: string[]): string {
  return join(configDir(), ...parts);
}

export function ensureConfigDir(): string {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export const VAULT_FILE = "vault.json";
export const QUEUE_FILE = "queue.json";
export const HISTORY_FILE = "history.json";
export const SETTINGS_FILE = "settings.json";
export const GRAPH_FILE = "graph.json";
/** What this install has reshared for others, and when it joined the network. */
export const RESHARE_FILE = "reshare.json";
/** The follow-up queue: who engaged, what to send them, what was sent. */
export const ENGAGE_FILE = "engage.json";
/** The proved DID and the session that proved it. */
export const DID_FILE = "did.json";
/** A hand-written OpenProfile.md wins over the one `myna profile` would build. */
export const PROFILE_FILE = "openprofile.md";
/** When the daily recap was last sent. State, not preference, so not in settings. */
export const RECAP_FILE = "recap.json";
/** Where `myna plugins add <package>` installs to. */
export const PLUGINS_DIR = "plugins";
