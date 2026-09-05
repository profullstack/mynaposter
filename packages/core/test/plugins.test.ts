/**
 * Loading plugins from disk.
 *
 * A plugin is a directory with an entry module; what it exports is registered
 * beside the built-ins. A plugin that breaks must be listed with its error,
 * not silently absent, or nobody would know why their command is missing.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getNetwork, NETWORKS } from "../src/net/registry.ts";
import { loadSettings, saveSettings } from "../src/store/settings.ts";
import { findPluginCommand, listPlugins, loadPlugins, pluginTasks, registerPlugin, resetPlugins, resolvePluginEntry, seedProviders } from "../src/plugins/loader.ts";
import { pluginContext } from "../src/plugins/context.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-plugins-"));
  process.env.MYNA_HOME = dir;
  resetPlugins();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
  resetPlugins();
  const index = NETWORKS.findIndex((network) => network.id === "pluginnet");
  if (index >= 0) NETWORKS.splice(index, 1);
});

const GOOD = `
export default {
  id: "good",
  name: "Good plugin",
  version: "1.2.3",
  networks: [{
    id: "pluginnet", name: "Plugin Net", category: "minor", blurb: "from a plugin",
    auth: { kind: "token", fields: [{ key: "token", label: "Token", secret: true }] },
    caps: { charLimit: 100, mediaLimit: 0, threads: false, delete: false, timeline: false, notifications: false, stats: false },
    async login() { return { handle: "h", creds: {}, meta: {} }; },
    async post() { return { id: "1" }; },
  }],
  commands: [{ name: "hello", summary: "say hi", async run(args, ctx) { ctx.out("hi " + args.join(" ")); return 7; } }],
  tasks: [{ id: "tick", everyMs: 1000, async run() { return "ticked"; } }],
  seeds: [{ id: "list", async fetch() { return [{ network: "pluginnet", handle: "someone" }]; } }],
};
`;

function writePlugin(name: string, source: string, manifest?: Record<string, unknown>): string {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  const entry = manifest ? String(manifest.main) : "index.mjs";
  writeFileSync(join(root, entry), source);
  if (manifest) writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
  return root;
}

test("a configured directory plugin brings its network, command, task and seed source", async () => {
  const root = writePlugin("good", GOOD, { name: "good", main: "plugin.js" });
  const settings = loadSettings();
  settings.plugins = [root];
  saveSettings(settings);

  const loaded = await loadPlugins();
  expect(loaded).toHaveLength(1);
  expect(loaded[0].plugin?.id).toBe("good");
  expect(loaded[0].origin).toBe(root);
  expect(getNetwork("pluginnet")?.name).toBe("Plugin Net");
  expect(findPluginCommand("hello")?.command.summary).toBe("say hi");
  expect(pluginTasks().map((entry) => `${entry.plugin.id}.${entry.task.id}`)).toEqual(["good.tick"]);
  expect(seedProviders()).toHaveLength(1);

  const lines: string[] = [];
  const ctx = pluginContext(loaded[0].plugin!, { out: (line = "") => lines.push(line) });
  expect(await findPluginCommand("hello")!.command.run(["there"], ctx)).toBe(7);
  expect(lines).toEqual(["hi there"]);
});

test("packages installed under the plugins directory load without being configured", async () => {
  const installed = join(dir, "plugins", "node_modules", "@scope", "thing");
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, "index.js"), GOOD.replace('id: "good"', 'id: "scoped"'));
  const loaded = await loadPlugins();
  expect(loaded.map((entry) => entry.plugin?.id)).toEqual(["scoped"]);
  expect(loaded[0].origin).toBe("@scope/thing");
});

test("a plugin that throws while loading is listed with its error", async () => {
  const bad = writePlugin("bad", "throw new Error('boom at import');");
  const invalid = writePlugin("invalid", "export default { id: 'Not Valid', name: 'x' };");
  const settings = loadSettings();
  settings.plugins = [bad, invalid, join(dir, "missing")];
  saveSettings(settings);

  const loaded = await loadPlugins();
  expect(loaded).toHaveLength(3);
  expect(loaded[0].error).toContain("boom at import");
  expect(loaded[1].error).toContain("lower-case");
  expect(loaded[2].error).toBeDefined();
  expect(findPluginCommand("hello")).toBeUndefined();
});

test("registering the same id again replaces the earlier plugin", () => {
  registerPlugin({ id: "twice", name: "One", commands: [{ name: "one", summary: "", async run() {} }] });
  registerPlugin({ id: "twice", name: "Two", commands: [{ name: "two", summary: "", async run() {} }] });
  expect(listPlugins()).toHaveLength(1);
  expect(findPluginCommand("one")).toBeUndefined();
  expect(findPluginCommand("two")?.plugin.name).toBe("Two");
});

test("an entry module is found through package.json main, then index files", () => {
  const withMain = writePlugin("a", "export default {}", { main: "entry.js" });
  expect(resolvePluginEntry(withMain)).toBe(join(withMain, "entry.js"));
  // main points at a file that does not exist; fall through to the index.
  const stale = join(dir, "stale");
  mkdirSync(stale, { recursive: true });
  writeFileSync(join(stale, "package.json"), JSON.stringify({ main: "lib/gone.js" }));
  writeFileSync(join(stale, "index.ts"), "export default {}");
  expect(resolvePluginEntry(stale)).toBe(join(stale, "index.ts"));
  const withIndex = writePlugin("b", "export default {}");
  expect(resolvePluginEntry(withIndex)).toBe(join(withIndex, "index.mjs"));
  expect(resolvePluginEntry(join(dir, "nowhere"))).toBeUndefined();
  expect(resolvePluginEntry("some-package-name")).toBeUndefined();
});
