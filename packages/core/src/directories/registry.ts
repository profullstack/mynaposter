/** Every directory myna can submit to. */
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

export function getDirectory(id: string): Directory | undefined {
  return BY_ID.get(id.trim().toLowerCase());
}

export function requireDirectory(id: string): Directory {
  const directory = getDirectory(id);
  if (directory) return directory;
  const known = DIRECTORIES.map((entry) => entry.id).join(", ");
  throw new Error(`No directory called "${id}". Known directories: ${known}`);
}
