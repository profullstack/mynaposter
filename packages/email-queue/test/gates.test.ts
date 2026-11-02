import { describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  bulkComplianceFailure,
  classifyProviderFailure,
  createResendTransport,
  createSmtpTransport,
  createUnsubscribeToken,
  emailAuditSchema,
  emailQueueConfigProblems,
  EmailQueueError,
  getQuotaUsage,
  getSuppression,
  handleUnsubscribe,
  isHardRecipientFailure,
  listUnsubscribeHeaders,
  mailJobId,
  PostgresEmailAuditStore,
  providerCircuitDecision,
  queueEmail,
  queueIdentity,
  queuedDelivery,
  redactError,
  resumeEmailQueue,
  smtpFailure,
  startEmailWorker,
  getEmailStatus,
  suppress,
  verifyUnsubscribeToken,
  type DeliveryResult,
  type DeliveryTransport,
  type EmailAuditStore,
  type QueuedMessage,
  type SmtpTransporterLike,
  type SuppressionRecord,
} from "../src/index.ts";

const POSTAL = "Profullstack, Inc., 1 Main St, Los Gatos, CA 95030, USA";

function compliantBulk(to: string, extra: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    to,
    subject: "Issue 7",
    text: `Hello.\n\nUnsubscribe: https://example.test/u/abc\n${POSTAL}`,
    html: `<p>Hello.</p><p>Profullstack, Inc., 1 Main St,<br>Los Gatos, CA 95030, USA</p>`,
    headers: listUnsubscribeHeaders("https://example.test/u/abc", "unsubscribe@example.test"),
    ...extra,
  };
}

/** An in-memory EmailAuditStore. */
function memoryStore() {
  const records = new Map<string, Record<string, unknown>>();
  const suppressions = new Map<string, SuppressionRecord>();
  const store: EmailAuditStore = {
    async migrate() {},
    async create(record) { if (!records.has(record.id)) records.set(record.id, { ...record }); },
    async transition(id, status, details = {}) {
      const existing = records.get(id);
      if (existing) records.set(id, { ...existing, status, ...details });
    },
    async get(id) { return records.get(id); },
    async ingestProviderEvent() { return true; },
    async suppress(entry) {
      const key = entry.recipient.trim().toLowerCase();
      if (!suppressions.has(key)) suppressions.set(key, { recipient: key, reason: entry.reason, source: entry.source, ...(entry.provider ? { provider: entry.provider } : {}) });
    },
    async getSuppression(recipient) { return suppressions.get(recipient.trim().toLowerCase()); },
  };
  return { store, records, suppressions };
}

