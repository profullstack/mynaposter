/**
 * @profullstack/email-queue
 *
 * One Redis-backed, account-scoped BullMQ queue for Gmail/Resend senders
 * across processes. Definite throttle refusals get three attempts with
 * Fibonacci backoff; ambiguous SMTP disconnects are never automatically retried.
 *
 * Provider credentials stay in the worker process and are NEVER copied into
 * Redis. V2 callers encrypt the job content with an application-held key.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Queue, QueueEvents, Worker } from "bullmq";
import { Redis } from "ioredis";
import type { Job } from "bullmq";
import type { EmailAuditStore } from "./audit.js";
import {
  bulkComplianceFailure,
  classifyProviderFailure,
  EmailQueueError,
  isBulkKind,
  isHardRecipientFailure,
  normalizeRecipient,
  recipientDomain,
  type EmailGateCode,
  type EmailKind,
} from "./gates.js";
import { redactError } from "./redact.js";
import { getSuppression, suppress } from "./suppression.js";

export { PostgresEmailAuditStore, emailAuditSchema, type EmailAuditEvent, type EmailAuditRecord, type EmailAuditStore, type EmailSqlExecutor, type SuppressionEntry, type SuppressionRecord } from "./audit.js";
export { processResendWebhook, verifyResendWebhook, type ResendWebhookHeaders, type ResendWebhookResult } from "./webhooks.js";
export { createResendTransport, type ResendTransportOptions } from "./resend.js";
export { createSmtpTransport, smtpFailure, type SmtpTransportOptions, type SmtpTransporterLike } from "./smtp.js";
export {
  bulkComplianceFailure,
  classifyProviderFailure,
  containsPostalAddress,
  EmailQueueError,
  enhancedStatusOf,
  isBulkKind,
  isHardRecipientFailure,
  normalizeRecipient,
  recipientDomain,
  type EmailGateCode,
  type EmailKind,
} from "./gates.js";
export { redactError } from "./redact.js";
export {
  createUnsubscribeToken,
  getSuppression,
  handleUnsubscribe,
  listUnsubscribeHeaders,
  suppress,
  unsuppressRedis,
  verifyUnsubscribeToken,
  type SuppressionStores,
  type UnsubscribeRequest,
  type UnsubscribeResult,
} from "./suppression.js";

export type DeliveryState =
  | "CREATED" | "VALIDATED" | "QUEUED" | "DEFERRED" | "PROCESSING"
  | "PROVIDER_ACCEPTED" | "SENT" | "DELIVERED" | "DELIVERY_DELAYED"
  | "BOUNCED" | "REJECTED" | "COMPLAINED" | "SUPPRESSED"
  | "FAILED" | "UNKNOWN" | "CANCELLED";
export type EmailPriority = 0 | 1 | 2 | 3 | 4;
export interface QueuedMessage {
  from?: string;
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  headers?: Record<string, string>;
  /**
   * Stable per campaign+recipient. When neither this nor idempotencyKey is set,
   * queuedDelivery derives one from recipient+subject+text+html, so an identical
   * message to the same recipient returns the earlier receipt (30-day retention).
   */
  dedupeKey?: string;
  /** Stable per request; preferred name for new callers. */
  idempotencyKey?: string;
}
export interface DeliveryResult {
  ok: boolean;
  id?: string;
  /** `PROVIDER_ACCEPTED` means the API accepted the request, not recipient delivery. */
  state?: DeliveryState;
  providerMessageId?: string;
  rfcMessageId?: string;
  error?: string;
  retryable?: boolean;
  status?: number;
  /** Provider supplied minimum delay before another attempt, when available. */
  retryAfterMs?: number;
  /** Number of provider calls made for this delivery. */
  attempts?: number;
  /** Machine-readable gate code when the queue (not the provider) refused the message. */
  code?: EmailGateCode | string;
  /** RFC 3463 enhanced SMTP status (e.g. "5.7.1"), when known. */
  enhancedStatus?: string;
}
export interface DeliveryTransport {
  id: string;
  type: string;
  from?: string;
  /** SMTP host, when the transport knows it (used for Google detection). */
  host?: string;
  send(message: QueuedMessage, options?: { kind?: EmailKind; idempotencyKey?: string; skipThrottleRecovery?: boolean }): Promise<DeliveryResult>;
}
export interface EmailQueueOptions {
  redisUrl: string;
  /** For SMTP sending via smtp.gmail.com with a Workspace/custom-domain From. */
  smtpHost?: string;
  /** Override defaults DOWNWARD only, not upward, without code review. */
  maxPer24Hours?: number;
  minGapMs?: number;
  /** Stable, non-secret identifier for the configured provider credential. */
  providerId?: string;
  /** Stable application/tenant scopes; limits are shared by all workers using the same values. */
  applicationId?: string;
  tenantId?: string;
  maxProviderPer24Hours?: number;
  maxApplicationPer24Hours?: number;
  maxTenantPer24Hours?: number;
  /** Authorized From addresses. Defaults to the transport's configured From. */
  authorizedSenders?: string[];
  /** Additional operational blocklist; EMAIL_QUEUE_BLOCKED_SENDERS is also honored. */
  blockedSenders?: string[];
  /** 32-byte base64 or 64-character hex key; never stored in Redis. */
  encryptionKey?: string;
  /** Use with encryptionKey when message bodies must never enter Redis in plaintext. */
  requireEncryption?: boolean;
  /** PostgreSQL is the durable record store; Redis is only the work queue. */
  auditStore?: EmailAuditStore;
  /**
   * The sender's physical postal address. REQUIRED for bulk/marketing mail: the
   * text and HTML bodies must contain it (CAN-SPAM), or the message is refused.
   */
  postalAddress?: string;
  /** Optional per-recipient-domain daily cap for this sender identity (e.g. 50 to gmail.com). */
  maxRecipientDomainPer24Hours?: number;
}
export interface Limits {
  maxPer24Hours: number;
  minGapMs: number;
  google: boolean;
}
const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_THROTTLE_ATTEMPTS = 3;
interface EncryptedMessage {
  version: 1;
  iv: string;
  tag: string;
  data: string;
}
interface EmailJobData {
  message?: QueuedMessage;
  encryptedMessage?: EncryptedMessage;
  kind: EmailKind;
  applicationId?: string;
  tenantId?: string;
  /** Redis quota counters reserved at enqueue; refunded on a definite non-delivery. Hashes only. */
  quotaKeys?: string[];
}
const hash = (s: string): string => createHash("sha256").update(s).digest("hex");
export function addressOf(from: string): string {
  return normalizeRecipient(from);
}
export function isGoogleSender(sender: Pick<DeliveryTransport, "type" | "from"> & { host?: string }, smtpHost = ""): boolean {
  const host = smtpHost || sender.host || "";
  return (sender.type === "smtp" && /(^|\.)smtp\.gmail\.com$|(^|\.)gmail\.com$|(^|\.)googlemail\.com$/i.test(host)) ||
    /@(gmail|googlemail)\.com$/i.test(addressOf(sender.from ?? ""));
}
export function senderLimits(sender: Pick<DeliveryTransport, "type" | "from">, smtpHost = "", overrides: Partial<Limits> = {}): Limits {
  const google = isGoogleSender(sender, smtpHost);
  const daily = google ? 100 : 1000;
  const gap = google ? 10 * 60_000 : 1000;
  return {
    google,
    maxPer24Hours: Math.max(1, Math.min(daily, Math.floor(overrides.maxPer24Hours ?? daily))),
    minGapMs: Math.max(gap, Math.floor(overrides.minGapMs ?? gap)),
  };
}
export function queueIdentity(sender: Pick<DeliveryTransport, "type" | "from">, smtpHost = ""): string {
  const from = addressOf(sender.from ?? "");
  if (!from) throw new Error("Email queue: a verified sender/from address is required.");
  // Gmail's direct SMTP and third-party wrappers share a per-mailbox budget.
  const provider = isGoogleSender(sender, smtpHost) ? "gmail" : sender.type === "resend" ? "resend" : sender.type;
  return provider + "|" + from;
}
export function mailJobId(identity: string, message: QueuedMessage, kind: EmailKind): string {
  const to = Array.isArray(message.to) ? message.to : [message.to];
  if (to.length !== 1 || !to[0]?.trim()) throw new Error("Email queue: exactly one recipient per job.");
  const stableKey = message.idempotencyKey ?? message.dedupeKey;
  // No caller key: derive one deterministically from the content so a retried
  // call can never send twice. (Before 0.2.0 transactional sends got a random
  // UUID here and were never deduplicated.)
  const key = stableKey
    ? "dedupe|" + stableKey
    : isBulkKind(kind)
      ? "bulk|" + message.subject + "|" + message.text + "|" + (message.html ?? "")
      : "derived|" + hash(message.subject + "\u0000" + message.text + "\u0000" + (message.html ?? ""));
  return hash(identity + "|" + to[0].trim().toLowerCase() + "|" + key);
}
const firstRecipient = (message: QueuedMessage): string => (Array.isArray(message.to) ? message.to[0] : message.to) ?? "";
const quotaScript = `
local ttl = tonumber(ARGV[#KEYS + 1])
for i = 1, #KEYS do
  local n = redis.call('INCR', KEYS[i])
  if n == 1 then redis.call('PEXPIRE', KEYS[i], ttl) end
  if n > tonumber(ARGV[i]) then
    redis.call('DECR', KEYS[i])
    for j = 1, i - 1 do redis.call('DECR', KEYS[j]) end
    return i
  end
end
return 0`;
// Gives back one unit per reserved scope; never below zero, never recreates an expired window.
const refundScript = `
for i = 1, #KEYS do
  local n = tonumber(redis.call('GET', KEYS[i]) or '0')
  if n > 0 then redis.call('DECR', KEYS[i]) end
end
return 0`;

