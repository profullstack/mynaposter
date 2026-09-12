/**
 * The reshare network, wired in as a bundled plugin.
 *
 * Two touch points, both already plumbed for plugins: `afterPost`, so a post
 * that just went out can be handed to the network when auto is on, and a
 * daemon task, so `myna run` pulls matches every few minutes and does its
 * share. Living here rather than in a package of its own because it needs
 * the network adapters, which only core has.
 */
import type { MynaPlugin, PostedEvent } from "./types.ts";
import { requestFromPosted, runReshare } from "../core/reshare.ts";
import { joined, submit } from "../store/reshare.ts";
import { loadSettings } from "../store/settings.ts";

export const RESHARE_EVERY_MS = 10 * 60_000;

export const resharePlugin: MynaPlugin = {
  id: "reshare",
  name: "Reshare network",
  description: "People and agents who reshare each other's posts, matched by topic.",

  async afterPost(event: PostedEvent): Promise<string | void> {
    const settings = loadSettings();
    if (!settings.reshare.auto) return;
    if (!joined()) return "auto is on but this install has not joined: myna reshare join";
    const request = requestFromPosted(event, settings);
    if (!request) return;
    const sent = await submit(request);
    return `asked the network to reshare (${sent.matched} match${sent.matched === 1 ? "" : "es"} so far)`;
  },

  tasks: [
    {
      id: "pull",
      everyMs: RESHARE_EVERY_MS,
      async run(ctx): Promise<string | void> {
        if (!joined()) return;
        const turn = await runReshare({ log: ctx.log });
        if (turn.done.length) {
          const ok = turn.done.filter((entry) => entry.ok).length;
          return `reshared ${ok}/${turn.done.length}`;
        }
      },
    },
  ],
};

export default resharePlugin;
