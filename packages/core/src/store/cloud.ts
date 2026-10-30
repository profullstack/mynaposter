/** Local client for myna cloud authentication and encrypted backup. */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { closeSync, openSync, statSync, unlinkSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { configPath } from "../util/paths.ts";
import { readJson, writeJson } from "../util/json.ts";
import { getJson, postJson, request } from "../util/http.ts";
import { openBrowser as defaultOpenBrowser } from "../net/oauth2.ts";
import type { BundleFile } from "./bundle.ts";

const FILE = "cloud.json";
const CLIENT_ID = "myna-cli";
const TOKEN_ENDPOINT = "/v1/oauth/token";
const DEVICE_ENDPOINT = "/v1/oauth/device_authorization";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const API_TIMEOUT_MS = 15_000;

export interface CloudSession {
  /** Base URL of the myna instance holding the backup. */
  server: string;
  email: string;
  token: string;
  refreshToken?: string;
  expiresAt?: string;
  checkedAt?: string;
  since: string;
  status?: "active" | "expired";
  expiredAt?: string;
  sessionAlertedAt?: string;
}

export interface CloudSessionHealth {
  state: "signed-out" | "active" | "expired";
  email?: string;
  expiredAt?: string;
}

export const DEFAULT_SERVER = "https://mynaposter.com/api";

export class CloudSessionExpiredError extends Error {
  constructor(message = "Your myna cloud session has expired. Sign in again: myna cloud login") {
    super(message);
    this.name = "CloudSessionExpiredError";
  }
}

export function session(): CloudSession | null {
  return readJson<CloudSession | null>(FILE, null);
}

export function sessionHealth(): CloudSessionHealth {
  const current = session();
  if (!current) return { state: "signed-out" };
  if (current.status === "expired" || !current.token) return { state: "expired", email: current.email, expiredAt: current.expiredAt };
  return { state: "active", email: current.email };
}

export function saveSession(value: CloudSession): void {
  writeJson(FILE, value);
}

export function markSessionAlerted(): void {
  const current = session();
  if (!current || current.status !== "expired" || current.sessionAlertedAt) return;
  saveSession({ ...current, sessionAlertedAt: new Date().toISOString() });
}

export function clearSession(): void {
  writeJson(FILE, null);
}

export function requireSession(): CloudSession {
  const current = session();
  if (current?.status === "expired" || (current && !current.token)) throw new CloudSessionExpiredError();
  if (!current?.token) throw new Error("Not signed in. Run: myna cloud login");
  return current;
}

const auth = (current: CloudSession) => ({ authorization: `Bearer ${current.token}` });
const base = (server?: string): string => (server ?? process.env.MYNA_SERVER ?? DEFAULT_SERVER).replace(/\/+$/, "");
const b64url = (value: Buffer): string => value.toString("base64url");
const challengeFor = (verifier: string): string => createHash("sha256").update(verifier, "ascii").digest("base64url");

function installTokenSet(server: string, reply: { access_token: string; refresh_token: string; expires_in: number; email: string }): CloudSession {
  const saved: CloudSession = {
    server,
    email: reply.email,
    token: reply.access_token,
    refreshToken: reply.refresh_token,
    expiresAt: new Date(Date.now() + reply.expires_in * 1000).toISOString(),
    since: new Date().toISOString(),
    status: "active",
  };
  saveSession(saved);
  return saved;
}

async function tokenRequest(server: string, fields: Record<string, string>): Promise<{ access_token: string; refresh_token: string; expires_in: number; email: string }> {
  const response = await fetch(`${server}${TOKEN_ENDPOINT}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof data.access_token !== "string" || typeof data.refresh_token !== "string" ||
      typeof data.expires_in !== "number" || typeof data.email !== "string") {
    const detail = typeof data.error_description === "string" ? data.error_description : typeof data.error === "string" ? data.error : `HTTP ${response.status}`;
    throw new Error(`myna cloud sign-in failed: ${detail}`);
  }
  return data as { access_token: string; refresh_token: string; expires_in: number; email: string };
}

interface Loopback {
  redirectUri: string;
  result: Promise<{ code?: string; error?: string }>;
  close(): void;
}

async function listenForCode(expectedState: string, timeoutMs: number): Promise<Loopback> {
  let resolveResult!: (value: { code?: string; error?: string }) => void;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = new Promise<{ code?: string; error?: string }>((resolve) => { resolveResult = resolve; });
  let server: ReturnType<typeof createServer>;
  const settle = (value: { code?: string; error?: string }) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    try { server.close(); } catch { /* it may have failed before listen */ }
    resolveResult(value);
  };
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
    });
    const error = url.searchParams.get("error") ?? undefined;
    const code = url.searchParams.get("code") ?? undefined;
    if (url.searchParams.get("state") !== expectedState) {
      res.end("<!doctype html><title>myna</title><p>Sign-in failed. Return to the terminal and try again.</p>");
      settle({ error: "OAuth state mismatch. Start the login again." });
    } else if (error || !code) {
      res.end("<!doctype html><title>myna</title><p>Sign-in was cancelled. You can close this tab.</p>");
      settle({ error: error === "access_denied" ? "Sign-in was cancelled." : `OAuth callback failed: ${error ?? "no authorization code"}` });
    } else {
      res.end("<!doctype html><title>myna</title><p>Connected to myna. You can close this tab and return to the terminal.</p>");
      settle({ code });
    }
  });
  server.on("error", (error) => settle({ error: (error as Error).message }));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not open a local sign-in callback.");
  }
  timer = setTimeout(() => settle({ error: "Timed out waiting for browser sign-in. Start the login again." }), timeoutMs);
  timer.unref?.();
  return { redirectUri: `http://127.0.0.1:${address.port}/callback`, result, close: () => { clearTimeout(timer); server.close(); } };
}

async function browserLogin(options: {
  server: string;
  email?: string;
  timeoutMs?: number;
  openBrowser?: (url: string) => Promise<void>;
  output?: (line: string) => void;
}): Promise<CloudSession> {
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(24));
  const callback = await listenForCode(state, options.timeoutMs ?? 180_000);
  const authorize = new URL(`${options.server}/v1/oauth/authorize`);
  authorize.searchParams.set("client_id", CLIENT_ID);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("redirect_uri", callback.redirectUri);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("code_challenge", challengeFor(verifier));
  authorize.searchParams.set("state", state);
  if (options.email) authorize.searchParams.set("login_hint", options.email);
  const output = options.output ?? (() => {});
  output(`Open this page to sign in: ${authorize.toString()}`);
  try {
    await (options.openBrowser ?? defaultOpenBrowser)(authorize.toString());
    const received = await callback.result;
    if (!received.code) throw new Error(received.error ?? "Sign-in did not return an authorization code.");
    const reply = await tokenRequest(options.server, {
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: received.code,
      redirect_uri: callback.redirectUri,
      code_verifier: verifier,
    });
    return installTokenSet(options.server, reply);
  } finally {
    callback.close();
  }
}

async function deviceLogin(options: {
  server: string;
  openBrowser?: (url: string) => Promise<void>;
  output?: (line: string) => void;
}): Promise<CloudSession> {
  const response = await fetch(`${options.server}${DEVICE_ENDPOINT}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ client_id: CLIENT_ID }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof data.device_code !== "string" || typeof data.user_code !== "string" ||
      typeof data.verification_uri !== "string" || typeof data.expires_in !== "number") {
    throw new Error(`myna cloud device sign-in could not start: ${typeof data.error === "string" ? data.error : `HTTP ${response.status}`}`);
  }
  const output = options.output ?? (() => {});
  const verification = typeof data.verification_uri_complete === "string" ? data.verification_uri_complete : data.verification_uri;
  output(`Open ${verification}`);
  output(`Enter code: ${data.user_code}`);
  output("Waiting for approval…");
  if (options.openBrowser) await options.openBrowser(verification);

  let interval = typeof data.interval === "number" ? data.interval : 5;
  const deadline = Date.now() + data.expires_in * 1000;
  while (Date.now() < deadline) {
    await delay(interval * 1000);
    try {
      const reply = await tokenRequest(options.server, {
        grant_type: DEVICE_GRANT,
        client_id: CLIENT_ID,
        device_code: data.device_code,
      });
      return installTokenSet(options.server, reply);
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes("authorization_pending")) continue;
      if (message.includes("slow_down")) { interval += 5; continue; }
      if (message.includes("access_denied")) throw new Error("Device sign-in was cancelled.");
      if (message.includes("expired_token")) break;
      throw error;
    }
  }
  throw new Error("Device sign-in expired. Run `myna cloud login --device` again.");
}

/** Sign in through a first-party OAuth flow; no password is read by the CLI. */
export async function authorizeLogin(options: {
  email?: string;
  server?: string;
  device?: boolean;
  timeoutMs?: number;
  openBrowser?: (url: string) => Promise<void>;
  output?: (line: string) => void;
} = {}): Promise<CloudSession> {
  const server = base(options.server);
  if (options.device) return deviceLogin({ server, openBrowser: options.openBrowser, output: options.output });
  return browserLogin({ ...options, server });
}

export async function signup(email: string, password: string, server?: string): Promise<CloudSession> {
  const url = base(server);
  const result = await postJson<{ ok: boolean; email: string; token: string; error?: string }>(`${url}/v1/cloud/signup`, { email, password });
  if (!result.ok) throw new Error(result.error ?? "Sign-up failed.");
  const created: CloudSession = { server: url, email: result.email, token: result.token, since: new Date().toISOString(), status: "active" };
  saveSession(created);
  return created;
}

/** Legacy password grant retained for older integrations; the CLI uses authorizeLogin. */
export async function login(email: string, password: string, server?: string): Promise<CloudSession> {
  const url = base(server);
  const result = await postJson<{ ok: boolean; email: string; token: string; error?: string }>(`${url}/v1/cloud/login`, { email, password });
  if (!result.ok) throw new Error(result.error ?? "Sign-in failed.");
  const created: CloudSession = { server: url, email: result.email, token: result.token, since: new Date().toISOString(), status: "active" };
  saveSession(created);
  return created;
}

function markExpired(current: CloudSession): CloudSession {
  const expired: CloudSession = {
    server: current.server,
    email: current.email,
    token: "",
    since: current.since,
    status: "expired",
    expiredAt: new Date().toISOString(),
  };
  saveSession(expired);
  return expired;
}

async function withRefreshLock<T>(run: () => Promise<T>): Promise<T> {
  const lockPath = `${configPath(FILE)}.refresh-lock`;
  let fd: number | undefined;
  const deadline = Date.now() + 30_000;
  while (fd === undefined) {
    try {
      fd = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 30_000) unlinkSync(lockPath);
      } catch { /* the other process released it */ }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for another myna process to refresh cloud sign-in.");
      await delay(100);
    }
  }
  try {
    return await run();
  } finally {
    closeSync(fd);
    try { unlinkSync(lockPath); } catch { /* already removed */ }
  }
}

/** Refresh early, and serialize rotation across a daemon and foreground CLI. */
export async function refreshSession(options: { force?: boolean } = {}): Promise<CloudSessionHealth> {
  const initial = session();
  if (!initial) return { state: "signed-out" };
  if (initial.status === "expired" || !initial.token) return { state: "expired", email: initial.email, expiredAt: initial.expiredAt };
  if (!initial.refreshToken) {
    if (!options.force && initial.checkedAt && Date.parse(initial.checkedAt) > Date.now() - 60_000) return { state: "active", email: initial.email };
    return withRefreshLock(async () => {
      const current = session();
      if (!current) return { state: "signed-out" as const };
      if (current.status === "expired" || !current.token) return { state: "expired" as const, email: current.email, expiredAt: current.expiredAt };
      // Another process may have completed an OAuth rotation while this one
      // waited for the file lock. Its saved token set is now authoritative.
      if (current.refreshToken) return { state: "active" as const, email: current.email };
      if (!options.force && current.checkedAt && Date.parse(current.checkedAt) > Date.now() - 60_000) return { state: "active" as const, email: current.email };
      const response = await fetch(`${current.server}/v1/cloud/me`, { headers: auth(current), signal: AbortSignal.timeout(API_TIMEOUT_MS) });
      if (response.status === 401) {
        const marked = markExpired(current);
        return { state: "expired" as const, email: marked.email, expiredAt: marked.expiredAt };
      }
      if (!response.ok) throw new Error(`Could not check myna cloud sign-in: HTTP ${response.status}`);
      saveSession({ ...current, checkedAt: new Date().toISOString() });
      return { state: "active" as const, email: current.email };
    });
  }
  if (!options.force && initial.expiresAt && Date.parse(initial.expiresAt) > Date.now() + 60_000) return { state: "active", email: initial.email };

  return withRefreshLock(async () => {
    const current = session();
    if (!current) return { state: "signed-out" as const };
    if (current.status === "expired" || !current.token) return { state: "expired" as const, email: current.email, expiredAt: current.expiredAt };
    if (!current.refreshToken) return { state: "active" as const, email: current.email };
    if (!options.force && current.expiresAt && Date.parse(current.expiresAt) > Date.now() + 60_000) return { state: "active" as const, email: current.email };
    try {
      const reply = await tokenRequest(current.server, { grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: current.refreshToken });
      const updated = installTokenSet(current.server, reply);
      saveSession({ ...updated, since: current.since });
      return { state: "active" as const, email: updated.email };
    } catch (error) {
      if (!(error as Error).message.includes("invalid_grant")) throw error;
      const marked = markExpired(current);
      return { state: "expired" as const, email: marked.email, expiredAt: marked.expiredAt };
    }
  });
}

/** Fetch a cloud API route with the freshest bearer, retrying one 401 after refresh. */
export async function cloudFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const current = session();
  if (!current) return fetch(input, init);
  if (current.status === "expired" || !current.token) throw new CloudSessionExpiredError();
  const target = new URL(input);
  if (!target.href.startsWith(`${current.server}/`)) return fetch(input, init);

  let active = requireSession();
  if (active.refreshToken) {
    const health = await refreshSession();
    if (health.state === "expired") throw new CloudSessionExpiredError();
    active = requireSession();
  }
  const send = (token: string) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
  let response = await send(active.token);
  if (response.status !== 401) return response;
  if (!active.refreshToken) {
    markExpired(active);
    throw new CloudSessionExpiredError();
  }
  const refreshed = await refreshSession({ force: true });
  if (refreshed.state === "expired") throw new CloudSessionExpiredError();
  active = requireSession();
  response = await send(active.token);
  if (response.status === 401) {
    markExpired(active);
    throw new CloudSessionExpiredError();
  }
  return response;
}

export async function logout(): Promise<void> {
  await withRefreshLock(async () => {
    const current = session();
    const revokeToken = current?.refreshToken ?? current?.token;
    if (current && revokeToken) {
      await request(`${current.server}/v1/oauth/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: CLIENT_ID, token: revokeToken }).toString(),
      }).catch(() => {
        // A server that cannot be reached must not leave a token on this disk.
      });
    }
    clearSession();
  });
}

