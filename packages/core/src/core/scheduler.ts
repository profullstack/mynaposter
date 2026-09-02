/**
 * The scheduler.
 *
 * Scheduled posts are marked "sending" before the first network call, so a
 * crash mid-send leaves evidence rather than silently re-posting everywhere on
 * the next tick.
 */
import { duePosts, updateQueued, type QueuedPost } from "../store/queue.ts";
import { getAccount } from "../store/accounts.ts";
import { postToAll, type TargetResult } from "./poster.ts";
import { loadAllMedia } from "./media.ts";
import { loadSettings } from "../store/settings.ts";

export interface RunResult {
  post: QueuedPost;
  results: TargetResult[];
}

/** Send everything due. Returns one entry per post attempted. */
export async function runDuePosts(now = new Date()): Promise<RunResult[]> {
  const out: RunResult[] = [];

  for (const post of duePosts(now)) {
    updateQueued(post.id, { status: "sending", attempts: (post.attempts ?? 0) + 1 });

    const accounts = post.targets.map((id) => getAccount(id)).filter((account) => account !== undefined);
    if (!accounts.length) {
      updateQueued(post.id, { status: "failed", lastError: "None of its target accounts still exist." });
      continue;
    }

    try {
      const results = await postToAll(accounts, {
        text: post.text,
        title: post.title,
        media: post.mediaPaths?.length ? loadAllMedia(post.mediaPaths) : undefined,
        thread: post.thread ?? loadSettings().threadByDefault,
        extra: post.extra,
      });

      const byAccount: QueuedPost["results"] = {};
      for (const result of results) {
        byAccount[result.account.id] = {
          ok: result.ok,
          id: result.posts[0]?.id,
          url: result.posts[0]?.url,
          error: result.error,
        };
      }

      const failed = results.filter((result) => !result.ok);
      updateQueued(post.id, {
        status: failed.length === results.length ? "failed" : "sent",
        results: byAccount,
        lastError: failed.length ? failed.map((result) => `${result.account.id}: ${result.error}`).join("; ") : undefined,
      });
      out.push({ post, results });
    } catch (error) {
      updateQueued(post.id, { status: "failed", lastError: (error as Error).message });
    }
  }

  return out;
}

/** Poll for due posts. Returns a function that stops the loop. */
export function startScheduler(intervalMs = 30_000, onRun?: (results: RunResult[]) => void): () => void {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const results = await runDuePosts();
      if (results.length && onRun) onRun(results);
    } catch {
      // A scheduler that dies on one bad post is worse than one that retries.
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
