/**
 * Provider-agnostic suppression list and unsubscribe ingestion.
 *
 * A suppression is keyed by the normalized recipient address and blocks EVERY
 * provider, sender, and kind (transactional included). The provider that
 * reported it is metadata only. Two stores can hold it:
 *
 *  - PostgreSQL (`EmailAuditStore.suppress/getSuppression`), the durable record;
 *  - Redis (`profullstack:email-suppression:v1:<sha256(recipient)>`), so callers
 *    that run without PostgreSQL (MyNaPoster's queuedDelivery) still honor it.
 *
 * Both are checked at enqueue and again in the worker immediately before send.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Redis } from "ioredis";
import type { EmailAuditStore, SuppressionEntry, SuppressionRecord } from "./audit.js";
import { normalizeRecipient } from "./gates.js";

const suppressionKey = (recipient: string): string =>
  "profullstack:email-suppression:v1:" + createHash("sha256").update(normalizeRecipient(recipient)).digest("hex");

export interface SuppressionStores {
  /** Redis URL (EMAIL_QUEUE_REDIS_URL) or an open ioredis client. */
  redisUrl?: string;
  redis?: Redis;
  auditStore?: EmailAuditStore;
}

async function withRedis<T>(stores: SuppressionStores, fn: (redis: Redis) => Promise<T>): Promise<T | undefined> {
  if (stores.redis) return fn(stores.redis);
  if (!stores.redisUrl) return undefined;
  const redis = new Redis(stores.redisUrl, { maxRetriesPerRequest: 2, connectTimeout: 5000, lazyConnect: false });
  redis.on("error", () => undefined);
  try { return await fn(redis); }
  finally { await redis.quit().catch(() => redis.disconnect()); }
}

/** Looks the recipient up in every configured store. */
export async function getSuppression(recipient: string, stores: SuppressionStores): Promise<SuppressionRecord | undefined> {
  const normalized = normalizeRecipient(recipient);
  const fromRedis = await withRedis(stores, async (redis) => {
    const raw = await redis.get(suppressionKey(normalized));
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as { reason?: string; source?: string; provider?: string; at?: string };
      return { recipient: normalized, reason: parsed.reason ?? "suppressed", source: parsed.source ?? "redis", ...(parsed.provider ? { provider: parsed.provider } : {}) } satisfies SuppressionRecord;
    } catch {
      return { recipient: normalized, reason: "suppressed", source: "redis" } satisfies SuppressionRecord;
    }
  });
  if (fromRedis) return fromRedis;
  return stores.auditStore ? await stores.auditStore.getSuppression(normalized) : undefined;
}

/**
 * Suppresses a recipient for every provider and sender. Writes every configured
 * store; requires at least one. Idempotent: the first reason recorded is kept.
 */
export async function suppress(
  recipient: string,
  reason: string,
  source: string,
  stores: SuppressionStores & { provider?: string; sourceEventId?: string },
): Promise<SuppressionRecord> {
  const normalized = normalizeRecipient(recipient);
  if (!normalized.includes("@")) throw new Error("suppress() requires a recipient email address.");
  if (!reason.trim() || !source.trim()) throw new Error("suppress() requires a reason and a source.");
  if (!stores.redis && !stores.redisUrl && !stores.auditStore) throw new Error("suppress() needs a Redis URL or an audit store to write to.");
  const entry: SuppressionEntry = {
    recipient: normalized, reason, source,
    ...(stores.provider ? { provider: stores.provider } : {}),
    ...(stores.sourceEventId ? { sourceEventId: stores.sourceEventId } : {}),
  };
  await withRedis(stores, async (redis) => {
    await redis.set(suppressionKey(normalized), JSON.stringify({ reason, source, ...(stores.provider ? { provider: stores.provider } : {}), at: new Date().toISOString() }), "NX");
  });
  if (stores.auditStore) await stores.auditStore.suppress(entry);
  return { recipient: normalized, reason, source, ...(stores.provider ? { provider: stores.provider } : {}) };
}

/** Removes a Redis suppression (an administrative action; PostgreSQL rows are the audit and are not deleted). */
export async function unsuppressRedis(recipient: string, stores: Pick<SuppressionStores, "redis" | "redisUrl">): Promise<boolean> {
  return Boolean(await withRedis(stores, async (redis) => (await redis.del(suppressionKey(recipient))) > 0));
}

