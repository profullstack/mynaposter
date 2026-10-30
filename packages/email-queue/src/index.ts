/**
 * @profullstack/email-queue
 *
 * One Redis-backed, account-scoped BullMQ queue for Gmail/Resend senders
 * across processes. The durable BullMQ job is the receipt: completed jobs
 * are never automatically retried, including ambiguous SMTP disconnects.
 *
 * Every job contains email content only. Provider credentials stay in the
 * calling worker process and are NEVER copied into Redis.
 */
import { createHash, randomUUID } from "node:crypto";
import { Queue, QueueEvents, Worker } from "bullmq";
import Redis from "ioredis";

export type EmailKind = "transactional" | "bulk";
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
}
export interface DeliveryResult {
  ok: boolean;
  id?: string;
  error?: string;
  retryable?: boolean;
  status?: number;
}
export interface DeliveryTransport {
  id: string;
  type: string;
  from?: string;
  send(message: QueuedMessage, options?: { kind?: EmailKind }): Promise<DeliveryResult>;
}
export interface EmailQueueOptions {
  redisUrl: string;
  /** For SMTP sending via smtp.gmail.com with a Workspace/custom-domain From. */
  smtpHost?: string;
  /** Override defaults DOWNWARD only, not upward, without code review. */
  maxPer24Hours?: number;
  minGapMs?: number;
}
export interface Limits {
  maxPer24Hours: number;
  minGapMs: number;
  google: boolean;
}
const DAY_MS = 24 * 60 * 60 * 1000;
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
  const key = message.dedupeKey
    ? "dedupe|" + message.dedupeKey
    : kind === "bulk"
      ? "bulk|" + message.subject + "|" + message.text + "|" + (message.html ?? "")
      : "new|" + randomUUID();
  return hash(identity + "|" + to[0].trim().toLowerCase() + "|" + key);
}
const quotaScript =
  "local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end; if n > tonumber(ARGV[1]) then redis.call('DECR', KEYS[1]); return 0 end; return 1";

/** Adds ONE job and waits for its durable result, without retrying uncertain sends.
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
  const identity = queueIdentity(sender, options.smtpHost);
  const limits = senderLimits(sender, options.smtpHost, options);
  const name = "profullstack-email-" + hash(identity).slice(0, 32);
  const jobId = mailJobId(identity, message, kind);
  const connect = () => new Redis(options.redisUrl, {
    maxRetriesPerRequest: null, connectTimeout: 5000, retryStrategy: (attempt) => attempt <= 3 ? Math.min(attempt * 200, 1000) : null,
  });
  const producerRedis = connect();
  const workerRedis = connect();
  const eventsRedis = connect();
  const queue = new Queue<{ message: QueuedMessage; kind: EmailKind }, DeliveryResult>(name, { connection: producerRedis });
  const events = new QueueEvents(name, { connection: eventsRedis });
  // Single-recipient jobs avoid Resend's 100-address batch bypassing a mailbox quota.
  const worker = new Worker<{ message: QueuedMessage; kind: EmailKind }, DeliveryResult>(
    name,
    async (job) => {
      const { dedupeKey: _dedupeKey, ...mail } = job.data.message;
      try {
        return await sender.send(mail, { kind: job.data.kind });
      } catch (error) {
        // A socket failure might mean the remote provider accepted the message.
        // Record an uncertain result. NEVER retry automatically.
        return { ok: false, retryable: false, status: 0, error: "Delivery uncertain; check provider before manual retry: " + String(error) };
      }
    },
    { connection: workerRedis, concurrency: 1, limiter: { max: 1, duration: limits.minGapMs } },
  );
  try {
    await events.waitUntilReady();
    const previous = await queue.getJob(jobId);
    let job = previous;
    if (!job) {
      const quotaKey = "profullstack:email-quota:" + hash(identity);
      const allowed = await producerRedis.eval(quotaScript, 1, quotaKey, limits.maxPer24Hours, DAY_MS);
      if (allowed !== 1) return { ok: false, status: 429, retryable: true, error: "Sender budget exhausted (" + limits.maxPer24Hours + "/24h). Remaining recipients stay unsent until the window resets." };
      // Important: jobId remains in Redis as a completed receipt for 30 days.
      job = await queue.add("deliver", { message, kind }, {
        jobId, attempts: 1, removeOnComplete: { age: 30 * 86400, count: 100_000 }, removeOnFail: false,
      });
    }
    const state = await job.getState();
    if (state === "completed") return job.returnvalue as DeliveryResult;
    if (state === "failed") return { ok: false, retryable: false, error: job.failedReason || "Queue job failed; inspect before retrying." };
    return await job.waitUntilFinished(events) as DeliveryResult;
  } finally {
    await worker.close().catch(() => undefined);
    await events.close().catch(() => undefined);
    await queue.close().catch(() => undefined);
    await Promise.all([producerRedis.quit().catch(() => producerRedis.disconnect()), workerRedis.quit().catch(() => workerRedis.disconnect()), eventsRedis.quit().catch(() => eventsRedis.disconnect())]);
  }
}
