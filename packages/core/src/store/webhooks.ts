/**
 * Webhooks: your myna cloud account calls your URL, signed, when something
 * happens. The endpoints, keys and delivery log live on myna cloud
 * (mynaposter.com/api/v1/webhooks); this is the client the CLI and MCP use.
 *
 * Posts and newsletters go out from this machine, not from the server, so
 * those events start here: with the relay on, every post that went out or
 * failed, and every issue that finished sending, is reported to myna cloud
 * (POST /v1/events), which delivers it to this account's endpoints. The relay
 * is off until you add an endpoint from the CLI or turn it on, so a myna with
 * no webhooks never makes the call.
 */
import { readJson, writeJson } from "../util/json.ts";
import { getJson, postJson, request } from "../util/http.ts";
import { requireSession, session, DEFAULT_SERVER } from "./cloud.ts";
import type { PostedEvent } from "../plugins/types.ts";

export interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  description: string;
  enabled: boolean;
  failures: number;
  disabled_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface WebhookDelivery {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  status: string;
  attempts: number;
  next_at: string | null;
  last_status: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  payload?: unknown;
}

/** What myna emits. The server's list (GET /v1/webhooks) is the authority; this is for help text. */
export const WEBHOOK_EVENTS = [
  "post.published",
  "post.failed",
  "newsletter.sent",
  "handoff.created",
  "handoff.completed",
  "newsletter.unsubscribed",
  "newsletter.resubscribed",
] as const;

const FILE = "webhooks.json";

interface RelayFile {
  relay: boolean;
}

/** Is this machine reporting its posts and sends to myna cloud's webhooks? */
export const relayOn = (): boolean => readJson<RelayFile>(FILE, { relay: false }).relay === true && Boolean(session()?.token);

export function setRelay(on: boolean): void {
  writeJson(FILE, { relay: on } satisfies RelayFile);
}

const base = (): string => (session()?.server ?? process.env.MYNA_SERVER ?? DEFAULT_SERVER).replace(/\/+$/, "");
const auth = (): Record<string, string> => ({ authorization: `Bearer ${requireSession().token}` });
const url = (path = ""): string => `${base()}/v1/webhooks${path}`;
const enc = encodeURIComponent;

export async function listWebhooks(): Promise<{ endpoints: WebhookEndpoint[]; event_types: string[] }> {
  return getJson(url(), { headers: auth() });
}

export async function addWebhook(input: { url: string; events?: string[]; description?: string }): Promise<{ endpoint: WebhookEndpoint; secret: string }> {
  return postJson(url(), input, { headers: auth() });
}

export async function getWebhook(id: string): Promise<WebhookEndpoint> {
  return getJson(url(`/${enc(id)}`), { headers: auth() });
}

export async function updateWebhook(id: string, patch: { url?: string; events?: string[]; description?: string; enabled?: boolean }): Promise<WebhookEndpoint> {
  return postJson(url(`/${enc(id)}`), patch, { method: "PATCH", headers: auth() });
}

export async function removeWebhook(id: string): Promise<{ deleted: true }> {
  return (await request(url(`/${enc(id)}`), { method: "DELETE", headers: auth() })).json() as Promise<{ deleted: true }>;
}

export async function webhookSecret(id: string): Promise<{ secret: string }> {
  return getJson(url(`/${enc(id)}/secret`), { headers: auth() });
}

export async function rotateWebhook(id: string): Promise<{ secret: string }> {
  return postJson(url(`/${enc(id)}/rotate`), {}, { headers: auth() });
}

export async function testWebhook(id: string): Promise<{ ok: boolean; status: number | null; error: string | null; delivery_id: string }> {
  return postJson(url(`/${enc(id)}/test`), {}, { headers: auth() });
}

export async function webhookDeliveries(id?: string, limit = 20): Promise<WebhookDelivery[]> {
  const path = id ? `/${enc(id)}/deliveries` : "/deliveries";
  return (await getJson<{ deliveries: WebhookDelivery[] }>(`${url(path)}?limit=${limit}`, { headers: auth() })).deliveries;
}

export async function retryDelivery(deliveryId: string): Promise<WebhookDelivery> {
  return postJson(url(`/deliveries/${enc(deliveryId)}/retry`), {}, { headers: auth() });
}

// ---------------------------------------------------------------- the relay

export interface RelayEvent {
  type: "post.published" | "post.failed" | "newsletter.sent";
  data: Record<string, unknown>;
  subject?: string;
}

/** A post's text in an event: whole, up to a size no receiver should choke on. */
const TEXT_LIMIT = 10_000;

/** One event per target: published where it worked, failed where it did not. */
export function postEvents(event: PostedEvent): RelayEvent[] {
  return event.targets.map((target) => ({
    type: target.ok ? "post.published" : "post.failed",
    subject: `account:${target.account.id}`,
    data: {
      account: target.account.id,
      network: target.account.network,
      handle: target.account.handle,
      ...(target.url ? { url: target.url } : {}),
      ...(target.id ? { post_id: target.id } : {}),
      ...(event.title ? { title: event.title } : {}),
      text: event.text.slice(0, TEXT_LIMIT),
      ...(target.ok ? {} : { error: target.error ?? "unknown error" }),
    },
  }));
}

/**
 * Report events to myna cloud. Quiet and quick by design: it runs after a
 * post has already gone out, so it never throws and gives up after a few
 * seconds. Returns how many deliveries were queued, or null when it did not run.
 */
export async function relayEvents(events: RelayEvent[], options: { timeoutMs?: number } = {}): Promise<number | null> {
  if (!events.length || !relayOn()) return null;
  let queued = 0;
  try {
    // The server takes 50 at a time.
    for (let at = 0; at < events.length; at += 50) {
      const batch = events.slice(at, at + 50);
      const reply = await postJson<{ ok: boolean; queued?: number }>(`${base()}/v1/events`, { events: batch }, { headers: auth(), timeoutMs: options.timeoutMs ?? 5_000 });
      if (!reply.ok) return null;
      queued += reply.queued ?? 0;
    }
    return queued;
  } catch {
    return null;
  }
}
