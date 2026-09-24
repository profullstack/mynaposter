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

/**
 * Where myna keeps run state that is not configuration: background send logs
 * and their lock files. $MYNA_STATE_DIR when set; under $MYNA_HOME/state when
 * that is set (so a test or a second install keeps its own); otherwise
 * $XDG_STATE_HOME/myna, which is ~/.local/state/myna, beside daemon.log.
 */
export function stateDir(): string {
  if (process.env.MYNA_STATE_DIR) return process.env.MYNA_STATE_DIR;
  if (process.env.MYNA_HOME) return join(process.env.MYNA_HOME, "state");
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "myna");
}

export function ensureStateDir(): string {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
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
/** People you may write to, and the lists they are on. */
export const CONTACTS_FILE = "contacts.json";
/** SMTP servers (secrets in the vault), the SMS setup, and what went out. */
export const OUTREACH_FILE = "outreach.json";
/** Newsletters, who each one reached, and the unsubscribe token per subscriber. */
export const NEWSLETTERS_FILE = "newsletters.json";
/** A hand-written OpenProfile.md wins over the one `myna profile` would build. */
export const PROFILE_FILE = "openprofile.md";
/** When the daily recap was last sent. State, not preference, so not in settings. */
export const RECAP_FILE = "recap.json";
/** Hand-off cards: the steps a person does by hand. Plain JSON, nothing secret. */
export const HANDOFFS_FILE = "handoffs.json";
/** The upvoter: what was found worth a vote, what was done about it, and what has been seen before. */
export const UPVOTE_FILE = "upvote.json";
/** Where `myna plugins add <package>` installs to. */
export const PLUGINS_DIR = "plugins";
