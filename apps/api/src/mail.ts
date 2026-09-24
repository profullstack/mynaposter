/**
 * Hosted sending: myna cloud sends mail for a signed-in user, through
 * Profullstack's own Resend account.
 *
 * The client is the `myna-cloud` mail provider (core/mail/providers.ts),
 * which POSTs {kind, messages[]} to /v1/mail/send with the cloud token. Three
 * gates stand between that and Resend:
 *
 *   1. The account. Only a signed-in myna cloud user reaches this.
 *   2. The daily cap. Every account may send MYNA_MAIL_DAILY_CAP messages
 *      (100 by default) in any 24 hours. A batch is reserved in the ledger
 *      before it goes, so two calls at once cannot both slip under the cap.
 *   3. The verified-from rule. Resend only sends from domains verified in
 *      the Profullstack account, and nobody should be able to send as
 *      somebody else. So the From is always MYNA_MAIL_FROM's address, with
 *      the sender's display name and "via myna", and Reply-To is the
 *      account's own email. The one exception is an account listed in
 *      MYNA_MAIL_TRUSTED_ACCOUNTS (Profullstack's own), which may send from
 *      any address on a domain in MYNA_MAIL_DOMAINS.
 *
 * Each message has exactly one recipient, a newsletter (`kind: "bulk"`)
 * must carry List-Unsubscribe, and only list and precedence headers pass
 * through. RESEND_API_KEY comes from the environment; without it the route
 * answers 503 and nothing else changes.
 */
import { db } from "./db/index.ts";
import type { CloudUser } from "./cloud.ts";

export interface HostedConfig {
  apiKey: string;
  /** `myna <mail@mynaposter.com>`: the address on a Resend-verified domain everything goes out from. */
  from: string;
  /** Domains verified in the Resend account. */
  domains: string[];
  /** Account emails that may send as any address on those domains. */
  trusted: string[];
  dailyCap: number;
  resendUrl: string;
}

export function hostedConfig(env: Record<string, string | undefined> = process.env): HostedConfig {
  const from = env.MYNA_MAIL_FROM?.trim() || "myna <mail@mynaposter.com>";
  const list = (value: string | undefined): string[] =>
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
  const domains = list(env.MYNA_MAIL_DOMAINS);
  return {
    apiKey: env.RESEND_API_KEY?.trim() ?? "",
    from,
    domains: domains.length ? domains : [domainOf(addressOf(from))],
    trusted: list(env.MYNA_MAIL_TRUSTED_ACCOUNTS),
    dailyCap: Math.max(0, Number(env.MYNA_MAIL_DAILY_CAP ?? 100) || 0),
    resendUrl: (env.MYNA_RESEND_URL ?? "https://api.resend.com").replace(/\/+$/, ""),
  };
}

export const MAX_BATCH = 100;

/** Headers a hosted message may carry. Everything else is dropped. */
const PASSED_HEADERS = new Set(["list-unsubscribe", "list-unsubscribe-post", "list-id", "precedence"]);

export function addressOf(value: string): string {
  const match = /<([^>]+)>/.exec(value);
  return (match ? match[1] : value).trim().toLowerCase();
}

const domainOf = (address: string): string => address.split("@")[1] ?? "";

const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

