/**
 * What a plugin is.
 *
 * A plugin is an ES module whose default export is a `MynaPlugin` (or a
 * function, possibly async, that returns one). It can bring any mix of:
 *
 *   - networks    adapters, registered beside the built-ins
 *   - commands    `myna <name> ...` subcommands
 *   - tasks       work the daemon (`myna run`) does on a schedule
 *   - seeds       sources of people for the follow graph
 *
 * Nothing here imports the rest of myna, so a plugin author's dependency on
 * `@profullstack/myna-core` is types only.
 */
import type { Account, Network } from "../net/types.ts";
import type { Settings } from "../store/settings.ts";
import type { SeedInput } from "../core/graph.ts";

export interface PluginContext {
  /** Print a line for the person running the command. */
  out(line?: string): void;
  /** Log a line with a timestamp, the way the daemon does. */
  log(line: string): void;
  /** Ask the person for a value. Absent when nobody is at a keyboard. */
  ask?(prompt: string, options?: { secret?: boolean }): Promise<string>;
  /** Every connected account. Throws when the vault is locked. */
  accounts(): Account[];
  settings(): Settings;
  /** This plugin's secrets, kept in the encrypted vault. */
  secrets: {
    get(): Record<string, string>;
    set(values: Record<string, string>): void;
    clear(): void;
  };
  graph: {
    addSeeds(seeds: SeedInput[]): { added: number; updated: number };
  };
  /** myna's config directory. A plugin that needs a file of its own puts it under `plugins/<id>/`. */
  configDir: string;
  /** Parsed `--flags` as the CLI saw them. */
  flags: Record<string, unknown>;
}

export interface PluginCommand {
  /** `myna <name>`. Must not shadow a built-in command. */
  name: string;
  /** One line for `myna help`. */
  summary: string;
  /** Sub-usage lines, shown by `myna plugins`. */
  usage?: string[];
  run(args: string[], ctx: PluginContext): Promise<number | void>;
}

export interface DaemonTask {
  /** Unique within the plugin. Shown in daemon output as `<plugin>.<id>`. */
  id: string;
  everyMs: number;
  /** Return a line to log, or nothing to stay quiet. Throwing is logged and the task is retried next time. */
  run(ctx: PluginContext): Promise<string | void>;
}

/** A source of seeds. The daemon calls it on its own schedule and feeds the result to the graph. */
export interface SeedProvider {
  id: string;
  everyMs?: number;
  fetch(ctx: PluginContext): Promise<SeedInput[]>;
}

export interface MynaPlugin {
  /** Lower-case, no spaces. Used for secrets, settings and logs. */
  id: string;
  name: string;
  version?: string;
  description?: string;
  networks?: Network[];
  commands?: PluginCommand[];
  tasks?: DaemonTask[];
  seeds?: SeedProvider[];
}

/** What the loader knows about one plugin, including one that failed to load. */
export interface LoadedPlugin {
  plugin?: MynaPlugin;
  /** Where it came from: `bundled`, a path, or a package name. */
  origin: string;
  error?: string;
}
