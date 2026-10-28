/**
 * Operator unlock for a myna that posts on a schedule (fleet rule 2026-10-28).
 *
 *   myna vault passphrase    move a keyfile vault to a passphrase (deletes vault.key)
 *   myna vault status        mode, and whether the running daemon is unlocked
 *   myna unlock [--ttl 7d]   unlock the running daemon: the key is derived here,
 *                            only the key is sent, it lives in the daemon's memory
 *   myna lock                lock it again (scheduled posts wait, nothing is lost)
 *
 * While the daemon is locked, due posts stay in the queue and one
 * "[alert] myna: operator keys locked" goes out (MYNA_ALERT_CMD, if set).
 * A lost passphrase means re-connecting every account: nobody can open it.
 */
import { existsSync, unlinkSync } from "node:fs";
import {
  configPath,
  daemonRequest,
  deriveVaultKey,
  readVault,
  rekeyVault,
  unlockSocketPath,
  vaultExists,
  vaultMode,
  verifyVaultKey,
} from "@profullstack/myna-core";
import { out } from "./io.ts";
import { askSecret } from "./prompt.ts";

type Flags = Record<string, unknown>;

export interface VaultIo {
  askSecret(label: string): Promise<string>;
}

const defaultIo: VaultIo = { askSecret };

function noDaemon(): number {
  out(`No myna daemon is listening on ${unlockSocketPath()}. Start it with: myna run`);
  return 1;
}

export async function runUnlock(flags: Flags, io: VaultIo = defaultIo): Promise<number> {
  if (vaultMode() !== "passphrase") {
    out("This vault opens with a key file, so there is nothing to unlock. Move it to a passphrase first: myna vault passphrase");
    return 1;
  }
  if (!existsSync(unlockSocketPath())) return noDaemon();
  const key = deriveVaultKey(await io.askSecret("Vault passphrase"));
  try {
    if (!verifyVaultKey(key)) {
      out("That passphrase does not open this vault.");
      return 1;
    }
    const ttl = typeof flags.ttl === "string" ? flags.ttl : "7d";
    const res = await daemonRequest<{ expiresAt?: string; error?: string }>("POST", "/unlock", { key: key.toString("base64"), ttl });
    if (res.status !== 200) {
      out(`Unlock refused: ${res.body.error ?? res.status}`);
      return 1;
    }
    out(`Unlocked until ${res.body.expiresAt}. Scheduled posts resume.`);
    return 0;
  } catch {
    return noDaemon();
  } finally {
    key.fill(0);
  }
}

export async function runLock(): Promise<number> {
  try {
    await daemonRequest("POST", "/lock");
    out("Locked. Scheduled posts wait until the next `myna unlock`.");
    return 0;
  } catch {
    return noDaemon();
  }
}

export async function runVault(positional: string[], _flags: Flags, io: VaultIo = defaultIo): Promise<number> {
  const [sub] = positional;
  if (!sub || sub === "status") {
    if (!vaultExists()) {
      out("No vault yet.");
      return 0;
    }
    out(`mode: ${vaultMode()}`);
    try {
      const res = await daemonRequest<{ unlocked?: boolean; expiresAt?: string | null }>("GET", "/status");
      if (vaultMode() === "keyfile") out("daemon: running (keyfile vault: nothing to unlock; `myna vault passphrase` to seal it)");
      else out(`daemon: ${res.body.unlocked ? `unlocked until ${res.body.expiresAt}` : "locked"}`);
    } catch {
      out("daemon: not running");
    }
    return 0;
  }
  if (sub === "passphrase") {
    if (vaultMode() !== "keyfile") {
      out("The vault already uses a passphrase.");
      return 1;
    }
    const payload = readVault<unknown>({ accounts: [] });
    const first = await io.askSecret("New vault passphrase (12+ characters)");
    if (first.length < 12) {
      out("Use at least 12 characters.");
      return 1;
    }
    if ((await io.askSecret("Repeat it")) !== first) {
      out("The two passphrases differ.");
      return 1;
    }
    rekeyVault(payload, { mode: "passphrase", passphrase: first });
    const keyfile = configPath("vault.key");
    if (existsSync(keyfile)) unlinkSync(keyfile);
    out("The vault now opens only with that passphrase, and vault.key is deleted.");
    out("Lose it and every account must be connected again: nobody can open the vault.");
    out("Restart the daemon (it starts locked), then: myna unlock --ttl 7d");
    return 0;
  }
  out("usage: myna vault [status|passphrase]  |  myna unlock [--ttl 7d]  |  myna lock");
  return 1;
}
