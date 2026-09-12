/** What was sent, where it landed, and what failed. Capped so it cannot grow forever. */
import { readJson, writeJson } from "../util/json.ts";
import { HISTORY_FILE } from "../util/paths.ts";

export interface HistoryEntry {
  at: string;
  accountId: string;
  network: string;
  handle: string;
  text: string;
  ok: boolean;
  /** The title a titled network received, so a blog's duplicate-title check has it. */
  title?: string;
  /** Which skill the account was using: `skill` for the default, else the slug. */
  skill?: string;
  /** The post type it went out as: launch-announcement, release-notes, bug-story... */
  type?: string;
  postId?: string;
  url?: string;
  /** The --canonical-url it went out with, so a mirror of a sent post stays one in the type's daily count. */
  canonicalUrl?: string;
  error?: string;
}

interface HistoryFile {
  entries: HistoryEntry[];
}

const LIMIT = 1000;

export function listHistory(): HistoryEntry[] {
  return readJson<HistoryFile>(HISTORY_FILE, { entries: [] }).entries.slice().reverse();
}

export function recordHistory(entries: HistoryEntry[]): void {
  if (!entries.length) return;
  const file = readJson<HistoryFile>(HISTORY_FILE, { entries: [] });
  file.entries.push(...entries);
  if (file.entries.length > LIMIT) file.entries = file.entries.slice(-LIMIT);
  writeJson(HISTORY_FILE, file);
}

export function clearHistory(): void {
  writeJson(HISTORY_FILE, { entries: [] } satisfies HistoryFile);
}
