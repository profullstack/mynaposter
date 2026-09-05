/**
 * Plugin hooks the core fires.
 *
 * `afterPost` runs once a post has gone out, with where it landed. It is how
 * a plugin reacts to publishing — an ad for the new page, a note in a
 * channel — without being a target itself. A hook that throws is reported
 * through its plugin's log and never affects the post: by the time it runs
 * the post is already out.
 */
import { getNetwork } from "../net/registry.ts";
import type { TargetResult } from "../core/poster.ts";
import { listPlugins } from "./loader.ts";
import { pluginContext } from "./context.ts";
import type { PostedEvent } from "./types.ts";

export interface HookOutcome {
  plugin: string;
  line?: string;
  error?: string;
}

/** Shape the poster's results into what a hook sees. */
export function postedEvent(results: TargetResult[], options: { text: string; title?: string; extra?: Record<string, string> }): PostedEvent {
  return {
    text: options.text,
    title: options.title,
    extra: options.extra,
    targets: results.map((result) => ({
      account: result.account,
      category: getNetwork(result.account.network)?.category ?? "minor",
      ok: result.ok,
      url: result.posts[0]?.url,
      id: result.posts[0]?.id,
      error: result.error,
    })),
  };
}

/** Run every plugin's `afterPost`, in load order, one at a time. */
export async function runAfterPost(event: PostedEvent, log?: (line: string) => void): Promise<HookOutcome[]> {
  const outcomes: HookOutcome[] = [];
  for (const { plugin } of listPlugins()) {
    if (!plugin?.afterPost) continue;
    const ctx = pluginContext(plugin, { log: log ? (line) => log(`${plugin.id}  ${line}`) : undefined });
    try {
      const line = await plugin.afterPost(event, ctx);
      outcomes.push({ plugin: plugin.id, line: line || undefined });
    } catch (error) {
      outcomes.push({ plugin: plugin.id, error: (error as Error).message });
    }
  }
  return outcomes;
}
