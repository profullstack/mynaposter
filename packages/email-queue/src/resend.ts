import type { DeliveryResult, DeliveryTransport, QueuedMessage } from "./index.js";
import { createHash } from "node:crypto";

export interface ResendTransportOptions {
  id: string;
  apiKey: string;
  /** Must be an address on a domain verified by Resend. */
  from: string;
  fetchImpl?: typeof fetch;
}

/** Resend API adapter. The key is captured in this worker-side closure, never in a job. */
export function createResendTransport(options: ResendTransportOptions): DeliveryTransport {
  if (!options.id.trim() || !options.apiKey.trim() || !options.from.trim()) {
    throw new Error("Resend transport requires a stable id, API key, and verified From address.");
  }
  const fetcher = options.fetchImpl ?? fetch;
  return {
    id: options.id,
    type: "resend",
    from: options.from,
    async send(message: QueuedMessage, sendOptions = {}): Promise<DeliveryResult> {
      const to = Array.isArray(message.to) ? message.to : [message.to];
      const idempotencyKey = sendOptions.idempotencyKey
        ? sendOptions.idempotencyKey.length <= 256
          ? sendOptions.idempotencyKey
          : `sha256:${createHash("sha256").update(sendOptions.idempotencyKey).digest("hex")}`
        : undefined;
      const response = await fetcher("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
        body: JSON.stringify({
          from: message.from ?? options.from,
          to,
          subject: message.subject,
          text: message.text,
          ...(message.html ? { html: message.html } : {}),
          ...(message.replyTo ? { reply_to: message.replyTo } : {}),
          ...(message.headers && Object.keys(message.headers).length ? { headers: message.headers } : {}),
        }),
      });
      const text = await response.text().catch(() => "");
      let body: { id?: string; message?: string; name?: string } = {};
      try { body = text ? JSON.parse(text) as typeof body : {}; } catch { body = {}; }
      if (!response.ok) {
        const messageText = body.message || body.name || text.slice(0, 500) || `HTTP ${response.status}`;
        return {
          ok: false,
          status: response.status,
          retryable: response.status === 408 || response.status === 429 || response.status >= 500,
          error: `Resend ${response.status}: ${messageText}`,
        };
      }
      return { ok: true, status: response.status, ...(body.id ? { id: body.id, providerMessageId: body.id } : {}) };
    },
  };
}
