/**
 * The scheduler.
 *
 * Scheduled posts are marked "sending" before the first network call, so a
 * crash mid-send leaves evidence rather than silently re-posting everywhere on
 * the next tick.
 */
import { duePosts, enqueue, listQueue, updateQueued, type QueuedPost } from "../store/queue.ts";
import { getAccount } from "../store/accounts.ts";
import { requireNetwork } from "../net/registry.ts";
import { postToAll, type TargetResult } from "./poster.ts";
import { loadAllMedia } from "./media.ts";
import { loadSettings } from "../store/settings.ts";
import { listHistory } from "../store/history.ts";
import { pacingRules, planTargets } from "./pacing.ts";
import { duplicateTitle, planLimitsFor } from "./skills.ts";
import { bookingsForType, isMirrorOfSent, refusedTargets, typeCapFor } from "./post-types.ts";

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

    // A repost shares something that already exists, so none of the composing
    // path applies to it: there is no text to pace against, no media to load
    // and no thread to split. It goes to its targets as asked.
    if (post.repostOf) {
      updateQueued(post.id, { status: "sending", attempts: (post.attempts ?? 0) + 1 });
      const results: TargetResult[] = [];
      for (const account of targeted) {
        const network = requireNetwork(account.network);
        if (!network.repost) {
          results.push({ account, ok: false, posts: [], error: `${network.name} has no repost API.` });
          continue;
        }
        try {
          const result = await network.repost(account, post.repostOf);
          results.push({ account, ok: true, posts: [result] });
        } catch (error) {
          results.push({ account, ok: false, posts: [], error: (error as Error).message });
        }
      }
      const byAccount: QueuedPost["results"] = {};
      for (const result of results) {
        byAccount[result.account.id] = {
          ok: result.ok,
          id: result.posts[0]?.id,
          url: result.posts[0]?.url,
          error: result.error,
        };
      }
      const failedReposts = results.filter((result) => !result.ok);
      updateQueued(post.id, {
        status: failedReposts.length === results.length ? "failed" : "sent",
        results: byAccount,
        lastError: failedReposts.length
          ? failedReposts.map((result) => `${result.account.id}: ${result.error}`).join("; ")
          : undefined,
      });
      out.push({ post, results });
      continue;
    }

    // Pacing holds at send time too. A post queued days ago does not know
    // what went out since; a post to several accounts (an old `schedule --to
    // all`) is split so they do not land together. --now on the entry is
    // honoured, duplicates are dropped.
    const settings = loadSettings();
    const history = listHistory();

    // A blog post whose title went out since this was queued is the re-send
    // the skill forbids. It is dropped with the reason, never published.
    if (post.extra?.allowDuplicate !== "true") {
      const repeat = targeted.map((account) => ({ account, earlier: duplicateTitle(account, post.text, post.title, history) })).find((row) => row.earlier);
      if (repeat?.earlier) {
        updateQueued(post.id, {
          status: "cancelled",
          lastError: `${repeat.account.id} already carried this title on ${repeat.earlier.at.slice(0, 10)}${repeat.earlier.url ? ` (${repeat.earlier.url})` : ""}`,
        });
        continue;
      }
    }

    // A type the target's kind does not carry: the entry was queued before
    // the type skill said so, or the skill was tightened since. Dropped
    // with the reason rather than published against the policy.
    if (post.type) {
      let refused: ReturnType<typeof refusedTargets> = [];
      try {
        refused = refusedTargets(post.type, targeted);
      } catch {
        // A type whose skill has gone is not a reason to hold a post.
      }
      if (refused.length) {
        updateQueued(post.id, { status: "cancelled", lastError: refused.map((row) => row.reason).join("; ") });
        continue;
      }
    }

    const others = listQueue().filter((entry) => entry.id !== post.id);
    // A canonical mirror of a post its type already sent is not counted against the type's day.
    const typeCap = post.type && !isMirrorOfSent(post.type, post.extra?.canonicalUrl, history) ? typeCapFor(post.type) : undefined;
    const plan = planTargets({
      accounts: targeted,
      text: post.text,
      now: now.getTime(),
      force: post.extra?.now === "true",
      history,
      queue: others,
      rules: pacingRules(settings.pacing),
      accountNetwork: (id) => getAccount(id)?.network,
      // The skill's daily cap holds at send time too: a queue built before the
      // cap existed still cannot put a fifth post on the blog today.
      limitsFor: (account) => planLimitsFor(account, settings),
      typeLimit: post.type && typeCap ? { type: post.type, maxPerDay: typeCap, bookings: bookingsForType(post.type, history, others) } : undefined,
    });
    for (const target of plan.later) {
      if (plan.now.length || plan.later[0] !== target) {
        enqueue({ scheduledFor: new Date(target.at).toISOString(), targets: [target.account.id], text: post.text, title: post.title, mediaPaths: post.mediaPaths, extra: post.extra, thread: post.thread, type: post.type });
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
        type: post.type,
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
