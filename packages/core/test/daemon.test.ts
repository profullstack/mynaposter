/**
 * The daemon loop: one job's failure is logged and the next job still runs,
 * and the built-in jobs follow the settings.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinJobs, runDaemonOnce, startDaemon } from "../src/core/daemon.ts";
import { loadSettings, saveSettings } from "../src/store/settings.ts";
import { registerPlugin, resetPlugins } from "../src/plugins/loader.ts";
import { resetAccountCache } from "../src/store/accounts.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-daemon-"));
  process.env.MYNA_HOME = dir;
  resetPlugins();
  resetAccountCache();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
  resetPlugins();
  resetAccountCache();
});

test("a job that throws does not stop the ones after it", async () => {
  const lines = await runDaemonOnce({
    builtins: false,
    jobs: [
      { id: "first", everyMs: 1, async run() { throw new Error("nope"); } },
      { id: "second", everyMs: 1, async run() { return "fine"; } },
      { id: "quiet", everyMs: 1, async run() {} },
    ],
  });
  expect(lines).toEqual(["first  failed: nope", "second  fine"]);
});

test("the follow graph and plugin work only run when configured", () => {
  const log = () => {};
  expect(builtinJobs(log, 1000).map((job) => job.id)).toEqual(["posts"]);

  const settings = loadSettings();
  settings.graph.enabled = true;
  settings.graph.followsPerHour = 6;
  saveSettings(settings);
  registerPlugin({
    id: "p",
    name: "P",
    tasks: [{ id: "t", everyMs: 5000, async run() {} }],
    seeds: [{ id: "s", async fetch() { return []; } }],
  });

  const jobs = builtinJobs(log, 1000);
  expect(jobs.map((job) => job.id)).toEqual(["posts", "graph.expand", "graph.follow", "p.t", "p.seeds.s"]);
  // Six an hour means one every ten minutes, not six at once.
  expect(jobs.find((job) => job.id === "graph.follow")?.everyMs).toBe(600_000);
  expect(jobs.find((job) => job.id === "p.t")?.everyMs).toBe(5000);
});

test("a seed provider's result lands in the graph", async () => {
  registerPlugin({
    id: "src",
    name: "Source",
    seeds: [{ id: "list", async fetch() { return [{ network: "bluesky", handle: "alice.bsky.social" }]; } }],
  });
  const lines = await runDaemonOnce({ jobs: [] });
  expect(lines.some((line) => line.includes("1 seeds from src: 1 new"))).toBe(true);
  const { readGraph } = await import("../src/store/graph.ts");
  expect(readGraph().seeds.map((seed) => seed.handle)).toEqual(["alice.bsky.social"]);
});

test("the loop runs due jobs on a tick and stops when told", async () => {
  let runs = 0;
  const stop = startDaemon({
    tickMs: 10,
    builtins: false,
    log: () => {},
    jobs: [{ id: "count", everyMs: 1, async run() { runs++; } }],
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  stop();
  const seen = runs;
  expect(seen).toBeGreaterThan(1);
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(runs).toBe(seen);
});
