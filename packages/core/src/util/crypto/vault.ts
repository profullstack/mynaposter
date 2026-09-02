/**
 * The credential vault.
 *
 * Account secrets are encrypted at rest with AES-256-GCM. The key comes from
 * either a passphrase (scrypt) or a local keyfile, chosen when the vault is
 * created. The keyfile mode exists because prompting for a master passphrase on
 * every launch is the kind of friction that makes people paste tokens into
 * shell history instead.
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
    super("Vault is locked. Set MYNA_PASSPHRASE or unlock it first.");
    this.name = "VaultLockedError";
  }
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

  const key =
    file.mode === "keyfile"
      ? keyfileKey()
      : deriveKey(requirePassphrase(passphrase), Buffer.from(file.salt, "hex"));

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
  const key = mode === "keyfile" ? keyfileKey() : deriveKey(requirePassphrase(passphrase), salt);

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
