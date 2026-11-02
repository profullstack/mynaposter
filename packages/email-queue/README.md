# @profullstack/email-queue

BullMQ + Redis delivery scheduling with PostgreSQL audit storage, sender authorization, idempotency, provider-agnostic suppression, bulk-mail compliance gates, and provider circuit breakers. Transports: Resend (`createResendTransport`), SMTP via nodemailer (`createSmtpTransport`), or any `DeliveryTransport`. Gmail is only for approved one-off correspondence; Gmail bulk jobs are rejected.

## Required environment

| Variable | Where | Required | Notes |
| --- | --- | --- | --- |
| `EMAIL_QUEUE_REDIS_URL` | producers and workers | yes | Without it every queued API refuses to send (fails closed, never direct). |
| `EMAIL_QUEUE_ENCRYPTION_KEY` | producers and workers | yes for `queueEmail()` and for `queuedDelivery()` with `requireEncryption: true` (MyNaPoster) | 32 random bytes, base64 or 64 hex chars: `openssl rand -base64 32`. Keep it in the secret manager/vault, never in a job or a repo. The SAME key on every producer and worker. |
| `EMAIL_QUEUE_BLOCKED_SENDERS` | every sender process | recommended | Comma-separated From addresses that may never send (e.g. a restricted Gmail mailbox). |
| `EMAIL_QUEUE_PROVIDER_ID` | MyNaPoster | optional | Stable, non-secret id of the provider credential; shared budgets and the account breaker key off it. |

Call `emailQueueConfigProblems()` (or `assertEmailQueueConfig()`) at process start and log/alert on the result. A missing key otherwise surfaces only as a `CONFIG_INVALID` failure on the first send. MyNaPoster's API server and daemon log these problems at startup.

## Release gate: before enabling automated outbound

Do not point an automated sender (newsletters, OutreachGraph sequences, agents) at this queue until every box is checked for that deployment:

- [ ] `EMAIL_QUEUE_REDIS_URL` and `EMAIL_QUEUE_ENCRYPTION_KEY` set on every producer and worker; `emailQueueConfigProblems()` is empty in the startup log.
- [ ] `PostgresEmailAuditStore.migrate()` has run (adds `email_queue_recipient_suppressions` and backfills it; idempotent) and the store is passed to producers AND workers.
- [ ] Bounces/complaints flow in: Resend webhooks via `processResendWebhook()`; SMTP hard bounces (5.1.1) are suppressed by the worker; IMAP bounce/unsubscribe mail is fed to `handleUnsubscribe({ type: "mailto" })`.
- [ ] One-click unsubscribe endpoint live: an https `List-Unsubscribe` URL that accepts `POST` with body `List-Unsubscribe=One-Click` and calls `handleUnsubscribe({ type: "one-click" })`. No login, no confirmation page.
- [ ] Bulk/marketing callers pass `postalAddress`, the `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers, and the address in both text and HTML bodies (see `listUnsubscribeHeaders()`).
- [ ] Each sender's `authorizedSenders` lists exactly the mailboxes it may use (OutreachGraph: `cha0spunk@profullstack.com`, `knox@profullstack.com`, via SMTP, never Resend).
- [ ] Budgets configured from the real provider limits: `maxPer24Hours`, `maxProviderPer24Hours`, `maxApplicationPer24Hours`, `maxTenantPer24Hours`, and `maxRecipientDomainPer24Hours` for cold outreach.
- [ ] A long-lived `startEmailWorker()` per sender identity, closed on SIGTERM.
- [ ] Someone is alerted when `getProviderHealth()` reports a paused sender, and knows that `resumeEmailQueue()` is a manual, audited action taken only after the provider issue is fixed.
- [ ] Redis and Postgres tests pass: `EMAIL_QUEUE_TEST_REDIS_URL=redis://127.0.0.1:6379 bun test packages/email-queue/test`.

## Safety behavior

