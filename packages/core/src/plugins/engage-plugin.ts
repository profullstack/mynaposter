/**
 * Follow-ups, wired in as a bundled plugin so the daemon runs them.
 *
 * Two tasks: a scan every fifteen minutes that reads notifications and fills
 * the queue with drafted replies, and a send every five that works through
 * what is due. Both stay quiet until `myna engage on`.
 */
import type { MynaPlugin } from "./types.ts";
import { scanEngagement, sendFollowUps } from "../core/engage.ts";
import { loadSettings } from "../store/settings.ts";

export const ENGAGE_SCAN_EVERY_MS = 15 * 60_000;
export const ENGAGE_SEND_EVERY_MS = 5 * 60_000;

export const engagePlugin: MynaPlugin = {
  id: "engage",
  name: "Follow-ups",
  description: "Replies to the people who replied, reposted or followed, drafted by the writer, and follows them back.",
  tasks: [
    {
      id: "scan",
      everyMs: ENGAGE_SCAN_EVERY_MS,
      async run(ctx): Promise<string | void> {
        if (!loadSettings().engage.enabled) return;
        const result = await scanEngagement({ log: ctx.log });
        if (result.queued.length || result.skipped.length) {
          return `read ${result.read}, queued ${result.queued.length}${result.skipped.length ? `, ${result.skipped.length} accounts skipped` : ""}`;
        }
      },
    },
    {
      id: "send",
      everyMs: ENGAGE_SEND_EVERY_MS,
      async run(ctx): Promise<string | void> {
        if (!loadSettings().engage.enabled) return;
        const result = await sendFollowUps({ log: ctx.log });
        if (result.sent.length) return `sent ${result.sent.length}`;
      },
    },
  ],
};

export default engagePlugin;
