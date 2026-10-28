/**
 * Customer webhooks: a signed CloudEvent to the account's own URL when
 * something happens, through @profullstack/webhooks (endpoints, keys, event
 * filters, a durable outbox with retries, the delivery log, SSRF-safe URLs).
 *
 * The owner is the myna cloud account. Two kinds of event reach it:
 *
 *   - Things that happen here, on the server: a hand-off card made or marked
 *     done, a newsletter reader unsubscribing or coming back.
 *   - Things that happen in the account's own myna, which is where posts go
 *     out and newsletters are sent (the server never holds a social token).
 *     That myna, signed in to myna cloud, reports them to POST /v1/events and
 *     they are delivered from here. Only the RELAYED types are accepted, and
 *     only to the account that sent them, so a myna can tell nobody but its
 *     own endpoints anything.
 *
 * Mounted at /v1/webhooks on the API, which the site serves as
 * https://mynaposter.com/api/v1/webhooks.
 */
import { Webhooks, postgresStore, webhooksApi, schemaSql, type PgLike, type WebhookStore } from "@profullstack/webhooks";
import { db, hasDatabase, type Sql } from "./db/index.ts";
import * as cloud from "./cloud.ts";
import { readCookie } from "./session.ts";
import { siteUrl } from "./handoff.ts";

/** Reported by the account's own myna (see RELAYED), delivered from here. */
export const RELAYED = ["post.published", "post.failed", "newsletter.sent"] as const;

/** Happen on this server. */
export const NATIVE = ["handoff.created", "handoff.completed", "newsletter.unsubscribed", "newsletter.resubscribed"] as const;

export const EVENT_TYPES: string[] = [...RELAYED, ...NATIVE];

export type EventType = (typeof RELAYED)[number] | (typeof NATIVE)[number];

/**
 * postgres.js (porsager) as the pg-style pool the store wants:
 * `query(text, params) -> { rows }`. The store already numbers its
 * placeholders `$1, $2...`, which is what `unsafe` takes.
 */
export function pgPool(sql: Sql): PgLike {
  return {
    async query(text: string, params: unknown[] = []) {
      const rows = await sql.unsafe(text, params as never[]);
      return { rows: [...rows] };
    },
  };
}

/** The DDL the store needs, as schema.sql carries it. A test keeps the two in step. */
export const WEBHOOK_DDL = schemaSql("pg");

let hub: Webhooks | null = null;

export interface HubOptions {
  store?: WebhookStore;
  fetchImpl?: typeof fetch;
  guard?: { allowHttp?: boolean; allowPrivate?: boolean };
  backoffMs?: number[];
}

/** Make the hub. The server calls `hooks()`; tests build their own with a memory store. */
export function createHub(options: HubOptions = {}): Webhooks {
  const store = options.store ?? postgresStore(pgPool(db()));
  return new Webhooks({
    store,
    source: siteUrl(),
    eventTypes: EVENT_TYPES,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.guard ? { guard: options.guard } : {}),
    ...(options.backoffMs ? { backoffMs: options.backoffMs } : {}),
    log: (message) => console.log(`webhooks: ${message}`),
  });
}

/** The server's hub, or null on an instance with no database. */
export function hooks(): Webhooks | null {
  if (!hasDatabase()) return null;
  // Local development only: lets an endpoint be http:// or on this machine.
  const local = process.env.MYNA_WEBHOOKS_ALLOW_PRIVATE === "1";
  hub ??= createHub(local ? { guard: { allowHttp: true, allowPrivate: true } } : {});
  return hub;
}

/** For tests: use this hub instead of the database one. */
export function useHub(next: Webhooks | null): void {
  hub = next;
}

/**
 * Queue an event for the owner's endpoints. Never throws: a webhook that
 * cannot be queued must not fail the request that caused it.
 */
export async function emit(owner: string | null | undefined, type: EventType, data: unknown, subject?: string): Promise<void> {
  const current = hooks();
  if (!current || !owner) return;
  try {
    await current.emit(owner, type, data, subject ? { subject } : undefined);
  } catch (error) {
    console.error(`webhooks: could not queue ${type}: ${(error as Error).message}`);
  }
}

