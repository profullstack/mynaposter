/** The context handed to a plugin's commands, tasks and seed providers. */
import { getPluginSecrets, listAccounts, setPluginSecrets } from "../store/accounts.ts";
import { loadSettings } from "../store/settings.ts";
import { configDir } from "../util/paths.ts";
import { addSeeds } from "../core/graph.ts";
import type { MynaPlugin, PluginContext } from "./types.ts";

export interface HostOptions {
  out?: (line?: string) => void;
  log?: (line: string) => void;
  ask?: PluginContext["ask"];
  flags?: Record<string, unknown>;
}

export function pluginContext(plugin: MynaPlugin, host: HostOptions = {}): PluginContext {
  const out = host.out ?? ((line = "") => process.stdout.write(`${line}\n`));
  return {
    out,
    log: host.log ?? ((line) => out(`${new Date().toISOString()}  ${plugin.id}  ${line}`)),
    ask: host.ask,
    accounts: listAccounts,
    settings: loadSettings,
    secrets: {
      get: () => getPluginSecrets(plugin.id),
      set: (values) => setPluginSecrets(plugin.id, values),
      clear: () => setPluginSecrets(plugin.id, {}),
    },
    graph: { addSeeds },
    configDir: configDir(),
    flags: host.flags ?? {},
  };
}
