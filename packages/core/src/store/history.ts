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
  postId?: string;
  url?: string;
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
