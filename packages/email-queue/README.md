# @profullstack/email-queue

BullMQ + Redis delivery scheduling with PostgreSQL audit storage, sender authorization, idempotency, and provider circuit breakers. Resend is the preferred application transport. Gmail is only for approved one-off correspondence; Gmail bulk jobs are rejected.

## Safety behavior

- New `queueEmail()` jobs require an idempotency key, a PostgreSQL audit store, and a 32-byte message encryption key. Email bodies are AES-256-GCM encrypted before they enter Redis. Provider credentials stay in the worker process.
- A message `From` must match the transport's configured sender or an explicit `authorizedSenders` list. `EMAIL_QUEUE_BLOCKED_SENDERS` adds a comma-separated sender denylist.
- Gmail bulk mail is refused. A Google sending restriction or provider `429` pauses that sender's shared BullMQ queue and blocks new submissions. Waiting jobs remain in Redis for administrator review.
- `resumeEmailQueue()` is an administrative operation. Verify provider health and record the action in the calling admin service before resuming.
- Provider API acceptance is reported as `PROVIDER_ACCEPTED`; only a verified provider webhook can move a record to `DELIVERED`. A connection loss after submission is `UNKNOWN` and is never automatically resent.
- Default budgets are conservative local safeguards, not provider guarantees. Configure provider, application, tenant, and mailbox budgets from the actual provider account and service policy.
- The package creates one recipient per job so each recipient has an independent idempotency key and delivery outcome.

## Asynchronous use

```ts
import {
  PostgresEmailAuditStore,
  queueEmail,
  startEmailWorker,
  type DeliveryTransport,
} from "@profullstack/email-queue";

const auditStore = new PostgresEmailAuditStore(pool);
await auditStore.migrate(); // Run through the deployment migration step.

const queueOptions = {
  redisUrl: process.env.EMAIL_QUEUE_REDIS_URL!,
  encryptionKey: process.env.EMAIL_QUEUE_ENCRYPTION_KEY!,
  applicationId: "my-app",
  tenantId: "workspace_42",
  providerId: "profullstack-resend-prod", // Stable non-secret credential identifier shared across apps.
  auditStore,
};

const resendTransport: DeliveryTransport = {
  id: "profullstack-resend-prod",
  type: "resend",
  from: "Profullstack <anthony@profullstack.com>",
  async send(message) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.RESEND_API_KEY!}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...message, to: Array.isArray(message.to) ? message.to : [message.to] }),
    });
    const result = await response.json() as { id?: string; message?: string };
    return response.ok
      ? { ok: true, status: response.status, id: result.id }
      : { ok: false, status: response.status, retryable: response.status === 429 || response.status >= 500, error: result.message ?? "Resend rejected the request." };
  },
};
const worker = await startEmailWorker(resendTransport, queueOptions);
const job = await queueEmail(resendTransport, {
  to: "person@example.net",
  subject: "Receipt",
  text: "Payment received.",
}, "transactional", {
  ...queueOptions,
  idempotencyKey: "payment:payment_123:receipt:v1",
});

// Keep the worker alive for the service lifetime; close it on SIGTERM.
await worker.close();
```

The `DeliveryTransport` adapter must use a verified provider sender and keep API credentials in its closure. `providerId` is an identifier, never a key. The same ID and budget must be used in every app sharing the provider account.

## Resend webhooks

Pass the untouched request body and `svix-id`, `svix-timestamp`, and `svix-signature` headers to `processResendWebhook()`. It verifies the signature and timestamp, deduplicates by provider event ID and recipient, records the provider event, updates the PostgreSQL lifecycle, and suppresses hard bounces, complaints, and provider suppressions.

```ts
const result = await processResendWebhook(
  await request.text(),
  request.headers,
  process.env.RESEND_WEBHOOK_SECRET!,
  "profullstack-resend-prod",
  auditStore,
);
```

Use the route's authentication and request-size controls as well. Do not parse and reserialize the body before verification.

## MyNaPoster

The existing `queuedDelivery()` API remains available for compatibility. It refuses direct delivery when Redis is unavailable and never retries uncertain sends. The MyNaPoster queue path now requires `EMAIL_QUEUE_ENCRYPTION_KEY` as a service secret for its Resend/Gmail sends. The key must be 32 random bytes encoded as base64 or 64 hexadecimal characters. Configure it in the approved secret manager before enabling queued sends; do not commit it or put it in a job payload.

Set `EMAIL_QUEUE_BLOCKED_SENDERS=ettinger@gmail.com` on any confirmed MyNaPoster sender worker to prevent that restricted mailbox from being scheduled. The global blocklist must also be configured in each independent sender application; package code cannot change already deployed services.

## Operational API

The package exports `queueEmail`, `queuedDelivery`, `getEmailStatus`, `cancelEmail`, `listEmailJobs`, `pauseEmailQueue`, `resumeEmailQueue`, `getProviderHealth`, `getQuotaUsage`, `startEmailWorker`, and `processResendWebhook`.

BullMQ provides the operational queue; PostgreSQL is the durable message and provider-event audit when an `EmailAuditStore` is configured. The package does not itself deploy an authenticated REST service, CLI, MCP server, admin PWA, alert routing, DNS records, or provider credentials. Those integrations and the wider repository migration remain separate deployment work.

## Development

```sh
bun run build
bun test test
```

Redis-backed tests run when `EMAIL_QUEUE_TEST_REDIS_URL` is set. A publication workflow also runs the repository typecheck and Redis integration tests before publishing a version-matched tag.
