/**
 * Credits for the hosted MCP: free every month, then pay as you go.
 *
 * Every myna cloud account gets FREE_MONTHLY credits each calendar month (UTC,
 * no rollover). The AI tools (analyze a site, write posts, suggest places)
 * spend one credit per call; managing hand-off cards and the rest is free.
 * More credits are bought with CoinPay (crypto or PayPal) as one-off grants
 * that never expire.
 *
 * The balance is @profullstack/redeem-credits on this API's Postgres: spends
 * are compare-and-swap, so parallel calls never overdraw. A top-up is a
 * CoinPay checkout session recorded in credit_topups; it is credited exactly
 * once, by whichever comes first: the signed webhook, or a status check when
 * the balance is read (so a lost webhook never loses a payment).
 */
import { Credits, postgresStore } from "@profullstack/redeem-credits";
import { createCoinPayClient, verifyCoinPayWebhook, COINPAY_WEBHOOK_SIGNATURE_HEADER } from "@profullstack/stack/coinpay";
import { db } from "./db/index.ts";

export const UNIT = "credits";
/** Free credits every calendar month. MYNA_FREE_CREDITS overrides. */
export const freeMonthly = (): number => {
  const n = Number(process.env.MYNA_FREE_CREDITS);
  return Number.isInteger(n) && n >= 0 ? n : 100;
};
/** USD per credit when buying (1 cent). */
export const USD_PER_CREDIT = 0.01;
/** Top-up packs offered, in USD. */
export const PACKS_USD = [5, 20, 50] as const;
export const MIN_TOPUP_USD = 5;
export const MAX_TOPUP_USD = 500;

export const creditsForUsd = (usd: number): number => Math.round(usd / USD_PER_CREDIT);

let credits: Credits | null = null;
/** The ledger, on this API's Postgres (tables credit_*, created on first use). */
export function ledger(): Credits {
  credits ??= new Credits(
    postgresStore({ query: async (sql: string, params: unknown[] = []) => ({ rows: await db().unsafe(sql, params as never[]) }) }),
  );
  return credits;
}

/** For tests: swap the ledger (e.g. a memoryStore). */
export function setLedgerForTests(c: Credits | null): void {
  credits = c;
  freeGranted.clear();
}

const freeGranted = new Set<string>();

/** Give the account its free monthly allowance, once, forever after recurring. */
export async function ensureFree(userId: string): Promise<void> {
  if (freeGranted.has(userId)) return;
  const l = ledger();
  const history = await l.history(userId, UNIT);
  if (freeMonthly() > 0 && !history.some((e) => e.kind === "grant" && e.source === "free-monthly")) {
    await l.grant(userId, { unit: UNIT, amount: freeMonthly(), every: "month", months: null }, "free-monthly");
  }
  freeGranted.add(userId);
}

export async function balance(userId: string): Promise<number> {
  await ensureFree(userId);
  await settleOpenTopups(userId).catch(() => {});
  return ledger().balance(userId, UNIT);
}

/** Spend `amount` credits; { ok:false } with the balance when there are not enough. */
export async function spend(userId: string, amount: number, note: string): Promise<{ ok: boolean; balance: number }> {
  await ensureFree(userId);
  return ledger().spend(userId, UNIT, amount, note.slice(0, 200));
}

/** Put credits back after a metered call failed upstream (not the caller's fault). */
export async function refund(userId: string, amount: number, note: string): Promise<void> {
  await ledger().grant(userId, { unit: UNIT, amount }, `refund:${note.slice(0, 180)}`);
}

// ── CoinPay top-ups ─────────────────────────────────────────────────────────

let topupTable: Promise<void> | null = null;
function ensureTopupTable(): Promise<void> {
  topupTable ??= db()
    .unsafe(
      `create table if not exists credit_topups (
        session_id  text primary key,
        user_id     uuid not null references users(id) on delete cascade,
        usd         numeric(10,2) not null,
        credits     integer not null,
        status      text not null default 'open',
        payment_id  text,
        created_at  timestamptz not null default now(),
        credited_at timestamptz
      );
      create index if not exists credit_topups_user_idx on credit_topups(user_id, created_at desc);`,
    )
    .then(() => undefined)
    .catch((error) => {
      topupTable = null;
      throw error;
    });
  return topupTable;
}

export const coinpayConfigured = (): boolean => Boolean(process.env.COINPAY_API_KEY);

const client = () => createCoinPayClient({ apiKey: process.env.COINPAY_API_KEY ?? "", baseUrl: process.env.COINPAY_API_URL || undefined });

const siteUrl = (): string => (process.env.MYNA_SITE_URL ?? "https://mynaposter.com").replace(/\/+$/, "");

