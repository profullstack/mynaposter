/**
 * What a plugin is.
 *
 * A plugin is an ES module whose default export is a `MynaPlugin` (or a
 * function, possibly async, that returns one). It can bring any mix of:
 *
 *   - networks    adapters, registered beside the built-ins
 *   - directories software directories a product can be listed in
 *   - commands    `myna <name> ...` subcommands
 *   - tasks       work the daemon (`myna run`) does on a schedule
 *   - seeds       sources of people for the follow graph
 *
 * Nothing here imports the rest of myna, so a plugin author's dependency on
 * `@profullstack/myna-core` is types only.
 */
import type { Account, Network, Profile } from "../net/types.ts";
import type { Directory } from "../directories/types.ts";
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
    /**
     * Who `handle` follows, read through `account`'s network. Throws when the
     * network cannot list it. Optional so a hand-built context in a test, or
     * an older host, can leave it out.
     */
    following?(account: Account, handle: string, limit: number): Promise<Profile[]>;
    /** Who follows `handle`. Same rules. */
    followers?(account: Account, handle: string, limit: number): Promise<Profile[]>;
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

/** One target's outcome, as a plugin sees it after a post went out. */
export interface PostedTarget {
  account: Account;
  /** The network's category: "blog", "major", "fediverse"… */
  category: string;
  ok: boolean;
  /** Where the post lives now, when the network said. */
  url?: string;
  id?: string;
  error?: string;
}

/** What `afterPost` receives: everything that was sent and where it landed. */
export interface PostedEvent {
  text: string;
  title?: string;
  extra?: Record<string, string>;
  targets: PostedTarget[];
}

/** What `afterSchedule` receives: the queue entry as it was written. */
export interface ScheduledEvent {
  /** The queue id, what `myna cancel` takes. */
  id: string;
  /** ISO timestamp the post is due. */
  scheduledFor: string;
  /** Account ids it will go to. */
  targets: string[];
  text: string;
  title?: string;
  extra?: Record<string, string>;
}

/** What `afterCancel` receives: only the id, since the entry is already gone. */
export interface CancelledEvent {
  id: string;
}

/** What `afterFollow` receives: who was followed, from which account, and how they were found. */
export interface FollowedEvent {
  account: Account;
  network: string;
  handle: string;
  id?: string;
  displayName?: string;
  url?: string;
  bio?: string;
  followers?: number;
  /** `manual` for `myna follow`, `list` for a pasted follows or followers page, `graph` for the follow graph. */
  source: "manual" | "list" | "graph";
  /** The seed or list they came from, when there was one: `bluesky|alice`, or `followers:bluesky|alice`. */
  via?: string;
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
  /** Software directories to submit listings to, registered beside the built-ins. */
  directories?: Directory[];
  commands?: PluginCommand[];
  tasks?: DaemonTask[];
  seeds?: SeedProvider[];
  /**
   * Called once after every post has been sent to its targets — from the
   * CLI, the TUI, the scheduler and the daemon alike. Return a line to show
   * the person, or nothing. Throwing is reported and never undoes the post.
   */
  afterPost?(event: PostedEvent, ctx: PluginContext): Promise<string | void>;
  /**
   * Called once a follow has gone out, from `myna follow`, a pasted list, the
   * graph and the daemon alike. `ctx.flags` carries the command's flags when a
   * person ran it, so a plugin can act on `--something` and stay quiet
   * otherwise. Same rules as `afterPost`: a line back, and throwing never
   * undoes the follow.
   */
  afterFollow?(event: FollowedEvent, ctx: PluginContext): Promise<string | void>;
  /**
   * Called once a post has been queued for later — from `myna schedule`, the
   * TUI and the MCP server. For a plugin that keeps a calendar, or wants to
   * remind someone. Same rules as `afterPost`: a line back, and throwing
   * never undoes the queue entry.
   */
  afterSchedule?(event: ScheduledEvent, ctx: PluginContext): Promise<string | void>;
  /** Called once a queued post has been cancelled, so whatever `afterSchedule` made can be undone. */
  afterCancel?(event: CancelledEvent, ctx: PluginContext): Promise<string | void>;
}

/** What the loader knows about one plugin, including one that failed to load. */
export interface LoadedPlugin {
  plugin?: MynaPlugin;
  /** Where it came from: `bundled`, a path, or a package name. */
  origin: string;
  error?: string;
}
