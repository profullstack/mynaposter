import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  isGoogleSender,
  mailJobId,
  queueIdentity,
  queuedDelivery,
  senderLimits,
  type DeliveryTransport,
  type QueuedMessage,
} from "../src/index.ts";

describe("email queue policy", () => {
  it("recognizes personal Gmail and Gmail-hosted custom-domain senders", () => {
    expect(isGoogleSender({ type: "smtp", from: "owner@gmail.com" }, "smtp.gmail.com")).toBe(true);
    expect(isGoogleSender({ type: "smtp", from: "owner@example.com" }, "smtp.googlemail.com")).toBe(true);
    expect(isGoogleSender({ type: "resend", from: "owner@gmail.com" })).toBe(true);
    expect(isGoogleSender({ type: "resend", from: "owner@example.com" })).toBe(false);
  });

  it("enforces conservative sender budgets and never raises them with overrides", () => {
    expect(senderLimits({ type: "smtp", from: "owner@gmail.com" }, "smtp.gmail.com")).toEqual({
      google: true,
      maxPer24Hours: 100,
      minGapMs: 600_000,
    });
    expect(senderLimits({ type: "resend", from: "owner@example.com" }, "", {
      maxPer24Hours: 10_000,
      minGapMs: 1,
    })).toEqual({ google: false, maxPer24Hours: 1000, minGapMs: 1000 });
  });

  it("scopes identity by sender and makes bulk recipient jobs idempotent", () => {
    const sender = { id: "resend", type: "resend", from: "News <news@example.com>" };
    const identity = queueIdentity(sender);
    const base: QueuedMessage = {
      from: sender.from,
      to: ["person@example.net"],
      subject: "Issue 1",
      text: "Hello",
      dedupeKey: "issue-1:contact-1",
    };
    expect(identity).toBe("resend|news@example.com");
    expect(mailJobId(identity, base, "bulk")).toBe(mailJobId(identity, base, "bulk"));
    expect(mailJobId(identity, base, "bulk")).not.toBe(mailJobId("resend|other@example.com", base, "bulk"));
    expect(() => mailJobId(identity, { ...base, to: ["a@example.net", "b@example.net"] }, "bulk")).toThrow("exactly one recipient");
  });
});

const testRedisUrl = process.env.EMAIL_QUEUE_TEST_REDIS_URL;

if (testRedisUrl) {
  describe("Redis-backed delivery", () => {
    function fakeSender() {
      const from = `queue-test-${randomUUID()}@example.test`;
      let calls = 0;
      const sender: DeliveryTransport = {
        id: "fake-resend",
        type: "resend",
        from,
        async send() {
          calls++;
          return { ok: true, id: `fake-${calls}` };
        },
      };
      return { sender, get calls() { return calls; } };
    }

    it("delivers once and returns the durable receipt for a repeated issue recipient", async () => {
      const fake = fakeSender();
      const message: QueuedMessage = {
        from: fake.sender.from,
        to: [`person-${randomUUID()}@example.test`],
        subject: "Queue test",
        text: "No external delivery",
        dedupeKey: `issue:${randomUUID()}`,
      };
      const options = { redisUrl: testRedisUrl! };
      const first = await queuedDelivery(fake.sender, message, "bulk", options);
      const repeated = await queuedDelivery(fake.sender, message, "bulk", options);
      expect(first).toEqual({ ok: true, id: "fake-1" });
      expect(repeated).toEqual(first);
      expect(fake.calls).toBe(1);
    });

    it("stops at the sender's daily cap without calling the provider again", async () => {
      const fake = fakeSender();
      const options = { redisUrl: testRedisUrl!, maxPer24Hours: 1, minGapMs: 1000 };
      const first = await queuedDelivery(fake.sender, {
        from: fake.sender.from,
        to: [`person-a-${randomUUID()}@example.test`],
        subject: "Queue budget test",
        text: "No external delivery",
        dedupeKey: `campaign:${randomUUID()}:a`,
      }, "bulk", options);
      const second = await queuedDelivery(fake.sender, {
        from: fake.sender.from,
        to: [`person-b-${randomUUID()}@example.test`],
        subject: "Queue budget test",
        text: "No external delivery",
        dedupeKey: `campaign:${randomUUID()}:b`,
      }, "bulk", options);
      expect(first.ok).toBe(true);
      expect(second).toMatchObject({ ok: false, status: 429, retryable: true });
      expect(fake.calls).toBe(1);
    });

    it("records an uncertain provider error as a completed receipt without retrying", async () => {
      const fake = fakeSender();
      let calls = 0;
      fake.sender.send = async () => {
        calls++;
        throw new Error("connection reset after DATA");
      };
      const message: QueuedMessage = {
        from: fake.sender.from,
        to: [`uncertain-${randomUUID()}@example.test`],
        subject: "Queue uncertain test",
        text: "No external delivery",
        dedupeKey: `campaign:${randomUUID()}:uncertain`,
      };
      const options = { redisUrl: testRedisUrl! };
      const first = await queuedDelivery(fake.sender, message, "bulk", options);
      const repeated = await queuedDelivery(fake.sender, message, "bulk", options);
      expect(first).toMatchObject({ ok: false, retryable: false, status: 0 });
      expect(first.error).toContain("Delivery uncertain");
      expect(repeated).toEqual(first);
      expect(calls).toBe(1);
    });
  });
}