describe("bulk/marketing compliance gate", () => {
  const sender: DeliveryTransport = { id: "resend-bulk", type: "resend", from: "news@example.test", async send() { throw new Error("must not send"); } };
  const offline = { redisUrl: "redis://127.0.0.1:1" };

  it("rejects bulk without List-Unsubscribe before touching Redis or the provider", async () => {
    const result = await queuedDelivery(sender, { to: "a@example.net", subject: "s", text: POSTAL }, "bulk", { ...offline, postalAddress: POSTAL });
    expect(result).toMatchObject({ ok: false, state: "REJECTED", status: 422, code: "BULK_LIST_UNSUBSCRIBE_MISSING" });
  });

  it("rejects a mailto-only List-Unsubscribe and a missing one-click header", () => {
    expect(bulkComplianceFailure({ text: POSTAL, headers: { "List-Unsubscribe": "<mailto:u@example.test>" } }, POSTAL)?.code).toBe("BULK_LIST_UNSUBSCRIBE_MISSING");
    expect(bulkComplianceFailure({ text: POSTAL, headers: { "list-unsubscribe": "<https://example.test/u/1>" } }, POSTAL)?.code).toBe("BULK_ONE_CLICK_MISSING");
    expect(bulkComplianceFailure({ text: POSTAL, headers: { "List-Unsubscribe": "<https://example.test/u/1>", "List-Unsubscribe-Post": "List-Unsubscribe=Yes" } }, POSTAL)?.code).toBe("BULK_ONE_CLICK_MISSING");
  });

  it("requires a configured postal address and finds it in text and HTML", async () => {
    const message = compliantBulk("a@example.net");
    const unconfigured = await queuedDelivery(sender, message, "bulk", offline);
    expect(unconfigured).toMatchObject({ ok: false, code: "BULK_POSTAL_ADDRESS_NOT_CONFIGURED" });
    const htmlMissing = await queuedDelivery(sender, { ...message, html: "<p>No address here</p>" }, "bulk", { ...offline, postalAddress: POSTAL });
    expect(htmlMissing).toMatchObject({ ok: false, code: "BULK_POSTAL_ADDRESS_MISSING" });
    const textMissing = await queuedDelivery(sender, { ...message, text: "No address" }, "marketing", { ...offline, postalAddress: POSTAL });
    expect(textMissing).toMatchObject({ ok: false, code: "BULK_POSTAL_ADDRESS_MISSING" });
    expect(bulkComplianceFailure(message, POSTAL)).toBeUndefined();
  });

  it("treats marketing like bulk and throws a coded error from queueEmail", async () => {
    const { store } = memoryStore();
    const promise = queueEmail(sender, { to: "a@example.net", subject: "s", text: "t" }, "marketing", {
      ...offline, encryptionKey: randomBytes(32).toString("base64"), applicationId: "app", tenantId: "t", auditStore: store, idempotencyKey: "k1",
    });
    await expect(promise).rejects.toBeInstanceOf(EmailQueueError);
    await expect(promise).rejects.toMatchObject({ code: "BULK_LIST_UNSUBSCRIBE_MISSING" });
  });

  it("refuses an empty idempotency key with a code", async () => {
    const { store } = memoryStore();
    await expect(queueEmail(sender, { to: "a@example.net", subject: "s", text: "t" }, "transactional", {
      ...offline, encryptionKey: randomBytes(32).toString("base64"), applicationId: "app", tenantId: "t", auditStore: store, idempotencyKey: "  ",
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
  });
});

describe("breaker classification", () => {
  const resend = { type: "resend", from: "mail@example.test" };
  const smtp = { type: "smtp", from: "knox@profullstack.com" };

  it("pauses on Resend 403 and 401, and on unverified-domain / suspended text", async () => {
    const transport = createResendTransport({
      id: "resend-test", apiKey: "re_test_secret_value", from: "mail@example.test",
      fetchImpl: async () => new Response(JSON.stringify({ name: "validation_error", message: "The example.test domain is not verified." }), { status: 403 }),
    });
    const result = await transport.send({ to: "a@example.net", subject: "s", text: "t" });
    expect(result).toMatchObject({ ok: false, status: 403, retryable: false });
    expect(providerCircuitDecision(result, resend)).toMatchObject({ scope: "sender" });
    expect(providerCircuitDecision({ ok: false, status: 401, error: "Resend 401: API key is invalid" }, resend)).toMatchObject({ scope: "account" });
    expect(providerCircuitDecision({ ok: false, status: 422, error: "Resend 422: Your account has been suspended" }, resend)).toMatchObject({ scope: "account" });
    expect(providerCircuitDecision({ ok: false, status: 400, error: "Bad request" }, resend)).toBeUndefined();
    expect(providerCircuitDecision({ ok: false, status: 0, error: "socket hang up" }, resend)).toBeUndefined();
  });

  it("pauses SMTP on 535 auth and any 5.7.x policy refusal, not on 5.1.1", () => {
    expect(classifyProviderFailure({ ok: false, status: 535, error: "SMTP 535: 5.7.8 Username and Password not accepted" }, "smtp")).toMatchObject({ scope: "sender" });
    expect(providerCircuitDecision({ ok: false, status: 550, error: "SMTP 550: 5.7.1 Sender not authorized" }, smtp)).toMatchObject({ scope: "sender" });
    expect(providerCircuitDecision({ ok: false, status: 554, enhancedStatus: "5.7.26", error: "DMARC" }, smtp)).toMatchObject({ scope: "sender" });
    const noSuchUser = { ok: false, status: 550, error: "SMTP 550: 5.1.1 No such user" };
    expect(providerCircuitDecision(noSuchUser, smtp)).toBeUndefined();
    expect(isHardRecipientFailure(noSuchUser, "smtp")).toBe(true);
  });

  it("maps nodemailer errors to SMTP codes the breaker understands", () => {
    const auth = smtpFailure(Object.assign(new Error("Invalid login: 535 5.7.8 Authentication failed"), { code: "EAUTH", responseCode: 535, response: "535 5.7.8 Authentication failed" }));
    expect(auth).toMatchObject({ ok: false, status: 535, enhancedStatus: "5.7.8" });
    expect(providerCircuitDecision(auth, smtp)).toBeDefined();
    const authNoCode = smtpFailure(Object.assign(new Error("Missing credentials"), { code: "EAUTH" }));
    expect(authNoCode.status).toBe(535);
    const socket = smtpFailure(Object.assign(new Error("Connection closed"), { code: "ECONNECTION" }));
    expect(socket.status).toBe(0);
    expect(providerCircuitDecision(socket, smtp)).toBeUndefined();
  });
});

describe("redaction", () => {
  it("strips emails, keys, bearer tokens and query strings from stored errors", () => {
    const raw = "Rejected bob.smith+x@example.com from <alice@corp.example> using re_AbCdEf123456789 Authorization: Bearer abc.def.ghi see https://api.example.com/v1/emails?token=SECRET&to=bob%40example.com api_key=sk_live_12345678 hash 0123456789abcdef0123456789abcdef01";
    const out = redactError(raw);
    expect(out).not.toContain("bob.smith");
    expect(out).not.toContain("alice@corp.example");
    expect(out).not.toContain("re_AbCdEf123456789");
    expect(out).not.toContain("abc.def.ghi");
    expect(out).not.toContain("SECRET");
    expect(out).not.toContain("sk_live_12345678");
    expect(out).not.toContain("0123456789abcdef0123456789abcdef01");
    expect(out).toContain("https://api.example.com/v1/emails?[redacted]");
    expect(out).toContain("[email]");
    expect(redactError("x".repeat(1000)).length).toBeLessThanOrEqual(300);
  });

  it("redacts Resend error bodies before returning them", async () => {
    const transport = createResendTransport({
      id: "resend-test", apiKey: "re_live_should_not_leak", from: "mail@example.test",
      fetchImpl: async () => new Response("upstream said: to=victim@example.org key re_live_should_not_leak", { status: 500 }),
    });
    const result = await transport.send({ to: "victim@example.org", subject: "s", text: "t" });
    expect(result.error).not.toContain("victim@example.org");
    expect(result.error).not.toContain("re_live_should_not_leak");
  });

  it("redacts errors written by the PostgreSQL audit store", async () => {
    const values: unknown[][] = [];
    const store = new PostgresEmailAuditStore({ async query(_text, params) { values.push(params ?? []); return { rows: [], rowCount: 0 }; } });
    await store.transition("m1", "FAILED", { error: "Resend 422: invalid to=someone@example.org" });
    expect(JSON.stringify(values[0])).not.toContain("someone@example.org");
  });
});

describe("SMTP transport", () => {
  function fake(response: Partial<Awaited<ReturnType<SmtpTransporterLike["sendMail"]>>> | Error = { messageId: "<m1@profullstack.com>", accepted: ["a@example.net"], rejected: [] }) {
    const sent: Record<string, unknown>[] = [];
    const configs: Record<string, unknown>[] = [];
    const factory = (config: Record<string, unknown>): SmtpTransporterLike => {
      configs.push(config);
      return {
        async sendMail(mail) {
          sent.push(mail);
          if (response instanceof Error) throw response;
          return response;
        },
      };
    };
    return { sent, configs, factory };
  }
  const base = { id: "fe-knox", host: "smtp.forwardemail.net", port: 465, secure: true, user: "knox@profullstack.com", pass: "app-password" };

  it("pins From and the envelope sender to the authenticated mailbox", async () => {
    const f = fake();
    const transport = createSmtpTransport({ ...base, fromName: "Knox", createTransport: f.factory });
    expect(transport.type).toBe("smtp");
    expect(transport.from).toBe('"Knox" <knox@profullstack.com>');
    const result = await transport.send({
      to: "a@example.net", subject: "Hi", text: "t",
      headers: { From: "ceo@bank.example", "Return-Path": "x@evil.example", "List-Unsubscribe": "<https://example.test/u/1>\r\nBcc: victim@example.org" },
    });
    expect(result).toMatchObject({ ok: true, status: 250, id: "<m1@profullstack.com>" });
    const mail = f.sent[0]!;
    expect(mail.from).toBe('"Knox" <knox@profullstack.com>');
    expect(mail.envelope).toEqual({ from: "knox@profullstack.com", to: ["a@example.net"] });
    const headers = mail.headers as Record<string, string>;
    expect(headers.From).toBeUndefined();
    expect(headers["Return-Path"]).toBeUndefined();
    expect(headers["List-Unsubscribe"]).not.toMatch(/[\r\n]/);
    expect(f.configs[0]).toMatchObject({ secure: true, auth: { user: "knox@profullstack.com" } });
  });

  it("refuses a different From without any network call", async () => {
    const f = fake();
    const transport = createSmtpTransport({ ...base, createTransport: f.factory });
    const result = await transport.send({ from: "cha0spunk@profullstack.com", to: "a@example.net", subject: "s", text: "t" });
    expect(result).toMatchObject({ ok: false, status: 400, code: "SENDER_UNAUTHORIZED" });
    expect(f.sent).toHaveLength(0);
    // Same address with a display name is fine and keeps the name.
    await transport.send({ from: "Knox Bot <KNOX@profullstack.com>", to: "a@example.net", subject: "s", text: "t" });
    expect(f.sent[0]?.from).toBe('"Knox Bot" <knox@profullstack.com>');
  });

  it("enforces authorizedSenders at construction and requires TLS on 587", () => {
    expect(() => createSmtpTransport({ ...base, user: "ettinger@gmail.com", authorizedSenders: ["cha0spunk@profullstack.com", "knox@profullstack.com"] })).toThrow("not in authorizedSenders");
    const f = fake();
    createSmtpTransport({ ...base, port: 587, secure: false, authorizedSenders: ["knox@profullstack.com"], createTransport: f.factory });
  });

  it("classifies a 550 5.7.1 rejection so the queue pauses", async () => {
    const f = fake(Object.assign(new Error("Message failed"), { responseCode: 550, response: "550 5.7.1 Relaying denied for victim@example.org", command: "RCPT TO" }));
    const transport = createSmtpTransport({ ...base, createTransport: f.factory });
    const result = await transport.send({ to: "victim@example.org", subject: "s", text: "t" });
    expect(result).toMatchObject({ ok: false, status: 550, enhancedStatus: "5.7.1" });
    expect(result.error).not.toContain("victim@example.org");
    expect(providerCircuitDecision(result, transport)).toMatchObject({ scope: "sender" });
  });
});

describe("unsubscribe ingestion", () => {
  const secret = "unsubscribe-secret-0123456789";

  it("round-trips signed tokens and rejects tampering", () => {
    const token = createUnsubscribeToken("Person <Person@Example.net>", secret);
    expect(verifyUnsubscribeToken(token, secret)).toBe("person@example.net");
    expect(verifyUnsubscribeToken(token + "x", secret)).toBeUndefined();
    expect(verifyUnsubscribeToken(token, "another-secret-0123456789")).toBeUndefined();
  });

  it("writes a provider-agnostic suppression for one-click POST and mailto", async () => {
    const { store, suppressions } = memoryStore();
    const token = createUnsubscribeToken("person@example.net", secret);
    expect(await handleUnsubscribe({ type: "one-click", token, body: "foo=bar" }, { auditStore: store, tokenSecret: secret })).toMatchObject({ ok: false, code: "NOT_ONE_CLICK" });
    expect(await handleUnsubscribe({ type: "one-click", token: "bad.token", body: "List-Unsubscribe=One-Click" }, { auditStore: store, tokenSecret: secret })).toMatchObject({ ok: false, code: "INVALID_TOKEN" });
    expect(await handleUnsubscribe({ type: "one-click", token, body: "List-Unsubscribe=One-Click" }, { auditStore: store, tokenSecret: secret })).toMatchObject({ ok: true, recipient: "person@example.net" });
    expect(await handleUnsubscribe({ type: "mailto", from: "Other <OTHER@example.net>", subject: "unsubscribe" }, { auditStore: store })).toMatchObject({ ok: true, recipient: "other@example.net" });
    expect(suppressions.get("person@example.net")).toMatchObject({ reason: "unsubscribe", source: "one-click" });
    expect(suppressions.get("other@example.net")).toMatchObject({ reason: "unsubscribe", source: "mailto" });
    expect(await getSuppression("PERSON@example.net", { auditStore: store })).toBeDefined();
  });

  it("refuses to suppress with nowhere to write", async () => {
    await expect(suppress("a@example.net", "manual", "admin", {})).rejects.toThrow("needs a Redis URL or an audit store");
  });
});

describe("PostgreSQL schema and store", () => {
  it("adds a recipient-keyed suppression table with an idempotent backfill", () => {
    expect(emailAuditSchema).toContain("CREATE TABLE IF NOT EXISTS email_queue_recipient_suppressions");
    expect(emailAuditSchema).toContain("recipient TEXT PRIMARY KEY");
    expect(emailAuditSchema).toMatch(/INSERT INTO email_queue_recipient_suppressions[\s\S]+ON CONFLICT \(recipient\) DO NOTHING/);
  });

  it("writes and reads suppressions by normalized recipient regardless of provider", async () => {
    const calls: { text: string; values: unknown[] }[] = [];
    const store = new PostgresEmailAuditStore({
      async query(text, values = []) {
        calls.push({ text, values });
        if (text.startsWith("SELECT recipient")) return { rows: [{ recipient: values[0], reason: "complaint", source: "resend.webhook", provider: "resend-prod" }] };
        return { rows: [], rowCount: 1 };
      },
    });
    await store.suppress({ recipient: "Person <Person@Example.net>", reason: "complaint", source: "resend.webhook", provider: "resend-prod" });
    expect(calls[0]?.values[0]).toBe("person@example.net");
    expect(calls[0]?.text).toContain("ON CONFLICT (recipient) DO NOTHING");
    expect(await store.getSuppression("PERSON@example.net")).toMatchObject({ reason: "complaint", provider: "resend-prod" });
    expect(calls[1]?.text).not.toContain("provider =");
    expect(await store.isSuppressed("some-other-provider", "person@example.net")).toBe(true);
  });

  it("routes webhook suppressions into the shared table", async () => {
    const texts: string[] = [];
    const store = new PostgresEmailAuditStore({ async query(text) { texts.push(text); return { rows: [{ event_row_id: 1 }], rowCount: 1 }; } });
    await store.ingestProviderEvent({ provider: "resend-prod", eventId: "e1", type: "email.complained", providerMessageId: "m1", recipient: "x@example.net", status: "COMPLAINED", occurredAt: new Date(), suppressRecipient: true });
    expect(texts.some((text) => text.includes("INSERT INTO email_queue_recipient_suppressions"))).toBe(true);
  });
});

describe("idempotency and configuration", () => {
  it("derives a deterministic transactional job id when no key is given", () => {
    const identity = "smtp|knox@profullstack.com";
    const message: QueuedMessage = { to: "a@example.net", subject: "Hi", text: "Body" };
    expect(mailJobId(identity, message, "transactional")).toBe(mailJobId(identity, { ...message }, "transactional"));
    expect(mailJobId(identity, message, "transactional")).not.toBe(mailJobId(identity, { ...message, text: "Other" }, "transactional"));
  });

  it("reports a missing encryption key clearly", () => {
    expect(emailQueueConfigProblems({}, { EMAIL_QUEUE_REDIS_URL: "redis://x" }).join(" ")).toContain("EMAIL_QUEUE_ENCRYPTION_KEY is not set");
    expect(emailQueueConfigProblems({}, { EMAIL_QUEUE_REDIS_URL: "redis://x", EMAIL_QUEUE_ENCRYPTION_KEY: "short" }).join(" ")).toContain("exactly 32 bytes");
    expect(emailQueueConfigProblems({}, { EMAIL_QUEUE_REDIS_URL: "redis://x", EMAIL_QUEUE_ENCRYPTION_KEY: randomBytes(32).toString("base64") })).toEqual([]);
  });

  it("fails early, with the env var name, when requireEncryption has no key", async () => {
    const previous = process.env.EMAIL_QUEUE_ENCRYPTION_KEY;
    delete process.env.EMAIL_QUEUE_ENCRYPTION_KEY;
    try {
      const sender: DeliveryTransport = { id: "r", type: "resend", from: "a@example.test", async send() { return { ok: true }; } };
      await expect(queuedDelivery(sender, { to: "b@example.net", subject: "s", text: "t" }, "transactional", { redisUrl: "redis://127.0.0.1:1", requireEncryption: true }))
        .rejects.toMatchObject({ code: "CONFIG_INVALID" });
    } finally {
      if (previous !== undefined) process.env.EMAIL_QUEUE_ENCRYPTION_KEY = previous;
    }
  });
});

const testRedisUrl = process.env.EMAIL_QUEUE_TEST_REDIS_URL;

if (testRedisUrl) {
  describe("Redis-backed gates", () => {
    function fakeTransport(type: "resend" | "smtp", answer: (calls: number) => DeliveryResult | Promise<DeliveryResult> = (calls) => ({ ok: true, id: `fake-${calls}` })) {
      let calls = 0;
      const sender: DeliveryTransport = {
        id: `fake-${type}-${randomUUID()}`,
        type,
        from: `gate-${randomUUID()}@example.test`,
        async send() { calls++; return answer(calls); },
      };
      return { sender, get calls() { return calls; } };
    }
    const waitFor = async <T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> => {
      let value = await read();
      for (let attempt = 0; attempt < 300 && !done(value); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        value = await read();
      }
      return value;
    };

    it("a suppression recorded for one provider blocks every other provider at enqueue", async () => {
      const recipient = `Suppressed-${randomUUID()}@Example.test`;
      await suppress(recipient, "hard_bounce", "resend.webhook", { redisUrl: testRedisUrl!, provider: "resend-prod" });
      const smtp = fakeTransport("smtp");
      const result = await queuedDelivery(smtp.sender, { to: recipient.toLowerCase(), subject: "s", text: "t" }, "transactional", { redisUrl: testRedisUrl! });
      expect(result).toMatchObject({ ok: false, state: "SUPPRESSED", code: "RECIPIENT_SUPPRESSED" });
      expect(smtp.calls).toBe(0);
    });

    it("re-checks suppression in the worker immediately before send and refunds the quota", async () => {
      const smtp = fakeTransport("smtp");
      const { store, records } = memoryStore();
      const options = {
        redisUrl: testRedisUrl!, encryptionKey: randomBytes(32).toString("base64"),
        applicationId: `app-${randomUUID()}`, tenantId: `tenant-${randomUUID()}`, providerId: smtp.sender.id, auditStore: store,
      };
      const recipient = `late-${randomUUID()}@example.test`;
      const queued = await queueEmail(smtp.sender, { to: recipient, subject: "s", text: "t" }, "transactional", { ...options, idempotencyKey: `k:${randomUUID()}` });
      expect(queued.state).toBe("QUEUED");
      expect((await getQuotaUsage(smtp.sender, options)).find((scope) => scope.scope === "mailbox")?.used).toBe(1);
      // A Resend complaint lands in PostgreSQL after enqueue, before the worker runs.
      await store.suppress({ recipient, reason: "complaint", source: "resend.webhook", provider: "resend-prod" });
      const worker = await startEmailWorker(smtp.sender, options);
      try {
        const status = await waitFor(() => getEmailStatus(smtp.sender, queued.id, options), (value) => value?.state === "SUPPRESSED");
        expect(status?.state).toBe("SUPPRESSED");
        expect(smtp.calls).toBe(0);
        expect(String(records.get(queued.id)?.error)).toContain("complaint");
        expect((await getQuotaUsage(smtp.sender, options)).find((scope) => scope.scope === "mailbox")?.used).toBe(0);
      } finally { await worker.close(); }
    });

    it("pauses (never reroutes) on a Resend 403 and blocks the next send", async () => {
      const resend = fakeTransport("resend", () => ({ ok: false, status: 403, retryable: false, error: "Resend 403: The example.test domain is not verified." }));
      const options = { redisUrl: testRedisUrl! };
      const first = await queuedDelivery(resend.sender, { to: `a-${randomUUID()}@example.test`, subject: "s", text: "t" }, "transactional", options);
      expect(first).toMatchObject({ ok: false, state: "REJECTED", status: 403 });
      const second = await queuedDelivery(resend.sender, { to: `b-${randomUUID()}@example.test`, subject: "s", text: "t" }, "transactional", options);
      expect(second).toMatchObject({ ok: false, state: "SUPPRESSED", code: "SENDER_PAUSED" });
      expect(resend.calls).toBe(1);
      await resumeEmailQueue(resend.sender, options);
    });

    it("an account-level 401 pauses every identity on the same provider credential", async () => {
      const providerId = `resend-account-${randomUUID()}`;
      const a = fakeTransport("resend", () => ({ ok: false, status: 401, retryable: false, error: "Resend 401: API key is invalid" }));
      const b = fakeTransport("resend");
      const options = { redisUrl: testRedisUrl!, providerId };
      await queuedDelivery(a.sender, { to: `a-${randomUUID()}@example.test`, subject: "s", text: "t" }, "transactional", options);
      const other = await queuedDelivery(b.sender, { to: `b-${randomUUID()}@example.test`, subject: "s", text: "t" }, "transactional", options);
      expect(other).toMatchObject({ ok: false, code: "SENDER_PAUSED" });
      expect(b.calls).toBe(0);
      await resumeEmailQueue(a.sender, options);
      await resumeEmailQueue(b.sender, options);
    });

    for (const [status, error] of [[535, "SMTP 535: 5.7.8 Username and Password not accepted"], [550, "SMTP 550: 5.7.1 Sender address rejected: not owned by user"]] as const) {
      it(`pauses an SMTP mailbox on ${status}`, async () => {
        const smtp = fakeTransport("smtp", () => ({ ok: false, status, retryable: false, error }));
        const options = { redisUrl: testRedisUrl! };
        const first = await queuedDelivery(smtp.sender, { to: `a-${randomUUID()}@example.test`, subject: "s", text: "t" }, "transactional", options);
        expect(first).toMatchObject({ ok: false, state: "REJECTED", status });
        const second = await queuedDelivery(smtp.sender, { to: `b-${randomUUID()}@example.test`, subject: "s", text: "t" }, "transactional", options);
        expect(second).toMatchObject({ ok: false, code: "SENDER_PAUSED" });
        expect(smtp.calls).toBe(1);
        await resumeEmailQueue(smtp.sender, options);
      });
    }

    it("suppresses a recipient after an SMTP 550 5.1.1 hard bounce without pausing the mailbox", async () => {
      const smtp = fakeTransport("smtp", () => ({ ok: false, status: 550, retryable: false, error: "SMTP 550: 5.1.1 No such user" }));
      const recipient = `gone-${randomUUID()}@example.test`;
      const result = await queuedDelivery(smtp.sender, { to: recipient, subject: "s", text: "t" }, "transactional", { redisUrl: testRedisUrl! });
      expect(result.ok).toBe(false);
      expect(await getSuppression(recipient, { redisUrl: testRedisUrl! })).toMatchObject({ reason: "hard_bounce", source: "smtp" });
    });

    it("refunds the reserved quota when the provider definitely refuses", async () => {
      const smtp = fakeTransport("smtp", (calls) => calls === 1 ? { ok: false, status: 400, retryable: false, error: "Bad request" } : { ok: true, id: "ok" });
      const options = { redisUrl: testRedisUrl!, maxPer24Hours: 1, minGapMs: 1000 };
      const first = await queuedDelivery(smtp.sender, { to: `a-${randomUUID()}@example.test`, subject: "s", text: "t" }, "transactional", options);
      expect(first).toMatchObject({ ok: false, state: "FAILED" });
      expect((await getQuotaUsage(smtp.sender, options)).find((scope) => scope.scope === "mailbox")?.used).toBe(0);
      const second = await queuedDelivery(smtp.sender, { to: `b-${randomUUID()}@example.test`, subject: "s", text: "t" }, "transactional", options);
      expect(second).toMatchObject({ ok: true });
      expect(smtp.calls).toBe(2);
    }, 15_000);

    it("keeps the quota spent for an UNKNOWN outcome", async () => {
      const smtp = fakeTransport("smtp", () => { throw new Error("connection reset after DATA"); });
      const options = { redisUrl: testRedisUrl! };
      const first = await queuedDelivery(smtp.sender, { to: `a-${randomUUID()}@example.test`, subject: "s", text: "t" }, "transactional", options);
      expect(first).toMatchObject({ state: "UNKNOWN" });
      expect((await getQuotaUsage(smtp.sender, options)).find((scope) => scope.scope === "mailbox")?.used).toBe(1);
    });

    it("caps sends per recipient domain when configured", async () => {
      const smtp = fakeTransport("smtp");
      const domain = `d${randomUUID().slice(0, 8)}.example`;
      const options = { redisUrl: testRedisUrl!, maxRecipientDomainPer24Hours: 1, minGapMs: 1000 };
      expect((await queuedDelivery(smtp.sender, { to: `a@${domain}`, subject: "s", text: "t" }, "transactional", options)).ok).toBe(true);
      const capped = await queuedDelivery(smtp.sender, { to: `b@${domain}`, subject: "s", text: "t" }, "transactional", options);
      expect(capped).toMatchObject({ ok: false, state: "DEFERRED", code: "QUOTA_EXHAUSTED" });
      expect(capped.error).toContain("recipient-domain");
      expect(smtp.calls).toBe(1);
    }, 15_000);

    it("dedupes a keyless transactional send and writes the PostgreSQL audit", async () => {
      const smtp = fakeTransport("smtp");
      const { store, records } = memoryStore();
      const options = { redisUrl: testRedisUrl!, auditStore: store, applicationId: "mynaposter" };
      const message: QueuedMessage = { to: `same-${randomUUID()}@example.test`, subject: "Receipt", text: "Paid" };
      const first = await queuedDelivery(smtp.sender, message, "transactional", options);
      const again = await queuedDelivery(smtp.sender, { ...message }, "transactional", options);
      expect(first.ok).toBe(true);
      expect(again).toEqual(first);
      expect(smtp.calls).toBe(1);
      const id = mailJobId(queueIdentity(smtp.sender), message, "transactional");
      expect(records.get(id)).toMatchObject({ status: "PROVIDER_ACCEPTED", applicationId: "mynaposter", transport: "smtp" });
    });

    it("sends compliant bulk mail through the queue", async () => {
      const resend = fakeTransport("resend");
      const result = await queuedDelivery(resend.sender, compliantBulk(`bulk-${randomUUID()}@example.test`, { dedupeKey: `issue:${randomUUID()}` }), "bulk", { redisUrl: testRedisUrl!, postalAddress: POSTAL });
      expect(result).toMatchObject({ ok: true, state: "PROVIDER_ACCEPTED" });
      expect(resend.calls).toBe(1);
    });
  });
}
