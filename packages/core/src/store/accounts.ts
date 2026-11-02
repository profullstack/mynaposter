/**
 * Accounts live in the encrypted vault; nothing else in myna touches it.
 *
 * Directory credentials live here too, and for a reason worth stating: the
 * vault is read into one module-level cache, so a second module opening it
 * would hold a second copy and the last writer would silently drop the other's
 * changes. Everything that persists into the vault goes through this file.
 *
 * The cache is also checked against the file on every use. The daemon runs for
 * days: with a cache read once at start, an account added by `myna login` was
 * invisible to it, and the next session refresh it saved wrote the old list
 * back over the new one, deleting the account.
 */
import type { Account, AccountArchive } from "../net/types.ts";
import type { DirectoryAccount } from "../directories/types.ts";
import { statSync } from "node:fs";
import { readVault, writeVault, vaultExists, vaultMode, sessionStatus, onVaultLock } from "../util/crypto/vault.ts";
import { configPath, VAULT_FILE } from "../util/paths.ts";
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
/** mtime and size of vault.json when `cache` was read or written; "" when there is no file. */
let cacheStamp = "";
let passphrase: string | undefined;

// The decrypted payload must not outlive an unlock session.
onVaultLock(() => {
  cache = null;
  cacheStamp = "";
});

/** Supply the passphrase for a passphrase-mode vault. */
export function unlock(value: string): void {
  passphrase = value;
  cache = null;
  load();
}

/** The passphrase this process unlocked the vault with, if any: a background child needs it handed over. */
export function activePassphrase(): string | undefined {
  return passphrase || process.env.MYNA_PASSPHRASE || undefined;
}

export function needsPassphrase(): boolean {
  return (
    vaultExists() && vaultMode() === "passphrase" && !passphrase && !process.env.MYNA_PASSPHRASE && !sessionStatus().unlocked
  );
}

function vaultStamp(): string {
  try {
    const stat = statSync(configPath(VAULT_FILE));
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "";
  }
}

/** The vault as it is on disk now: re-read whenever another process has written it since. */
function load(): VaultPayload {
  const stamp = vaultStamp();
  if (!cache || stamp !== cacheStamp) {
    cache = readVault<VaultPayload>({ accounts: [] }, passphrase);
    cacheStamp = stamp;
  }
  return cache;
}

function save(payload: VaultPayload): void {
  writeVault(payload, passphrase);
  cache = payload;
  cacheStamp = vaultStamp();
}

/** True when the account was archived: it keeps its credentials but is never posted to. */
export function isArchived(account: Pick<Account, "archived"> | undefined): boolean {
  return Boolean(account?.archived);
}

/** "archived" or "banned", plus the date and the note: the line every refusal prints. */
export function describeArchive(account: Pick<Account, "id" | "archived">): string {
  const archive = account.archived;
  if (!archive) return `${account.id} is active`;
  const label = archive.banned ? "banned" : "archived";
  return `${account.id} is ${label} (since ${archive.at.slice(0, 10)})${archive.note ? `: ${archive.note}` : ""}`;
}

/** Thrown when an archived account is named as a posting target. */
export class ArchivedAccountError extends Error {
  constructor(public readonly accounts: Account[]) {
    super(
      `${accounts.map(describeArchive).join("\n")}\n` +
        `An archived account is never posted to. Restore it first: myna account restore ${accounts[0]?.id ?? "<account>"}`,
    );
    this.name = "ArchivedAccountError";
  }
}

/** Refuse to go any further when an archived account is among the targets. */
export function refuseArchived(accounts: Account[]): void {
  const archived = accounts.filter(isArchived);
  if (archived.length) throw new ArchivedAccountError(archived);
}

/**
 * Every connected account that can be posted to. Archived accounts are left
 * out, so the many loops that walk this list (engage, follow, graph, upvote,
 * hubs, plugin tasks) never act for one; pass `{ includeArchived: true }`
 * where the archived ones belong in the answer (the accounts list, a backup).
 */
export function listAccounts(options: { includeArchived?: boolean } = {}): Account[] {
  return [...load().accounts]
    .filter((account) => options.includeArchived || !isArchived(account))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Only the archived accounts. */
export function archivedAccounts(): Account[] {
  return listAccounts({ includeArchived: true }).filter(isArchived);
}

/**
 * Archive an account: it keeps its credentials and stays in `myna accounts`,
 * but it is never a posting target again until restored.
 */
export function archiveAccount(id: string, details: { banned?: boolean; note?: string; at?: string } = {}): Account {
  const payload = load();
  const account = payload.accounts.find((entry) => entry.id === id);
  if (!account) throw new Error(`No account "${id}". Run: myna accounts`);
  const archived: AccountArchive = { at: details.at ?? new Date().toISOString() };
  if (details.banned) archived.banned = true;
  const note = details.note?.trim();
  if (note) archived.note = note;
  account.archived = archived;
  save(payload);
  return account;
}

/** Put an archived account back into rotation. Returns undefined when it was not archived. */
export function restoreAccount(id: string): Account | undefined {
  const payload = load();
  const account = payload.accounts.find((entry) => entry.id === id);
  if (!account) throw new Error(`No account "${id}". Run: myna accounts`);
  if (!account.archived) return undefined;
  delete account.archived;
  save(payload);
  return account;
}

export function getAccount(id: string): Account | undefined {
  return load().accounts.find((account) => account.id === id);
}

export function accountsFor(network: string): Account[] {
  return load().accounts.filter((account) => account.network === network && !isArchived(account));
}

/**
 * Add or replace an account. An archived account stays archived when it is
 * saved again without saying otherwise (a token refresh, a re-login): only
 * `restoreAccount`, or an account that carries the `archived` key itself,
 * changes that.
 */
export function saveAccount(account: Account): void {
  const payload = load();
  const index = payload.accounts.findIndex((existing) => existing.id === account.id);
  if (index >= 0) {
    const kept = payload.accounts[index].archived;
    payload.accounts[index] = kept && !("archived" in account) ? { ...account, archived: kept } : account;
  } else payload.accounts.push(account);
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
  const accounts = listAccounts({ includeArchived: true });
  const wanted = spec.split(",").map((part) => part.trim()).filter(Boolean);
  // "all" is every account that is safe to fan out to. A blog you host is
  // not one: a post there is a page and a commit, so it has to be named.
  // Neither is an archived account, which is never a target at all.
  if (!wanted.length || wanted.includes("all") || wanted.includes("*")) {
    return accounts.filter((account) => !isArchived(account) && !getNetwork(account.network)?.caps.explicitTarget);
  }

  const seen = new Set<string>();
  const out: Account[] = [];
  for (const token of wanted) {
    const named = accounts.filter((account) => account.id === token || account.handle === token);
    // Naming an archived account is refused outright, with the reason, so a
    // post meant for it never quietly goes nowhere (or somewhere else).
    if (named.some(isArchived)) throw new ArchivedAccountError(named.filter(isArchived));
    const all = accounts.filter((account) => account.id === token || account.network === token || account.handle === token);
    // A network name means its live accounts; the archived ones are skipped.
    const matches = all.filter((account) => !isArchived(account));
    if (!matches.length && all.length) throw new ArchivedAccountError(all);
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
  cacheStamp = "";
}
