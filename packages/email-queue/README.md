# @profullstack/email-queue

BullMQ + Redis rate-limited delivery of Gmail SMTP and Resend. Used by MyNaPoster.

## Safety defaults
- Gmail SMTP (including custom-domain mail through smtp.gmail.com): **100 emails per mailbox per 24 hours, one every 10 minutes**.
- Resend: **1,000 per From address per 24 hours, one per second** (lower according to your actual plan).
- Limits share Redis keys across processes. No provider credentials in jobs.
- Idempotent newsletter delivery keyed by issue + contact, with a retained receipt.
- **No automatic retries** of uncertain SMTP/HTTP sends; check the provider and manually reconcile.
- If Redis is unavailable, Gmail and Resend deliveries fail closed.

## MyNaPoster

Set \`EMAIL_QUEUE_REDIS_URL=redis://127.0.0.1:6379\` (or \`REDIS_URL\`), then send normally.
The CLI process provides a BullMQ worker for its own sends; multiple processes use the same
per-sender queue and rate limiter. Install Redis before resuming a newsletter blast.
Existing Gmail restrictions must clear at Google's discretion.

Run \`bun install\` to resolve the new workspace dependencies and refresh \`bun.lock\` before merging.
Run \`bun run typecheck\` and \`bun test packages/email-queue/test\` against Redis in CI.

**Publish:** \`cd packages/email-queue && bun run build && npm publish --access public\`
before using this package outside the MyNaPoster workspace.

Limitations: this does not automatically migrate independent applications using direct provider APIs.
Those call sites need separate audited integration PRs. No deployment or publish is performed here.
