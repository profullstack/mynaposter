/** Every directory myna can submit to. */
import { loadSettings, saveSettings, type CustomDirectorySetting } from "../store/settings.ts";
import { mcpDirectory } from "./custom.ts";
import { catalogEntry } from "./catalog.ts";
import { McpClient } from "./mcp.ts";
import type { Directory } from "./types.ts";
import { saasrow } from "./adapters/saasrow.ts";

export const DIRECTORIES: Directory[] = [saasrow];

const BY_ID = new Map(DIRECTORIES.map((directory) => [directory.id, directory]));

/**
 * Add a directory at runtime, the way `registerNetwork` adds a network: a
 * plugin registers before any command runs, and from then on its directory is
 * indistinguishable from a built-in. Registering the same id twice replaces
 * the earlier one.
 */
export function registerDirectory(directory: Directory): void {
  const id = directory.id.trim().toLowerCase();
  if (!id) throw new Error("A directory needs an id.");
  const index = DIRECTORIES.findIndex((entry) => entry.id === id);
  if (index >= 0) DIRECTORIES[index] = directory;
  else DIRECTORIES.push(directory);
  BY_ID.set(id, directory);
}

/** Take a registered directory back out. Tests register stand-ins; see `resetPlugins`. */
export function unregisterDirectory(id: string): void {
  const index = DIRECTORIES.findIndex((entry) => entry.id === id);
  if (index >= 0) DIRECTORIES.splice(index, 1);
  BY_ID.delete(id);
}

/**
 * Register the directories added by URL.
 *
 * Done here, lazily, rather than by every surface calling a setup function:
 * the CLI, the TUI, the desktop app and the MCP server all reach directories
 * through this module, so this is the one place that cannot be forgotten. A
 * malformed entry is skipped rather than thrown, because one bad line in
 * settings.json must not take out `myna directory` altogether.
 */
let customLoaded = false;

function ensureCustom(): void {
  if (customLoaded) return;
  // Set before the loop: a throw must not leave this retrying on every call.
  customLoaded = true;
  for (const entry of loadSettings().directories ?? []) {
    // A built-in of the same id wins: it knows things the generic one cannot,
    // such as how to sign in.
    if (catalogEntry(entry.id)?.builtIn) continue;
    try {
      registerDirectory(mcpDirectory(entry));
    } catch {
      /* a malformed entry is not worth breaking every other directory over */
    }
  }
}

/** Every directory, built-in, added by URL and registered by a plugin. */
export function listDirectories(): Directory[] {
  ensureCustom();
  return [...DIRECTORIES];
}

export function getDirectory(id: string): Directory | undefined {
  ensureCustom();
  return BY_ID.get(id.trim().toLowerCase());
}

export function requireDirectory(id: string): Directory {
  const directory = getDirectory(id);
  if (directory) return directory;
  const known = listDirectories().map((entry) => entry.id).join(", ");
  throw new Error(
    `No directory called "${id}". Known directories: ${known}. ` +
      `Add another with: myna directory add ${id} <mcp url>`,
  );
}

/** Forget the custom directories, so the next read picks settings up again. */
export function resetDirectoryCache(): void {
  for (const entry of loadSettings().directories ?? []) {
    if (!catalogEntry(entry.id)?.builtIn) unregisterDirectory(entry.id);
  }
  customLoaded = false;
}

/**
 * Add a directory by URL, and keep it. The endpoint is checked before it is
 * written: a URL that does not speak MCP, or speaks it but cannot take a
 * listing, is worth finding out now rather than the first time somebody
 * submits to it.
 */
export async function addCustomDirectory(
  entry: CustomDirectorySetting,
  report: (message: string) => void = () => {},
): Promise<Directory> {
  const id = entry.id.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(`"${entry.id}" is not a valid id: lower-case letters, digits and dashes.`);
  }
  if (catalogEntry(id)?.builtIn) throw new Error(`${id} is built in already. Run: myna directory login ${id}`);

  const directory = mcpDirectory({ ...entry, id });
  // Reading the tool table proves the endpoint is what it claims to be.
  report(`Reading ${entry.url}…`);
  const tools = await new McpClient({ url: entry.url, clientName: "myna" }).listTools();
  if (!tools.length) throw new Error(`${entry.url} answered, but offers no tools.`);

  const settings = loadSettings();
  const directories = (settings.directories ?? []).filter((existing) => existing.id !== id);
  directories.push({ ...entry, id });
  saveSettings({ ...settings, directories });

  registerDirectory(directory);
  customLoaded = true;
  return directory;
}

/** Forget a directory added by URL. Its stored credential is removed separately. */
export function removeCustomDirectory(id: string): boolean {
  const wanted = id.trim().toLowerCase();
  const settings = loadSettings();
  const directories = (settings.directories ?? []).filter((entry) => entry.id !== wanted);
  if (directories.length === (settings.directories ?? []).length) return false;
  saveSettings({ ...settings, directories });
  unregisterDirectory(wanted);
  return true;
}
