/**
 * The credential vault.
 *
 * Account secrets are encrypted at rest with AES-256-GCM. The key comes from
 * either a passphrase (scrypt) or a local keyfile, chosen when the vault is
 * created. The keyfile mode exists because prompting for a master passphrase on
 * every launch is the kind of friction that makes people paste tokens into
 * shell history instead.
 *
 * A passphrase-mode vault can also be opened by an UNLOCK SESSION: the scrypt
 * key, derived on the operator's side by `myna unlock` and handed to the
 * daemon over its owner-only socket, held in memory with a TTL (7 days by
 * default, at most 7) and never written anywhere. This is the operator rule
 * (fleet, 2026-10-28): a box that posts on a schedule keeps no passphrase in
 * its environment and no key file beside the vault. While locked, the daemon
 * pauses (queue entries wait, nothing is marked failed) and alerts once.
 */
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { configPath, ensureConfigDir, VAULT_FILE } from "../paths.ts";
import { readJson, writeJson } from "../json.ts";

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32 } as const;
const KEYFILE = "vault.key";

export interface VaultFile {
  version: 1;
  /** "passphrase" derives the key with scrypt; "keyfile" reads it from disk. */
  mode: "passphrase" | "keyfile";
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

export class VaultLockedError extends Error {
  constructor() {
    super("Vault is locked. Run `myna unlock` (or set MYNA_PASSPHRASE on your own machine).");
    this.name = "VaultLockedError";
  }
}

export const UNLOCK_DEFAULT_TTL_SECONDS = 7 * 24 * 3600;
export const UNLOCK_MAX_TTL_SECONDS = 7 * 24 * 3600;

/** "30m", "8h", "7d", "3600" -> seconds, clamped to 60s..7d. */
export function parseUnlockTtl(text: string | undefined): number {
  if (!text) return UNLOCK_DEFAULT_TTL_SECONDS;
  const m = /^(\d+)\s*([smhd]?)$/i.exec(String(text).trim());
  if (!m) throw new Error(`bad ttl "${text}" (use e.g. 30m, 8h, 7d)`);
  const mult = ({ "": 1, s: 1, m: 60, h: 3600, d: 86400 } as Record<string, number>)[m[2]!.toLowerCase()]!;
  return Math.min(UNLOCK_MAX_TTL_SECONDS, Math.max(60, Number(m[1]) * mult));
}

let session: { key: Buffer; expiresAt: number } | null = null;
const lockListeners = new Set<() => void>();

/** Called when the session key is dropped (lock, expiry), so caches of decrypted data can go too. */
export function onVaultLock(fn: () => void): () => void {
  lockListeners.add(fn);
  return () => lockListeners.delete(fn);
}

function sessionKey(): Buffer | null {
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    lockSession();
    return null;
  }
  return session.key;
}

/** Hold a derived vault key in memory until the TTL. Verifies it first. */
export function unlockSession(key: Buffer, ttlSeconds = UNLOCK_DEFAULT_TTL_SECONDS): { unlocked: true; expiresAt: string } {
  if (!verifyVaultKey(key)) throw new Error("That passphrase does not open this vault.");
  lockSession();
  const ttl = Math.min(UNLOCK_MAX_TTL_SECONDS, Math.max(60, Math.floor(ttlSeconds)));
  session = { key: Buffer.from(key), expiresAt: Date.now() + ttl * 1000 };
  return { unlocked: true, expiresAt: new Date(session.expiresAt).toISOString() };
}

export function lockSession(): void {
  if (!session) return;
  session.key.fill(0);
  session = null;
  for (const fn of lockListeners) {
    try {
      fn();
    } catch {
      // a listener never breaks the lock
    }
  }
}

export function sessionStatus(): { unlocked: boolean; expiresAt: string | null } {
  const key = sessionKey();
  return key && session ? { unlocked: true, expiresAt: new Date(session.expiresAt).toISOString() } : { unlocked: false, expiresAt: null };
}

/** The session key while unlocked (for handing to a same-user CLI over the socket). */
export function currentSessionKey(): Buffer | null {
  return sessionKey();
}

