/**
 * Asks, wired in as a bundled plugin so the daemon runs it.
 *
 * A scan every half hour reads the subreddits for people asking for a thing
 * and files them under ideas; a stats run every six hours re-reads the threads
 * and our replies in them. Both stay quiet until `myna asks on`. Nothing here
 * posts: replies are hand-off cards a person pastes.
 */
import type { MynaPlugin } from "./types.ts";
import { refreshAskStats, scanAsks } from "../core/asks.ts";
import { loadSettings } from "../store/settings.ts";

export const ASKS_SCAN_EVERY_MS = 30 * 60_000;
export const ASKS_STATS_EVERY_MS = 6 * 3_600_000;

export const asksPlugin: MynaPlugin = {
  id: "asks",
  name: "Asks",
  description:
    "Finds people on Reddit asking for a site or app that does X, Y and Z, counts how many want the same thing, and tracks the replies you paste.",
  tasks: [
    {
      id: "scan",
      everyMs: ASKS_SCAN_EVERY_MS,
      async run(ctx): Promise<string | void> {
        if (!loadSettings().asks.enabled) return;
        const result = await scanAsks({ log: ctx.log });
        if (result.found.length || result.flagged.length) {
          const flagged = result.flagged.length
            ? `; worth building now: ${result.flagged.map((idea) => idea.label).join("; ")}`
            : "";
          return `read ${result.read}, ${result.found.length} new ask${result.found.length === 1 ? "" : "s"}${flagged}`;
        }
      },
    },
    {
      id: "stats",
      everyMs: ASKS_STATS_EVERY_MS,
      async run(ctx): Promise<string | void> {
        if (!loadSettings().asks.enabled) return;
        const result = await refreshAskStats({ log: ctx.log });
        if (result.refreshed || result.foundOurs.length) {
          return `${result.refreshed} threads re-read${result.foundOurs.length ? `, ${result.foundOurs.length} of our replies found` : ""}`;
        }
      },
    },
  ],
};

export default asksPlugin;
