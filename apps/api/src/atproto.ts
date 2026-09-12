/**
 * The atproto directory, server side: probe, list, keep fresh.
 *
 * Anyone signed in to myna cloud can list a server; the probe decides what
 * is shown. The person who listed it, or the operator, can remove it. Every
 * server is probed again on a schedule so "online" means recently.
 */
import { probeAtproto, atprotoOrigin, type AtprotoKind } from "@profullstack/myna-core";
import { db } from "./db/index.ts";

export interface ServerRow {
  id: string;
  url: string;
  user_id: string | null;
  kind: AtprotoKind;
  online: boolean;
  did: string | null;
  user_domains: string[];
  invite_code_required: boolean | null;
  version: string | null;
  name: string | null;
  description: string | null;
  tags: string[];
  seen_at: Date | null;
  first_seen_at: Date;
  failures: number;
  last_error: string | null;
}

const shape = (row: ServerRow) => ({
  id: row.id,
  url: row.url,
  kind: row.kind,
  online: row.online,
  did: row.did,
  userDomains: row.user_domains,
  inviteCodeRequired: row.invite_code_required,
  version: row.version,
  name: row.name,
  description: row.description,
  tags: row.tags,
  seenAt: row.seen_at ? new Date(row.seen_at).toISOString() : null,
  firstSeenAt: new Date(row.first_seen_at).toISOString(),
  failures: row.failures,
  lastError: row.last_error,
});

export type AtprotoListing = ReturnType<typeof shape>;

const idFor = (url: string): string => new URL(url).host.toLowerCase();

export async function listServers(options: { kind?: string; online?: boolean; q?: string } = {}): Promise<AtprotoListing[]> {
  const rows = (await db()`select * from atproto_servers order by online desc, kind, url limit 500`) as unknown as ServerRow[];
  const needle = (options.q ?? "").toLowerCase();
  return rows
    .filter((row) => !options.kind || row.kind === options.kind)
    .filter((row) => !options.online || row.online)
    .filter((row) => !needle || `${row.url} ${row.did ?? ""} ${row.name ?? ""} ${row.description ?? ""} ${row.tags.join(" ")} ${row.user_domains.join(" ")}`.toLowerCase().includes(needle))
    .map(shape);
}

export async function getServer(id: string): Promise<ServerRow | null> {
  const rows = (await db()`select * from atproto_servers where id = ${id}`) as unknown as ServerRow[];
  return rows[0] ?? null;
}

export async function addServer(userId: string, input: { url?: string; description?: string; tags?: unknown }): Promise<AtprotoListing> {
  if (typeof input.url !== "string" || !input.url.trim()) throw new Error("Send {url}: the server's origin, e.g. https://pds.example.");
  const url = atprotoOrigin(input.url);
  const probe = await probeAtproto(url);
  if (!probe.online) throw new Error(`Nothing at ${url} answered as an atproto server: ${probe.error ?? "no health, no describeServer"}.`);
  const id = idFor(url);
  const description = typeof input.description === "string" ? input.description.trim().slice(0, 500) : null;
  const tags = Array.isArray(input.tags) ? (input.tags as unknown[]).filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase().trim()).filter(Boolean).slice(0, 20) : [];
  const now = new Date();
  await db()`
    insert into atproto_servers (id, url, user_id, kind, online, did, user_domains, invite_code_required, version, name, description, tags, seen_at, first_seen_at, failures, last_error)
    values (${id}, ${url}, ${userId}, ${probe.kind}, true, ${probe.did}, ${probe.userDomains}, ${probe.inviteCodeRequired}, ${probe.version}, ${probe.name}, ${description}, ${tags}, ${now}, ${now}, 0, null)
    on conflict (id) do update set
      kind = excluded.kind, online = true, did = excluded.did, user_domains = excluded.user_domains,
      invite_code_required = excluded.invite_code_required, version = excluded.version, name = excluded.name,
      description = coalesce(excluded.description, atproto_servers.description),
      tags = case when cardinality(excluded.tags) > 0 then excluded.tags else atproto_servers.tags end,
      seen_at = excluded.seen_at, failures = 0, last_error = null
  `;
  return shape((await getServer(id)) as ServerRow);
}

/** Probe one server again and write down what happened. */
export async function refreshServer(id: string): Promise<AtprotoListing | null> {
  const row = await getServer(id);
  if (!row) return null;
  const probe = await probeAtproto(row.url);
  if (probe.online) {
    await db()`
      update atproto_servers set kind = ${probe.kind}, online = true, did = ${probe.did}, user_domains = ${probe.userDomains},
        invite_code_required = ${probe.inviteCodeRequired}, version = ${probe.version}, name = ${probe.name ?? row.name},
        seen_at = now(), failures = 0, last_error = null where id = ${id}
    `;
  } else {
    await db()`update atproto_servers set online = false, failures = failures + 1, last_error = ${probe.error} where id = ${id}`;
  }
  return shape((await getServer(id)) as ServerRow);
}

export async function refreshAll(): Promise<{ probed: number; online: number }> {
  const rows = (await db()`select id from atproto_servers`) as unknown as { id: string }[];
  let online = 0;
  for (const row of rows) {
    const listing = await refreshServer(row.id);
    if (listing?.online) online++;
  }
  return { probed: rows.length, online };
}

/** The person who listed it can remove it; the operator (MYNA_API_TOKEN) can remove anything. */
export async function removeServer(id: string, userId: string | null, operator: boolean): Promise<boolean> {
  const row = await getServer(id);
  if (!row) return false;
  if (!operator && row.user_id !== userId) throw new Error("Only whoever listed this server can remove it.");
  await db()`delete from atproto_servers where id = ${id}`;
  return true;
}
