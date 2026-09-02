/**
 * Fetching engagement from the networks.
 *
 * Deliberately bounded: only posts that can be measured, only the newest, and
 * only those not measured recently. A refresh that fanned out over every post
 * ever sent would rate-limit the account it was reporting on.
 */
import { listHistory } from "../store/history.ts";
import { listEngagement, recordEngagement } from "../store/engagement.ts";
import { getAccount } from "../store/accounts.ts";
import { requireNetwork } from "../net/registry.ts";
import { needsRefresh, type EngagementRecord } from "./analytics.ts";

export interface RefreshResult {
  checked: number;
  updated: number;
  /** Accounts whose network has no stats API, so nothing was asked. */
  skipped: string[];
  errors: string[];
}

export async function refreshEngagement(options: { limit?: number; staleAfterMs?: number } = {}): Promise<RefreshResult> {
  const wanted = needsRefresh(listHistory(), listEngagement(), {
    limit: options.limit ?? 25,
    staleAfterMs: options.staleAfterMs ?? 3_600_000,
  });

  const result: RefreshResult = { checked: 0, updated: 0, skipped: [], errors: [] };
  const records: EngagementRecord[] = [];
  const skipped = new Set<string>();

  for (const target of wanted) {
    const account = getAccount(target.accountId);
    if (!account) continue;

    const network = requireNetwork(account.network);
    if (!network.stats) {
      skipped.add(network.name);
      continue;
    }

    result.checked++;
    try {
      const stats = await network.stats(account, target.postId);
      records.push({ ...stats, accountId: target.accountId, postId: target.postId, at: new Date().toISOString() });
      result.updated++;
    } catch (error) {
      // One dead post must not stop the rest: a deleted post 404s forever, and
      // giving up there would mean never measuring anything newer.
      result.errors.push(`${target.accountId} ${target.postId}: ${(error as Error).message}`);
    }
  }

  recordEngagement(records);
  result.skipped = [...skipped];
  return result;
}
