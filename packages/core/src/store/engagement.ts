/**
 * Cached engagement figures.
 *
 * Asking a network how a post is doing costs an API call each time, so the
 * answers are kept here and the performance screen renders from the cache.
 * Nothing secret lives in this file, so it is plain JSON like the queue.
 */
import { readJson, writeJson } from "../util/json.ts";
import { configPath } from "../util/paths.ts";
import type { EngagementRecord } from "../core/analytics.ts";

const FILE = "engagement.json";

/** Enough for months of posting, and bounded so the file cannot grow forever. */
const LIMIT = 2000;

interface EngagementFile {
  records: EngagementRecord[];
}

export function listEngagement(): EngagementRecord[] {
  return readJson<EngagementFile>(FILE, { records: [] }).records;
}

/** Upsert by account and post, so a refresh replaces rather than appends. */
export function recordEngagement(records: EngagementRecord[]): void {
  if (!records.length) return;
  const file = readJson<EngagementFile>(FILE, { records: [] });
  const byId = new Map(file.records.map((record) => [`${record.accountId}|${record.postId}`, record]));
  for (const record of records) byId.set(`${record.accountId}|${record.postId}`, record);

  const merged = [...byId.values()].sort((a, b) => a.at.localeCompare(b.at));
  writeJson(FILE, { records: merged.slice(-LIMIT) } satisfies EngagementFile);
}

export function clearEngagement(): void {
  writeJson(FILE, { records: [] } satisfies EngagementFile);
}

export const engagementPath = (): string => configPath(FILE);