const THROTTLE_ERROR = /rate.?limit|too many (?:requests|messages|emails)|throttl|sending (?:mail )?limit|limit for sending mail|quota.{0,30}(?:exceed|reach)|temporarily blocked/i;

/** Only retry a provider's definite throttle refusal; never retry an ambiguous send. */
export function isThrottleFailure(
  result: DeliveryResult,
  sender: Pick<DeliveryTransport, "type" | "from">,
  smtpHost = "",
): boolean {
  if (result.ok || result.status === 0) return false;
  if (result.status === 429 || THROTTLE_ERROR.test(result.error ?? "")) return true;
  if (sender.type !== "smtp") return false;
  if (result.status === 421) return true;
  return isGoogleSender(sender, smtpHost) && [450, 451, 452].includes(result.status ?? 0);
}

/** Fibonacci delays start at 1x, 2x, 3x, 5x the provider's base send gap. */
export function fibonacciBackoffMs(failureNumber: number, baseMs = 1000): number {
  if (!Number.isInteger(failureNumber) || failureNumber < 1) throw new Error("failureNumber must be a positive integer.");
  let previous = 1;
  let current = 2;
  for (let index = 1; index < failureNumber; index++) {
    [previous, current] = [current, previous + current];
  }
  return Math.max(0, Math.floor(baseMs)) * previous;
}

/** Retry only definite throttles; uncertain transport failures remain one-shot. */
export async function sendWithThrottleRecovery(
  sender: DeliveryTransport,
  message: QueuedMessage,
  options: {
    kind: EmailKind;
    idempotencyKey?: string;
    smtpHost?: string;
    minGapMs?: number;
    sleep?: (milliseconds: number) => Promise<void>;
  },
): Promise<DeliveryResult> {
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const baseMs = Math.max(1000, options.minGapMs ?? 1000);
  for (let attempt = 1; attempt <= MAX_THROTTLE_ATTEMPTS; attempt++) {
    const result = await sender.send(message, {
      kind: options.kind,
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      skipThrottleRecovery: true,
    });
    if (!isThrottleFailure(result, sender, options.smtpHost)) {
      return attempt === 1 ? result : { ...result, attempts: attempt };
    }
    if (attempt === MAX_THROTTLE_ATTEMPTS) {
      return {
        ...result,
        retryable: false,
        attempts: attempt,
        error: `${result.error ?? "Provider throttled the send."} Stopped after ${MAX_THROTTLE_ATTEMPTS} consecutive throttling responses.`,
      };
    }
    const delay = fibonacciBackoffMs(attempt, baseMs);
    await sleep(Math.max(delay, result.retryAfterMs ?? 0));
  }
  throw new Error("Unreachable throttle recovery state.");
}

