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
import type { QueuedPost } from "../store/queue.ts";
import type { CancelledEvent, FollowedEvent, MynaPlugin, PostedEvent, ScheduledEvent } from "./types.ts";

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

type Hook = "afterPost" | "afterSchedule" | "afterCancel" | "afterFollow";

/** Run one hook on every plugin that has it, in load order, one at a time. */
async function runHook<E>(hook: Hook, event: E, log?: (line: string) => void, flags?: Record<string, unknown>): Promise<HookOutcome[]> {
  const outcomes: HookOutcome[] = [];
  for (const { plugin } of listPlugins()) {
    const fn = plugin?.[hook] as ((event: E, ctx: ReturnType<typeof pluginContext>) => Promise<string | void>) | undefined;
    if (!plugin || !fn) continue;
    const ctx = pluginContext(plugin, { log: log ? (line) => log(`${plugin.id}  ${line}`) : undefined, flags });
    try {
      const line = await fn.call(plugin as MynaPlugin, event, ctx);
      outcomes.push({ plugin: plugin.id, line: line || undefined });
    } catch (error) {
      outcomes.push({ plugin: plugin.id, error: (error as Error).message });
    }
  }
  return outcomes;
}

/** Run every plugin's `afterPost`, in load order, one at a time. */
export const runAfterPost = (event: PostedEvent, log?: (line: string) => void): Promise<HookOutcome[]> =>
  runHook("afterPost", event, log);

/** Shape a queue entry into what `afterSchedule` sees. */
export const scheduledEvent = (post: QueuedPost): ScheduledEvent => ({
  id: post.id,
  scheduledFor: post.scheduledFor,
  targets: post.targets,
  text: post.text,
  title: post.title,
  extra: post.extra,
});

/** Run every plugin's `afterSchedule` for a post that was just queued. */
export const runAfterSchedule = (post: QueuedPost, log?: (line: string) => void): Promise<HookOutcome[]> =>
  runHook("afterSchedule", scheduledEvent(post), log);

/** Run every plugin's `afterFollow` for a follow that just went out. `flags` are the command's, when a person ran one. */
export const runAfterFollow = (event: FollowedEvent, options: { log?: (line: string) => void; flags?: Record<string, unknown> } = {}): Promise<HookOutcome[]> =>
  runHook("afterFollow", event, options.log, options.flags);

/** Run every plugin's `afterCancel` for a queue entry that was just removed. */
export const runAfterCancel = (id: string, log?: (line: string) => void): Promise<HookOutcome[]> =>
  runHook("afterCancel", { id } satisfies CancelledEvent, log);