/** Derive the key a passphrase-mode vault opens with. Client side of `myna unlock`. */
export function deriveVaultKey(passphrase: string): Buffer {
  const file = readJson<VaultFile | null>(VAULT_FILE, null);
  if (!file || file.mode !== "passphrase") throw new Error("This vault is not in passphrase mode.");
  return deriveKey(passphrase, Buffer.from(file.salt, "hex"));
}

/** Does this key open the vault on disk? (AES-GCM tag check, nothing kept.) */
export function verifyVaultKey(key: Buffer): boolean {
  const file = readJson<VaultFile | null>(VAULT_FILE, null);
  if (!file || file.mode !== "passphrase" || key.length !== 32) return false;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(file.iv, "hex"));
    decipher.setAuthTag(Buffer.from(file.tag, "hex"));
    decipher.update(Buffer.from(file.data, "base64"));
    decipher.final();
    return true;
  } catch {
    return false;
  }
}

/** The key for a passphrase-mode vault: explicit passphrase, then MYNA_PASSPHRASE, then the unlock session. */
function passphraseModeKey(salt: Buffer, passphrase: string | undefined): Buffer {
  const value = passphrase ?? process.env.MYNA_PASSPHRASE;
  if (value) return deriveKey(value, salt);
  const key = sessionKey();
  if (key) return Buffer.from(key);
  throw new VaultLockedError();
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * SCRYPT.N * SCRYPT.r * 2 });
}

function keyfileKey(): Buffer {
  ensureConfigDir();
  const path = configPath(KEYFILE);
  if (!existsSync(path)) {
    const key = randomBytes(32);
    writeFileSync(path, key, { mode: 0o600 });
    return key;
  }
  return readFileSync(path);
}

export function vaultExists(): boolean {
  return existsSync(configPath(VAULT_FILE));
}

export function vaultMode(): "passphrase" | "keyfile" | null {
  if (!vaultExists()) return null;
  return readJson<VaultFile | null>(VAULT_FILE, null)?.mode ?? null;
}

/**
 * Open the vault and return its plaintext payload.
 * `passphrase` is required only when the vault was created in passphrase mode.
 */
export function readVault<T>(fallback: T, passphrase?: string): T {
  const file = readJson<VaultFile | null>(VAULT_FILE, null);
  if (!file) return fallback;

  const key = file.mode === "keyfile" ? keyfileKey() : passphraseModeKey(Buffer.from(file.salt, "hex"), passphrase);

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(file.iv, "hex"));
    decipher.setAuthTag(Buffer.from(file.tag, "hex"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(file.data, "base64")), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as T;
  } catch {
    throw new Error(
      file.mode === "passphrase"
        ? "Wrong passphrase — the vault did not decrypt."
        : "The vault did not decrypt. Its keyfile may be missing or from another machine.",
    );
  }
}

export function writeVault(value: unknown, passphrase?: string): void {
  const existing = readJson<VaultFile | null>(VAULT_FILE, null);
  const mode: "passphrase" | "keyfile" = existing?.mode ?? (passphrase ? "passphrase" : "keyfile");
  const salt = existing ? Buffer.from(existing.salt, "hex") : randomBytes(16);
  // A session key belongs to the existing salt, so writing keeps it.
  const key = mode === "keyfile" ? keyfileKey() : existing ? passphraseModeKey(salt, passphrase) : deriveKey(requirePassphrase(passphrase), salt);

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), "utf8")), cipher.final()]);

  const file: VaultFile = {
    version: 1,
    mode,
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    data: data.toString("base64"),
  };
  writeJson(VAULT_FILE, file);
}

function requirePassphrase(passphrase: string | undefined): string {
  const value = passphrase ?? process.env.MYNA_PASSPHRASE;
  if (!value) throw new VaultLockedError();
  return value;
}

/** Re-encrypt the whole vault under a new passphrase, or back to a keyfile. */
export function rekeyVault(payload: unknown, next: { mode: "passphrase"; passphrase: string } | { mode: "keyfile" }): void {
  const salt = randomBytes(16);
  const key = next.mode === "keyfile" ? keyfileKey() : deriveKey(next.passphrase, salt);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), "utf8")), cipher.final()]);
  writeJson(VAULT_FILE, {
    version: 1,
    mode: next.mode,
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    data: data.toString("base64"),
  } satisfies VaultFile);
}
