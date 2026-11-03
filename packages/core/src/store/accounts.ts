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
import type { Account, AccountArchive, AccountMirror } from "../net/types.ts";
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

/** True when the account is a mirror: it only reposts/likes another account and never posts its own. */
export function isMirror(account: Pick<Account, "mirror"> | undefined): boolean {
  return Boolean(account?.mirror);
}

/**
 * True when nothing original may be posted from the account: it is archived
 * or a mirror. Every posting gate uses this, so a mirror is shut out of
 * `all`, network names, rotation, the drip, newsletters, evergreen and engage
 * exactly the way an archived account is.
 */
export function isOffLimits(account: Pick<Account, "archived" | "mirror"> | undefined): boolean {
  return isArchived(account) || isMirror(account);
}

/** "mirror of <source>", "archived" or "banned": the short status `myna accounts` prints. */
export function accountStatus(account: Pick<Account, "archived" | "mirror">): string {
  if (account.archived) return `${account.archived.banned ? "banned" : "archived"} ${account.archived.at.slice(0, 10)}`;
  if (account.mirror) return `mirror of ${account.mirror.from}`;
  return "active";
}

/** "archived" or "banned", plus the date and the note, or the mirror's source: the line every refusal prints. */
export function describeArchive(account: Pick<Account, "id" | "archived" | "mirror">): string {
  const archive = account.archived;
  if (!archive) {
    const mirror = account.mirror;
    if (mirror) {
      const what = [mirror.repost ? "reposts" : "", mirror.like ? "likes" : ""].filter(Boolean).join(" and ") || "mirrors";
      return `${account.id} is a mirror of ${mirror.from} (since ${mirror.at.slice(0, 10)}): it only ${what} ${mirror.from}'s posts and never posts its own`;
    }
    return `${account.id} is active`;
  }
  const label = archive.banned ? "banned" : "archived";
  return `${account.id} is ${label} (since ${archive.at.slice(0, 10)})${archive.note ? `: ${archive.note}` : ""}`;
}

/** Thrown when an archived or mirror account is named as a posting target. */
export class ArchivedAccountError extends Error {
  constructor(public readonly accounts: Account[]) {
    const first = accounts[0];
    const fix = first && !first.archived && first.mirror
      ? `A mirror account never posts on its own. Turn the mirror off first: myna account mirror ${first.id} --off`
      : `An archived account is never posted to. Restore it first: myna account restore ${first?.id ?? "<account>"}`;
    super(`${accounts.map(describeArchive).join("\n")}\n${fix}`);
    this.name = "ArchivedAccountError";
  }
}

/** Refuse to go any further when an archived or mirror account is among the targets. */
export function refuseArchived(accounts: Account[]): void {
  const blocked = accounts.filter(isOffLimits);
  if (blocked.length) throw new ArchivedAccountError(blocked);
}

/**
 * Every connected account that can be posted to. Archived accounts are left
 * out, so the many loops that walk this list (engage, follow, graph, upvote,
 * hubs, plugin tasks) never act for one; pass `{ includeArchived: true }`
 * where the archived ones belong in the answer (the accounts list, a backup).
 */
export function listAccounts(options: { includeArchived?: boolean } = {}): Account[] {
  // A mirror is left out with the archived ones: it acts only through the
  // mirror job, never through engage/follow/upvote or anything else.
  return [...load().accounts]
    .filter((account) => options.includeArchived || !isOffLimits(account))
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

/** Accounts set up as mirrors and not archived: what the mirror job walks. */
export function mirrorAccounts(): Account[] {
  return listAccounts({ includeArchived: true }).filter((account) => isMirror(account) && !isArchived(account));
}

/**
 * Make an account a mirror of `from`: from now on it never posts its own and
 * the daemon reposts and/or likes each new original post by `from`.
 *
 * An archived account is refused unless `restore` is set, in which case the
 * archive is lifted and the mirror set in ONE vault write, so there is never
 * a moment where the account is a plain, fully active posting target.
 */
export function setMirror(
  id: string,
  config: { from: string; like?: boolean; repost?: boolean; at?: string; since?: string; restore?: boolean },
): Account {
  const payload = load();
  const account = payload.accounts.find((entry) => entry.id === id);
  if (!account) throw new Error(`No account "${id}". Run: myna accounts`);
  const from = config.from.trim();
  if (!from) throw new Error("A mirror needs a source: --from <account>");
  const source = payload.accounts.find((entry) => entry.id === from || (entry.network === account.network && entry.handle === from));
  if (source && source.id === account.id) throw new Error("An account cannot mirror itself.");
  if (source && source.network !== account.network) {
    throw new Error(`${account.id} and ${source.id} are on different networks; a mirror reposts on its own network.`);
  }
  if (account.archived && !config.restore) {
    throw new Error(`${describeArchive(account)}\nPass --restore to lift the archive and make it a mirror in one step.`);
  }
  const like = config.like ?? true;
  const repost = config.repost ?? true;
  if (!like && !repost) throw new Error("A mirror has to like, repost, or both.");
  const at = config.at ?? new Date().toISOString();
  const mirror: AccountMirror = {
    from: source?.id ?? from,
    like,
    repost,
    at,
    // First enable: only the last day, never the whole history.
    since: config.since ?? new Date(Date.parse(at) - 24 * 3_600_000).toISOString(),
  };
  account.mirror = mirror;
  if (config.restore) delete account.archived;
  save(payload);
  return account;
}

/** Stop mirroring. Returns undefined when the account was not a mirror. It goes back to being a normal account. */
export function clearMirror(id: string): Account | undefined {
  const payload = load();
  const account = payload.accounts.find((entry) => entry.id === id);
  if (!account) throw new Error(`No account "${id}". Run: myna accounts`);
  if (!account.mirror) return undefined;
  delete account.mirror;
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
  return load().accounts.filter((account) => account.network === network && !isOffLimits(account));
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
    // The archive and the mirror are ours, not the adapter's: a re-login or a
    // token refresh keeps both unless the saved account says otherwise.
    const existing = payload.accounts[index];
    const next: Account = { ...account };
    if (existing.archived && !("archived" in account)) next.archived = existing.archived;
    if (existing.mirror && !("mirror" in account)) next.mirror = existing.mirror;
    payload.accounts[index] = next;
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
    return accounts.filter((account) => !isOffLimits(account) && !getNetwork(account.network)?.caps.explicitTarget);
  }

  const seen = new Set<string>();
  const out: Account[] = [];
  for (const token of wanted) {
    const named = accounts.filter((account) => account.id === token || account.handle === token);
    // Naming an archived account is refused outright, with the reason, so a
    // post meant for it never quietly goes nowhere (or somewhere else).
    if (named.some(isOffLimits)) throw new ArchivedAccountError(named.filter(isOffLimits));
    const all = accounts.filter((account) => account.id === token || account.network === token || account.handle === token);
    // A network name means its live accounts; the archived ones are skipped.
    const matches = all.filter((account) => !isOffLimits(account));
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
