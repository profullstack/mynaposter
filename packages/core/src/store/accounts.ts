/** Accounts live in the encrypted vault; nothing else in myna touches it. */
import type { Account } from "../net/types.ts";
import { readVault, writeVault, vaultExists, vaultMode } from "../util/crypto/vault.ts";

interface VaultPayload {
  accounts: Account[];
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
  if (!wanted.length || wanted.includes("all") || wanted.includes("*")) return accounts;

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