const queueName = (identity: string): string => "profullstack-email-" + hash(identity).slice(0, 32);
const circuitKey = (identity: string): string => "profullstack:email-circuit:" + hash(identity);
/** Account-wide breaker: a suspended/invalid credential stops every identity that uses it. */
const providerCircuitKey = (providerId: string): string => "profullstack:email-provider-circuit:" + hash(providerId);
const quotaKey = (scope: string, value: string): string => "profullstack:email-quota:v2:" + hash(scope + "|" + value);
const normAddress = (value: string): string => addressOf(value);

const MISSING_KEY = "EMAIL_QUEUE_ENCRYPTION_KEY is not set, but this email queue requires encryption (requireEncryption/queueEmail); refusing to store message content in Redis as plaintext. Generate 32 random bytes (openssl rand -base64 32), store it in the service's secret manager, and set EMAIL_QUEUE_ENCRYPTION_KEY on every producer AND worker.";

/**
 * Configuration problems that would make every send fail. Call at process
 * startup and log/alert on a non-empty result instead of discovering it on the
 * first recipient. Reads options first, then the environment.
 */
export function emailQueueConfigProblems(
  options: Partial<Pick<EmailQueueOptions, "redisUrl" | "encryptionKey" | "requireEncryption">> = {},
  env: Record<string, string | undefined> = process.env,
): string[] {
  const problems: string[] = [];
  if (!(options.redisUrl ?? env.EMAIL_QUEUE_REDIS_URL)?.trim()) problems.push("EMAIL_QUEUE_REDIS_URL is not set; queued email is disabled.");
  const key = options.encryptionKey ?? env.EMAIL_QUEUE_ENCRYPTION_KEY;
  if (!key) {
    if (options.requireEncryption ?? true) problems.push(MISSING_KEY);
  } else {
    const bytes = /^[a-f0-9]{64}$/i.test(key) ? Buffer.from(key, "hex") : Buffer.from(key, "base64");
    if (bytes.length !== 32) problems.push("EMAIL_QUEUE_ENCRYPTION_KEY must encode exactly 32 bytes (base64 or 64-character hex).");
  }
  return problems;
}

/** Throws one clear error listing every problem; use in a startup check. */
export function assertEmailQueueConfig(options: Parameters<typeof emailQueueConfigProblems>[0] = {}, env: Record<string, string | undefined> = process.env): void {
  const problems = emailQueueConfigProblems(options, env);
  if (problems.length) throw new EmailQueueError("CONFIG_INVALID", `Email queue misconfigured: ${problems.join(" ")}`);
}

function encryptionKey(options: EmailQueueOptions, required = false): Buffer | undefined {
  const configured = options.encryptionKey ?? process.env.EMAIL_QUEUE_ENCRYPTION_KEY;
  if (!configured) {
    if (required || options.requireEncryption) throw new EmailQueueError("CONFIG_INVALID", MISSING_KEY);
    return undefined;
  }
  const key = /^[a-f0-9]{64}$/i.test(configured) ? Buffer.from(configured, "hex") : Buffer.from(configured, "base64");
  if (key.length !== 32) throw new Error("EMAIL_QUEUE_ENCRYPTION_KEY must encode exactly 32 bytes (base64 or 64-character hex).");
  return key;
}

function encryptMessage(message: QueuedMessage, key: Buffer): EncryptedMessage {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(message), "utf8"), cipher.final()]);
  return { version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

function jobMessage(message: QueuedMessage, options: EmailQueueOptions, require = false): Pick<EmailJobData, "message" | "encryptedMessage"> {
  const key = encryptionKey(options, require);
  return key ? { encryptedMessage: encryptMessage(message, key) } : { message };
}

function readJobMessage(data: EmailJobData, options: EmailQueueOptions): QueuedMessage {
  if (data.message) return data.message; // Read queued jobs from pre-v2 releases without deleting them.
  if (!data.encryptedMessage) throw new Error("Email queue job has no message payload.");
  const key = encryptionKey(options, true);
  const encrypted = data.encryptedMessage;
  if (encrypted.version !== 1) throw new Error("Unsupported email queue payload version.");
  const decipher = createDecipheriv("aes-256-gcm", key!, Buffer.from(encrypted.iv, "base64"));
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(encrypted.data, "base64")), decipher.final()]).toString("utf8");
  return JSON.parse(plaintext) as QueuedMessage;
}

