/**
 * The client half of the atproto directory at mynaposter.com/listing/atproto.
 *
 * Reading the list needs nothing. Adding or removing a server uses the myna
 * cloud account, so a listing has somebody behind it and can be taken down
 * by whoever put it up.
 */
import { getJson, postJson, request } from "../util/http.ts";
import { requireSession, session, DEFAULT_SERVER } from "./cloud.ts";
import type { AtprotoKind } from "../core/atproto.ts";

export interface AtprotoListing {
  id: string;
  url: string;
  kind: AtprotoKind;
  online: boolean;
  did: string | null;
  userDomains: string[];
  inviteCodeRequired: boolean | null;
  version: string | null;
  name: string | null;
  description: string | null;
  tags: string[];
  seenAt: string | null;
  firstSeenAt: string;
  failures: number;
  lastError: string | null;
}

type Reply<T> = ({ ok: true } & T) | { ok: false; error?: string };

const base = (): string => (session()?.server ?? process.env.MYNA_SERVER ?? DEFAULT_SERVER).replace(/\/+$/, "");
const auth = (): Record<string, string> => ({ authorization: `Bearer ${requireSession().token}` });

function unwrap<T>(reply: Reply<T>, fallback: string): T {
  if (!reply.ok) throw new Error(reply.error ?? fallback);
  return reply;
}

export async function listServers(options: { kind?: AtprotoKind; online?: boolean; q?: string } = {}): Promise<AtprotoListing[]> {
  const params = new URLSearchParams();
  if (options.kind) params.set("kind", options.kind);
  if (options.online) params.set("online", "1");
  if (options.q) params.set("q", options.q);
  const suffix = params.toString() ? `?${params}` : "";
  return unwrap(await getJson<Reply<{ servers: AtprotoListing[] }>>(`${base()}/v1/atproto${suffix}`), "Could not list servers.").servers;
}

export async function addServer(url: string, input: { description?: string; tags?: string[] } = {}): Promise<AtprotoListing> {
  return unwrap(await postJson<Reply<{ server: AtprotoListing }>>(`${base()}/v1/atproto`, { url, ...input }, { headers: auth() }), "The directory refused that server.").server;
}

export async function refreshServer(id: string): Promise<AtprotoListing> {
  return unwrap(await postJson<Reply<{ server: AtprotoListing }>>(`${base()}/v1/atproto/${encodeURIComponent(id)}/refresh`, {}, { headers: auth() }), "Could not refresh.").server;
}

export async function removeServer(id: string): Promise<boolean> {
  const reply = await request(`${base()}/v1/atproto/${encodeURIComponent(id)}`, { method: "DELETE", headers: auth() });
  return ((await reply.json()) as { ok: boolean }).ok;
}
