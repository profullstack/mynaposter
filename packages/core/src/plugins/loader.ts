/**
 * Finding and loading plugins.
 *
 * Three places, in order: plugins the host bundles in (the CLI registers
 * these itself), the specs in `settings.plugins`, and every package under
 * `~/.config/myna/plugins/node_modules`. A plugin that throws while loading is
 * kept in the list with its error, so `myna plugins` can say what is wrong
 * rather than the plugin silently not existing.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerNetwork } from "../net/registry.ts";
import { loadSettings } from "../store/settings.ts";
import { configPath, PLUGINS_DIR } from "../util/paths.ts";
import type { DaemonTask, LoadedPlugin, MynaPlugin, PluginCommand, SeedProvider } from "./types.ts";

const loaded: LoadedPlugin[] = [];
let scanned = false;

/** Register a plugin object directly. The host uses this for the ones it bundles. */
export function registerPlugin(plugin: MynaPlugin, origin = "bundled"): LoadedPlugin {
  const entry: LoadedPlugin = { origin };
  try {
    validate(plugin);
    const existing = loaded.findIndex((item) => item.plugin?.id === plugin.id);
    if (existing >= 0) loaded.splice(existing, 1);
    for (const network of plugin.networks ?? []) registerNetwork(network);
    entry.plugin = plugin;
  } catch (error) {
    entry.error = (error as Error).message;
  }
  loaded.push(entry);
  return entry;
}

function validate(plugin: MynaPlugin): void {
  if (!plugin || typeof plugin !== "object") throw new Error("The module's default export is not a plugin object.");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(plugin.id ?? "")) throw new Error(`Plugin id "${plugin.id}" must be lower-case letters, digits and dashes.`);
  if (!plugin.name) throw new Error(`Plugin "${plugin.id}" has no name.`);
  for (const command of plugin.commands ?? []) {
    if (!/^[a-z][a-z0-9-]*$/.test(command.name)) throw new Error(`Command "${command.name}" in ${plugin.id} is not a valid name.`);
    if (typeof command.run !== "function") throw new Error(`Command "${command.name}" in ${plugin.id} has no run().`);
  }
  for (const task of plugin.tasks ?? []) {
    if (!(task.everyMs > 0)) throw new Error(`Task "${task.id}" in ${plugin.id} needs an everyMs.`);
  }
}

/** The directory `myna plugins add <package>` installs into. */
export const pluginsDir = (): string => configPath(PLUGINS_DIR);

/** Where a spec's entry module is: a file, a directory with a package.json or index, or an installed package. */
export function resolvePluginEntry(spec: string): string | undefined {
  const candidates = [spec, resolve(spec), join(pluginsDir(), "node_modules", spec)];
  for (const candidate of candidates) {
    if (!isAbsolute(candidate) || !existsSync(candidate)) continue;
    if (statSync(candidate).isFile()) return candidate;
    const manifest = join(candidate, "package.json");
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { main?: string; module?: string; exports?: unknown };
        const main = pkg.module ?? pkg.main ?? (typeof pkg.exports === "string" ? pkg.exports : undefined);
        if (main && existsSync(join(candidate, main))) return join(candidate, main);
      } catch {
        /* fall through to the index files */
      }
    }
    for (const index of ["index.ts", "index.js", "index.mjs"]) {
      if (existsSync(join(candidate, index))) return join(candidate, index);
    }
  }
  return undefined;
}

async function importPlugin(spec: string): Promise<MynaPlugin> {
  const entry = resolvePluginEntry(spec);
  const target = entry ? pathToFileURL(entry).href : spec;
  const module = (await import(target)) as { default?: unknown; plugin?: unknown };
  let exported = module.default ?? module.plugin;
  if (typeof exported === "function") exported = await (exported as () => unknown)();
  return exported as MynaPlugin;
}

/**
 * Load everything configured. Safe to call more than once; later calls only
 * pick up specs not seen before.
 */
export async function loadPlugins(): Promise<LoadedPlugin[]> {
  if (scanned) return loaded;
  scanned = true;

  const specs = new Set(loadSettings().plugins);
  const installed = join(pluginsDir(), "node_modules");
  if (existsSync(installed)) {
    for (const name of readdirSync(installed)) {
      if (name.startsWith(".")) continue;
      if (name.startsWith("@")) {
        for (const scoped of readdirSync(join(installed, name))) specs.add(`${name}/${scoped}`);
      } else {
        specs.add(name);
      }
    }
  }

  for (const spec of specs) {
    if (loaded.some((entry) => entry.origin === spec)) continue;
    try {
      registerPlugin(await importPlugin(spec), spec);
    } catch (error) {
      loaded.push({ origin: spec, error: (error as Error).message });
    }
  }
  return loaded;
}

export function listPlugins(): LoadedPlugin[] {
  return [...loaded];
}

export function getPlugin(id: string): MynaPlugin | undefined {
  return loaded.find((entry) => entry.plugin?.id === id)?.plugin;
}

export function findPluginCommand(name: string): { plugin: MynaPlugin; command: PluginCommand } | undefined {
  for (const entry of loaded) {
    const command = entry.plugin?.commands?.find((candidate) => candidate.name === name);
    if (command && entry.plugin) return { plugin: entry.plugin, command };
  }
  return undefined;
}

export function pluginTasks(): { plugin: MynaPlugin; task: DaemonTask }[] {
  return loaded.flatMap((entry) => (entry.plugin?.tasks ?? []).map((task) => ({ plugin: entry.plugin!, task })));
}

export function seedProviders(): { plugin: MynaPlugin; provider: SeedProvider }[] {
  return loaded.flatMap((entry) => (entry.plugin?.seeds ?? []).map((provider) => ({ plugin: entry.plugin!, provider })));
}

/** For tests: forget everything loaded. */
export function resetPlugins(): void {
  loaded.length = 0;
  scanned = false;
}