function blockedAddresses(options: EmailQueueOptions): Set<string> {
  const fromEnv = (process.env.EMAIL_QUEUE_BLOCKED_SENDERS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return new Set([...fromEnv, ...(options.blockedSenders ?? [])].map(normAddress));
}

function authorizedSender(sender: DeliveryTransport, message: QueuedMessage, options: EmailQueueOptions): boolean {
  const requested = message.from ? normAddress(message.from) : normAddress(sender.from ?? "");
  const allowed = options.authorizedSenders?.length
    ? options.authorizedSenders.map(normAddress)
    : sender.from ? [normAddress(sender.from)] : [];
  return Boolean(requested && allowed.includes(requested));
}

interface QuotaScope { name: string; key: string; limit: number }

function providerIdOf(sender: DeliveryTransport, options: EmailQueueOptions): string {
  return options.providerId ?? sender.id ?? sender.type;
}

function quotaScopes(identity: string, sender: DeliveryTransport, options: EmailQueueOptions, limits: Limits, recipient?: string): QuotaScope[] {
  const provider = providerIdOf(sender, options);
  const scopes: QuotaScope[] = [
    { name: "provider", key: quotaKey("provider", provider), limit: Math.max(1, Math.floor(options.maxProviderPer24Hours ?? limits.maxPer24Hours)) },
    { name: "mailbox", key: quotaKey("mailbox", identity), limit: limits.maxPer24Hours },
  ];
  if (options.applicationId) scopes.push({ name: "application", key: quotaKey("application", options.applicationId), limit: Math.max(1, Math.floor(options.maxApplicationPer24Hours ?? limits.maxPer24Hours)) });
  if (options.tenantId) scopes.push({ name: "tenant", key: quotaKey("tenant", options.tenantId), limit: Math.max(1, Math.floor(options.maxTenantPer24Hours ?? limits.maxPer24Hours)) });
  const domain = recipient ? recipientDomain(recipient) : "";
  if (options.maxRecipientDomainPer24Hours && domain) {
    scopes.push({ name: "recipient-domain", key: quotaKey("recipient-domain", identity + "|" + domain), limit: Math.max(1, Math.floor(options.maxRecipientDomainPer24Hours)) });
  }
  return scopes;
}

/** Reserves one unit in every scope atomically. Returns the exhausted scope's name, or undefined. */
async function reserveQuota(redis: Redis, scopes: QuotaScope[]): Promise<string | undefined> {
  const failed = await redis.eval(quotaScript, scopes.length, ...scopes.map((scope) => scope.key), ...scopes.map((scope) => scope.limit), DAY_MS);
  return failed === 0 ? undefined : scopes[Number(failed) - 1]?.name ?? "configured";
}

async function refundQuota(redis: Redis, keys: string[] | undefined): Promise<void> {
  if (!keys?.length) return;
  await redis.eval(refundScript, keys.length, ...keys);
}

/**
 * Why a sender must stop after this result, or undefined. Any provider
 * 401/403, account suspension, unverified domain, SMTP auth failure or SMTP
 * 5.7.x pauses the sender; persistent throttling pauses it too. A restriction
 * is an operator action, never a reason to route the message elsewhere.
 */
export function providerCircuitDecision(
  result: DeliveryResult,
  sender: Pick<DeliveryTransport, "type" | "from"> & { host?: string },
  smtpHost = "",
): { scope: "account" | "sender"; reason: string } | undefined {
  if (isGoogleSender(sender, smtpHost) && result.status === 403) return { scope: "sender", reason: "Google sending restriction reported; mailbox paused for administrator review." };
  const classified = classifyProviderFailure(result, sender.type);
  if (classified) return classified;
  if (isThrottleFailure(result, sender, smtpHost) && (result.attempts ?? 0) >= MAX_THROTTLE_ATTEMPTS) {
    if (isGoogleSender(sender, smtpHost)) return { scope: "sender", reason: "Google sending restriction persisted after three attempts; mailbox paused for administrator review." };
    return { scope: "sender", reason: "Provider throttling persisted after three attempts; queue paused for administrator review." };
  }
  return undefined;
}

/** A restriction/rate-limit is an operator action, never a reason to route elsewhere. */
export function providerCircuitReason(result: DeliveryResult, sender: Pick<DeliveryTransport, "type" | "from"> & { host?: string }, smtpHost = ""): string | undefined {
  return providerCircuitDecision(result, sender, smtpHost)?.reason;
}

/** The open breaker reason for this identity or its provider credential, if any. */
async function openCircuit(redis: Redis, identity: string, providerId: string): Promise<string | undefined> {
  const [own, account] = await redis.mget(circuitKey(identity), providerCircuitKey(providerId));
  return own ?? account ?? undefined;
}

type GateFailure = { code: EmailGateCode; error: string; state: DeliveryState; status: number };

/** Synchronous gates that need neither Redis nor the provider. */
function preflightFailure(sender: DeliveryTransport, message: QueuedMessage, kind: EmailKind, options: EmailQueueOptions): GateFailure | undefined {
  if (isBulkKind(kind) && isGoogleSender(sender, options.smtpHost)) {
    return { code: "BULK_GMAIL_FORBIDDEN", state: "REJECTED", status: 403, error: "Bulk email must use Resend or another bulk provider; Gmail is reserved for approved one-off correspondence." };
  }
  const from = message.from ? normAddress(message.from) : normAddress(sender.from ?? "");
  if (!authorizedSender(sender, message, options)) {
    return { code: "SENDER_UNAUTHORIZED", state: "REJECTED", status: 403, error: `Sender ${from || "(missing)"} is not authorized for this transport.` };
  }
  if (blockedAddresses(options).has(from)) {
    return { code: "SENDER_BLOCKED", state: "SUPPRESSED", status: 403, error: `Sending from ${from} is administratively blocked.` };
  }
  if (isBulkKind(kind)) {
    const failure = bulkComplianceFailure(message, options.postalAddress);
    if (failure) return { ...failure, state: "REJECTED", status: 422 };
  }
  return undefined;
}

const gateResult = (failure: GateFailure): DeliveryResult => ({ ok: false, retryable: false, state: failure.state, status: failure.status, code: failure.code, error: failure.error });

interface DeliveryContext {
  sender: DeliveryTransport;
  options: EmailQueueOptions;
  identity: string;
  providerId: string;
  limits: Limits;
  /** A non-blocking command connection. */
  redis: Redis;
  queue: Queue<EmailJobData, DeliveryResult>;
}

async function tripCircuit(ctx: DeliveryContext, decision: { scope: "account" | "sender"; reason: string }): Promise<void> {
  await ctx.redis.set(circuitKey(ctx.identity), decision.reason);
  if (decision.scope === "account") await ctx.redis.set(providerCircuitKey(ctx.providerId), decision.reason);
  void ctx.queue.pause().catch(() => undefined);
}

/**
 * The single worker-side send path used by queuedDelivery and startEmailWorker.
 * Re-checks the breaker, the recipient's suppression, and bulk compliance
 * immediately before calling the provider. Refunds the reserved quota whenever
 * the message definitely did not reach the provider (gate refusal or a
 * definite provider refusal), but never for an UNKNOWN outcome.
 */
async function processDeliveryJob(ctx: DeliveryContext, job: Job<EmailJobData, DeliveryResult>): Promise<DeliveryResult> {
  const id = String(job.id);
  const audit = ctx.options.auditStore;
  const finish = async (result: DeliveryResult, refund: boolean): Promise<DeliveryResult> => {
    if (refund) await refundQuota(ctx.redis, job.data.quotaKeys).catch(() => undefined);
    try {
      await audit?.transition(id, result.state ?? "FAILED", {
        ...(result.providerMessageId ? { providerMessageId: result.providerMessageId } : {}),
        ...(result.rfcMessageId ? { rfcMessageId: result.rfcMessageId } : {}),
        ...(result.error ? { error: result.error } : {}),
      });
    } catch (auditError) {
      await tripCircuit(ctx, { scope: "sender", reason: "PostgreSQL audit update failed after provider response; queue paused for reconciliation." });
      return { ...result, error: [result.error, `PostgreSQL audit update failed: ${redactError(auditError)}`].filter(Boolean).join("; ") };
    }
    return result;
  };

  const paused = await openCircuit(ctx.redis, ctx.identity, ctx.providerId);
  if (paused) {
    void ctx.queue.pause().catch(() => undefined);
    return finish({ ok: false, state: "SUPPRESSED", retryable: false, status: 403, code: "SENDER_PAUSED", error: paused }, true);
  }
  let decoded: QueuedMessage;
  try {
    decoded = readJobMessage(job.data, ctx.options);
  } catch (error) {
    return finish({ ok: false, state: "FAILED", retryable: false, code: "CONFIG_INVALID", error: redactError(error) }, true);
  }
  const recipient = firstRecipient(decoded);
  const suppressed = await getSuppression(recipient, { redis: ctx.redis, ...(audit ? { auditStore: audit } : {}) });
  if (suppressed) {
    return finish({ ok: false, state: "SUPPRESSED", retryable: false, status: 403, code: "RECIPIENT_SUPPRESSED", error: `Recipient is suppressed (${suppressed.reason} via ${suppressed.source}); not sent.` }, true);
  }
  if (isBulkKind(job.data.kind)) {
    // Enqueue already enforced the postal address; a worker without postalAddress still re-checks headers.
    const failure = bulkComplianceFailure(decoded, ctx.options.postalAddress, { headersOnly: !ctx.options.postalAddress });
    if (failure) return finish({ ok: false, state: "REJECTED", retryable: false, status: 422, code: failure.code, error: failure.error }, true);
  }
  const idempotencyKey = decoded.idempotencyKey ?? decoded.dedupeKey ?? `email-queue:${id}`;
  const { dedupeKey: _dedupeKey, idempotencyKey: _idempotencyKey, ...mail } = decoded;
  if (audit) {
    try {
      await audit.transition(id, "PROCESSING");
    } catch (auditError) {
      // Never send what cannot be audited. Nothing left this process: refund and pause.
      await refundQuota(ctx.redis, job.data.quotaKeys).catch(() => undefined);
      await tripCircuit(ctx, { scope: "sender", reason: "PostgreSQL audit update failed before send; queue paused for reconciliation." });
      return { ok: false, state: "FAILED", retryable: false, code: "CONFIG_INVALID", error: `PostgreSQL audit update failed before send: ${redactError(auditError)}` };
    }
  }
  try {
    const result = await sendWithThrottleRecovery(ctx.sender, mail, {
      kind: job.data.kind,
      idempotencyKey,
      smtpHost: ctx.options.smtpHost ?? ctx.sender.host,
      minGapMs: ctx.limits.minGapMs,
    });
    const state = deliveryState(result, ctx.sender, ctx.options.smtpHost);
    const decision = result.ok ? undefined : providerCircuitDecision({ ...result, state }, ctx.sender, ctx.options.smtpHost);
    if (decision) await tripCircuit(ctx, decision);
    if (isHardRecipientFailure(result, ctx.sender.type)) {
      await suppress(recipient, "hard_bounce", ctx.sender.type, { redis: ctx.redis, ...(audit ? { auditStore: audit } : {}), provider: ctx.providerId }).catch(() => undefined);
    }
    const normalized: DeliveryResult = {
      ...result,
      state,
      ...(result.id ? { providerMessageId: result.id } : {}),
      ...(result.error ? { error: redactError(result.error) } : {}),
    };
    // status 0 = uncertain: the provider may have accepted it, so the quota stays spent.
    return finish(normalized, !result.ok && result.status !== 0);
  } catch (error) {
    // A socket failure might mean the remote provider accepted the message.
    // Record an uncertain result. NEVER retry automatically.
    return finish({ ok: false, state: "UNKNOWN", retryable: false, status: 0, error: "Delivery uncertain; check provider before manual retry: " + redactError(error) }, false);
  }
}

function deliveryState(result: DeliveryResult, sender: DeliveryTransport, smtpHost = ""): DeliveryState {
  if (result.ok) return "PROVIDER_ACCEPTED";
  if (result.status === 0) return "UNKNOWN";
  if (result.status === 401 || result.status === 403 || result.status === 429 || result.retryable) return "REJECTED";
  if (classifyProviderFailure(result, sender.type)) return "REJECTED";
  if ((result.attempts ?? 0) >= MAX_THROTTLE_ATTEMPTS && isThrottleFailure(result, sender, smtpHost)) return "REJECTED";
  return "FAILED";
}

/** Adds ONE job and waits for its durable result, retrying only definite throttles.
 * Production daemons should keep a worker alive; this convenience API starts
 * a worker with the account's credential-bearing provider for CLI use.
 */
export async function queuedDelivery(
  sender: DeliveryTransport,
  message: QueuedMessage,
  kind: EmailKind,
  options: EmailQueueOptions,
): Promise<DeliveryResult> {
  if (!options.redisUrl) throw new EmailQueueError("CONFIG_INVALID", "EMAIL_QUEUE_REDIS_URL is required; refusing direct Gmail/Resend bulk sending.");
  encryptionKey(options, options.requireEncryption);
  const gate = preflightFailure(sender, message, kind, options);
  if (gate) return gateResult(gate);
  const identity = queueIdentity(sender, options.smtpHost);
  const providerId = providerIdOf(sender, options);
  const limits = senderLimits(sender, options.smtpHost, options);
  const name = queueName(identity);
  const jobId = mailJobId(identity, message, kind);
  const recipient = firstRecipient(message);
  const connect = () => connectRedis(options);
  const producerRedis = connect();
  const workerRedis = connect();
  const eventsRedis = connect();
  const queue = new Queue<EmailJobData, DeliveryResult>(name, { connection: producerRedis });
  const events = new QueueEvents(name, { connection: eventsRedis });
  const ctx: DeliveryContext = { sender, options, identity, providerId, limits, redis: producerRedis, queue };
  let worker: Worker<EmailJobData, DeliveryResult> | undefined;
  try {
    const circuit = await openCircuit(producerRedis, identity, providerId);
    if (circuit) return { ok: false, state: "SUPPRESSED", retryable: false, status: 403, code: "SENDER_PAUSED", error: circuit };
    const suppressed = await getSuppression(recipient, { redis: producerRedis, ...(options.auditStore ? { auditStore: options.auditStore } : {}) });
    if (suppressed) return { ok: false, state: "SUPPRESSED", retryable: false, status: 403, code: "RECIPIENT_SUPPRESSED", error: `Recipient is suppressed (${suppressed.reason} via ${suppressed.source}); not sent.` };
    await events.waitUntilReady();
    let job = await queue.getJob(jobId);
    if (!job) {
      const audit = options.auditStore;
      const prepared = { ...message, from: message.from ?? sender.from };
      await audit?.create({
        id: jobId,
        provider: providerId,
        applicationId: options.applicationId ?? "default",
        ...(options.tenantId ? { tenantId: options.tenantId } : {}),
        sender: prepared.from ?? "",
        recipient: normalizeRecipient(recipient),
        transport: sender.type,
        status: "CREATED",
        // The job id is already unique per identity+recipient+key (or content hash).
        idempotencyKey: jobId,
      });
      const scopes = quotaScopes(identity, sender, options, limits, recipient);
      const exhausted = await reserveQuota(producerRedis, scopes);
      if (exhausted) {
        const error = `Email budget exhausted in ${exhausted} scope; recipient remains unsent.`;
        await audit?.transition(jobId, "DEFERRED", { error });
        return { ok: false, state: "DEFERRED", status: 429, retryable: true, code: "QUOTA_EXHAUSTED", error };
      }
      try {
        // Important: jobId remains in Redis as a completed receipt for 30 days.
        job = await queue.add("deliver", { ...jobMessage(prepared, options), kind, quotaKeys: scopes.map((scope) => scope.key) }, {
          jobId, attempts: 1, removeOnComplete: { age: 30 * 86400, count: 100_000 }, removeOnFail: false,
        });
      } catch (error) {
        await refundQuota(producerRedis, scopes.map((scope) => scope.key)).catch(() => undefined);
        await audit?.transition(jobId, "FAILED", { error: redactError(error) }).catch(() => undefined);
        throw error;
      }
      if (audit) {
        try {
          await audit.transition(jobId, "QUEUED");
        } catch (error) {
          const reason = "PostgreSQL audit update failed after queue insertion; queue paused for reconciliation.";
          await tripCircuit(ctx, { scope: "sender", reason });
          throw new Error(`${reason} ${redactError(error)}`);
        }
      }
    }
    worker = new Worker<EmailJobData, DeliveryResult>(
      name,
      (activeJob) => processDeliveryJob(ctx, activeJob),
      { connection: workerRedis, concurrency: 1, limiter: { max: 1, duration: limits.minGapMs } },
    );
    const state = await job.getState();
    if (state === "completed") return job.returnvalue as DeliveryResult;
    if (state === "failed") return { ok: false, state: "FAILED", retryable: false, error: redactError(job.failedReason || "Queue job failed; inspect before retrying.") };
    const result = await job.waitUntilFinished(events) as DeliveryResult;
    if (await openCircuit(producerRedis, identity, providerId)) await queue.pause();
    return result;
  } finally {
    await worker?.close().catch(() => undefined);
    await events.close().catch(() => undefined);
    await queue.close().catch(() => undefined);
    await Promise.all([producerRedis.quit().catch(() => producerRedis.disconnect()), workerRedis.quit().catch(() => workerRedis.disconnect()), eventsRedis.quit().catch(() => eventsRedis.disconnect())]);
  }
}

/** Compatibility name for callers that distinguish submitting from enqueueing. */
export const sendEmail = queuedDelivery;

export interface EmailJobStatus {
  id: string;
  state: DeliveryState;
  queueState: string;
  result?: DeliveryResult;
  error?: string;
  timestamp?: number;
}

export interface QueueEmailOptions extends EmailQueueOptions {
  /** New asynchronous callers must supply a stable request key. */
  idempotencyKey: string;
  applicationId: string;
  tenantId: string;
  auditStore: EmailAuditStore;
  priority?: EmailPriority;
  delayMs?: number;
}

function connectRedis(options: EmailQueueOptions): Redis {
  const redis = new Redis(options.redisUrl, {
    maxRetriesPerRequest: null,
    connectTimeout: 5000,
    retryStrategy: (attempt: number) => attempt <= 3 ? Math.min(attempt * 200, 1000) : null,
  });
  // Failures surface as rejected commands; without a listener ioredis also logs every reconnect attempt.
  redis.on("error", () => undefined);
  return redis;
}

function getQueue(sender: DeliveryTransport, options: EmailQueueOptions) {
  const identity = queueIdentity(sender, options.smtpHost);
  const queue = new Queue<EmailJobData, DeliveryResult>(
    queueName(identity), { connection: connectRedis(options) },
  );
  return { identity, queue };
}

function stateFromQueue(queueState: string, result?: DeliveryResult): DeliveryState {
  if (result?.state) return result.state;
  if (queueState === "completed") return result?.ok ? "PROVIDER_ACCEPTED" : result?.status === 0 ? "UNKNOWN" : "FAILED";
  if (queueState === "failed") return "FAILED";
  if (queueState === "active") return "PROCESSING";
  if (queueState === "delayed") return "DEFERRED";
  if (queueState === "waiting" || queueState === "paused" || queueState === "prioritized") return "QUEUED";
  return "CREATED";
}

/** Asynchronously enqueue a message. Provider credentials are used only by a worker, never by this payload. */
export async function queueEmail(
  sender: DeliveryTransport,
  message: QueuedMessage,
  kind: EmailKind,
  options: QueueEmailOptions,
): Promise<EmailJobStatus> {
  if (!options.redisUrl) throw new EmailQueueError("CONFIG_INVALID", "EMAIL_QUEUE_REDIS_URL is required; refusing direct sending.");
  encryptionKey(options, true);
  const idempotencyKey = options.idempotencyKey?.trim() ?? "";
  if (!idempotencyKey) throw new EmailQueueError("IDEMPOTENCY_KEY_REQUIRED", "queueEmail requires a stable idempotencyKey.");
  const prepared = { ...message, idempotencyKey };
  const gate = preflightFailure(sender, prepared, kind, options);
  if (gate) throw new EmailQueueError(gate.code, gate.error);
  const identity = queueIdentity(sender, options.smtpHost);
  const provider = providerIdOf(sender, options);
  const redis = connectRedis(options);
  const { queue } = getQueue(sender, options);
  try {
    const circuit = await openCircuit(redis, identity, provider);
    if (circuit) throw new EmailQueueError("SENDER_PAUSED", `Email queue paused: ${circuit}`);
    const id = mailJobId(identity, prepared, kind);
    const recipient = firstRecipient(prepared);
    const suppressed = await getSuppression(recipient, { redis, auditStore: options.auditStore });
    if (suppressed) throw new EmailQueueError("RECIPIENT_SUPPRESSED", `Recipient is suppressed (${suppressed.reason} via ${suppressed.source}); not queued.`);
    let job = await queue.getJob(id);
    if (!job) {
      await options.auditStore.create({
        id,
        provider,
        applicationId: options.applicationId,
        ...(options.tenantId ? { tenantId: options.tenantId } : {}),
        sender: prepared.from ?? sender.from ?? "",
        recipient: normalizeRecipient(recipient),
        transport: sender.type,
        status: "CREATED",
        idempotencyKey,
      });
      const limits = senderLimits(sender, options.smtpHost, options);
      const scopes = quotaScopes(identity, sender, options, limits, recipient);
      const exhausted = await reserveQuota(redis, scopes);
      if (exhausted) {
        await options.auditStore.transition(id, "DEFERRED", { error: `Email budget exhausted in ${exhausted} scope.` });
        throw new EmailQueueError("QUOTA_EXHAUSTED", `Email budget exhausted in ${exhausted} scope.`);
      }
      const priority = options.priority === undefined ? undefined : 5 - options.priority;
      const encrypted = jobMessage({ ...prepared, from: prepared.from ?? sender.from }, options, true);
      try {
        job = await queue.add("deliver", {
          ...encrypted, kind,
          applicationId: options.applicationId,
          ...(options.tenantId ? { tenantId: options.tenantId } : {}),
          quotaKeys: scopes.map((scope) => scope.key),
        }, {
          jobId: id,
          attempts: 1,
          ...(options.delayMs && options.delayMs > 0 ? { delay: Math.floor(options.delayMs) } : {}),
          ...(priority !== undefined ? { priority } : {}),
          removeOnComplete: { age: 30 * 86400, count: 100_000 },
          removeOnFail: false,
        });
      } catch (error) {
        await refundQuota(redis, scopes.map((scope) => scope.key)).catch(() => undefined);
        await options.auditStore.transition(id, "FAILED", { error: redactError(error) });
        throw error;
      }
      try {
        await options.auditStore.transition(id, options.delayMs && options.delayMs > 0 ? "DEFERRED" : "QUEUED");
      } catch (error) {
        const reason = "PostgreSQL audit update failed after queue insertion; queue paused for reconciliation.";
        await redis.set(circuitKey(identity), reason);
        await queue.pause();
        throw new Error(`${reason} ${redactError(error)}`);
      }
    }
    const queueState = await job.getState();
    const result = queueState === "completed" ? job.returnvalue as DeliveryResult : undefined;
    return { id: job.id ?? id, state: stateFromQueue(queueState, result), queueState, ...(result ? { result } : {}), ...(job.failedReason ? { error: redactError(job.failedReason) } : {}), timestamp: job.timestamp };
  } finally {
    await queue.close().catch(() => undefined);
    await redis.quit().catch(() => redis.disconnect());
  }
}

/** Starts a credential-bearing worker. Keep its returned handle alive for the service lifetime. */
export async function startEmailWorker(sender: DeliveryTransport, options: EmailQueueOptions): Promise<{ close(): Promise<void>; worker: Worker }> {
  if (!options.redisUrl) throw new EmailQueueError("CONFIG_INVALID", "EMAIL_QUEUE_REDIS_URL is required.");
  const identity = queueIdentity(sender, options.smtpHost);
  const providerId = providerIdOf(sender, options);
  const limits = senderLimits(sender, options.smtpHost, options);
  const name = queueName(identity);
  const connection = connectRedis(options);
  const commands = connectRedis(options);
  const queue = new Queue<EmailJobData, DeliveryResult>(name, { connection: connectRedis(options) });
  const closeAll = async () => {
    await queue.close().catch(() => undefined);
    await Promise.all([connection.quit().catch(() => connection.disconnect()), commands.quit().catch(() => commands.disconnect())]);
  };
  // Workers created after a restriction remain idle while the global pause is set.
  try {
    if (await openCircuit(commands, identity, providerId)) await queue.pause();
  } catch (error) {
    await closeAll();
    throw error;
  }
  const ctx: DeliveryContext = { sender, options, identity, providerId, limits, redis: commands, queue };
  const worker = new Worker<EmailJobData, DeliveryResult>(
    name,
    (job) => processDeliveryJob(ctx, job),
    { connection, concurrency: 1, limiter: { max: 1, duration: limits.minGapMs } },
  );
  worker.on("completed", (_job, result) => {
    if (result && (result.code === "SENDER_PAUSED" || providerCircuitDecision(result, sender, options.smtpHost))) void queue.pause().catch(() => undefined);
  });
  return {
    worker,
    async close() {
      await worker.close().catch(() => undefined);
      await closeAll();
    },
  };
}

export async function getEmailStatus(sender: DeliveryTransport, id: string, options: EmailQueueOptions): Promise<EmailJobStatus | undefined> {
  const audited = await options.auditStore?.get(id);
  if (audited) {
    const state = String(audited.status) as DeliveryState;
    return {
      id,
      state,
      queueState: "audit",
      ...(typeof audited.error === "string" && audited.error ? { error: audited.error } : {}),
      ...(typeof audited.provider_message_id === "string" ? { result: { ok: state === "PROVIDER_ACCEPTED" || state === "DELIVERED", state, providerMessageId: audited.provider_message_id } } : {}),
      ...(audited.created_at instanceof Date ? { timestamp: audited.created_at.getTime() } : {}),
    };
  }
  const { queue } = getQueue(sender, options);
  try {
    const job = await queue.getJob(id);
    if (!job) return undefined;
    const queueState = await job.getState();
    const result = queueState === "completed" ? job.returnvalue as DeliveryResult : undefined;
    return { id: job.id ?? id, state: stateFromQueue(queueState, result), queueState, ...(result ? { result } : {}), ...(job.failedReason ? { error: job.failedReason } : {}), timestamp: job.timestamp };
  } finally { await queue.close().catch(() => undefined); }
}

export async function listEmailJobs(sender: DeliveryTransport, options: EmailQueueOptions, states: Array<"waiting" | "active" | "completed" | "failed" | "delayed" | "paused" | "prioritized"> = ["waiting", "active", "completed", "failed", "delayed", "paused", "prioritized"], start = 0, end = 99): Promise<EmailJobStatus[]> {
  const { queue } = getQueue(sender, options);
  try {
    const jobs = await queue.getJobs(states, start, end, true);
    return await Promise.all(jobs.map(async (job) => {
      const queueState = await job.getState();
      const result = queueState === "completed" ? job.returnvalue as DeliveryResult : undefined;
      return { id: job.id ?? "", state: stateFromQueue(queueState, result), queueState, ...(result ? { result } : {}), ...(job.failedReason ? { error: job.failedReason } : {}), timestamp: job.timestamp };
    }));
  } finally { await queue.close().catch(() => undefined); }
}

export async function cancelEmail(sender: DeliveryTransport, id: string, options: EmailQueueOptions): Promise<boolean> {
  const { queue } = getQueue(sender, options);
  try {
    const job = await queue.getJob(id);
    if (!job) return false;
    const state = await job.getState();
    if (!["waiting", "delayed", "paused", "prioritized"].includes(state)) return false;
    const cancelled = await job.remove().then(() => true).catch(() => false);
    if (cancelled) await options.auditStore?.transition(id, "CANCELLED");
    return cancelled;
  } finally { await queue.close().catch(() => undefined); }
}

export async function pauseEmailQueue(sender: DeliveryTransport, options: EmailQueueOptions, reason = "Manually paused by an administrator."): Promise<void> {
  const identity = queueIdentity(sender, options.smtpHost);
  const { queue } = getQueue(sender, options);
  const redis = connectRedis(options);
  try { await redis.set(circuitKey(identity), reason); await queue.pause(); }
  finally { await queue.close().catch(() => undefined); await redis.quit().catch(() => redis.disconnect()); }
}

/** Resume is an administrative action; callers must verify provider health and audit it. */
export async function resumeEmailQueue(sender: DeliveryTransport, options: EmailQueueOptions): Promise<void> {
  const identity = queueIdentity(sender, options.smtpHost);
  const { queue } = getQueue(sender, options);
  const redis = connectRedis(options);
  // Clears this identity's breaker AND the account-wide breaker for its provider credential.
  try { await redis.del(circuitKey(identity), providerCircuitKey(providerIdOf(sender, options))); await queue.resume(); }
  finally { await queue.close().catch(() => undefined); await redis.quit().catch(() => redis.disconnect()); }
}

export async function getProviderHealth(sender: DeliveryTransport, options: EmailQueueOptions): Promise<{ provider: string; sender: string; available: boolean; pausedReason?: string }> {
  const identity = queueIdentity(sender, options.smtpHost);
  const redis = connectRedis(options);
  try {
    const pausedReason = await openCircuit(redis, identity, providerIdOf(sender, options));
    return { provider: providerIdOf(sender, options), sender: addressOf(sender.from ?? ""), available: !pausedReason, ...(pausedReason ? { pausedReason } : {}) };
  } finally { await redis.quit().catch(() => redis.disconnect()); }
}

export async function getQuotaUsage(sender: DeliveryTransport, options: EmailQueueOptions, recipient?: string): Promise<Array<{ scope: string; limit: number; used: number; resetsInMs: number }>> {
  const identity = queueIdentity(sender, options.smtpHost);
  const limits = senderLimits(sender, options.smtpHost, options);
  const scopes = quotaScopes(identity, sender, options, limits, recipient);
  const redis = connectRedis(options);
  try {
    return await Promise.all(scopes.map(async (scope) => {
      const [value, ttl] = await Promise.all([redis.get(scope.key), redis.pttl(scope.key)]);
      return { scope: scope.name, limit: scope.limit, used: Number(value ?? 0), resetsInMs: Math.max(0, ttl) };
    }));
  } finally { await redis.quit().catch(() => redis.disconnect()); }
}

export interface ReconciliationAnswer {
  accepted: boolean;
  status?: DeliveryState;
  providerMessageId?: string;
  rfcMessageId?: string;
  error?: string;
}

/** Records the provider's lookup result. The lookup must use provider logs/API, never guess from an HTTP timeout. */
export async function reconcileDelivery(
  sender: DeliveryTransport,
  id: string,
  options: EmailQueueOptions & { auditStore: EmailAuditStore },
  lookup: (record: Record<string, unknown>) => Promise<ReconciliationAnswer>,
): Promise<EmailJobStatus> {
  const record = await options.auditStore.get(id);
  if (!record) throw new Error(`No PostgreSQL delivery record exists for ${id}.`);
  const answer = await lookup(record);
  const state = answer.accepted ? answer.status ?? "PROVIDER_ACCEPTED" : "FAILED";
  const error = answer.accepted ? answer.error : `Provider reconciliation confirmed no acceptance.${answer.error ? ` ${answer.error}` : ""}`;
  await options.auditStore.transition(id, state, {
    ...(answer.providerMessageId ? { providerMessageId: answer.providerMessageId } : {}),
    ...(answer.rfcMessageId ? { rfcMessageId: answer.rfcMessageId } : {}),
    ...(error ? { error } : {}),
  });
  return (await getEmailStatus(sender, id, options)) ?? { id, state, queueState: "audit", ...(error ? { error } : {}) };
}

export interface RetryEmailOptions extends QueueEmailOptions {
  actor: string;
  verifyProviderDidNotAccept(record: Record<string, unknown>): Promise<boolean>;
  auditReplay(entry: { actor: string; originalId: string; replayId: string; reason: string }): Promise<void>;
  reason: string;
}

/** Explicit, audited replay after a provider lookup confirms no acceptance. */
export async function retryEmail(sender: DeliveryTransport, id: string, options: RetryEmailOptions): Promise<EmailJobStatus> {
  if (!options.actor.trim() || !options.reason.trim() || !options.idempotencyKey.trim()) {
    throw new Error("Manual replay requires an actor, reason, and new idempotency key.");
  }
  const record = await options.auditStore.get(id);
  if (!record) throw new Error(`No PostgreSQL delivery record exists for ${id}.`);
  const status = String(record.status);
  if (status !== "UNKNOWN" && status !== "FAILED" && status !== "REJECTED") {
    throw new Error(`Cannot replay a message in ${status} state.`);
  }
  if (!(await options.verifyProviderDidNotAccept(record))) {
    throw new Error("Provider acceptance is not ruled out; reconcile this message before replaying it.");
  }
  const { queue } = getQueue(sender, options);
  let message: QueuedMessage;
  let kind: EmailKind;
  try {
    const job = await queue.getJob(id);
    if (!job) throw new Error(`Queue receipt ${id} is no longer available; refusing a blind replay.`);
    message = readJobMessage(job.data as EmailJobData, options);
    kind = (job.data as EmailJobData).kind;
  } finally { await queue.close().catch(() => undefined); }
  const replayMessage = { ...message, dedupeKey: undefined, idempotencyKey: options.idempotencyKey };
  const replayId = mailJobId(queueIdentity(sender, options.smtpHost), replayMessage, kind);
  await options.auditReplay({ actor: options.actor, originalId: id, replayId, reason: options.reason });
  return queueEmail(sender, replayMessage, kind, options);
}
