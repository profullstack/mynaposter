/** The context handed to a plugin's commands, tasks and seed providers. */
import { getPluginSecrets, listAccounts, setPluginSecrets } from "../store/accounts.ts";
import { loadSettings } from "../store/settings.ts";
import { configDir } from "../util/paths.ts";
import { addSeeds } from "../core/graph.ts";
import { getNetwork } from "../net/registry.ts";
import type { Account, Profile } from "../net/types.ts";
import type { MynaPlugin, PluginContext } from "./types.ts";

async function readList(list: "following" | "followers", account: Account, handle: string, limit: number): Promise<Profile[]> {
  const network = getNetwork(account.network);
  const read = network?.[list];
  if (!network || !read) throw new Error(`${network?.name ?? account.network} cannot list ${list === "followers" ? "who follows someone" : "who someone follows"}.`);
  return read.call(network, account, handle, limit);
}

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
    graph: {
      addSeeds,
      following: (account, handle, limit) => readList("following", account, handle, limit),
      followers: (account, handle, limit) => readList("followers", account, handle, limit),
    },
    configDir: configDir(),
    flags: host.flags ?? {},
  };
}