// ------------------------------------------------------------- unsubscribe tokens

const b64url = (value: Buffer | string): string => Buffer.from(value).toString("base64url");

/**
 * An opaque, signed unsubscribe token for a recipient. Put it in the
 * List-Unsubscribe https URL. The address is recoverable by the holder of the
 * token (base64url), so treat unsubscribe URLs as personal data in logs.
 */
export function createUnsubscribeToken(recipient: string, secret: string): string {
  if (!secret || secret.length < 16) throw new Error("Unsubscribe token secret must be at least 16 characters.");
  const payload = b64url(normalizeRecipient(recipient));
  const mac = createHmac("sha256", secret).update(`unsubscribe.v1.${payload}`).digest().subarray(0, 18);
  return `${payload}.${b64url(mac)}`;
}

export function verifyUnsubscribeToken(token: string, secret: string): string | undefined {
  const [payload, mac] = token.trim().split(".", 2);
  if (!payload || !mac || !secret) return undefined;
  // Compare the canonical encodings, so trailing junk that base64 decoding would ignore is rejected.
  const expected = Buffer.from(b64url(createHmac("sha256", secret).update(`unsubscribe.v1.${payload}`).digest().subarray(0, 18)));
  const supplied = Buffer.from(mac);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return undefined;
  const recipient = Buffer.from(payload, "base64url").toString("utf8");
  return recipient.includes("@") ? normalizeRecipient(recipient) : undefined;
}

/** The two values to put on a bulk message so it passes the RFC 8058 gate. */
export function listUnsubscribeHeaders(httpsUrl: string, mailto?: string): Record<string, string> {
  if (!/^https:\/\//i.test(httpsUrl)) throw new Error("List-Unsubscribe one-click URL must be https.");
  const parts = [`<${httpsUrl}>`, ...(mailto ? [`<mailto:${mailto}>`] : [])];
  return { "List-Unsubscribe": parts.join(", "), "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}

export type UnsubscribeRequest =
  | {
      /** RFC 8058: POST to the List-Unsubscribe URL with body `List-Unsubscribe=One-Click`. */
      type: "one-click";
      token: string;
      /** The raw form body. Must contain List-Unsubscribe=One-Click. */
      body: string;
    }
  | {
      /** An email received at the List-Unsubscribe mailto address (read via IMAP). */
      type: "mailto";
      /** The sender of the unsubscribe email: the address to suppress. */
      from: string;
      subject?: string;
    };

export interface UnsubscribeResult {
  ok: boolean;
  recipient?: string;
  code?: "UNSUBSCRIBED" | "INVALID_TOKEN" | "NOT_ONE_CLICK" | "INVALID_SENDER";
  error?: string;
}

/**
 * Ingests an unsubscribe and writes the shared, provider-agnostic suppression.
 * Answer the one-click POST with 200 regardless of `ok` to avoid address probing,
 * and never require a login, a confirmation page, or a GET for one-click.
 */
export async function handleUnsubscribe(
  request: UnsubscribeRequest,
  options: SuppressionStores & { tokenSecret?: string; resolveToken?: (token: string) => Promise<string | undefined>; provider?: string },
): Promise<UnsubscribeResult> {
  if (request.type === "one-click") {
    const params = new URLSearchParams(request.body ?? "");
    if (params.get("List-Unsubscribe") !== "One-Click") {
      return { ok: false, code: "NOT_ONE_CLICK", error: "Body must be List-Unsubscribe=One-Click (RFC 8058)." };
    }
    const recipient = options.resolveToken
      ? await options.resolveToken(request.token)
      : options.tokenSecret ? verifyUnsubscribeToken(request.token, options.tokenSecret) : undefined;
    if (!recipient) return { ok: false, code: "INVALID_TOKEN", error: "Unsubscribe token is invalid." };
    const stored = await suppress(recipient, "unsubscribe", "one-click", options);
    return { ok: true, code: "UNSUBSCRIBED", recipient: stored.recipient };
  }
  const recipient = normalizeRecipient(request.from ?? "");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient)) return { ok: false, code: "INVALID_SENDER", error: "Unsubscribe email has no usable From address." };
  // A forged From can only ever STOP mail to that address, which is the safe direction.
  const stored = await suppress(recipient, "unsubscribe", "mailto", options);
  return { ok: true, code: "UNSUBSCRIBED", recipient: stored.recipient };
}
