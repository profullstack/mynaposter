import { describe, expect, it } from "bun:test";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import {
  fibonacciBackoffMs,
  emailAuditSchema,
  PostgresEmailAuditStore,
  createResendTransport,
  getEmailStatus,
  isGoogleSender,
  isThrottleFailure,
  MAX_THROTTLE_ATTEMPTS,
  mailJobId,
  processResendWebhook,
  providerCircuitReason,
  queueEmail,
  queueIdentity,
  queuedDelivery,
  resumeEmailQueue,
  sendWithThrottleRecovery,
  senderLimits,
  startEmailWorker,
  type DeliveryTransport,
  type EmailAuditEvent,
  type EmailAuditStore,
  type QueuedMessage,
} from "../src/index.ts";

describe("email queue policy", () => {
  it("recognizes personal Gmail and Gmail-hosted custom-domain senders", () => {
    expect(isGoogleSender({ type: "smtp", from: "owner@gmail.com" }, "smtp.gmail.com")).toBe(true);
    expect(isGoogleSender({ type: "smtp", from: "owner@example.com" }, "smtp.googlemail.com")).toBe(true);
    expect(isGoogleSender({ type: "resend", from: "owner@gmail.com" })).toBe(true);
    expect(isGoogleSender({ type: "resend", from: "owner@example.com" })).toBe(false);
  });

  it("enforces conservative sender budgets and never raises them with overrides", () => {
    expect(senderLimits({ type: "smtp", from: "owner@gmail.com" }, "smtp.gmail.com")).toEqual({
      google: true,
      maxPer24Hours: 100,
      minGapMs: 600_000,
    });
    expect(senderLimits({ type: "resend", from: "owner@example.com" }, "", {
      maxPer24Hours: 10_000,
      minGapMs: 1,
    })).toEqual({ google: false, maxPer24Hours: 1000, minGapMs: 1000 });
  });

  it("uses Fibonacci backoff for three definite throttling failures, then stops", async () => {
    expect([1, 2, 3, 4, 5].map((failure) => fibonacciBackoffMs(failure, 1000))).toEqual([1000, 2000, 3000, 5000, 8000]);
    expect(MAX_THROTTLE_ATTEMPTS).toBe(3);
    let calls = 0;
    const waits: number[] = [];
    const sender: DeliveryTransport = {
      id: "gmail",
      type: "smtp",
      from: "owner@gmail.com",
      async send() {
        calls++;
        return { ok: false, status: 451, retryable: true, error: "You have reached a limit for sending mail. Your message was not sent." };
      },
    };
    const result = await sendWithThrottleRecovery(sender, {
      to: "person@example.net",
      subject: "Throttle recovery",
      text: "No external delivery",
    }, {
      kind: "transactional",
      minGapMs: 600_000,
      sleep: async (milliseconds) => { waits.push(milliseconds); },
    });
    expect(calls).toBe(3);
    expect(waits).toEqual([600_000, 1_200_000]);
    expect(result).toMatchObject({ ok: false, retryable: false, attempts: 3 });
    expect(result.error).toContain("Stopped after 3 consecutive throttling responses");
    expect(providerCircuitReason(result, sender, "smtp.gmail.com")).toContain("paused for administrator review");
  });

  it("does not retry uncertain transport outcomes or ordinary refusals", async () => {
    let calls = 0;
    const waits: number[] = [];
    const sender: DeliveryTransport = {
      id: "gmail",
      type: "smtp",
      from: "owner@gmail.com",
      async send() {
        calls++;
        return { ok: false, status: 0, retryable: true, error: "connection reset" };
      },
    };
    expect(isThrottleFailure({ ok: false, status: 0, error: "rate limit" }, sender, "smtp.gmail.com")).toBe(false);
    const result = await sendWithThrottleRecovery(sender, {
      to: "person@example.net",
      subject: "No retry",
      text: "No external delivery",
    }, { kind: "transactional", sleep: async (milliseconds) => { waits.push(milliseconds); } });
    expect(result).toMatchObject({ ok: false, status: 0 });
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
    expect(isThrottleFailure({ ok: false, status: 535, error: "Authentication failed" }, sender, "smtp.gmail.com")).toBe(false);
  });

  it("honors Retry-After and stops retrying when a throttled send succeeds", async () => {
    let calls = 0;
    const waits: number[] = [];
    const sender: DeliveryTransport = {
      id: "resend",
      type: "resend",
      from: "owner@example.com",
      async send() {
        calls++;
        return calls === 1
          ? { ok: false, status: 429, retryable: true, retryAfterMs: 2500, error: "Too many requests" }
          : { ok: true, id: "accepted" };
      },
    };
    const result = await sendWithThrottleRecovery(sender, {
      to: "person@example.net",
      subject: "Recovered",
      text: "No external delivery",
    }, {
      kind: "transactional",
      minGapMs: 1000,
      sleep: async (milliseconds) => { waits.push(milliseconds); },
    });
    expect(calls).toBe(2);
    expect(waits).toEqual([2500]);
    expect(result).toMatchObject({ ok: true, id: "accepted", attempts: 2 });
  });

  it("scopes identity by sender and makes bulk recipient jobs idempotent", () => {
    const sender = { id: "resend", type: "resend", from: "News <news@example.com>" };
    const identity = queueIdentity(sender);
    const base: QueuedMessage = {
      from: sender.from,
      to: ["person@example.net"],
      subject: "Issue 1",
      text: "Hello",
      dedupeKey: "issue-1:contact-1",
    };
    expect(identity).toBe("resend|news@example.com");
    expect(mailJobId(identity, base, "bulk")).toBe(mailJobId(identity, base, "bulk"));
    expect(mailJobId(identity, base, "bulk")).not.toBe(mailJobId("resend|other@example.com", base, "bulk"));
    expect(() => mailJobId(identity, { ...base, to: ["a@example.net", "b@example.net"] }, "bulk")).toThrow("exactly one recipient");
  });

  it("refuses Gmail bulk delivery before connecting to Redis or calling the provider", async () => {
    let calls = 0;
    const gmail: DeliveryTransport = {
      id: "gmail",
      type: "smtp",
      from: "owner@example.com",
      async send() {
        calls++;
        return { ok: true };
      },
    };
    const result = await queuedDelivery(gmail, {
      from: gmail.from,
      to: ["recipient@example.net"],
      subject: "Bulk must use Resend",
      text: "No external delivery",
    }, "bulk", { redisUrl: "redis://127.0.0.1:1", smtpHost: "smtp.gmail.com" });
    expect(result).toMatchObject({ ok: false, retryable: false, status: 403 });
    expect(result.error).toContain("Gmail is reserved for approved one-off correspondence");
    expect(calls).toBe(0);
  });

  it("rejects an unapproved From address before touching Redis or the provider", async () => {
    let calls = 0;
    const sender: DeliveryTransport = {
      id: "resend-prod",
      type: "resend",
      from: "mail@example.com",
      async send() { calls++; return { ok: true }; },
    };
    const result = await queuedDelivery(sender, {
      from: "owner@gmail.com",
      to: "person@example.net",
      subject: "Unauthorized",
      text: "Must not send",
    }, "transactional", { redisUrl: "redis://127.0.0.1:1" });
    expect(result).toMatchObject({ ok: false, state: "REJECTED", status: 403 });
    expect(calls).toBe(0);
  });

  it("opens a circuit for provider restrictions and rate limits", () => {
    expect(providerCircuitReason({ ok: false, status: 429, attempts: 1, error: "You have reached a limit for sending mail." }, { type: "smtp", from: "owner@gmail.com" }, "smtp.gmail.com")).toBeUndefined();
    expect(providerCircuitReason({ ok: false, status: 429, attempts: 3, error: "You have reached a limit for sending mail." }, { type: "smtp", from: "owner@gmail.com" }, "smtp.gmail.com")).toContain("Google sending restriction");
    expect(providerCircuitReason({ ok: false, status: 429, attempts: 3, error: "Too many requests" }, { type: "resend", from: "mail@example.com" })).toContain("Provider throttling persisted");
    expect(providerCircuitReason({ ok: false, status: 400, error: "Bad request" }, { type: "resend", from: "mail@example.com" })).toBeUndefined();
  });

  it("verifies Resend webhook signatures and rejects invalid signatures", async () => {
    const key = randomBytes(32);
    const secret = `whsec_${key.toString("base64")}`;
    const now = Date.now();
    const id = `evt_${randomUUID()}`;
    const timestamp = String(Math.floor(now / 1000));
    const body = JSON.stringify({ type: "email.delivered", created_at: new Date(now).toISOString(), data: { email_id: "msg-1", to: ["person@example.net"] } });
    const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
    const headers = { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` };
    const events: EmailAuditEvent[] = [];
    const store: EmailAuditStore = {
      async migrate() {},
      async create() {},
      async transition() {},
      async get() { return undefined; },
      async ingestProviderEvent(event) { events.push(event); return true; },
      async isSuppressed() { return false; },
    };
    const result = await processResendWebhook(body, headers, secret, "resend-prod", store, { now });
    expect(result).toMatchObject({ verified: true, type: "email.delivered", handled: true, inserted: 1 });
    expect(events[0]).toMatchObject({ status: "DELIVERED", recipient: "person@example.net", providerMessageId: "msg-1" });
    await expect(processResendWebhook(body, { ...headers, "svix-signature": "v1,AAAA" }, secret, "resend-prod", store, { now })).rejects.toThrow("Invalid Resend webhook signature");
  });

  it("stores a minimal PostgreSQL schema without the message body", () => {
    expect(emailAuditSchema).toContain("email_queue_messages");
    expect(emailAuditSchema).toContain("email_queue_provider_events");
    expect(emailAuditSchema).toContain("email_queue_suppressions");
    expect(emailAuditSchema).not.toMatch(/\b(html|body|text)\s+(TEXT|JSONB)/i);
  });

  it("reapplies a provider webhook that arrived before the worker's acceptance update", async () => {
    const queries: string[] = [];
    const store = new PostgresEmailAuditStore({
      async query(text) {
        queries.push(text);
        return { rows: [], rowCount: 0 };
      },
    });
    await store.transition("message-1", "PROVIDER_ACCEPTED", { providerMessageId: "resend-message-1" });
    expect(queries).toHaveLength(2);
    expect(queries[1]).toContain("FROM email_queue_provider_events e");
    expect(queries[1]).toContain("newer.occurred_at > e.occurred_at");
  });

  it("sends through Resend with server-side credentials and an idempotency header", async () => {
    let request: RequestInit | undefined;
    const resend = createResendTransport({
      id: "resend-test",
      apiKey: "test-only-secret",
      from: "Profullstack <anthony@profullstack.com>",
      fetchImpl: async (_input, init) => {
        request = init;
        return new Response(JSON.stringify({ id: "resend-message-1" }), { status: 200 });
      },
    });
    const result = await resend.send({
      to: "person@example.net",
      subject: "Authorized test",
      text: "No external delivery",
    }, { idempotencyKey: "test:message:1" });
    expect(result).toMatchObject({ ok: true, status: 200, id: "resend-message-1", providerMessageId: "resend-message-1" });
    expect(new Headers(request?.headers).get("idempotency-key")).toBe("test:message:1");
    expect(String(request?.body)).toContain("anthony@profullstack.com");
    expect(String(request?.body)).not.toContain("test-only-secret");
  });
});

const testRedisUrl = process.env.EMAIL_QUEUE_TEST_REDIS_URL;

if (testRedisUrl) {
  describe("Redis-backed delivery", () => {
    function fakeSender() {
      const from = `queue-test-${randomUUID()}@example.test`;
      let calls = 0;
      const sender: DeliveryTransport = {
        id: `fake-resend-${randomUUID()}`,
        type: "resend",
        from,
        async send() {
          calls++;
          return { ok: true, id: `fake-${calls}` };
        },
      };
      return { sender, get calls() { return calls; } };
    }

    it("delivers once and returns the durable receipt for a repeated issue recipient", async () => {
      const fake = fakeSender();
      const message: QueuedMessage = {
        from: fake.sender.from,
        to: [`person-${randomUUID()}@example.test`],
        subject: "Queue test",
        text: "No external delivery",
        dedupeKey: `issue:${randomUUID()}`,
      };
      const options = { redisUrl: testRedisUrl! };
      const first = await queuedDelivery(fake.sender, message, "bulk", options);
      const repeated = await queuedDelivery(fake.sender, message, "bulk", options);
      expect(first).toMatchObject({ ok: true, id: "fake-1", state: "PROVIDER_ACCEPTED", providerMessageId: "fake-1" });
      expect(repeated).toEqual(first);
      expect(fake.calls).toBe(1);
    });

    it("stops at the sender's daily cap without calling the provider again", async () => {
      const fake = fakeSender();
      const options = { redisUrl: testRedisUrl!, maxPer24Hours: 1, minGapMs: 1000 };
      const first = await queuedDelivery(fake.sender, {
        from: fake.sender.from,
        to: [`person-a-${randomUUID()}@example.test`],
        subject: "Queue budget test",
        text: "No external delivery",
        dedupeKey: `campaign:${randomUUID()}:a`,
      }, "bulk", options);
      const second = await queuedDelivery(fake.sender, {
        from: fake.sender.from,
        to: [`person-b-${randomUUID()}@example.test`],
        subject: "Queue budget test",
        text: "No external delivery",
        dedupeKey: `campaign:${randomUUID()}:b`,
      }, "bulk", options);
      expect(first.ok).toBe(true);
      expect(second).toMatchObject({ ok: false, status: 429, retryable: true });
      expect(fake.calls).toBe(1);
    });

    it("records an uncertain provider error as a completed receipt without retrying", async () => {
      const fake = fakeSender();
      let calls = 0;
      fake.sender.send = async () => {
        calls++;
        throw new Error("connection reset after DATA");
      };
      const message: QueuedMessage = {
        from: fake.sender.from,
        to: [`uncertain-${randomUUID()}@example.test`],
        subject: "Queue uncertain test",
        text: "No external delivery",
        dedupeKey: `campaign:${randomUUID()}:uncertain`,
      };
      const options = { redisUrl: testRedisUrl! };
      const first = await queuedDelivery(fake.sender, message, "bulk", options);
      const repeated = await queuedDelivery(fake.sender, message, "bulk", options);
      expect(first).toMatchObject({ ok: false, state: "UNKNOWN", retryable: false, status: 0 });
      expect(first.error).toContain("Delivery uncertain");
      expect(repeated).toEqual(first);
      expect(calls).toBe(1);
    });

    it("encrypts Redis payloads, keeps transport secrets out, and decrypts only in the worker", async () => {
      const from = `encrypted-${randomUUID()}@example.test`;
      const providerId = `resend-${randomUUID()}`;
      const audit = new Map<string, Record<string, unknown>>();
      const auditStore: EmailAuditStore = {
        async migrate() {},
        async create(record) { audit.set(record.id, { ...record }); },
        async transition(id, status, details = {}) {
          const existing = audit.get(id);
          if (existing) audit.set(id, { ...existing, status, ...details });
        },
        async get(id) { return audit.get(id); },
        async ingestProviderEvent() { return true; },
        async isSuppressed() { return false; },
      };
      let sentText = "";
      const sender = Object.assign({
        id: providerId,
        type: "resend",
        from,
        async send(message: QueuedMessage) { sentText = message.text; return { ok: true, id: "provider-message-1" }; },
      }, { apiKey: "never-store-this-secret" }) as DeliveryTransport;
      const options = {
        redisUrl: testRedisUrl!,
        encryptionKey: randomBytes(32).toString("base64"),
        applicationId: `app-${randomUUID()}`,
        tenantId: `tenant-${randomUUID()}`,
        providerId,
        auditStore,
      };
      const text = `private-body-${randomUUID()}`;
      const queued = await queueEmail(sender, {
        from,
        to: `recipient-${randomUUID()}@example.test`,
        subject: "Encrypted queue test",
        text,
      }, "transactional", { ...options, idempotencyKey: `test:${randomUUID()}` });
      expect(queued.state).toBe("QUEUED");
      const identity = queueIdentity(sender);
      const queueName = `profullstack-email-${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
      const inspection = new Queue(queueName, { connection: new Redis(testRedisUrl!, { maxRetriesPerRequest: null }) });
      try {
        const job = await inspection.getJob(queued.id);
        expect(job?.data.message).toBeUndefined();
        expect(job?.data.encryptedMessage.data).not.toContain(text);
        expect(JSON.stringify(job?.data)).not.toContain("never-store-this-secret");
      } finally { await inspection.close(); }

      const worker = await startEmailWorker(sender, options);
      try {
        let status = await getEmailStatus(sender, queued.id, options);
        for (let attempt = 0; attempt < 100 && status?.state !== "PROVIDER_ACCEPTED"; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          status = await getEmailStatus(sender, queued.id, options);
        }
        expect(sentText).toBe(text);
        expect(status).toMatchObject({ id: queued.id, state: "PROVIDER_ACCEPTED" });
      } finally { await worker.close(); }
    });

    it("persists an uncertain worker outcome as UNKNOWN in the audit store", async () => {
      const from = `unknown-${randomUUID()}@example.test`;
      const providerId = `resend-${randomUUID()}`;
      const audit = new Map<string, Record<string, unknown>>();
      const auditStore: EmailAuditStore = {
        async migrate() {},
        async create(record) { audit.set(record.id, { ...record }); },
        async transition(id, status, details = {}) {
          const existing = audit.get(id);
          if (existing) audit.set(id, { ...existing, status, ...details });
        },
        async get(id) { return audit.get(id); },
        async ingestProviderEvent() { return true; },
        async isSuppressed() { return false; },
      };
      let calls = 0;
      const sender: DeliveryTransport = {
        id: providerId,
        type: "resend",
        from,
        async send() { calls++; throw new Error("connection reset after request body"); },
      };
      const options = {
        redisUrl: testRedisUrl!,
        encryptionKey: randomBytes(32).toString("base64"),
        applicationId: `app-${randomUUID()}`,
        tenantId: `tenant-${randomUUID()}`,
        providerId,
        auditStore,
      };
      const queued = await queueEmail(sender, {
        from,
        to: `recipient-${randomUUID()}@example.test`,
        subject: "Uncertain delivery test",
        text: "No external delivery",
      }, "transactional", { ...options, idempotencyKey: `test:${randomUUID()}` });
      const worker = await startEmailWorker(sender, options);
      try {
        let status = await getEmailStatus(sender, queued.id, options);
        for (let attempt = 0; attempt < 100 && status?.state !== "UNKNOWN"; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          status = await getEmailStatus(sender, queued.id, options);
        }
        expect(calls).toBe(1);
        expect(status).toMatchObject({ id: queued.id, state: "UNKNOWN" });
        expect(status?.error).toContain("Delivery uncertain");
      } finally { await worker.close(); }
    });

    it("pauses a Gmail mailbox on a provider restriction and preserves queued work", async () => {
      const from = `restricted-${randomUUID()}@gmail.com`;
      let calls = 0;
      const sender: DeliveryTransport = {
        id: "gmail-restricted-test",
        type: "smtp",
        from,
        async send() {
          calls++;
          return { ok: false, status: 403, retryable: false, error: "Google sending restriction" };
        },
      };
      const options = { redisUrl: testRedisUrl!, smtpHost: "smtp.gmail.com", minGapMs: 1000 };
      const first = await queuedDelivery(sender, {
        from,
        to: [`first-${randomUUID()}@example.test`],
        subject: "Restriction test",
        text: "No external delivery",
        dedupeKey: `restricted:first:${randomUUID()}`,
      }, "transactional", options);
      expect(first).toMatchObject({ ok: false, state: "REJECTED", status: 403 });
      const second = await queuedDelivery(sender, {
        from,
        to: [`second-${randomUUID()}@example.test`],
        subject: "Restriction test",
        text: "No external delivery",
        dedupeKey: `restricted:second:${randomUUID()}`,
      }, "transactional", options);
      expect(second).toMatchObject({ ok: false, state: "SUPPRESSED", status: 403 });
      expect(calls).toBe(1);
      await resumeEmailQueue(sender, options);
    });
  });
}
