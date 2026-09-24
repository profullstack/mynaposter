/**
 * Every mail provider against a stubbed fetch: the request it makes (URL,
 * auth, body shape, the List-Unsubscribe headers passed through), the id it
 * reads back, and how its failures map to retryable or not. No request
 * leaves the machine; the SMTP cases talk to a fake server on a local port.
 */
import { test, expect, describe } from "bun:test";
import { createHmac, createHash } from "node:crypto";
import { createServer, type Socket } from "node:net";
import {
  brevoProvider,
  mailgunProvider,
  mailjetProvider,
  mandrillProvider,
  mynaCloudProvider,
  postmarkProvider,
  resendProvider,
  sendgridProvider,
  sesProvider,
  smtp2goProvider,
  smtpProvider,
  sparkpostProvider,
  parseAddress,
  retryableStatus,
  errorWords,
} from "../src/core/mail/providers.ts";
import { signV4, signingKey } from "../src/core/mail/sigv4.ts";
import { sendEach } from "../src/core/mail/index.ts";
import type { Fetch, MailMessage, MailProviderConfig, MailSender } from "../src/core/mail/types.ts";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** A fetch that records every call and answers from a queue (the last answer repeats). */
function stub(...answers: Array<{ status?: number; body?: unknown; headers?: Record<string, string> } | Error>) {
  const calls: Call[] = [];
  const fetcher: Fetch = async (url, init = {}) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[key.toLowerCase()] = value;
    calls.push({ url, method: init.method ?? "GET", headers, body: typeof init.body === "string" ? init.body : String(init.body ?? "") });
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    if (answer instanceof Error) throw answer;
    const payload = answer?.body === undefined ? "" : typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
    return new Response(payload, { status: answer?.status ?? 200, headers: answer?.headers });
  };
  return { calls, fetch: fetcher, json: (index = 0) => JSON.parse(calls[index]?.body ?? "null") };
}

const UNSUB = {
  "List-Unsubscribe": "<https://example.com/u/tok>, <mailto:news@example.com?subject=unsubscribe>",
  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
};

const message = (overrides: Partial<MailMessage> = {}): MailMessage => ({
  to: ["ada@example.com"],
  subject: "Hello",
  text: "Plain body",
  html: "<p>HTML body</p>",
  replyTo: "reply@example.com",
  headers: { ...UNSUB },
  ...overrides,
});

const config = (type: MailProviderConfig["type"], extra: Partial<MailProviderConfig> = {}): MailProviderConfig => ({ id: `my-${type}`, type, from: "Myna News <news@example.com>", ...extra });

/** The shared failure mapping every HTTP provider must follow. */
async function expectErrorMapping(make: (fetcher: Fetch) => MailSender) {
  for (const [status, retryable] of [
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [401, false],
    [422, false],
  ] as const) {
    const s = stub({ status, body: { message: `status ${status}` } });
    const result = await make(s.fetch).send(message());
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(retryable);
    expect(result.error).toBeTruthy();
  }
  const down = stub(new Error("ECONNRESET"));
  const result = await make(down.fetch).send(message());
  expect(result).toMatchObject({ ok: false, retryable: true, status: 0 });
  expect(result.error).toContain("ECONNRESET");
}

test("addresses split into name and email; 429 and 5xx are retryable", () => {
  expect(parseAddress("Myna News <news@example.com>")).toEqual({ email: "news@example.com", name: "Myna News" });
  expect(parseAddress('"Quoted" <q@example.com>')).toEqual({ email: "q@example.com", name: "Quoted" });
  expect(parseAddress("bare@example.com")).toEqual({ email: "bare@example.com" });
  expect([408, 429, 500, 502, 503].every(retryableStatus)).toBe(true);
  expect([400, 401, 403, 404, 422].some(retryableStatus)).toBe(false);
  expect(errorWords({ errors: [{ message: "bad from" }] }, "")).toBe("bad from");
  expect(errorWords(null, "<html><b>Gateway</b> timeout</html>")).toBe("Gateway timeout");
});

