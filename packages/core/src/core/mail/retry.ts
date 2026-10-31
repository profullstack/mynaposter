import type { MailResult } from "./types.ts";

export const THROTTLE_ATTEMPTS = 3;
export const THROTTLE_BACKOFF_MS = [1_000, 2_000] as const;

const THROTTLE_MESSAGE = /rate[ -]?limit|throttl|too many (?:requests|messages|emails)|quota|(?:reach(?:ed)?|hit|exceed(?:ed)?).{0,40}limit.{0,40}(?:send|sending|mail|message|email)|(?:send|sending|mail|message|email).{0,40}(?:limit|quota)|limit.{0,40}(?:send|sending|mail|message|email)/i;
const TEMPORARY_SMTP_CODES = new Set([421, 450, 451, 452]);

export type RetrySleep = (milliseconds: number) => Promise<void>;

const sleep: RetrySleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** A provider explicitly rejected this send for rate limiting or a temporary SMTP deferral. */
export function isThrottleFailure(result: MailResult): boolean {
  if (result.ok || result.status === 0) return false;
  return result.status === 429 || TEMPORARY_SMTP_CODES.has(result.status ?? 0) || THROTTLE_MESSAGE.test(result.error ?? "");
}

function exhausted(result: MailResult): MailResult {
  return {
    ...result,
    retryable: false,
    attempts: THROTTLE_ATTEMPTS,
    error: `${result.error ?? "The provider is still throttling this message."} (stopped after ${THROTTLE_ATTEMPTS} consecutive failures)`,
  };
}

/** Retry a single, definitely refused message up to three total attempts. Unknown sends are never retried. */
export async function recoverThrottledSend<T extends MailResult>(
  send: () => Promise<T>,
  wait: RetrySleep = sleep,
): Promise<T> {
  let result = await send();
  let attempts = 1;
  for (let attempt = 1; isThrottleFailure(result) && attempt < THROTTLE_ATTEMPTS; attempt++) {
    const delay = THROTTLE_BACKOFF_MS[attempt - 1] ?? THROTTLE_BACKOFF_MS[THROTTLE_BACKOFF_MS.length - 1];
    await wait(Math.max(delay, result.retryAfterMs ?? 0));
    result = await send();
    attempts++;
  }
  if (isThrottleFailure(result)) return exhausted({ ...result, attempts }) as T;
  return attempts > 1 ? { ...result, attempts } as T : result;
}

/** Only retry a batch when every recipient was definitely refused for throttling. */
export async function recoverThrottledBatch(
  send: () => Promise<MailResult[]>,
  wait: RetrySleep = sleep,
): Promise<MailResult[]> {
  let results = await send();
  let attempts = 1;
  const allThrottled = () => results.length > 0 && results.every(isThrottleFailure);
  for (let attempt = 1; allThrottled() && attempt < THROTTLE_ATTEMPTS; attempt++) {
    const delay = THROTTLE_BACKOFF_MS[attempt - 1] ?? THROTTLE_BACKOFF_MS[THROTTLE_BACKOFF_MS.length - 1];
    await wait(Math.max(delay, ...results.map((result) => result.retryAfterMs ?? 0)));
    results = await send();
    attempts++;
  }
  return allThrottled()
    ? results.map((result) => exhausted({ ...result, attempts }))
    : attempts > 1 ? results.map((result) => ({ ...result, attempts })) : results;
}