/** A display name with nothing that could break out of the header. */
function cleanName(value: string): string {
  return value
    .replace(/[\r\n"<>\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

/**
 * The From and Reply-To a message actually gets. A trusted account on a
 * verified domain keeps its own From; everyone else sends as
 * `"<name> via myna" <MYNA_MAIL_FROM>` with Reply-To their own address.
 */
export function verifiedFrom(requested: string | undefined, account: CloudUser, config: HostedConfig): { from: string; replyTo: string } {
  const asked = requested?.trim() ?? "";
  const address = addressOf(asked);
  const accountEmail = account.email.toLowerCase();
  if (EMAIL.test(address) && config.trusted.includes(accountEmail) && config.domains.includes(domainOf(address))) {
    return { from: asked.includes("<") ? asked.replace(/[\r\n]/g, "") : address, replyTo: accountEmail };
  }
  const base = addressOf(config.from);
  const named = asked.includes("<") ? cleanName(asked.slice(0, asked.indexOf("<")).replace(/^"|"$/g, "")) : "";
  const name = named || cleanName(EMAIL.test(address) ? (address.split("@")[0] ?? "") : asked) || cleanName(accountEmail.split("@")[0] ?? "") || "myna";
  return { from: `"${name} via myna" <${base}>`, replyTo: accountEmail };
}

export interface HostedMessage {
  from?: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

export interface HostedResult {
  ok: boolean;
  id?: string;
  error?: string;
  retryable?: boolean;
}

export type HostedReply =
  | { status: 200; body: { ok: true; results: HostedResult[]; used: number; cap: number } }
  | { status: 400 | 403 | 429 | 502 | 503; body: { ok: false; error: string; retryable: boolean } };

/** What a batch reservation needs from storage; Postgres in the server, a map in the tests. */
export interface MailLedger {
  /** Reserve n sends now; answers how many the account has used in 24h including these. */
  reserve(userId: string, n: number): Promise<{ id: string; used: number }>;
  /** Give a reservation back, whole or the part that did not go. */
  release(reservation: string, unsent: number): Promise<void>;
}

/** Validate the request; the error says what to fix. */
export function parseBatch(input: unknown): { kind: "transactional" | "bulk"; messages: HostedMessage[] } | { error: string } {
  const body = (input ?? {}) as { kind?: unknown; messages?: unknown };
  const kind = body.kind === "bulk" ? "bulk" : "transactional";
  if (!Array.isArray(body.messages) || !body.messages.length) return { error: "messages: a non-empty array." };
  if (body.messages.length > MAX_BATCH) return { error: `At most ${MAX_BATCH} messages per call.` };
  const messages: HostedMessage[] = [];
  for (const [index, raw] of body.messages.entries()) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const to = (Array.isArray(entry.to) ? entry.to : [entry.to]).filter((value): value is string => typeof value === "string" && value.trim() !== "");
    if (to.length !== 1) return { error: `messages[${index}]: exactly one recipient per message.` };
    const address = addressOf(to[0] as string);
    if (!EMAIL.test(address)) return { error: `messages[${index}]: ${to[0]} is not an email address.` };
    if (typeof entry.subject !== "string" || !entry.subject.trim()) return { error: `messages[${index}]: a subject.` };
    if (typeof entry.text !== "string" || !entry.text.trim()) return { error: `messages[${index}]: a text body.` };
    const headers: Record<string, string> = {};
    if (entry.headers && typeof entry.headers === "object") {
      for (const [name, value] of Object.entries(entry.headers as Record<string, unknown>)) {
        if (typeof value !== "string" || !PASSED_HEADERS.has(name.toLowerCase())) continue;
        headers[name] = value.replace(/[\r\n]+/g, " ").trim();
      }
    }
    if (kind === "bulk" && !Object.keys(headers).some((name) => name.toLowerCase() === "list-unsubscribe"))
      return { error: `messages[${index}]: a newsletter needs a List-Unsubscribe header.` };
    messages.push({
      to: [address],
      subject: entry.subject.replace(/[\r\n]+/g, " ").trim(),
      text: entry.text,
      ...(typeof entry.html === "string" && entry.html ? { html: entry.html } : {}),
      ...(typeof entry.from === "string" ? { from: entry.from } : {}),
      headers,
    });
  }
  return { kind, messages };
}

/** Send one batch for one account: reserve under the cap, POST to Resend's batch endpoint, settle. */
export async function hostedSend(
  account: CloudUser,
  input: unknown,
  deps: { config?: HostedConfig; ledger: MailLedger; fetch?: typeof fetch; idempotencyKey?: string },
): Promise<HostedReply> {
  const config = deps.config ?? hostedConfig();
  if (!config.apiKey) return { status: 503, body: { ok: false, error: "Hosted sending is off on this instance (no RESEND_API_KEY).", retryable: false } };
  const parsed = parseBatch(input);
  if ("error" in parsed) return { status: 400, body: { ok: false, error: parsed.error, retryable: false } };
  const { messages } = parsed;

  const reservation = await deps.ledger.reserve(account.id, messages.length);
  if (reservation.used > config.dailyCap) {
    await deps.ledger.release(reservation.id, messages.length);
    const left = Math.max(0, config.dailyCap - (reservation.used - messages.length));
    return {
      status: 429,
      body: { ok: false, error: `Daily cap: myna cloud sends ${config.dailyCap} a day per account and ${left} are left. Try again tomorrow, or add your own provider (myna mail provider add).`, retryable: true },
    };
  }

  const payload = messages.map((message) => {
    const { from, replyTo } = verifiedFrom(message.from, account, config);
    return {
      from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
      reply_to: replyTo,
      ...(Object.keys(message.headers ?? {}).length ? { headers: message.headers } : {}),
    };
  });
  const fetcher = deps.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetcher(`${config.resendUrl}/emails/batch`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
        ...(deps.idempotencyKey ? { "idempotency-key": `${account.id}:${deps.idempotencyKey}`.slice(0, 256) } : {}),
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    // Nobody knows whether Resend took it, so the reservation stands.
    return { status: 502, body: { ok: false, error: `Resend did not answer: ${(error as Error).message}`, retryable: true } };
  }
  const text = await response.text().catch(() => "");
  let reply: { data?: { id?: string }[]; message?: string; name?: string } | null = null;
  try {
    reply = text ? JSON.parse(text) : null;
  } catch {
    reply = null;
  }
  if (!response.ok) {
    await deps.ledger.release(reservation.id, messages.length);
    const retryable = response.status === 429 || response.status >= 500;
    // Resend's own 4xx (a bad address, a validation error) is the sender's to fix; a 401/403 is ours.
    const ours = response.status === 401 || response.status === 403;
    return {
      status: retryable ? 429 : ours ? 503 : 400,
      body: { ok: false, error: ours ? "Hosted sending is misconfigured on this instance." : `Resend ${response.status}: ${reply?.message ?? text.slice(0, 200)}`, retryable },
    };
  }
  const data = reply?.data ?? [];
  const results: HostedResult[] = messages.map((_, index) => {
    const id = data[index]?.id;
    return id ? { ok: true, id } : { ok: false, error: "Resend gave no id for this message.", retryable: false };
  });
  const unsent = results.filter((result) => !result.ok).length;
  if (unsent) await deps.ledger.release(reservation.id, unsent);
  return { status: 200, body: { ok: true, results, used: reservation.used - unsent, cap: config.dailyCap } };
}

// ---------------------------------------------------------------- Postgres

/** The ledger over cloud_mail_sends: one row per batch, summed over the last 24 hours. */
export const pgLedger: MailLedger = {
  async reserve(userId, n) {
    const rows = (await db()`
      insert into cloud_mail_sends (user_id, count) values (${userId}, ${n}) returning id
    `) as unknown as { id: string }[];
    const used = (await db()`
      select coalesce(sum(count), 0)::int as used from cloud_mail_sends
      where user_id = ${userId} and at > now() - interval '24 hours'
    `) as unknown as { used: number }[];
    return { id: String(rows[0]?.id), used: Number(used[0]?.used ?? n) };
  },
  async release(reservation, unsent) {
    await db()`update cloud_mail_sends set count = greatest(0, count - ${unsent}) where id = ${reservation}`;
  },
};
