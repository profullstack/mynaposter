/**
 * Porkbun webhooks: POST /v1/callbacks/porkbun[/<route>].
 *
 * Porkbun delivers signed JSON for account events (domain.registered,
 * domain.renewed, domain.expiring, dns.record.*, cloudflare.connect.*).
 * Its webhook URLs may not carry credentials, so the operator bearer token
 * that guards every other write here cannot apply: the HMAC is the auth.
 *
 * The route segment is optional. It lets one myna take several Porkbun
 * endpoints (one per Porkbun account, say) at different URLs, each with its
 * own signing secret:
 *
 *   /v1/callbacks/porkbun          PORKBUN_WEBHOOK_SECRET
 *   /v1/callbacks/porkbun/<route>  PORKBUN_WEBHOOK_SECRET_<ROUTE>, else the default
 *
 * The secret is optional too. With one set, a delivery must carry a valid
 * X-Porkbun-Signature for it and a timestamp within five minutes, or it is
 * refused. With none set the event is still taken, and stored as unverified,
 * so an endpoint can be registered and tried before its secret is copied
 * into the vault. Set the secret before trusting what arrives.
 *
 * Signature, per Porkbun: "sha256=" + hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`),
 * computed over the exact body bytes, so it is checked before parsing.
 */
import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { db, hasDatabase } from "./db/index.ts";

/** How old a signed timestamp may be before it reads as a replay. */
export const MAX_SKEW_SECONDS = 300;

/** A route segment: short, URL-safe, and never a path traversal. */
export const ROUTE_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

export type Env = Record<string, string | undefined>;

/** The env var a route's secret lives in: "acme-co" -> PORKBUN_WEBHOOK_SECRET_ACME_CO. */
export const secretVar = (route: string): string => `PORKBUN_WEBHOOK_SECRET_${route.toUpperCase().replace(/-/g, "_")}`;

/** The signing secret for a route, or the default, or none. */
export function secretFor(route: string | undefined, env: Env = process.env): string | undefined {
  const own = route ? env[secretVar(route)] : undefined;
  return (own || env.PORKBUN_WEBHOOK_SECRET || undefined)?.trim() || undefined;
}

/** Constant time, and no early exit on a length difference. */
function same(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

export type Verdict = { ok: true } | { ok: false; reason: string };

export function verifySignature(
  secret: string,
  timestamp: string | undefined,
  rawBody: string,
  signature: string | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Verdict {
  if (!timestamp || !/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "missing or malformed X-Porkbun-Webhook-Timestamp" };
  if (!signature) return { ok: false, reason: "missing X-Porkbun-Signature" };
  if (Math.abs(nowSeconds - Number(timestamp)) > MAX_SKEW_SECONDS) return { ok: false, reason: "timestamp outside the five minute window" };
  const expected = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
  return same(expected, signature.trim()) ? { ok: true } : { ok: false, reason: "signature does not match" };
}

export interface PorkbunEvent {
  event: string;
  id: string;
  createdAt?: string;
  data?: Record<string, unknown>;
}

export function parseEvent(rawBody: string): PorkbunEvent | null {
  try {
    const body = JSON.parse(rawBody) as Partial<PorkbunEvent>;
    if (typeof body.event !== "string" || typeof body.id !== "string" || !body.event || !body.id) return null;
    if (body.event.length > 100 || body.id.length > 100) return null;
    return body as PorkbunEvent;
  } catch {
    return null;
  }
}

export interface Received {
  status: number;
  body: { ok: boolean; error?: string; event?: string; id?: string; verified?: boolean; duplicate?: boolean; stored?: boolean };
}

/**
 * Everything but the HTTP plumbing, so tests drive it with a fake store.
 * `store` returns false when the event id was seen before.
 */
export async function receive(
  input: { route?: string; rawBody: string; headers: Record<string, string | undefined> },
  options: { env?: Env; now?: number; store?: (row: StoredEvent) => Promise<boolean> } = {},
): Promise<Received> {
  const { route, rawBody, headers } = input;
  if (route !== undefined && !ROUTE_SHAPE.test(route)) return { status: 404, body: { ok: false, error: "unknown route" } };
  if (rawBody.length > 256 * 1024) return { status: 413, body: { ok: false, error: "payload too large" } };

  const secret = secretFor(route, options.env);
  let verified = false;
  if (secret) {
    const verdict = verifySignature(secret, headers["x-porkbun-webhook-timestamp"], rawBody, headers["x-porkbun-signature"], options.now);
    // 401, not 400: Porkbun retries failures, and a wrong secret is worth seeing in its delivery health.
    if (!verdict.ok) return { status: 401, body: { ok: false, error: verdict.reason } };
    verified = true;
  }

  const event = parseEvent(rawBody);
  if (!event) return { status: 400, body: { ok: false, error: "not a Porkbun event envelope" } };

  const row: StoredEvent = {
    id: event.id,
    route: route ?? null,
    event: event.event,
    createdAt: event.createdAt ?? null,
    verified,
    payload: event,
  };
  const store = options.store ?? (hasDatabase() ? storeEvent : undefined);
  if (!store) {
    console.log(`porkbun webhook ${event.event} ${event.id}${route ? ` route=${route}` : ""} verified=${verified} (no database, not stored)`);
    return { status: 200, body: { ok: true, event: event.event, id: event.id, verified, stored: false } };
  }
  const fresh = await store(row);
  return { status: 200, body: { ok: true, event: event.event, id: event.id, verified, stored: true, duplicate: !fresh } };
}

export interface StoredEvent {
  id: string;
  route: string | null;
  event: string;
  createdAt: string | null;
  verified: boolean;
  payload: PorkbunEvent;
}

/** Insert once per event id: Porkbun may deliver the same event twice. */
export async function storeEvent(row: StoredEvent): Promise<boolean> {
  const sql = db();
  const created = row.createdAt && !Number.isNaN(Date.parse(row.createdAt)) ? new Date(row.createdAt) : null;
  const inserted = await sql`
    insert into porkbun_events (id, route, event, created_at, verified, payload)
    values (${row.id}, ${row.route}, ${row.event}, ${created}, ${row.verified}, ${sql.json(row.payload as never)})
    on conflict (id) do nothing
    returning id`;
  return inserted.length > 0;
}

/** The newest events, for the operator. */
export async function listEvents(limit = 50, route?: string) {
  const sql = db();
  const n = Math.min(Math.max(Math.trunc(limit) || 50, 1), 500);
  const rows = route
    ? await sql`select id, route, event, created_at, received_at, verified, payload from porkbun_events where route = ${route} order by received_at desc limit ${n}`
    : await sql`select id, route, event, created_at, received_at, verified, payload from porkbun_events order by received_at desc limit ${n}`;
  return rows;
}