describe("Resend", () => {
  test("POST /emails with a bearer key, reply_to and headers; the id comes back", async () => {
    const s = stub({ status: 200, body: { id: "re_123" } });
    const result = await resendProvider(config("resend"), "re_key", { fetch: s.fetch }).send(message());
    expect(result).toMatchObject({ ok: true, id: "re_123" });
    expect(s.calls[0]?.url).toBe("https://api.resend.com/emails");
    expect(s.calls[0]?.method).toBe("POST");
    expect(s.calls[0]?.headers.authorization).toBe("Bearer re_key");
    expect(s.json()).toEqual({
      from: "Myna News <news@example.com>",
      to: ["ada@example.com"],
      subject: "Hello",
      text: "Plain body",
      html: "<p>HTML body</p>",
      reply_to: "reply@example.com",
      headers: UNSUB,
    });
  });

  test("the batch endpoint takes up to 100 and answers one id per message, in order", async () => {
    const s = stub({ status: 200, body: { data: [{ id: "a" }, { id: "b" }] } });
    const sender = resendProvider(config("resend"), "re_key", { fetch: s.fetch });
    expect(sender.batchSize).toBe(100);
    const results = await sender.sendBatch!([message({ to: "a@example.com" }), message({ to: "b@example.com" })]);
    expect(results.map((r) => r.id)).toEqual(["a", "b"]);
    expect(s.calls[0]?.url).toBe("https://api.resend.com/emails/batch");
    const body = s.json() as { to: string[]; headers: Record<string, string> }[];
    expect(body.map((entry) => entry.to[0])).toEqual(["a@example.com", "b@example.com"]);
    expect(body[1]?.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const tooMany = await sender.sendBatch!(Array.from({ length: 101 }, () => message()));
    expect(tooMany.every((r) => !r.ok && /at most 100/.test(r.error ?? ""))).toBe(true);
    const limited = await resendProvider(config("resend"), "k", { fetch: stub({ status: 429, body: { message: "slow down" } }).fetch }).sendBatch!([message(), message()]);
    expect(limited.every((r) => !r.ok && r.retryable)).toBe(true);
  });

  test("errors map", () => expectErrorMapping((f) => resendProvider(config("resend"), "k", { fetch: f })));

  test("no sender and no key are failures, not throws", async () => {
    const s = stub({ body: { id: "x" } });
    const noFrom = await resendProvider({ id: "r", type: "resend" }, "k", { fetch: s.fetch }).send(message());
    expect(noFrom).toMatchObject({ ok: false, retryable: false });
    expect(noFrom.error).toMatch(/no sender/);
    const noKey = await resendProvider(config("resend"), "", { fetch: s.fetch }).send(message());
    expect(noKey.error).toMatch(/no API key/);
    expect(s.calls).toHaveLength(0);
  });
});

describe("Mailgun", () => {
  test("form POST to the US or EU base with basic api:key, h: headers and the domain", async () => {
    const s = stub({ status: 200, body: { id: "<20260924.1@mg.example.com>", message: "Queued. Thank you." } });
    const result = await mailgunProvider(config("mailgun", { domain: "mg.example.com" }), "key-1", { fetch: s.fetch }).send(message());
    expect(result).toMatchObject({ ok: true, id: "<20260924.1@mg.example.com>" });
    expect(s.calls[0]?.url).toBe("https://api.mailgun.net/v3/mg.example.com/messages");
    expect(s.calls[0]?.headers.authorization).toBe(`Basic ${Buffer.from("api:key-1").toString("base64")}`);
    expect(s.calls[0]?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(s.calls[0]?.body);
    expect(form.get("from")).toBe("Myna News <news@example.com>");
    expect(form.getAll("to")).toEqual(["ada@example.com"]);
    expect(form.get("text")).toBe("Plain body");
    expect(form.get("html")).toBe("<p>HTML body</p>");
    expect(form.get("h:Reply-To")).toBe("reply@example.com");
    expect(form.get("h:List-Unsubscribe")).toBe(UNSUB["List-Unsubscribe"]);
    expect(form.get("h:List-Unsubscribe-Post")).toBe("List-Unsubscribe=One-Click");

    const eu = stub({ body: { id: "x" } });
    await mailgunProvider(config("mailgun", { region: "eu" }), "k", { fetch: eu.fetch }).send(message());
    expect(eu.calls[0]?.url).toBe("https://api.eu.mailgun.net/v3/example.com/messages");
  });

  test("errors map", () => expectErrorMapping((f) => mailgunProvider(config("mailgun"), "k", { fetch: f })));
});

describe("Mailchimp Transactional (Mandrill)", () => {
  test("the key rides in the body; headers carry Reply-To and List-Unsubscribe", async () => {
    const s = stub({ status: 200, body: [{ email: "ada@example.com", status: "sent", _id: "md_1", reject_reason: null }] });
    const result = await mandrillProvider(config("mandrill"), "md-key", { fetch: s.fetch }).send(message());
    expect(result).toMatchObject({ ok: true, id: "md_1" });
    expect(s.calls[0]?.url).toBe("https://mandrillapp.com/api/1.0/messages/send");
    const body = s.json() as { key: string; message: Record<string, unknown> };
    expect(body.key).toBe("md-key");
    expect(body.message).toEqual({
      from_email: "news@example.com",
      from_name: "Myna News",
      to: [{ email: "ada@example.com", type: "to" }],
      subject: "Hello",
      text: "Plain body",
      html: "<p>HTML body</p>",
      headers: { ...UNSUB, "Reply-To": "reply@example.com" },
    });
  });

  test("a rejected recipient is final; Invalid_Key (a 500) is final; a GeneralError 500 is retryable", async () => {
    const rejected = await mandrillProvider(config("mandrill"), "k", {
      fetch: stub({ body: [{ email: "ada@example.com", status: "rejected", reject_reason: "hard-bounce", _id: "x" }] }).fetch,
    }).send(message());
    expect(rejected).toMatchObject({ ok: false, retryable: false });
    expect(rejected.error).toContain("hard-bounce");
    const badKey = await mandrillProvider(config("mandrill"), "k", { fetch: stub({ status: 500, body: { status: "error", code: -1, name: "Invalid_Key", message: "Invalid API key" } }).fetch }).send(message());
    expect(badKey).toMatchObject({ ok: false, retryable: false });
    expect(badKey.error).toContain("Invalid_Key");
    const general = await mandrillProvider(config("mandrill"), "k", { fetch: stub({ status: 500, body: { status: "error", name: "GeneralError", message: "oops" } }).fetch }).send(message());
    expect(general.retryable).toBe(true);
    const queued = await mandrillProvider(config("mandrill"), "k", { fetch: stub({ body: [{ status: "queued", _id: "q" }] }).fetch }).send(message());
    expect(queued).toMatchObject({ ok: true, id: "q" });
  });

  test("errors map", () => expectErrorMapping((f) => mandrillProvider(config("mandrill"), "k", { fetch: f })));
});

describe("SendGrid", () => {
  test("v3 mail/send: personalizations, text before html, headers; the id from X-Message-Id", async () => {
    const s = stub({ status: 202, body: "", headers: { "x-message-id": "sg_abc" } });
    const result = await sendgridProvider(config("sendgrid"), "SG.key", { fetch: s.fetch }).send(message());
    expect(result).toMatchObject({ ok: true, id: "sg_abc", status: 202 });
    expect(s.calls[0]?.url).toBe("https://api.sendgrid.com/v3/mail/send");
    expect(s.calls[0]?.headers.authorization).toBe("Bearer SG.key");
    expect(s.json()).toEqual({
      personalizations: [{ to: [{ email: "ada@example.com" }] }],
      from: { email: "news@example.com", name: "Myna News" },
      reply_to: { email: "reply@example.com" },
      subject: "Hello",
      content: [
        { type: "text/plain", value: "Plain body" },
        { type: "text/html", value: "<p>HTML body</p>" },
      ],
      headers: UNSUB,
    });
    const eu = stub({ status: 202 });
    await sendgridProvider(config("sendgrid", { region: "eu" }), "k", { fetch: eu.fetch }).send(message());
    expect(eu.calls[0]?.url).toBe("https://api.eu.sendgrid.com/v3/mail/send");
  });

  test("errors map, in SendGrid's errors[] shape too", async () => {
    await expectErrorMapping((f) => sendgridProvider(config("sendgrid"), "k", { fetch: f }));
    const result = await sendgridProvider(config("sendgrid"), "k", { fetch: stub({ status: 400, body: { errors: [{ message: "The from address does not match a verified Sender Identity." }] } }).fetch }).send(message());
    expect(result.error).toContain("verified Sender Identity");
  });
});

describe("Postmark", () => {
  test("server token header, Headers as Name/Value, outbound for one email and broadcast for a newsletter", async () => {
    const s = stub({ status: 200, body: { ErrorCode: 0, Message: "OK", MessageID: "pm-1" } });
    const sender = postmarkProvider(config("postmark"), "pm-token", { fetch: s.fetch });
    expect(await sender.send(message())).toMatchObject({ ok: true, id: "pm-1" });
    expect(s.calls[0]?.url).toBe("https://api.postmarkapp.com/email");
    expect(s.calls[0]?.headers["x-postmark-server-token"]).toBe("pm-token");
    expect(s.json()).toEqual({
      From: "Myna News <news@example.com>",
      To: "ada@example.com",
      Subject: "Hello",
      TextBody: "Plain body",
      HtmlBody: "<p>HTML body</p>",
      ReplyTo: "reply@example.com",
      Headers: [
        { Name: "List-Unsubscribe", Value: UNSUB["List-Unsubscribe"] },
        { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
      ],
      MessageStream: "outbound",
    });
    await sender.send(message(), { kind: "bulk" });
    expect((s.json(1) as { MessageStream: string }).MessageStream).toBe("broadcast");
    const custom = stub({ body: { ErrorCode: 0, MessageID: "x" } });
    await postmarkProvider(config("postmark", { stream: "news" }), "t", { fetch: custom.fetch }).send(message(), { kind: "bulk" });
    expect((custom.json() as { MessageStream: string }).MessageStream).toBe("news");
  });

  test("the batch endpoint answers per message; an inactive recipient (406) is final, a 429 retryable", async () => {
    const s = stub({
      body: [
        { ErrorCode: 0, MessageID: "one" },
        { ErrorCode: 406, Message: "You tried to send to a recipient that has been marked as inactive." },
      ],
    });
    const sender = postmarkProvider(config("postmark"), "t", { fetch: s.fetch });
    expect(sender.batchSize).toBe(500);
    const results = await sender.sendBatch!([message(), message({ to: "gone@example.com" })], { kind: "bulk" });
    expect(s.calls[0]?.url).toBe("https://api.postmarkapp.com/email/batch");
    expect(results[0]).toMatchObject({ ok: true, id: "one" });
    expect(results[1]).toMatchObject({ ok: false, retryable: false });
    expect(results[1]?.error).toContain("406");
    const limited = await postmarkProvider(config("postmark"), "t", { fetch: stub({ status: 429, body: { ErrorCode: 429, Message: "Rate limit exceeded" } }).fetch }).send(message());
    expect(limited).toMatchObject({ ok: false, retryable: true });
    const bad = await postmarkProvider(config("postmark"), "t", { fetch: stub({ status: 422, body: { ErrorCode: 300, Message: "Invalid email request" } }).fetch }).send(message());
    expect(bad).toMatchObject({ ok: false, retryable: false });
    expect(bad.error).toBe("Postmark 300: Invalid email request");
  });

  test("errors map", () => expectErrorMapping((f) => postmarkProvider(config("postmark"), "t", { fetch: f })));
});

describe("Amazon SES v2", () => {
  test("SigV4 matches AWS's published examples", () => {
    expect(signingKey("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20120215", "us-east-1", "iam").toString("hex")).toBe("f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d");
    // get-vanilla from the AWS SigV4 test suite.
    const headers = signV4(
      { method: "GET", host: "example.amazonaws.com", path: "/", headers: {}, body: "" },
      { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
      "us-east-1",
      "service",
      new Date("2015-08-30T12:36:00Z"),
    );
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
    expect(headers["x-amz-date"]).toBe("20150830T123600Z");
  });

  test("POST outbound-emails signed for ses in the region, Simple content with Headers", async () => {
    const s = stub({ status: 200, body: { MessageId: "ses-1" } });
    const now = new Date("2026-09-24T10:00:00Z");
    const sender = sesProvider(config("ses", { region: "eu-west-1", keyId: "AKIATEST" }), "secret/key", { fetch: s.fetch, now: () => now });
    expect(await sender.send(message({ subject: "Héllo" }))).toMatchObject({ ok: true, id: "ses-1" });
    const call = s.calls[0] as Call;
    expect(call.url).toBe("https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails");
    expect(call.headers["x-amz-date"]).toBe("20260924T100000Z");
    expect(call.headers.authorization).toStartWith("AWS4-HMAC-SHA256 Credential=AKIATEST/20260924/eu-west-1/ses/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=");
    // Recompute the signature from the request as sent.
    const canonical = ["POST", "/v2/email/outbound-emails", "", "content-type:application/json\nhost:email.eu-west-1.amazonaws.com\nx-amz-date:20260924T100000Z\n", "content-type;host;x-amz-date", createHash("sha256").update(call.body).digest("hex")].join("\n");
    const toSign = ["AWS4-HMAC-SHA256", "20260924T100000Z", "20260924/eu-west-1/ses/aws4_request", createHash("sha256").update(canonical).digest("hex")].join("\n");
    const expected = createHmac("sha256", signingKey("secret/key", "20260924", "eu-west-1", "ses")).update(toSign).digest("hex");
    expect(call.headers.authorization).toEndWith(`Signature=${expected}`);
    expect(JSON.parse(call.body)).toEqual({
      FromEmailAddress: "Myna News <news@example.com>",
      Destination: { ToAddresses: ["ada@example.com"] },
      ReplyToAddresses: ["reply@example.com"],
      Content: {
        Simple: {
          Subject: { Data: `=?UTF-8?B?${Buffer.from("Héllo").toString("base64")}?=`, Charset: "UTF-8" },
          Body: { Text: { Data: "Plain body", Charset: "UTF-8" }, Html: { Data: "<p>HTML body</p>", Charset: "UTF-8" } },
          Headers: [
            { Name: "List-Unsubscribe", Value: UNSUB["List-Unsubscribe"] },
            { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
          ],
        },
      },
    });
  });

  test("throttling and the sending quota are retryable, a rejected message is not, and a key id is required", async () => {
    const make = (answer: Parameters<typeof stub>[0]) => sesProvider(config("ses", { keyId: "AKIA" }), "s", { fetch: stub(answer).fetch });
    expect(await make({ status: 400, headers: { "x-amzn-errortype": "LimitExceededException:http://internal" }, body: { message: "Daily message quota exceeded" } }).send(message())).toMatchObject({ ok: false, retryable: true });
    const rejected = await make({ status: 400, headers: { "x-amzn-errortype": "MessageRejected" }, body: { message: "Email address is not verified." } }).send(message());
    expect(rejected).toMatchObject({ ok: false, retryable: false });
    expect(rejected.error).toContain("MessageRejected");
    expect(rejected.error).toContain("not verified");
    const noKeyId = await sesProvider(config("ses"), "s", { fetch: stub({}).fetch }).send(message());
    expect(noKeyId.error).toMatch(/access key id/);
    const many = await make({ body: { MessageId: "x" } }).send(message({ headers: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`X-H${i}`, "v"])) }));
    expect(many.error).toMatch(/15/);
    await expectErrorMapping((f) => sesProvider(config("ses", { keyId: "AKIA" }), "s", { fetch: f }));
  });
});

describe("Brevo", () => {
  test("api-key header, sender/to objects, headers; a text-only message still has htmlContent", async () => {
    const s = stub({ status: 201, body: { messageId: "<brevo-1@smtp-relay.mailin.fr>" } });
    const sender = brevoProvider(config("brevo"), "xkeysib-1", { fetch: s.fetch });
    expect(await sender.send(message())).toMatchObject({ ok: true, id: "<brevo-1@smtp-relay.mailin.fr>" });
    expect(s.calls[0]?.url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(s.calls[0]?.headers["api-key"]).toBe("xkeysib-1");
    expect(s.json()).toEqual({
      sender: { email: "news@example.com", name: "Myna News" },
      to: [{ email: "ada@example.com" }],
      subject: "Hello",
      htmlContent: "<p>HTML body</p>",
      textContent: "Plain body",
      replyTo: { email: "reply@example.com" },
      headers: UNSUB,
    });
    await sender.send(message({ html: undefined, text: "a < b" }));
    expect((s.json(1) as { htmlContent: string }).htmlContent).toContain("a &lt; b");
  });

  test("errors map", () => expectErrorMapping((f) => brevoProvider(config("brevo"), "k", { fetch: f })));
});

describe("SparkPost", () => {
  test("the key is the whole Authorization header; transactional unless bulk; content.headers", async () => {
    const s = stub({ status: 200, body: { results: { total_rejected_recipients: 0, total_accepted_recipients: 1, id: "sp-1" } } });
    const sender = sparkpostProvider(config("sparkpost"), "sp-key", { fetch: s.fetch });
    expect(await sender.send(message())).toMatchObject({ ok: true, id: "sp-1" });
    expect(s.calls[0]?.url).toBe("https://api.sparkpost.com/api/v1/transmissions");
    expect(s.calls[0]?.headers.authorization).toBe("sp-key");
    expect(s.json()).toEqual({
      options: { transactional: true },
      recipients: [{ address: { email: "ada@example.com" } }],
      content: {
        from: { email: "news@example.com", name: "Myna News" },
        subject: "Hello",
        text: "Plain body",
        html: "<p>HTML body</p>",
        reply_to: "reply@example.com",
        headers: UNSUB,
      },
    });
    await sender.send(message(), { kind: "bulk" });
    expect((s.json(1) as { options: { transactional: boolean } }).options.transactional).toBe(false);
    const eu = stub({ body: { results: { total_accepted_recipients: 1, id: "e" } } });
    await sparkpostProvider(config("sparkpost", { region: "eu" }), "k", { fetch: eu.fetch }).send(message());
    expect(eu.calls[0]?.url).toBe("https://api.eu.sparkpost.com/api/v1/transmissions");
  });

  test("every recipient rejected is a failure; errors map", async () => {
    const rejected = await sparkpostProvider(config("sparkpost"), "k", { fetch: stub({ body: { results: { total_rejected_recipients: 1, total_accepted_recipients: 0, id: "x" } } }).fetch }).send(message());
    expect(rejected).toMatchObject({ ok: false, retryable: false });
    await expectErrorMapping((f) => sparkpostProvider(config("sparkpost"), "k", { fetch: f }));
  });
});

describe("Mailjet", () => {
  test("v3.1 send with basic key:secret, Messages[] with Headers; up to 50 per call", async () => {
    const s = stub({ status: 200, body: { Messages: [{ Status: "success", To: [{ Email: "ada@example.com", MessageUUID: "mj-uuid", MessageID: 123 }] }] } });
    const sender = mailjetProvider(config("mailjet", { keyId: "public" }), "private", { fetch: s.fetch });
    expect(sender.batchSize).toBe(50);
    expect(await sender.send(message())).toMatchObject({ ok: true, id: "mj-uuid" });
    expect(s.calls[0]?.url).toBe("https://api.mailjet.com/v3.1/send");
    expect(s.calls[0]?.headers.authorization).toBe(`Basic ${Buffer.from("public:private").toString("base64")}`);
    expect(s.json()).toEqual({
      Messages: [
        {
          From: { Email: "news@example.com", Name: "Myna News" },
          To: [{ Email: "ada@example.com" }],
          Subject: "Hello",
          TextPart: "Plain body",
          HTMLPart: "<p>HTML body</p>",
          ReplyTo: { Email: "reply@example.com" },
          Headers: UNSUB,
        },
      ],
    });
  });

  test("a 400 with per-message statuses maps each one; no key id is a failure", async () => {
    const s = stub({
      status: 400,
      body: { Messages: [{ Status: "success", To: [{ MessageUUID: "ok-1" }] }, { Status: "error", Errors: [{ ErrorMessage: "Type mismatch", StatusCode: 400 }] }] },
    });
    const results = await mailjetProvider(config("mailjet", { keyId: "p" }), "s", { fetch: s.fetch }).sendBatch!([message(), message()]);
    expect(results[0]).toMatchObject({ ok: true, id: "ok-1" });
    expect(results[1]).toMatchObject({ ok: false, retryable: false });
    expect(results[1]?.error).toContain("Type mismatch");
    const noKey = await mailjetProvider(config("mailjet"), "s", { fetch: stub({}).fetch }).send(message());
    expect(noKey.error).toMatch(/no API key/);
    await expectErrorMapping((f) => mailjetProvider(config("mailjet", { keyId: "p" }), "s", { fetch: f }));
  });
});

describe("SMTP2GO", () => {
  test("X-Smtp2go-Api-Key, custom_headers with Reply-To, and a 200 that failed is a failure", async () => {
    const s = stub({ status: 200, body: { request_id: "r", data: { succeeded: 1, failed: 0, failures: [], email_id: "s2g-1" } } });
    expect(await smtp2goProvider(config("smtp2go"), "api-1", { fetch: s.fetch }).send(message())).toMatchObject({ ok: true, id: "s2g-1" });
    expect(s.calls[0]?.url).toBe("https://api.smtp2go.com/v3/email/send");
    expect(s.calls[0]?.headers["x-smtp2go-api-key"]).toBe("api-1");
    expect(s.json()).toEqual({
      sender: "Myna News <news@example.com>",
      to: ["ada@example.com"],
      subject: "Hello",
      text_body: "Plain body",
      html_body: "<p>HTML body</p>",
      custom_headers: [
        { header: "List-Unsubscribe", value: UNSUB["List-Unsubscribe"] },
        { header: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
        { header: "Reply-To", value: "reply@example.com" },
      ],
    });
    const failed = await smtp2goProvider(config("smtp2go"), "k", { fetch: stub({ body: { data: { succeeded: 0, failed: 1, failures: ["sender not verified"] } } }).fetch }).send(message());
    expect(failed).toMatchObject({ ok: false, retryable: false });
    expect(failed.error).toContain("sender not verified");
    const eu = stub({ body: { data: { succeeded: 1, failed: 0, email_id: "x" } } });
    await smtp2goProvider(config("smtp2go", { region: "eu" }), "k", { fetch: eu.fetch }).send(message());
    expect(eu.calls[0]?.url).toBe("https://eu-api.smtp2go.com/v3/email/send");
    await expectErrorMapping((f) => smtp2goProvider(config("smtp2go"), "k", { fetch: f }));
  });
});

describe("myna cloud", () => {
  test("posts {kind, messages} with the cloud token and an idempotency key; results come back per message", async () => {
    const s = stub({ status: 200, body: { ok: true, results: [{ ok: true, id: "c1" }, { ok: false, error: "no id" }] } });
    const sender = mynaCloudProvider({ id: "cloud", type: "myna-cloud", from: "Anthony <a@profullstack.com>" }, "tok", "https://myna.test/api/", { fetch: s.fetch });
    const results = await sender.sendBatch!([message(), message({ to: "b@example.com" })], { kind: "bulk" });
    expect(results[0]).toMatchObject({ ok: true, id: "c1" });
    expect(results[1]).toMatchObject({ ok: false });
    expect(s.calls[0]?.url).toBe("https://myna.test/api/v1/mail/send");
    expect(s.calls[0]?.headers.authorization).toBe("Bearer tok");
    expect(s.calls[0]?.headers["idempotency-key"]).toMatch(/^[0-9a-f]{32}$/);
    const body = s.json() as { kind: string; messages: { from: string; to: string[]; headers: Record<string, string> }[] };
    expect(body.kind).toBe("bulk");
    expect(body.messages[0]?.from).toBe("Anthony <a@profullstack.com>");
    expect(body.messages[1]?.to).toEqual(["b@example.com"]);
    expect(body.messages[0]?.headers).toEqual(UNSUB);
  });

  test("the daily cap (429) is retryable; signed out is a failure before any request", async () => {
    const capped = await mynaCloudProvider({ id: "c", type: "myna-cloud" }, "tok", "https://myna.test/api", {
      fetch: stub({ status: 429, body: { ok: false, error: "Daily cap", retryable: true } }).fetch,
    }).send(message());
    expect(capped).toMatchObject({ ok: false, retryable: true, status: 429 });
    expect(capped.error).toContain("Daily cap");
    const s = stub({});
    const out = await mynaCloudProvider({ id: "c", type: "myna-cloud" }, "", "https://myna.test/api", { fetch: s.fetch }).send(message());
    expect(out.error).toMatch(/myna cloud login/);
    expect(s.calls).toHaveLength(0);
  });
});

describe("SMTP as a provider", () => {
  /** A server that takes one address, defers one (450) and refuses one (550). */
  function fakeSmtp() {
    const data: string[] = [];
    const server = createServer((socket: Socket) => {
      let buffer = "";
      let inData = false;
      let body = "";
      socket.write("220 fake ESMTP\r\n");
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        let index: number;
        while ((index = buffer.indexOf("\r\n")) !== -1) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (inData) {
            if (line === ".") {
              inData = false;
              data.push(body);
              socket.write("250 queued as Q1\r\n");
            } else body += `${line}\n`;
          } else if (line.startsWith("EHLO")) socket.write("250 fake\r\n");
          else if (line.startsWith("MAIL")) socket.write("250 ok\r\n");
          else if (line.includes("later@")) socket.write("450 4.2.1 try later\r\n");
          else if (line.includes("gone@")) socket.write("550 5.1.1 no such user\r\n");
          else if (line.startsWith("RCPT")) socket.write("250 ok\r\n");
          else if (line === "DATA") {
            inData = true;
            socket.write("354 go\r\n");
          } else if (line === "QUIT") {
            socket.write("221 bye\r\n");
            socket.end();
          }
        }
      });
    });
    return {
      data,
      listen: () => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port))),
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  test("delivered, 4xx retryable, 5xx final, a refused connection retryable; List-Unsubscribe on the wire", async () => {
    const fake = fakeSmtp();
    const port = await fake.listen();
    try {
      const sender = smtpProvider({ id: "s", host: "127.0.0.1", port, secure: "none", user: "", pass: "", from: "News <news@example.com>" });
      expect(await sender.send(message())).toMatchObject({ ok: true, status: 250 });
      expect(fake.data[0]).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
      expect(fake.data[0]).toContain("Reply-To: reply@example.com");
      expect(await sender.send(message({ to: "later@example.com" }))).toMatchObject({ ok: false, retryable: true, status: 450 });
      expect(await sender.send(message({ to: "gone@example.com" }))).toMatchObject({ ok: false, retryable: false, status: 550 });
    } finally {
      await fake.close();
    }
    const refused = await smtpProvider({ id: "s", host: "127.0.0.1", port: 1, secure: "none", user: "", pass: "", from: "n@example.com" }).send(message());
    expect(refused).toMatchObject({ ok: false, retryable: true, status: 0 });
  });
});

test("sendEach batches where it can, calls before/after in order, pauses between calls and stops when asked", async () => {
  const calls: number[] = [];
  const batchy: MailSender = {
    id: "b",
    type: "resend",
    batchSize: 2,
    send: async () => ({ ok: true, id: "single" }),
    sendBatch: async (messages) => {
      calls.push(messages.length);
      return messages.map((_, i) => ({ ok: true, id: `id${calls.length}-${i}` }));
    },
  };
  const order: string[] = [];
  let pauses = 0;
  const results = await sendEach(batchy, [message(), message(), message(), message(), message()], {
    before: (indexes) => void order.push(`before ${indexes.join(",")}`),
    after: (index) => void order.push(`after ${index}`),
    pause: async () => void pauses++,
  });
  expect(calls).toEqual([2, 2, 1]);
  expect(results).toHaveLength(5);
  expect(pauses).toBe(2);
  expect(order).toEqual(["before 0,1", "after 0", "after 1", "before 2,3", "after 2", "after 3", "before 4", "after 4"]);

  let stop = false;
  const stopped = await sendEach(batchy, [message(), message(), message()], { after: () => void (stop = true), stop: () => stop });
  expect(stopped).toHaveLength(2);
});
