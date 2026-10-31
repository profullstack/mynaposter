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
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { Queue, QueueEvents, Worker } from "bullmq";
import { Redis } from "ioredis";
import type { EmailAuditStore } from "./audit.js";

export { PostgresEmailAuditStore, emailAuditSchema, type EmailAuditEvent, type EmailAuditRecord, type EmailAuditStore, type EmailSqlExecutor } from "./audit.js";
export { processResendWebhook, verifyResendWebhook, type ResendWebhookHeaders, type ResendWebhookResult } from "./webhooks.js";
export { createResendTransport, type ResendTransportOptions } from "./resend.js";

export type EmailKind = "transactional" | "bulk";
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
  /** Stable per campaign+recipient. Leave blank for a fresh transactional send. */
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
}
export interface DeliveryTransport {
  id: string;
  type: string;
  from?: string;
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
}
const hash = (s: string): string => createHash("sha256").update(s).digest("hex");
export function addressOf(from: string): string {
  return (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();
}
export function isGoogleSender(sender: Pick<DeliveryTransport, "type" | "from">, smtpHost = ""): boolean {
  return (sender.type === "smtp" && /(^|\.)smtp\.gmail\.com$|(^|\.)gmail\.com$|(^|\.)googlemail\.com$/i.test(smtpHost)) ||
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
  const key = stableKey
    ? "dedupe|" + stableKey
    : kind === "bulk"
      ? "bulk|" + message.subject + "|" + message.text + "|" + (message.html ?? "")
      : "new|" + randomUUID();
  return hash(identity + "|" + to[0].trim().toLowerCase() + "|" + key);
}
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
const quotaKey = (scope: string, value: string): string => "profullstack:email-quota:v2:" + hash(scope + "|" + value);
const normAddress = (value: string): string => addressOf(value);

function encryptionKey(options: EmailQueueOptions, required = false): Buffer | undefined {
  const configured = options.encryptionKey ?? process.env.EMAIL_QUEUE_ENCRYPTION_KEY;
  if (!configured) {
    if (required || options.requireEncryption) throw new Error("EMAIL_QUEUE_ENCRYPTION_KEY is required; refusing to store message content in Redis as plaintext.");
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

function quotaScopes(identity: string, sender: DeliveryTransport, options: EmailQueueOptions, limits: Limits) {
  const provider = options.providerId ?? sender.id ?? sender.type;
  const scopes: { key: string; limit: number }[] = [
    { key: quotaKey("provider", provider), limit: Math.max(1, Math.floor(options.maxProviderPer24Hours ?? limits.maxPer24Hours)) },
    { key: quotaKey("mailbox", identity), limit: limits.maxPer24Hours },
  ];
  if (options.applicationId) scopes.push({ key: quotaKey("application", options.applicationId), limit: Math.max(1, Math.floor(options.maxApplicationPer24Hours ?? limits.maxPer24Hours)) });
  if (options.tenantId) scopes.push({ key: quotaKey("tenant", options.tenantId), limit: Math.max(1, Math.floor(options.maxTenantPer24Hours ?? limits.maxPer24Hours)) });
  return scopes;
}

/** A restriction/rate-limit is an operator action, never a reason to route elsewhere. */
export function providerCircuitReason(result: DeliveryResult, sender: Pick<DeliveryTransport, "type" | "from">, smtpHost = ""): string | undefined {
  if (isGoogleSender(sender, smtpHost) && result.status === 403) return "Google sending restriction reported; mailbox paused for administrator review.";
  if (isThrottleFailure(result, sender, smtpHost) && (result.attempts ?? 0) >= MAX_THROTTLE_ATTEMPTS) {
    if (isGoogleSender(sender, smtpHost)) return "Google sending restriction persisted after three attempts; mailbox paused for administrator review.";
    return "Provider throttling persisted after three attempts; queue paused for administrator review.";
  }
  return undefined;
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
  if (!options.redisUrl) throw new Error("EMAIL_QUEUE_REDIS_URL is required; refusing direct Gmail/Resend bulk sending.");
  encryptionKey(options, options.requireEncryption);
  if (kind === "bulk" && isGoogleSender(sender, options.smtpHost)) {
    return { ok: false, state: "REJECTED", retryable: false, status: 403, error: "Bulk email must use Resend or another bulk provider; Gmail is reserved for approved one-off correspondence." };
  }
  const from = message.from ? normAddress(message.from) : normAddress(sender.from ?? "");
  if (!authorizedSender(sender, message, options)) {
    return { ok: false, state: "REJECTED", retryable: false, status: 403, error: `Sender ${from || "(missing)"} is not authorized for this transport.` };
  }
  if (blockedAddresses(options).has(from)) {
    return { ok: false, state: "SUPPRESSED", retryable: false, status: 403, error: `Sending from ${from} is administratively blocked.` };
  }
  const identity = queueIdentity(sender, options.smtpHost);
  const limits = senderLimits(sender, options.smtpHost, options);
  const name = queueName(identity);
  const jobId = mailJobId(identity, message, kind);
  const connect = () => new Redis(options.redisUrl, {
    maxRetriesPerRequest: null, connectTimeout: 5000, retryStrategy: (attempt: number) => attempt <= 3 ? Math.min(attempt * 200, 1000) : null,
  });
  const producerRedis = connect();
  const workerRedis = connect();
  const eventsRedis = connect();
  const queue = new Queue<EmailJobData, DeliveryResult>(name, { connection: producerRedis });
  const events = new QueueEvents(name, { connection: eventsRedis });
  let worker: Worker<EmailJobData, DeliveryResult> | undefined;
  try {
    const circuit = await producerRedis.get(circuitKey(identity));
    if (circuit) return { ok: false, state: "SUPPRESSED", retryable: false, status: 403, error: circuit };
    await events.waitUntilReady();
    const previous = await queue.getJob(jobId);
    let job = previous;
    if (!job) {
      const scopes = quotaScopes(identity, sender, options, limits);
      const allowed = await producerRedis.eval(quotaScript, scopes.length, ...scopes.map((scope) => scope.key), ...scopes.map((scope) => scope.limit), DAY_MS);
      if (allowed !== 0) return { ok: false, state: "DEFERRED", status: 429, retryable: true, error: `Email budget exhausted in ${scopes[Number(allowed) - 1]?.key.split(":")[3] ?? "configured"} scope; recipient remains unsent.` };
      // Important: jobId remains in Redis as a completed receipt for 30 days.
      const prepared = { ...message, from: message.from ?? sender.from };
      job = await queue.add("deliver", { ...jobMessage(prepared, options), kind }, {
        jobId, attempts: 1, removeOnComplete: { age: 30 * 86400, count: 100_000 }, removeOnFail: false,
      });
    }
    worker = new Worker<EmailJobData, DeliveryResult>(
      name,
      async (activeJob) => {
        const decoded = readJobMessage(activeJob.data, options);
        const idempotencyKey = decoded.idempotencyKey ?? decoded.dedupeKey;
        const { dedupeKey: _dedupeKey, idempotencyKey: _idempotencyKey, ...mail } = decoded;
        try {
          const result = await sendWithThrottleRecovery(sender, mail, {
            kind: activeJob.data.kind,
            idempotencyKey,
            smtpHost: options.smtpHost,
            minGapMs: limits.minGapMs,
          });
          const state: DeliveryState = result.ok ? "PROVIDER_ACCEPTED" : result.status === 0 ? "UNKNOWN" : result.status === 403 || result.status === 429 || result.retryable || ((result.attempts ?? 0) >= MAX_THROTTLE_ATTEMPTS && isThrottleFailure(result, sender, options.smtpHost)) ? "REJECTED" : "FAILED";
          const normalized = { ...result, state, ...(result.id ? { providerMessageId: result.id } : {}) };
          const reason = providerCircuitReason(normalized, sender, options.smtpHost);
          if (reason) {
            await producerRedis.set(circuitKey(identity), reason);
            void queue.pause().catch(() => undefined);
          }
          return normalized;
        } catch (error) {
          // A socket failure might mean the remote provider accepted the message.
          // Record an uncertain result. NEVER retry automatically.
          return { ok: false, state: "UNKNOWN", retryable: false, status: 0, error: "Delivery uncertain; check provider before manual retry: " + String(error) };
        }
      },
      { connection: workerRedis, concurrency: 1, limiter: { max: 1, duration: limits.minGapMs } },
    );
    const state = await job.getState();
    if (state === "completed") return job.returnvalue as DeliveryResult;
    if (state === "failed") return { ok: false, state: "FAILED", retryable: false, error: job.failedReason || "Queue job failed; inspect before retrying." };
    const result = await job.waitUntilFinished(events) as DeliveryResult;
    if (await producerRedis.get(circuitKey(identity))) await queue.pause();
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
  return new Redis(options.redisUrl, {
    maxRetriesPerRequest: null,
    connectTimeout: 5000,
    retryStrategy: (attempt: number) => attempt <= 3 ? Math.min(attempt * 200, 1000) : null,
  });
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
  if (!options.redisUrl) throw new Error("EMAIL_QUEUE_REDIS_URL is required; refusing direct sending.");
  encryptionKey(options, true);
  const idempotencyKey = options.idempotencyKey.trim();
  if (!idempotencyKey) throw new Error("queueEmail requires a stable idempotencyKey.");
  const prepared = { ...message, idempotencyKey };
  if (kind === "bulk" && isGoogleSender(sender, options.smtpHost)) throw new Error("Bulk email must use an approved bulk provider; Gmail is reserved for approved one-off correspondence.");
  const from = prepared.from ? normAddress(prepared.from) : normAddress(sender.from ?? "");
  if (!authorizedSender(sender, prepared, options)) throw new Error(`Sender ${from || "(missing)"} is not authorized for this transport.`);
  if (blockedAddresses(options).has(from)) throw new Error(`Sending from ${from} is administratively blocked.`);
  const identity = queueIdentity(sender, options.smtpHost);
  const redis = connectRedis(options);
  const { queue } = getQueue(sender, options);
  try {
    const circuit = await redis.get(circuitKey(identity));
    if (circuit) throw new Error(`Email queue paused: ${circuit}`);
    const id = mailJobId(identity, prepared, kind);
    const recipient = Array.isArray(prepared.to) ? prepared.to[0] as string : prepared.to;
    const provider = options.providerId ?? sender.id ?? sender.type;
    if (await options.auditStore.isSuppressed(provider, recipient)) throw new Error(`Recipient ${recipient} is suppressed for provider ${provider}.`);
    let job = await queue.getJob(id);
    if (!job) {
      await options.auditStore.create({
        id,
        provider,
        applicationId: options.applicationId,
        ...(options.tenantId ? { tenantId: options.tenantId } : {}),
        sender: prepared.from ?? sender.from ?? "",
        recipient,
        transport: sender.type,
        status: "CREATED",
        idempotencyKey,
      });
      const limits = senderLimits(sender, options.smtpHost, options);
      const scopes = quotaScopes(identity, sender, options, limits);
      const reserved = await redis.eval(quotaScript, scopes.length, ...scopes.map((scope) => scope.key), ...scopes.map((scope) => scope.limit), DAY_MS);
      if (reserved !== 0) {
        await options.auditStore.transition(id, "DEFERRED", { error: `Email budget exhausted in ${scopes[Number(reserved) - 1]?.key.split(":")[3] ?? "configured"} scope.` });
        throw new Error(`Email budget exhausted in ${scopes[Number(reserved) - 1]?.key.split(":")[3] ?? "configured"} scope.`);
      }
      const priority = options.priority === undefined ? undefined : 5 - options.priority;
      const encrypted = jobMessage({ ...prepared, from: prepared.from ?? sender.from }, options, true);
      try {
        job = await queue.add("deliver", {
          ...encrypted, kind,
          applicationId: options.applicationId,
          ...(options.tenantId ? { tenantId: options.tenantId } : {}),
        }, {
          jobId: id,
          attempts: 1,
          ...(options.delayMs && options.delayMs > 0 ? { delay: Math.floor(options.delayMs) } : {}),
          ...(priority !== undefined ? { priority } : {}),
          removeOnComplete: { age: 30 * 86400, count: 100_000 },
          removeOnFail: false,
        });
      } catch (error) {
        await options.auditStore.transition(id, "FAILED", { error: String(error) });
        throw error;
      }
      try {
        await options.auditStore.transition(id, options.delayMs && options.delayMs > 0 ? "DEFERRED" : "QUEUED");
      } catch (error) {
        const reason = "PostgreSQL audit update failed after queue insertion; queue paused for reconciliation.";
        await redis.set(circuitKey(identity), reason);
        await queue.pause();
        throw new Error(`${reason} ${String(error)}`);
      }
    }
    const queueState = await job.getState();
    const result = queueState === "completed" ? job.returnvalue as DeliveryResult : undefined;
    return { id: job.id ?? id, state: stateFromQueue(queueState, result), queueState, ...(result ? { result } : {}), ...(job.failedReason ? { error: job.failedReason } : {}), timestamp: job.timestamp };
  } finally {
    await queue.close().catch(() => undefined);
    await redis.quit().catch(() => redis.disconnect());
  }
}

/** Starts a credential-bearing worker. Keep its returned handle alive for the service lifetime. */
export async function startEmailWorker(sender: DeliveryTransport, options: EmailQueueOptions): Promise<{ close(): Promise<void>; worker: Worker }> {
  if (!options.redisUrl) throw new Error("EMAIL_QUEUE_REDIS_URL is required.");
  const identity = queueIdentity(sender, options.smtpHost);
  const limits = senderLimits(sender, options.smtpHost, options);
  const name = queueName(identity);
  const connection = connectRedis(options);
  const queue = new Queue(name, { connection: connectRedis(options) });
  // Workers created after a restriction remain idle while the global pause is set.
  try {
    if (await connection.get(circuitKey(identity))) await queue.pause();
  } catch (error) {
    await queue.close().catch(() => undefined);
    await connection.quit().catch(() => connection.disconnect());
    throw error;
  }
  const worker = new Worker<EmailJobData, DeliveryResult>(
    name,
    async (job) => {
      const block = await connection.get(circuitKey(identity));
      if (block) {
        return { ok: false, state: "SUPPRESSED", retryable: false, status: 403, error: block };
      }
      const decoded = readJobMessage(job.data, options);
      const idempotencyKey = decoded.idempotencyKey ?? decoded.dedupeKey;
      const { dedupeKey: _dedupeKey, idempotencyKey: _idempotencyKey, ...message } = decoded;
      if (options.auditStore) await options.auditStore.transition(String(job.id), "PROCESSING");
      try {
        const result = await sendWithThrottleRecovery(sender, message, {
          kind: job.data.kind,
          idempotencyKey,
          smtpHost: options.smtpHost,
          minGapMs: limits.minGapMs,
        });
        const normalized = { ...result, state: result.ok ? "PROVIDER_ACCEPTED" as const : result.status === 0 ? "UNKNOWN" as const : result.status === 403 || result.status === 429 || result.retryable || ((result.attempts ?? 0) >= MAX_THROTTLE_ATTEMPTS && isThrottleFailure(result, sender, options.smtpHost)) ? "REJECTED" as const : "FAILED" as const, ...(result.id ? { providerMessageId: result.id } : {}) };
        const reason = providerCircuitReason(normalized, sender, options.smtpHost);
        if (reason) {
          await connection.set(circuitKey(identity), reason);
          void queue.pause().catch(() => undefined);
        }
        try {
          await options.auditStore?.transition(String(job.id), normalized.state, {
            ...(normalized.providerMessageId ? { providerMessageId: normalized.providerMessageId } : {}),
            ...(normalized.rfcMessageId ? { rfcMessageId: normalized.rfcMessageId } : {}),
            ...(normalized.error ? { error: normalized.error } : {}),
          });
        } catch (auditError) {
          const reason = "PostgreSQL audit update failed after provider response; queue paused for reconciliation.";
          await connection.set(circuitKey(identity), reason);
          void queue.pause().catch(() => undefined);
          return { ...normalized, error: [normalized.error, `PostgreSQL audit update failed: ${String(auditError)}`].filter(Boolean).join("; ") };
        }
        return normalized;
      } catch (error) {
        const unknown: DeliveryResult = { ok: false, state: "UNKNOWN", retryable: false, status: 0, error: "Delivery uncertain; check provider before manual retry: " + String(error) };
        try {
          await options.auditStore?.transition(String(job.id), "UNKNOWN", { error: unknown.error });
        } catch (auditError) {
          unknown.error += ` PostgreSQL audit update failed: ${String(auditError)}`;
        }
        return unknown;
      }
    },
    { connection, concurrency: 1, limiter: { max: 1, duration: limits.minGapMs } },
  );
  worker.on("completed", (_job, result) => {
    if (result && (result.state === "SUPPRESSED" || providerCircuitReason(result, sender, options.smtpHost))) void queue.pause().catch(() => undefined);
  });
  return {
    worker,
    async close() {
      await worker.close().catch(() => undefined);
      await queue.close().catch(() => undefined);
      await Promise.all([connection.quit().catch(() => connection.disconnect())]);
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
  try { await redis.del(circuitKey(identity)); await queue.resume(); }
  finally { await queue.close().catch(() => undefined); await redis.quit().catch(() => redis.disconnect()); }
}

export async function getProviderHealth(sender: DeliveryTransport, options: EmailQueueOptions): Promise<{ provider: string; sender: string; available: boolean; pausedReason?: string }> {
  const identity = queueIdentity(sender, options.smtpHost);
  const redis = connectRedis(options);
  try {
    const pausedReason = await redis.get(circuitKey(identity));
    return { provider: options.providerId ?? sender.id ?? sender.type, sender: addressOf(sender.from ?? ""), available: !pausedReason, ...(pausedReason ? { pausedReason } : {}) };
  } finally { await redis.quit().catch(() => redis.disconnect()); }
}

export async function getQuotaUsage(sender: DeliveryTransport, options: EmailQueueOptions): Promise<Array<{ scope: string; limit: number; used: number; resetsInMs: number }>> {
  const identity = queueIdentity(sender, options.smtpHost);
  const limits = senderLimits(sender, options.smtpHost, options);
  const scopes = quotaScopes(identity, sender, options, limits);
  const redis = connectRedis(options);
  try {
    return await Promise.all(scopes.map(async (scope, index) => {
      const [value, ttl] = await Promise.all([redis.get(scope.key), redis.pttl(scope.key)]);
      return { scope: index === 0 ? "provider" : index === 1 ? "mailbox" : scope.key.includes(hash("application|" + options.applicationId)) ? "application" : "tenant", limit: scope.limit, used: Number(value ?? 0), resetsInMs: Math.max(0, ttl) };
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
