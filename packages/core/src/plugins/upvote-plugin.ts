/**
 * The upvoter, wired in as a bundled plugin so the daemon runs it.
 *
 * Two tasks: a scan every half hour that reads what we have been posting,
 * searches each network for other people on the same subject and queues what
 * is worth amplifying, and a run every three minutes that works through what
 * is due. Both stay quiet until `myna upvote on`.
 *
 * The scan is the expensive half — it is several searches per account — and
 * the run is the one that has to be frequent, because the gap between two
 * actions is what makes the pace look like a reader rather than a script.
 */
import type { MynaPlugin } from "./types.ts";
import { runUpvotes, scanUpvotes } from "../core/upvote.ts";
import { loadSettings } from "../store/settings.ts";

export const UPVOTE_SCAN_EVERY_MS = 30 * 60_000;
export const UPVOTE_RUN_EVERY_MS = 3 * 60_000;

export const upvotePlugin: MynaPlugin = {
  id: "upvote",
  name: "Upvoter",
  description: "Finds other people posting about what you post about, votes on it, shares some of it, and once in a while replies with a link.",
  tasks: [
    {
      id: "scan",
      everyMs: UPVOTE_SCAN_EVERY_MS,
      async run(ctx): Promise<string | void> {
        if (!loadSettings().upvote.enabled) return;
        const result = await scanUpvotes({ log: ctx.log });
        if (result.queued.length || result.skipped.length) {
          const kinds = result.queued.reduce<Record<string, number>>((tally, item) => {
            tally[item.action] = (tally[item.action] ?? 0) + 1;
            return tally;
          }, {});
          const what = Object.entries(kinds)
            .map(([action, count]) => `${count} ${action}`)
            .join(", ");
          return `read ${result.read}, queued ${result.queued.length}${what ? ` (${what})` : ""}${result.skipped.length ? `, ${result.skipped.length} skipped` : ""}`;
        }
      },
    },
    {
      id: "run",
      everyMs: UPVOTE_RUN_EVERY_MS,
      async run(ctx): Promise<string | void> {
        if (!loadSettings().upvote.enabled) return;
        const result = await runUpvotes({ log: ctx.log });
        if (result.done.length) return `${result.done.length} cast`;
      },
    },
  ],
};

export default upvotePlugin;