- **Suppression is per recipient, not per provider.** A suppression (unsubscribe, hard bounce, complaint, provider suppression, manual) is keyed by the normalized address (trimmed, lower-cased, display name removed; plus-tags and Gmail dots are NOT folded) and blocks every provider, sender, and kind, transactional included. The reporting provider is stored as metadata only. It is checked at enqueue AND again in the worker immediately before the provider call, on both `queueEmail()` and `queuedDelivery()`. Stores: PostgreSQL (`email_queue_recipient_suppressions`) when an audit store is configured, and Redis (`profullstack:email-suppression:v1:*`) so `queuedDelivery()` without PostgreSQL still honors it. Write with `suppress(recipient, reason, source, { redisUrl, auditStore })`.
- **Bulk/marketing compliance.** `kind: "bulk"` or `"marketing"` is refused unless the message has a `List-Unsubscribe` header with an https URL, `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, the `postalAddress` option is set, and the text and HTML bodies both contain that address (whitespace/case/HTML-insensitive). Codes: `BULK_LIST_UNSUBSCRIBE_MISSING`, `BULK_ONE_CLICK_MISSING`, `BULK_POSTAL_ADDRESS_NOT_CONFIGURED`, `BULK_POSTAL_ADDRESS_MISSING`.
- **Circuit breaker: stop, never reroute.** The sender identity pauses (BullMQ queue paused, new submissions refused with `SENDER_PAUSED`) on: any provider 401/403; "account suspended/disabled", "invalid API key"; "domain not verified"; SMTP 530/534/535/538 (auth); any SMTP 5.7.x (security/policy, e.g. 550 5.7.1); a Google 403; and three consecutive throttles. 401, suspension and invalid-key responses also open an account-wide breaker on the `providerId`, pausing every identity on that credential. Nothing ever fails over to another sender or account. Waiting jobs stay in Redis for review; `resumeEmailQueue()` clears both breakers.
- **Quota** is reserved atomically at enqueue across provider, mailbox, application, tenant and (optional) recipient-domain scopes. It is refunded when the message definitely did not reach the provider: a worker-side gate (paused, suppressed, non-compliant), a definite provider refusal, or a failed enqueue. An `UNKNOWN` outcome (socket loss after submission) keeps the quota spent, because the provider may have accepted it.
- **Idempotency.** `queueEmail()` requires an idempotency key. `queuedDelivery()` uses `idempotencyKey`/`dedupeKey` when given; otherwise it derives the key from sender identity + recipient + SHA-256(subject, text, html). An identical message to the same recipient therefore returns the earlier receipt for the 30-day receipt retention instead of sending again; pass a new `idempotencyKey` to deliberately send the same content twice. (Before 0.2.0 keyless transactional sends got a random UUID and were never deduplicated.) The key is also passed to the provider (`Idempotency-Key` on Resend).
- **Audit.** When `auditStore` is configured, `queuedDelivery()` now writes the same PostgreSQL lifecycle as `queueEmail()` (CREATED, QUEUED/DEFERRED, PROCESSING, final state).
- **Redaction.** Every stored error (Redis receipts, PostgreSQL `error` columns, provider event errors) goes through `redactError()`: email addresses, bearer/basic credentials, `key=value` secrets, provider key prefixes (`re_`, `sk_`, `SG.`...), JWTs, long hex/base64 runs, and URL query strings are removed, and the text is capped at 300 characters.
- Message bodies are AES-256-GCM encrypted before they enter Redis when a key is configured (always for `queueEmail()`). Provider credentials stay in the worker process.
- A message `From` must match the transport's configured sender or an explicit `authorizedSenders` list. `EMAIL_QUEUE_BLOCKED_SENDERS` adds a denylist.
- Provider API acceptance is reported as `PROVIDER_ACCEPTED`; only a verified provider webhook can move a record to `DELIVERED`. A connection loss after submission is `UNKNOWN` and is never automatically resent.
- One recipient per job, so each recipient has an independent idempotency key, suppression check, and outcome.

All gate refusals carry a `code` (`DeliveryResult.code`, or `EmailQueueError.code` from `queueEmail()`): `RECIPIENT_SUPPRESSED`, `SENDER_PAUSED`, `SENDER_UNAUTHORIZED`, `SENDER_BLOCKED`, `BULK_*`, `QUOTA_EXHAUSTED`, `IDEMPOTENCY_KEY_REQUIRED`, `CONFIG_INVALID`.

## SMTP transport

```ts
import { createSmtpTransport, startEmailWorker } from "@profullstack/email-queue";

const knox = createSmtpTransport({
  id: "forwardemail-knox",            // stable, non-secret
  host: "smtp.forwardemail.net",
  port: 465, secure: true,            // or 587 + secure:false (STARTTLS required)
  user: "knox@profullstack.com",
  pass: process.env.KNOX_SMTP_PASSWORD!,
  fromName: "Knox",
  authorizedSenders: ["cha0spunk@profullstack.com", "knox@profullstack.com"],
});
await knox.verify();                  // proves the credential before you rely on it
const worker = await startEmailWorker(knox, queueOptions);
```

From and the envelope sender are pinned to `user`. A message asking for another From is refused locally (`SENDER_UNAUTHORIZED`, status 400, no network call); `From`, `Sender`, `Return-Path`, `Reply-To`, `To`, `Cc`, `Bcc` cannot be set through `headers`, and CR/LF are stripped from header values. Constructing a transport for a mailbox outside `authorizedSenders` throws. nodemailer errors map to `{ status: <SMTP reply code>, enhancedStatus: "5.7.1" }` (EAUTH without a code counts as 535; socket errors are status 0 = uncertain) so the breaker can act on them. nodemailer is loaded lazily on first send.

## Unsubscribe ingestion

```ts
import { createUnsubscribeToken, handleUnsubscribe, listUnsubscribeHeaders } from "@profullstack/email-queue";

