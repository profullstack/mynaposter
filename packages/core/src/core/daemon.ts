/**
 * The daemon behind `myna run`.
 *
 * One loop, many jobs: the post scheduler, the follow graph, every plugin's
 * tasks and every seed provider. Jobs run one at a time — the vault and the
 * JSON stores are read-modify-write files, and two jobs saving at once would
 * lose one of them — and a job that throws is logged and retried on its next
 * turn rather than taking the loop down.
 */
import { runDuePosts } from "./scheduler.ts";
import { summarize } from "./poster.ts";
import { addSeeds, expandSeeds, followNext } from "./graph.ts";
import { loadSettings } from "../store/settings.ts";
import { pluginTasks, seedProviders } from "../plugins/loader.ts";
import { pluginContext } from "../plugins/context.ts";

export interface DaemonJob {
  id: string;
  everyMs: number;
  /** Return a line to log, or nothing to stay quiet. */
  run(): Promise<string | void>;
}

export interface DaemonOptions {
  /** How often the loop wakes to see what is due. */
  tickMs?: number;
  log?: (line: string) => void;
  /** Extra jobs beyond the built-in ones. */
  jobs?: DaemonJob[];
  /** Leave out the built-in jobs, for a host that only wants its own. */
  builtins?: boolean;
}

const stamp = (): string => new Date().toISOString();

/** The jobs myna itself runs, given the current settings. */
export function builtinJobs(log: (line: string) => void, tickMs: number): DaemonJob[] {
  const settings = loadSettings();
  const jobs: DaemonJob[] = [
    {
      id: "posts",
      everyMs: tickMs,
      async run() {
        const runs = await runDuePosts();
        for (const run of runs) log(`${run.post.id}  ${summarize(run.results)}`);
      },
    },
  ];

  if (settings.graph.enabled) {
    jobs.push(
      {
        id: "graph.expand",
        // Look for stale seeds every hour; the staleness rule is what decides.
        everyMs: 3_600_000,
        async run() {
          const result = await expandSeeds({ maxSeeds: 5, log });
          if (result.expanded || result.failed.length) {
            return `expanded ${result.expanded} seed${result.expanded === 1 ? "" : "s"}, ${result.discovered} new candidate${result.discovered === 1 ? "" : "s"}` +
              (result.failed.length ? `, ${result.failed.length} failed` : "");
          }
        },
      },
      {
        id: "graph.follow",
        // Spread the hourly budget over the hour rather than sending it all at
        // once: a burst of follows is what gets an account flagged.
        everyMs: Math.max(tickMs, Math.floor(3_600_000 / Math.max(1, settings.graph.followsPerHour))),
        async run() {
          const sent = await followNext({ limit: 1, log });
          if (!sent.length) return;
        },
      },
    );
  }

  for (const { plugin, task } of pluginTasks()) {
    jobs.push({
      id: `${plugin.id}.${task.id}`,
      everyMs: task.everyMs,
      run: () => task.run(pluginContext(plugin, { log: (line) => log(`${plugin.id}  ${line}`) })),
    });
  }

  for (const { plugin, provider } of seedProviders()) {
    jobs.push({
      id: `${plugin.id}.seeds.${provider.id}`,
      everyMs: provider.everyMs ?? 6 * 3_600_000,
      async run() {
        const seeds = await provider.fetch(pluginContext(plugin, { log: (line) => log(`${plugin.id}  ${line}`) }));
        const result = addSeeds(seeds);
        if (seeds.length) return `${seeds.length} seeds from ${plugin.id}: ${result.added} new, ${result.updated} refreshed`;
      },
    });
  }

  return jobs;
}

/** Start the loop. Returns a function that stops it. */
export function startDaemon(options: DaemonOptions = {}): () => void {
  const tickMs = options.tickMs ?? 30_000;
  const log = options.log ?? ((line: string) => process.stdout.write(`${stamp()}  ${line}\n`));
  const jobs = [...(options.builtins === false ? [] : builtinJobs(log, tickMs)), ...(options.jobs ?? [])];
  const lastRun = new Map<string, number>();
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      for (const job of jobs) {
        if (stopped) break;
        const last = lastRun.get(job.id) ?? 0;
        if (Date.now() - last < job.everyMs) continue;
        lastRun.set(job.id, Date.now());
        try {
          const line = await job.run();
          if (line) log(`${job.id}  ${line}`);
        } catch (error) {
          log(`${job.id}  failed: ${(error as Error).message}`);
        }
      }
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), tickMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** One pass over every job, for `myna run --once=true` and for tests. */
export async function runDaemonOnce(options: Omit<DaemonOptions, "tickMs"> = {}): Promise<string[]> {
  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
    options.log?.(line);
  };
  const jobs = [...(options.builtins === false ? [] : builtinJobs(log, 0)), ...(options.jobs ?? [])];
  for (const job of jobs) {
    try {
      const line = await job.run();
      if (line) log(`${job.id}  ${line}`);
    } catch (error) {
      log(`${job.id}  failed: ${(error as Error).message}`);
    }
  }
  return lines;
}
