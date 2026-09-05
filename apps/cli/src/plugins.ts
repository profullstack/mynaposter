/**
 * Plugins the CLI ships with, and the one call that loads the rest.
 *
 * A bundled plugin is imported statically so it compiles into the binary; an
 * installed one is found on disk at run time. Both go through the same
 * registry, so nothing downstream knows the difference.
 */
import { loadPlugins, registerPlugin, type LoadedPlugin } from "@profullstack/myna-core";
import outreachgraph from "@profullstack/myna-plugin-outreachgraph";

let prepared: Promise<LoadedPlugin[]> | undefined;

export function preparePlugins(): Promise<LoadedPlugin[]> {
  if (!prepared) {
    registerPlugin(outreachgraph, "bundled");
    prepared = loadPlugins();
  }
  return prepared;
}
