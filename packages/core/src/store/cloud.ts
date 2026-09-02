/**
 * The client half of cloud backup.
 *
 * Optional in the strongest sense: myna never contacts a server unless you run
 * a `cloud` command, and everything else works with no account at all.
 *
 * What goes up is a bundle already sealed with a passphrase that stays on this
 * machine. The server holds ciphertext it cannot read, which is the only
 * arrangement under which storing tokens for 26 social networks somewhere else
 * is a reasonable thing to do.
 */
import { readJson, writeJson } from "../util/json.ts";
import { getJson, postJson, request } from "../util/http.ts";
import type { BundleFile } from "./bundle.ts";

const FILE = "cloud.json";

export interface CloudSession {
  /** Base URL of the myna instance holding the backup. */
  server: string;
  email: string;
  token: string;
  since: string;
}

export const DEFAULT_SERVER = "https://mynaposter-api-production.up.railway.app";

export function session(): CloudSession | null {
  return readJson<CloudSession | null>(FILE, null);
}

export function saveSession(value: CloudSession): void {
  writeJson(FILE, value);
}

export function clearSession(): void {
  writeJson(FILE, null);
}

export function requireSession(): CloudSession {
  const current = session();
  if (!current?.token) throw new Error("Not signed in. Run: myna cloud login");
  return current;
}

const auth = (current: CloudSession) => ({ authorization: `Bearer ${current.token}` });

const base = (server?: string): string => (server ?? process.env.MYNA_SERVER ?? DEFAULT_SERVER).replace(/\/+$/, "");

export async function signup(email: string, password: string, server?: string): Promise<CloudSession> {
  const url = base(server);
  const result = await postJson<{ ok: boolean; email: string; token: string; error?: string }>(
    `${url}/v1/cloud/signup`,
    { email, password },
  );
  if (!result.ok) throw new Error(result.error ?? "Sign-up failed.");
  const created: CloudSession = { server: url, email: result.email, token: result.token, since: new Date().toISOString() };
  saveSession(created);
  return created;
}

export async function login(email: string, password: string, server?: string): Promise<CloudSession> {
  const url = base(server);
  const result = await postJson<{ ok: boolean; email: string; token: string; error?: string }>(
    `${url}/v1/cloud/login`,
    { email, password },
  );
  if (!result.ok) throw new Error(result.error ?? "Sign-in failed.");
  const created: CloudSession = { server: url, email: result.email, token: result.token, since: new Date().toISOString() };
  saveSession(created);
  return created;
}

export async function logout(): Promise<void> {
  const current = session();
  if (current?.token) {
    await request(`${current.server}/v1/cloud/logout`, { method: "POST", headers: auth(current) }).catch(() => {
      // A server that cannot be reached must not leave a token on this disk.
    });
  }
  clearSession();
}

export interface RemoteStatus {
  email: string;
  backup: { meta: BundleFile["meta"] | null; bytes: number; updatedAt: string } | null;
}

export async function status(): Promise<RemoteStatus> {
  const current = requireSession();
  const result = await getJson<{ ok: boolean; email: string; backup: RemoteStatus["backup"]; error?: string }>(
    `${current.server}/v1/cloud/me`,
    { headers: auth(current) },
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
    { method: "PUT", headers: auth(current) },
  );
  if (!result.ok) throw new Error(result.error ?? "Upload failed.");
  return { bytes: result.bytes, updatedAt: result.updatedAt };
}

export async function pull(): Promise<BundleFile> {
  const current = requireSession();
  const result = await getJson<{ ok: boolean; blob: string; error?: string }>(
    `${current.server}/v1/cloud/backup`,
    { headers: auth(current) },
  );
  if (!result.ok) throw new Error(result.error ?? "No backup stored yet.");
  return JSON.parse(result.blob) as BundleFile;
}

export async function forget(): Promise<boolean> {
  const current = requireSession();
  const result = await request(`${current.server}/v1/cloud/backup`, { method: "DELETE", headers: auth(current) });
  return ((await result.json()) as { ok: boolean }).ok;
}