const READS = new Set(["GET", "HEAD"]);

/**
 * Who is asking. The bearer token (the CLI, MCP, scripts) always works. The
 * dashboard's session cookie works on reads, as everywhere else, and on
 * writes only from the site itself: SameSite=Strict keeps other sites from
 * sending it, and the Origin check is the second lock, so the settings page
 * can add and remove endpoints without the cookie becoming a write key for
 * the rest of the API.
 */
export async function webhookOwner(
  request: Request,
  site = siteUrl(),
  whoami: (token: string) => Promise<{ id: string } | null> = cloud.whoami,
): Promise<string | null> {
  const header = request.headers.get("authorization") ?? "";
  let token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    const reading = READS.has(request.method.toUpperCase());
    const origin = request.headers.get("origin");
    const sameSite = origin !== null && origin === new URL(site).origin;
    if (reading || sameSite) token = readCookie(request.headers.get("cookie"));
  }
  if (!token) return null;
  return (await whoami(token))?.id ?? null;
}

/** The /v1/webhooks API: a fetch handler that answers null for any other path. */
export function webhooksHandler(
  owner: (request: Request) => Promise<string | null> = (request) => webhookOwner(request),
  hub_: () => Webhooks | null = hooks,
) {
  return async (request: Request): Promise<Response | null> => {
    const current = hub_();
    if (!current) {
      return new Response(JSON.stringify({ ok: false, error: "This instance has no DATABASE_URL, so webhooks are off." }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    return webhooksApi(current, { basePath: "/v1/webhooks", owner })(request);
  };
}

/** One event a myna reports. */
export interface RelayedEvent {
  type: string;
  data?: unknown;
  subject?: string;
}

export const MAX_RELAY_BATCH = 50;
/** A post is text and a few links; a body bigger than this is not one. */
export const MAX_RELAY_BYTES = 256 * 1024;

/**
 * Check what a myna sent to /v1/events and queue it. Unknown types are
 * refused rather than dropped, so a myna that is newer than the server finds
 * out instead of losing events quietly.
 */
export async function relay(owner: string, input: unknown, hub_ = hooks()): Promise<{ queued: number; events: number }> {
  if (!hub_) throw new Error("This instance has no DATABASE_URL, so webhooks are off.");
  const list = (input as { events?: unknown })?.events;
  if (!Array.isArray(list) || !list.length) throw new Error("Send {events: [{type, data, subject?}]}.");
  if (list.length > MAX_RELAY_BATCH) throw new Error(`At most ${MAX_RELAY_BATCH} events at a time.`);
  const allowed = new Set<string>(RELAYED);
  const events = list.map((entry, index) => {
    const event = entry as RelayedEvent;
    if (!event || typeof event.type !== "string" || !allowed.has(event.type)) {
      throw new Error(`Event ${index}: type must be one of ${RELAYED.join(", ")}.`);
    }
    const subject = typeof event.subject === "string" && event.subject ? event.subject.slice(0, 200) : undefined;
    return { type: event.type, data: event.data ?? {}, subject };
  });
  let queued = 0;
  for (const event of events) queued += (await hub_.emit(owner, event.type, event.data, event.subject ? { subject: event.subject } : undefined)).queued;
  return { queued, events: events.length };
}

/** Whose inbox this is, for an unsubscribe event. */
export async function inboxOwner(inbox: string): Promise<string | null> {
  if (!hasDatabase()) return null;
  const rows = (await db()`select user_id from newsletter_inboxes where id = ${inbox}`) as unknown as { user_id: string }[];
  return rows[0]?.user_id ?? null;
}

/** Whose card this is, for a hand-off event marked by whoever held the link. */
export async function handoffOwner(id: string): Promise<string | null> {
  if (!hasDatabase()) return null;
  const rows = (await db()`select user_id from handoffs where id = ${id}`) as unknown as { user_id: string }[];
  return rows[0]?.user_id ?? null;
}