export interface RemoteStatus {
  email: string;
  backup: { meta: BundleFile["meta"] | null; bytes: number; updatedAt: string } | null;
}

export async function status(): Promise<RemoteStatus> {
  const current = requireSession();
  const result = await getJson<{ ok: boolean; email: string; backup: RemoteStatus["backup"]; error?: string }>(
    `${current.server}/v1/cloud/me`,
    { headers: auth(current), fetchImpl: cloudFetch },
  );
  if (!result.ok) throw new Error(result.error ?? "Could not read the account.");
  return { email: result.email, backup: result.backup };
}

/** Upload a sealed bundle. The passphrase is not sent, and never has been. */
export async function push(sealed: BundleFile): Promise<{ bytes: number; updatedAt: string }> {
  const current = requireSession();
  const result = await postJson<{ ok: boolean; bytes: number; updatedAt: string; error?: string }>(
    `${current.server}/v1/cloud/backup`,
    { blob: JSON.stringify(sealed), meta: sealed.meta },
    { method: "PUT", headers: auth(current), fetchImpl: cloudFetch },
  );
  if (!result.ok) throw new Error(result.error ?? "Upload failed.");
  return { bytes: result.bytes, updatedAt: result.updatedAt };
}

export async function pull(): Promise<BundleFile> {
  const current = requireSession();
  const result = await getJson<{ ok: boolean; blob: string; error?: string }>(
    `${current.server}/v1/cloud/backup`,
    { headers: auth(current), fetchImpl: cloudFetch },
  );
  if (!result.ok) throw new Error(result.error ?? "No backup stored yet.");
  return JSON.parse(result.blob) as BundleFile;
}

export async function forget(): Promise<boolean> {
  const current = requireSession();
  const result = await request(`${current.server}/v1/cloud/backup`, { method: "DELETE", headers: auth(current), fetchImpl: cloudFetch });
  return ((await result.json()) as { ok: boolean }).ok;
}
