/**
 * The daemon's operator unlock socket.
 *
 * A Unix socket in the config dir, mode 0600, so only the vault's own user can
 * reach it. `myna unlock` derives the vault key from the passphrase on its own
 * side and sends only the key; the daemon keeps it in memory with a TTL
 * (util/crypto/vault.ts). A short-lived `myna` command run by the same user
 * (cron's `myna post`) asks the daemon for the key instead of a passphrase,
 * and holds it only for its own run.
 *
 *   GET  /status   { mode, unlocked, expiresAt }
 *   POST /unlock   { key: base64, ttl?: "7d" }
 *   POST /lock
 *   GET  /key      { key } while unlocked, 423 while locked
 */
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { configPath, ensureConfigDir } from "../util/paths.ts";
import {
  currentSessionKey,
  lockSession,
  parseUnlockTtl,
  sessionStatus,
  unlockSession,
  vaultMode,
} from "../util/crypto/vault.ts";

export const UNLOCK_SOCKET = "daemon.sock";

export function unlockSocketPath(): string {
  return process.env.MYNA_UNLOCK_SOCKET || configPath(UNLOCK_SOCKET);
}

function status() {
  return { mode: vaultMode(), ...sessionStatus() };
}

/** Start the socket server. Returns it so the caller can close it. */
export async function startUnlockServer(log: (line: string) => void = () => {}): Promise<Server> {
  ensureConfigDir();
  const path = unlockSocketPath();
  if (existsSync(path)) unlinkSync(path);
  const server = createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const route = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && route === "/status") return send(200, status());
    if (req.method === "GET" && route === "/key") {
      const key = currentSessionKey();
      return key ? send(200, { key: key.toString("base64"), ...sessionStatus() }) : send(423, { error: "locked" });
    }
    if (req.method !== "POST" || (route !== "/unlock" && route !== "/lock")) return send(404, { error: "not found" });
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
      if (raw.length > 16 * 1024) req.destroy();
    });
    req.on("end", () => {
      if (route === "/lock") {
        lockSession();
        log("vault locked by operator");
        return send(200, status());
      }
      let body: { key?: string; ttl?: string };
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        return send(400, { error: "body must be JSON" });
      }
      const key = Buffer.from(String(body.key ?? ""), "base64");
      try {
        const out = unlockSession(key, parseUnlockTtl(body.ttl));
        log(`vault unlocked until ${out.expiresAt}`);
        return send(200, status());
      } catch (error) {
        return send(403, { error: (error as Error).message });
      } finally {
        key.fill(0);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
  chmodSync(path, 0o600);
  server.unref();
  return server;
}

/** Talk to a running daemon. Rejects when none is listening. */
export function daemonRequest<T = Record<string, unknown>>(
  method: "GET" | "POST",
  route: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath: unlockSocketPath(), path: route, method, headers: { "content-type": "application/json" } },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (raw += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw || "{}") as T });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("daemon did not answer")));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/**
 * For a short-lived command: borrow the daemon's unlock session, if it has
 * one. Returns true when this process can now open the vault.
 */
export async function borrowDaemonUnlock(): Promise<boolean> {
  if (!existsSync(unlockSocketPath())) return false;
  try {
    const { status: code, body } = await daemonRequest<{ key?: string; expiresAt?: string }>("GET", "/key");
    if (code !== 200 || !body.key) return false;
    const key = Buffer.from(body.key, "base64");
    const left = body.expiresAt ? Math.floor((Date.parse(body.expiresAt) - Date.now()) / 1000) : 60;
    try {
      unlockSession(key, Math.max(60, left));
    } finally {
      key.fill(0);
    }
    return true;
  } catch {
    return false;
  }
}
