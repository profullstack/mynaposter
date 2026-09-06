/**
 * The scheduler.
 *
 * Scheduled posts are marked "sending" before the first network call, so a
 * crash mid-send leaves evidence rather than silently re-posting everywhere on
 * the next tick.
 */
import { duePosts, enqueue, listQueue, updateQueued, type QueuedPost } from "../store/queue.ts";
import { getAccount } from "../store/accounts.ts";
import { postToAll, type TargetResult } from "./poster.ts";
import { loadAllMedia } from "./media.ts";
import { loadSettings } from "../store/settings.ts";
import { listHistory } from "../store/history.ts";
import { pacingRules, planTargets } from "./pacing.ts";

export interface RunResult {
  post: QueuedPost;
  results: TargetResult[];
}

/** Send everything due. Returns one entry per post attempted. */
export async function runDuePosts(now = new Date()): Promise<RunResult[]> {
  const out: RunResult[] = [];

  for (const post of duePosts(now)) {
    const targeted = post.targets.map((id) => getAccount(id)).filter((account) => account !== undefined);
    if (!targeted.length) {
      updateQueued(post.id, { status: "failed", lastError: "None of its target accounts still exist." });
      continue;
    }

    // Pacing holds at send time too. A post queued days ago does not know
    // what went out since; a post to several accounts (an old `schedule --to
    // all`) is split so they do not land together. --now on the entry is
    // honoured, duplicates are dropped.
    const settings = loadSettings();
    const plan = planTargets({
      accounts: targeted,
      text: post.text,
      now: now.getTime(),
      force: post.extra?.now === "true",
      history: listHistory(),
      queue: listQueue().filter((entry) => entry.id !== post.id),
      rules: pacingRules(settings.pacing),
      accountNetwork: (id) => getAccount(id)?.network,
    });
    for (const target of plan.later) {
      if (plan.now.length || plan.later[0] !== target) {
        enqueue({ scheduledFor: new Date(target.at).toISOString(), targets: [target.account.id], text: post.text, title: post.title, mediaPaths: post.mediaPaths, extra: post.extra, thread: post.thread });
      }
    }
    if (!plan.now.length) {
      if (!plan.later.length) {
        updateQueued(post.id, { status: "cancelled", lastError: plan.skipped.map((s) => `${s.account.id}: ${s.reason}`).join("; ") || "nothing left to send" });
        continue;
      }
      // Its own first target moves this entry to its slot rather than spawning a copy.
      updateQueued(post.id, { scheduledFor: new Date(plan.later[0].at).toISOString(), targets: [plan.later[0].account.id], lastError: plan.later[0].reason });
      continue;
    }
    const accounts = plan.now;
    updateQueued(post.id, { status: "sending", attempts: (post.attempts ?? 0) + 1, targets: accounts.map((account) => account.id) });

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
