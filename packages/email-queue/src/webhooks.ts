import { createHmac, timingSafeEqual } from "node:crypto";
import type { EmailAuditStore } from "./audit.js";
import type { DeliveryState } from "./index.js";

export type ResendWebhookHeaders = Headers | Record<string, string | undefined>;

export interface ResendWebhookResult {
  verified: true;
  eventId: string;
  type: string;
  handled: boolean;
  inserted: number;
}

function header(headers: ResendWebhookHeaders, key: string): string | undefined {
  if (headers instanceof Headers) return headers.get(key) ?? undefined;
  const wanted = key.toLowerCase();
  const found = Object.entries(headers).find(([name]) => name.toLowerCase() === wanted)?.[1];
  return found?.trim() || undefined;
}

/** Verifies the unchanged raw body using Resend's Svix id/timestamp/signature headers. */
export function verifyResendWebhook(
  rawBody: string,
  headers: ResendWebhookHeaders,
  webhookSecret: string,
  options: { now?: number; toleranceSeconds?: number } = {},
): Record<string, unknown> {
  if (rawBody.length > 1_000_000) throw new Error("Resend webhook body exceeds 1 MB.");
  const id = header(headers, "svix-id");
  const timestamp = header(headers, "svix-timestamp");
  const signatures = header(headers, "svix-signature");
  if (!id || !timestamp || !signatures || !webhookSecret) throw new Error("Missing Resend webhook verification headers or secret.");
  const timestampSeconds = Number(timestamp);
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  if (!Number.isFinite(timestampSeconds) || Math.abs(nowSeconds - timestampSeconds) > (options.toleranceSeconds ?? 300)) {
    throw new Error("Resend webhook timestamp is outside the allowed tolerance.");
  }
  const encodedSecret = webhookSecret.replace(/^whsec_/, "");
  const key = Buffer.from(encodedSecret, "base64");
  if (!key.length) throw new Error("Invalid Resend webhook signing secret.");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest();
  const valid = signatures.split(" ").some((entry) => {
    const [version, encoded] = entry.split(",", 2);
    if (version !== "v1" || !encoded) return false;
    const supplied = Buffer.from(encoded, "base64");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  });
  if (!valid) throw new Error("Invalid Resend webhook signature.");
  let event: unknown;
  try { event = JSON.parse(rawBody); }
  catch { throw new Error("Resend webhook body is not valid JSON."); }
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("Resend webhook payload must be an object.");
  return event as Record<string, unknown>;
}

const eventStatus: Record<string, DeliveryState> = {
  "email.sent": "SENT",
  "email.delivered": "DELIVERED",
  "email.delivery_delayed": "DELIVERY_DELAYED",
  "email.bounced": "BOUNCED",
  "email.complained": "COMPLAINED",
  "email.suppressed": "SUPPRESSED",
  "email.failed": "FAILED",
};

/** Verifies, deduplicates, and stores recipient-level Resend delivery outcomes. */
export async function processResendWebhook(
  rawBody: string,
  headers: ResendWebhookHeaders,
  webhookSecret: string,
  providerId: string,
  store: EmailAuditStore,
  verifyOptions: { now?: number; toleranceSeconds?: number } = {},
): Promise<ResendWebhookResult> {
  const payload = verifyResendWebhook(rawBody, headers, webhookSecret, verifyOptions);
  const eventId = header(headers, "svix-id") as string;
  const type = typeof payload.type === "string" ? payload.type : "";
  const status = eventStatus[type];
  if (!status) return { verified: true, eventId, type, handled: false, inserted: 0 };
  const data = payload.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Resend webhook has no data object.");
  const record = data as Record<string, unknown>;
  const providerMessageId = typeof record.email_id === "string" ? record.email_id : "";
  const recipients = Array.isArray(record.to) ? record.to.filter((x): x is string => typeof x === "string" && x.includes("@")) : [];
  const occurredAtValue = typeof payload.created_at === "string" ? payload.created_at : typeof record.created_at === "string" ? record.created_at : "";
  const occurredAt = new Date(occurredAtValue);
  if (!providerMessageId || !recipients.length || Number.isNaN(occurredAt.getTime())) throw new Error("Resend webhook is missing email_id, recipient, or a valid event timestamp.");

  const bounce = record.bounce && typeof record.bounce === "object" ? record.bounce as Record<string, unknown> : undefined;
  const error = typeof bounce?.message === "string" ? bounce.message : typeof record.reason === "string" ? record.reason : undefined;
  const hardBounce = type === "email.bounced" && typeof bounce?.type === "string" && bounce.type.toLowerCase() === "permanent";
  const suppressRecipient = hardBounce || type === "email.complained" || type === "email.suppressed";
  let inserted = 0;
  for (const recipient of recipients) {
    const added = await store.ingestProviderEvent({
      provider: providerId,
      eventId,
      type,
      providerMessageId,
      recipient,
      status,
      occurredAt,
      ...(error ? { error } : {}),
      ...(typeof record.message_id === "string" ? { rfcMessageId: record.message_id } : {}),
      ...(suppressRecipient ? { suppressRecipient: true } : {}),
    });
    if (added) inserted++;
  }
  return { verified: true, eventId, type, handled: true, inserted };
}