const token = createUnsubscribeToken(recipient, process.env.UNSUBSCRIBE_SECRET!);
const headers = listUnsubscribeHeaders(`https://example.com/u/${token}`, "unsubscribe@example.com");

// POST /u/:token (RFC 8058 one-click). Always answer 200.
await handleUnsubscribe({ type: "one-click", token, body: await request.text() },
  { tokenSecret: process.env.UNSUBSCRIBE_SECRET!, redisUrl, auditStore });

// An email that arrived at unsubscribe@ (e.g. read over IMAP).
await handleUnsubscribe({ type: "mailto", from: incoming.from, subject: incoming.subject }, { redisUrl, auditStore });
```

Tokens are HMAC-signed and carry the address in base64url, so treat unsubscribe URLs as personal data in logs. Pass `resolveToken` instead of `tokenSecret` to use your own token table.

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

`queuedDelivery()` is the synchronous path MyNaPoster uses (`packages/core/src/core/mail/index.ts`). It refuses direct delivery when Redis is unavailable, retries definite throttles up to three attempts, and never retries uncertain sends.

- Resend and Gmail senders ALWAYS go through the queue (fail closed without Redis), with `requireEncryption: true`, so `EMAIL_QUEUE_ENCRYPTION_KEY` must be set or every Resend/Gmail send fails with `CONFIG_INVALID` (logged at API/daemon startup).
- Non-Google SMTP senders go through the queue only when BOTH `EMAIL_QUEUE_REDIS_URL` and `EMAIL_QUEUE_ENCRYPTION_KEY` are set; otherwise they keep the direct SMTP path exactly as before (with a one-time stderr warning when only the URL is set). This keeps today's deployments working; set the key to put SMTP behind the same gates.
- Newsletters pass the issue's postal address (`newsletter.address`) as `postalAddress`; their existing List-Unsubscribe headers satisfy the bulk gate.
- Other HTTP providers (Mailgun, Postmark, SES, ...) still send directly and are not covered by these gates.

Set `EMAIL_QUEUE_BLOCKED_SENDERS=ettinger@gmail.com` on any confirmed MyNaPoster sender worker to prevent that restricted mailbox from being scheduled. The global blocklist must also be configured in each independent sender application; package code cannot change already deployed services.

## Operational API

The package exports `queueEmail`, `queuedDelivery`, `getEmailStatus`, `cancelEmail`, `listEmailJobs`, `pauseEmailQueue`, `resumeEmailQueue`, `getProviderHealth`, `getQuotaUsage`, `startEmailWorker`, `processResendWebhook`, `createResendTransport`, `createSmtpTransport`, `suppress`, `getSuppression`, `handleUnsubscribe`, `emailQueueConfigProblems`, `assertEmailQueueConfig`, and `redactError`.

## Upgrading to 0.2.0

- `EmailAuditStore` implementations must add `suppress(entry)` and `getSuppression(recipient)`; `isSuppressed(provider, recipient)` is deprecated and optional (the provider argument is ignored). Run `migrate()` once to create and backfill `email_queue_recipient_suppressions`; the old per-provider table is kept for history.
- Bulk/marketing sends without one-click headers and a configured, present postal address are now refused.
- Any provider 401/403, unverified domain, suspended account, SMTP auth failure or SMTP 5.7.x now pauses the sender (previously only Google 403 and persistent throttling).
- Keyless transactional `queuedDelivery()` calls are now deduplicated by content (see Idempotency).
- `EmailKind` adds `"marketing"`.

BullMQ provides the operational queue; PostgreSQL is the durable message and provider-event audit when an `EmailAuditStore` is configured. The package does not itself deploy an authenticated REST service, CLI, MCP server, admin PWA, alert routing, DNS records, or provider credentials. Those integrations and the wider repository migration remain separate deployment work.

## Development

```sh
bun run build
bun test test
```

Redis-backed tests run when `EMAIL_QUEUE_TEST_REDIS_URL` is set. A publication workflow also runs the repository typecheck and Redis integration tests before publishing a version-matched tag.
