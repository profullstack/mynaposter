import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deriveVaultKey,
  lockSession,
  readVault,
  rekeyVault,
  sessionStatus,
  unlockSession,
  verifyVaultKey,
  writeVault,
  VaultLockedError,
  parseUnlockTtl,
} from "../src/util/crypto/vault.ts";
import { needsPassphrase } from "../src/store/accounts.ts";
import { createVaultGate } from "../src/core/daemon.ts";
import { startUnlockServer, daemonRequest, borrowDaemonUnlock } from "../src/core/unlock-socket.ts";

const PASS = "a long operator passphrase";
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-unlock-"));
  process.env.MYNA_HOME = dir;
  delete process.env.MYNA_PASSPHRASE;
  rekeyVault({ accounts: [{ id: "bluesky:me", creds: { password: "sekrit-pw" } }] }, { mode: "passphrase", passphrase: PASS });
});

afterEach(() => {
  lockSession();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
});

test("locked: no env passphrase and no session means VaultLockedError, and the file holds no plaintext", () => {
  expect(() => readVault({ accounts: [] })).toThrow(VaultLockedError);
  expect(needsPassphrase()).toBe(true);
  expect(readFileSync(join(dir, "vault.json"), "utf8")).not.toContain("sekrit-pw");
});

test("an unlock session opens and writes the vault; lock forgets it", () => {
  const key = deriveVaultKey(PASS);
  expect(verifyVaultKey(key)).toBe(true);
  const out = unlockSession(key);
  const days = (Date.parse(out.expiresAt) - Date.now()) / 86_400_000;
  expect(days).toBeGreaterThan(6.9);
  expect(needsPassphrase()).toBe(false);
  expect(readVault<{ accounts: unknown[] }>({ accounts: [] }).accounts).toHaveLength(1);
  writeVault({ accounts: [] });
  expect(readVault<{ accounts: unknown[] }>({ accounts: [] }).accounts).toHaveLength(0);
  lockSession();
  expect(sessionStatus().unlocked).toBe(false);
  expect(() => readVault({ accounts: [] })).toThrow(VaultLockedError);
});

test("a wrong key does not unlock; TTL is clamped to 7 days", () => {
  expect(() => unlockSession(Buffer.alloc(32, 9))).toThrow(/does not open/);
  expect(parseUnlockTtl("30d")).toBe(7 * 86400);
  expect(parseUnlockTtl(undefined)).toBe(7 * 86400);
  expect(parseUnlockTtl("8h")).toBe(8 * 3600);
});

test("the gate pauses jobs while locked and alerts once per lock", () => {
  const lines: string[] = [];
  let locked = true;
  const gate = createVaultGate((l) => lines.push(l), { locked: () => locked, alertCmd: "" });
  expect(gate.open()).toBe(false);
  expect(gate.open()).toBe(false);
  expect(lines.filter((l) => l.startsWith("[alert] myna: operator keys locked"))).toHaveLength(1);
  locked = false;
  expect(gate.open()).toBe(true);
  locked = true;
  expect(gate.open()).toBe(false);
  expect(lines.filter((l) => l.startsWith("[alert]"))).toHaveLength(2);
});

test("the socket: unlock with the derived key, lend it to a CLI, lock", async () => {
  const server = await startUnlockServer();
  try {
    expect((await daemonRequest<{ unlocked: boolean }>("GET", "/status")).body.unlocked).toBe(false);
    expect((await daemonRequest("GET", "/key")).status).toBe(423);
    expect((await daemonRequest("POST", "/unlock", { key: Buffer.alloc(32, 1).toString("base64") })).status).toBe(403);

    const key = deriveVaultKey(PASS).toString("base64");
    const ok = await daemonRequest<{ unlocked: boolean }>("POST", "/unlock", { key, ttl: "1h" });
    expect(ok.status).toBe(200);
    expect(ok.body.unlocked).toBe(true);
    expect(await borrowDaemonUnlock()).toBe(true);

    await daemonRequest("POST", "/lock");
    expect(sessionStatus().unlocked).toBe(false);
    expect(await borrowDaemonUnlock()).toBe(false);
  } finally {
    server.close();
  }
});
