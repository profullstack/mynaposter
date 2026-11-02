import { randomUUID } from "node:crypto";
import type { DeliveryState } from "./index.js";
import { normalizeRecipient } from "./gates.js";
import { redactError } from "./redact.js";

/** A deliberately small SQL surface compatible with pg.Pool and pg.Client. */
export interface EmailSqlExecutor {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

export interface EmailAuditRecord {
  id: string;
  provider: string;
  providerMessageId?: string;
  rfcMessageId?: string;
  applicationId: string;
  tenantId?: string;
  sender: string;
  recipient: string;
  transport: string;
  status: DeliveryState;
  error?: string;
  idempotencyKey?: string;
}

export interface EmailAuditEvent {
  provider: string;
  eventId: string;
  type: string;
  providerMessageId: string;
  recipient: string;
  status: DeliveryState;
  occurredAt: Date;
  error?: string;
  rfcMessageId?: string;
  suppressRecipient?: boolean;
}

/** A provider-agnostic suppression: one row per normalized recipient address. */
export interface SuppressionEntry {
  recipient: string;
  /** Why: "unsubscribe", "hard_bounce", "complaint", "provider_suppressed", "manual", ... */
  reason: string;
  /** Where it came from: "one-click", "mailto", "resend.webhook", "smtp", "admin", ... */
  source: string;
  /** Metadata only. A suppression blocks every provider and sender. */
  provider?: string;
  sourceEventId?: string;
}

export interface SuppressionRecord {
  recipient: string;
  reason: string;
  source: string;
  provider?: string;
  createdAt?: Date;
}

export interface EmailAuditStore {
  migrate(): Promise<void>;
  create(record: EmailAuditRecord): Promise<void>;
  transition(id: string, status: DeliveryState, details?: { providerMessageId?: string; rfcMessageId?: string; error?: string }): Promise<void>;
  get(id: string): Promise<Record<string, unknown> | undefined>;
  ingestProviderEvent(event: EmailAuditEvent): Promise<boolean>;
  /** Writes a provider-agnostic suppression keyed by the normalized recipient. Idempotent. */
  suppress(entry: SuppressionEntry): Promise<void>;
  /** The suppression for this recipient from ANY provider/source, if one exists. */
  getSuppression(recipient: string): Promise<SuppressionRecord | undefined>;
  /** @deprecated The provider argument is ignored; suppressions are provider-agnostic since 0.2.0. */
  isSuppressed?(provider: string, recipient: string): Promise<boolean>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS email_queue_messages (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_message_id TEXT,
  rfc_message_id TEXT,
  application_id TEXT NOT NULL,
  tenant_id TEXT,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  transport TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_provider_event_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS email_queue_messages_app_created_idx ON email_queue_messages(application_id, created_at DESC);
CREATE INDEX IF NOT EXISTS email_queue_messages_tenant_created_idx ON email_queue_messages(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS email_queue_messages_provider_message_idx ON email_queue_messages(provider, provider_message_id);
CREATE INDEX IF NOT EXISTS email_queue_messages_recipient_idx ON email_queue_messages(recipient, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS email_queue_messages_idempotency_idx
  ON email_queue_messages(application_id, COALESCE(tenant_id, ''), idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS email_queue_events (
  event_row_id BIGSERIAL PRIMARY KEY,
  message_id TEXT REFERENCES email_queue_messages(id) ON DELETE SET NULL,
  event_id TEXT,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  recipient TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  error TEXT
);
CREATE INDEX IF NOT EXISTS email_queue_events_message_idx ON email_queue_events(message_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS email_queue_provider_events (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  error TEXT,
  PRIMARY KEY (provider, event_id, recipient)
);
CREATE TABLE IF NOT EXISTS email_queue_suppressions (
  provider TEXT NOT NULL,
  recipient TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, recipient)
);

-- 0.2.0: suppressions are keyed by normalized recipient, independent of provider.
-- email_queue_suppressions (per provider) is kept read-only for history and
-- backfilled here on every migrate; the statement is idempotent.
CREATE TABLE IF NOT EXISTS email_queue_recipient_suppressions (
  recipient TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  source TEXT NOT NULL,
  provider TEXT,
  source_event_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO email_queue_recipient_suppressions (recipient, reason, source, provider, source_event_id, created_at)
  SELECT DISTINCT ON (lower(trim(recipient))) lower(trim(recipient)), reason, 'legacy.provider_suppression', provider, source_event_id, created_at
  FROM email_queue_suppressions
  ORDER BY lower(trim(recipient)), created_at
ON CONFLICT (recipient) DO NOTHING;
`;

export class PostgresEmailAuditStore implements EmailAuditStore {
  constructor(private readonly sql: EmailSqlExecutor) {}

  async migrate(): Promise<void> {
    await this.sql.query(SCHEMA);
  }

  async create(record: EmailAuditRecord): Promise<void> {
    await this.sql.query(
      `INSERT INTO email_queue_messages
        (id, provider, provider_message_id, rfc_message_id, application_id, tenant_id, sender, recipient, transport, status, error, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO NOTHING`,
      [record.id, record.provider, record.providerMessageId ?? null, record.rfcMessageId ?? null, record.applicationId, record.tenantId ?? null, record.sender, record.recipient, record.transport, record.status, record.error ? redactError(record.error) : null, record.idempotencyKey ?? null],
    );
    await this.sql.query(
      `INSERT INTO email_queue_events (message_id, event_id, event_type, source, status, recipient)
       VALUES ($1,$2,'created','queue',$3,$4) ON CONFLICT DO NOTHING`,
      [record.id, randomUUID(), record.status, record.recipient],
    );
  }

  async transition(id: string, status: DeliveryState, details: { providerMessageId?: string; rfcMessageId?: string; error?: string } = {}): Promise<void> {
    const eventId = randomUUID();
    await this.sql.query(
      `WITH updated AS (
         UPDATE email_queue_messages SET
           status = $2,
           provider_message_id = COALESCE($3, provider_message_id),
           rfc_message_id = COALESCE($4, rfc_message_id),
           error = $5,
           updated_at = now()
         WHERE id = $1 RETURNING id, recipient
       )
       INSERT INTO email_queue_events (message_id, event_id, event_type, source, status, recipient, error)
       SELECT id, $6, 'state.changed', 'queue', $2, recipient, $5 FROM updated`,
      [id, status, details.providerMessageId ?? null, details.rfcMessageId ?? null, details.error ? redactError(details.error) : null, eventId],
    );
    // A webhook can beat the worker's provider-accepted update. Reapply the
    // newest stored provider event so a late queue transition cannot downgrade
    // a delivered, bounced, or complained message.
    await this.sql.query(
      `UPDATE email_queue_messages m SET
         status = e.status,
         error = e.error,
         last_provider_event_at = e.occurred_at,
         updated_at = now()
       FROM email_queue_provider_events e
       WHERE m.id = $1
         AND e.provider = m.provider
         AND e.provider_message_id = m.provider_message_id
         AND lower(e.recipient) = lower(m.recipient)
         AND NOT EXISTS (
           SELECT 1 FROM email_queue_provider_events newer
           WHERE newer.provider = e.provider
             AND newer.provider_message_id = e.provider_message_id
             AND lower(newer.recipient) = lower(e.recipient)
             AND (newer.occurred_at > e.occurred_at OR (newer.occurred_at = e.occurred_at AND newer.event_id > e.event_id))
         )
         AND (m.last_provider_event_at IS NULL OR m.last_provider_event_at <= e.occurred_at)`,
      [id],
    );
  }

  async get(id: string): Promise<Record<string, unknown> | undefined> {
    const result = await this.sql.query("SELECT * FROM email_queue_messages WHERE id = $1", [id]);
    return result.rows[0];
  }

  async ingestProviderEvent(event: EmailAuditEvent): Promise<boolean> {
    let insertedAny = false;
    for (const recipient of [event.recipient.toLowerCase()]) {
      const result = await this.sql.query(
        `WITH inserted AS (
           INSERT INTO email_queue_provider_events
             (provider, event_id, recipient, provider_message_id, event_type, status, occurred_at, error)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (provider, event_id, recipient) DO NOTHING
           RETURNING provider, event_id, recipient, provider_message_id
         ), updated AS (
           UPDATE email_queue_messages m SET
             status = $6,
             error = $8,
             rfc_message_id = COALESCE($9, m.rfc_message_id),
             last_provider_event_at = $7,
             updated_at = now()
           FROM inserted i
           WHERE m.provider = i.provider
             AND m.provider_message_id = i.provider_message_id
             AND lower(m.recipient) = i.recipient
             AND (m.last_provider_event_at IS NULL OR m.last_provider_event_at <= $7)
           RETURNING m.id, m.recipient
         )
         INSERT INTO email_queue_events (message_id, event_id, event_type, source, status, recipient, occurred_at, error)
         SELECT updated.id, $2, $5, 'resend.webhook', $6, inserted.recipient, $7, $8
         FROM inserted LEFT JOIN updated ON updated.recipient = inserted.recipient
         RETURNING event_row_id`,
        [event.provider, event.eventId, recipient, event.providerMessageId, event.type, event.status, event.occurredAt, event.error ? redactError(event.error) : null, event.rfcMessageId ?? null],
      );
      insertedAny ||= (result.rowCount ?? result.rows.length) > 0;
      if (event.suppressRecipient) {
        await this.suppress({
          recipient,
          reason: event.type === "email.complained" ? "complaint" : event.type === "email.bounced" ? "hard_bounce" : event.type === "email.suppressed" ? "provider_suppressed" : event.type,
          source: `${event.provider}.webhook`,
          provider: event.provider,
          sourceEventId: event.eventId,
        });
      }
    }
    return insertedAny;
  }

  async suppress(entry: SuppressionEntry): Promise<void> {
    const recipient = normalizeRecipient(entry.recipient);
    if (!recipient.includes("@")) throw new Error("Suppression requires a recipient address.");
    await this.sql.query(
      `INSERT INTO email_queue_recipient_suppressions (recipient, reason, source, provider, source_event_id)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (recipient) DO NOTHING`,
      [recipient, entry.reason, entry.source, entry.provider ?? null, entry.sourceEventId ?? null],
    );
  }

  async getSuppression(recipient: string): Promise<SuppressionRecord | undefined> {
    const result = await this.sql.query(
      "SELECT recipient, reason, source, provider, created_at FROM email_queue_recipient_suppressions WHERE recipient = $1 LIMIT 1",
      [normalizeRecipient(recipient)],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      recipient: String(row.recipient),
      reason: String(row.reason),
      source: String(row.source),
      ...(typeof row.provider === "string" ? { provider: row.provider } : {}),
      ...(row.created_at instanceof Date ? { createdAt: row.created_at } : {}),
    };
  }

  /** @deprecated Provider is ignored; see getSuppression. */
  async isSuppressed(_provider: string, recipient: string): Promise<boolean> {
    return Boolean(await this.getSuppression(recipient));
  }
}

export const emailAuditSchema = SCHEMA;
