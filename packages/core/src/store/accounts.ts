/**
 * Accounts live in the encrypted vault; nothing else in myna touches it.
 *
 * Directory credentials live here too, and for a reason worth stating: the
 * vault is read into one module-level cache, so a second module opening it
 * would hold a second copy and the last writer would silently drop the other's
 * changes. Everything that persists into the vault goes through this file.
 */
import type { Account } from "../net/types.ts";
import type { DirectoryAccount } from "../directories/types.ts";
import { readVault, writeVault, vaultExists, vaultMode } from "../util/crypto/vault.ts";
import { getNetwork } from "../net/registry.ts";

interface VaultPayload {
  accounts: Account[];
  /**
   * Secrets a plugin keeps, by plugin id. In the vault rather than in
   * settings.json so an API key for a data source is protected exactly like
   * an account password is.
   */
  plugins?: Record<string, Record<string, string>>;
  /**
   * Directory credentials, by directory id. Deliberately not in `accounts`:
   * `resolveTargets("all")` fans out over every account, so a directory key
   * kept there would be a posting target, and a stray thought would go out as
   * a product submission.
   */
  directories?: Record<string, DirectoryAccount>;
}

let cache: VaultPayload | null = null;
let passphrase: string | undefined;

/** Supply the passphrase for a passphrase-mode vault. */
export function unlock(value: string): void {
  passphrase = value;
  cache = null;
  load();
}

export function needsPassphrase(): boolean {
  return vaultExists() && vaultMode() === "passphrase" && !passphrase && !process.env.MYNA_PASSPHRASE;
}

function load(): VaultPayload {
  if (!cache) cache = readVault<VaultPayload>({ accounts: [] }, passphrase);
  return cache;
}

function save(payload: VaultPayload): void {
  cache = payload;
  writeVault(payload, passphrase);
}

export function listAccounts(): Account[] {
  return [...load().accounts].sort((a, b) => a.id.localeCompare(b.id));
}

export function getAccount(id: string): Account | undefined {
  return load().accounts.find((account) => account.id === id);
}

export function accountsFor(network: string): Account[] {
  return load().accounts.filter((account) => account.network === network);
}

export function saveAccount(account: Account): void {
  const payload = load();
  const index = payload.accounts.findIndex((existing) => existing.id === account.id);
  if (index >= 0) payload.accounts[index] = account;
  else payload.accounts.push(account);
  save(payload);
}

export function getPluginSecrets(pluginId: string): Record<string, string> {
  return { ...(load().plugins?.[pluginId] ?? {}) };
}

/** Replace a plugin's secrets. An empty object removes the entry. */
export function setPluginSecrets(pluginId: string, values: Record<string, string>): void {
  const payload = load();
  const plugins = { ...(payload.plugins ?? {}) };
  if (Object.keys(values).length) plugins[pluginId] = { ...values };
  else delete plugins[pluginId];
  save({ ...payload, plugins });
}

/** Every directory this machine is signed in to, by id. */
export function listDirectoryAccounts(): DirectoryAccount[] {
  const stored = load().directories ?? {};
  return Object.values(stored).sort((a, b) => a.directory.localeCompare(b.directory));
}

export function getDirectoryAccount(directory: string): DirectoryAccount | undefined {
  return load().directories?.[directory.trim().toLowerCase()];
}

export function saveDirectoryAccount(account: DirectoryAccount): void {
  const payload = load();
  const directories = { ...(payload.directories ?? {}) };
  directories[account.directory] = account;
  save({ ...payload, directories });
}

export function removeDirectoryAccount(directory: string): boolean {
  const payload = load();
  const id = directory.trim().toLowerCase();
  if (!payload.directories?.[id]) return false;
  const directories = { ...payload.directories };
  delete directories[id];
  save({ ...payload, directories });
  return true;
}

export function removeAccount(id: string): boolean {
  const payload = load();
  const before = payload.accounts.length;
  payload.accounts = payload.accounts.filter((account) => account.id !== id);
  if (payload.accounts.length === before) return false;
  save(payload);
  return true;
}

/**
 * Resolve `--to` values. Accepts a full account id (`bluesky:alice.bsky.social`),
 * a bare network name (every account on it), or `all`.
 */
export function resolveTargets(spec: string): Account[] {
  const accounts = listAccounts();
  const wanted = spec.split(",").map((part) => part.trim()).filter(Boolean);
  // "all" is every account that is safe to fan out to. A blog you host is
  // not one: a post there is a page and a commit, so it has to be named.
  if (!wanted.length || wanted.includes("all") || wanted.includes("*")) {
    return accounts.filter((account) => !getNetwork(account.network)?.caps.explicitTarget);
  }

  const seen = new Set<string>();
  const out: Account[] = [];
  for (const token of wanted) {
    const matches = accounts.filter((account) => account.id === token || account.network === token || account.handle === token);
    if (!matches.length) throw new Error(`No connected account matches "${token}". Run /accounts to see what is connected.`);
    for (const match of matches) {
      if (seen.has(match.id)) continue;
      seen.add(match.id);
      out.push(match);
    }
  }
  return out;
}

/** Drop the in-memory copy — used after a rekey or in tests. */
export function resetAccountCache(): void {
  cache = null;
}
