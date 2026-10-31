import { expect, test } from "bun:test";
import { isThrottleFailure, recoverThrottledBatch, recoverThrottledSend, THROTTLE_BACKOFF_MS, THROTTLE_ATTEMPTS } from "../src/core/mail/retry.ts";

test("a provider throttle gets three total attempts with Fibonacci delays", async () => {
  let calls = 0;
  const waits: number[] = [];
  const result = await recoverThrottledSend(async () => {
    calls++;
    return { ok: false, status: 429, retryable: true, error: "429 rate limit" };
  }, async (milliseconds) => void waits.push(milliseconds));

  expect(calls).toBe(THROTTLE_ATTEMPTS);
  expect(waits).toEqual([...THROTTLE_BACKOFF_MS]);
  expect(result).toMatchObject({ ok: false, retryable: false, status: 429, attempts: 3 });
  expect(result.error).toContain("stopped after 3 consecutive failures");
});

test("a batch retries only when every recipient was definitely refused", async () => {
  let calls = 0;
  const waits: number[] = [];
  const mixed = await recoverThrottledBatch(async () => {
    calls++;
    return [
      { ok: true, id: "accepted" },
      { ok: false, status: 429, retryable: true, error: "rate limit" },
    ];
  }, async (milliseconds) => void waits.push(milliseconds));
  expect(calls).toBe(1);
  expect(waits).toEqual([]);
  expect(mixed[0]).toMatchObject({ ok: true });
  expect(mixed[1]).toMatchObject({ ok: false, status: 429 });

  calls = 0;
  waits.length = 0;
  const allLimited = await recoverThrottledBatch(async () => {
    calls++;
    return [{ ok: false, status: 429, retryable: true, error: "rate limit" }];
  }, async (milliseconds) => void waits.push(milliseconds));
  expect(calls).toBe(3);
  expect(waits).toEqual([1000, 2000]);
  expect(allLimited[0]).toMatchObject({ ok: false, retryable: false, attempts: 3 });
});

test("a Gmail sending-limit refusal retries, but an uncertain connection does not", async () => {
  expect(isThrottleFailure({ ok: false, status: 550, error: "You have reached a limit for sending mail. Your message was not sent." })).toBe(true);
  expect(isThrottleFailure({ ok: false, status: 0, retryable: true, error: "connection timed out" })).toBe(false);

  let calls = 0;
  const result = await recoverThrottledSend(async () => {
    calls++;
    return { ok: false, status: 0, retryable: true, error: "connection timed out" };
  }, async () => {
    throw new Error("uncertain sends must not wait or retry");
  });
  expect(calls).toBe(1);
  expect(result.status).toBe(0);
});