/** Start a top-up: a CoinPay hosted checkout for `usd`, credited when paid. */
export async function startTopup(user: { id: string; email: string }, usd: number): Promise<{ checkoutUrl: string; sessionId: string; usd: number; credits: number }> {
  if (!coinpayConfigured()) throw Object.assign(new Error("Buying credits is not switched on yet."), { status: 503 });
  const amount = Math.round(Number(usd) * 100) / 100;
  if (!Number.isFinite(amount) || amount < MIN_TOPUP_USD || amount > MAX_TOPUP_USD) {
    throw Object.assign(new Error(`A top-up is ${MIN_TOPUP_USD} to ${MAX_TOPUP_USD} USD.`), { status: 400 });
  }
  await ensureTopupTable();
  const credits = creditsForUsd(amount);
  const out = await client().createCheckout({
    amountUsd: amount,
    customerEmail: user.email,
    accountId: user.id,
    property: "mynaposter.com",
    description: `myna credits: ${credits} AI calls`,
    metadata: { kind: "myna-credits", user_id: user.id, credits },
    successUrl: `${siteUrl()}/pricing?paid={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${siteUrl()}/pricing`,
    expiresInMinutes: 60,
  });
  await db()`insert into credit_topups (session_id, user_id, usd, credits) values (${out.sessionId}, ${user.id}, ${amount}, ${credits}) on conflict (session_id) do nothing`;
  return { checkoutUrl: out.checkoutUrl, sessionId: out.sessionId, usd: amount, credits };
}

/**
 * Credit a paid top-up, exactly once. The UPDATE ... WHERE status <> 'credited'
 * is the serialization point: a webhook and a status check racing each other
 * cannot both grant.
 */
export async function creditTopup(sessionId: string, paymentId: string | null): Promise<boolean> {
  await ensureTopupTable();
  const rows = await db()`
    update credit_topups set status = 'credited', credited_at = now(), payment_id = ${paymentId}
    where session_id = ${sessionId} and status <> 'credited'
    returning user_id, credits`;
  const row = rows[0] as { user_id: string; credits: number } | undefined;
  if (!row) return false;
  await ledger().grant(String(row.user_id), { unit: UNIT, amount: Number(row.credits) }, `coinpay:${sessionId}`);
  return true;
}

/** Ask CoinPay about this account's open top-ups (last 2 days) and credit the paid ones. */
export async function settleOpenTopups(userId: string): Promise<number> {
  if (!coinpayConfigured()) return 0;
  await ensureTopupTable();
  const open = (await db()`
    select session_id from credit_topups
    where user_id = ${userId} and status = 'open' and created_at > now() - interval '2 days'
    order by created_at desc limit 5`) as unknown as { session_id: string }[];
  let n = 0;
  for (const { session_id } of open) {
    try {
      const s = await client().getCheckout(session_id);
      if (s.paid) n += (await creditTopup(session_id, s.paymentId)) ? 1 : 0;
      else if (s.status === "expired") await db()`update credit_topups set status = 'expired' where session_id = ${session_id} and status = 'open'`;
    } catch {
      /* CoinPay unreachable: the next read or the webhook settles it */
    }
  }
  return n;
}

/** The signed CoinPay webhook. Returns what happened, for the log and the response. */
export async function handleCoinPayWebhook(rawBody: string, signature: string | null): Promise<{ status: number; result: string }> {
  const secret = process.env.COINPAY_WEBHOOK_SECRET ?? "";
  if (!secret) return { status: 503, result: "webhook secret not configured" };
  if (!verifyCoinPayWebhook({ signature, rawBody, secret })) return { status: 401, result: "bad signature" };
  let event: { type?: string; data?: { status?: string; payment_id?: string; metadata?: Record<string, unknown>; checkout_session_id?: string; session_id?: string } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { status: 400, result: "not json" };
  }
  const data = event.data ?? {};
  const meta = (data.metadata ?? {}) as Record<string, unknown>;
  if (meta.kind !== "myna-credits") return { status: 200, result: "ignored: not a credits payment" };
  const paid = /confirmed|completed|paid|forwarded/i.test(String(event.type ?? "")) || /confirmed|completed|paid|forwarded/i.test(String(data.status ?? ""));
  if (!paid) return { status: 200, result: `ignored: ${event.type ?? data.status ?? "unknown"}` };
  const sessionId = String(data.checkout_session_id ?? data.session_id ?? meta.session_id ?? "");
  if (sessionId) return { status: 200, result: (await creditTopup(sessionId, data.payment_id ?? null)) ? "credited" : "already credited" };
  // No session id on the event: settle that account's open sessions by asking CoinPay.
  const userId = typeof meta.user_id === "string" ? meta.user_id : "";
  if (!userId) return { status: 200, result: "ignored: no session or user" };
  return { status: 200, result: `settled ${await settleOpenTopups(userId)}` };
}

export { COINPAY_WEBHOOK_SIGNATURE_HEADER };
