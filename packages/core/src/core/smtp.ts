/**
 * Sending one message over SMTP, with nothing but node:net and node:tls.
 *
 * The house emailer wraps Resend and says SMTP is not implemented, and this
 * is for the servers people already have: a mailbox at their host, a Fastmail
 * app password, Postmark's SMTP door. EHLO, STARTTLS where offered, AUTH PLAIN
 * with LOGIN as the fallback, one MAIL FROM, one RCPT TO per recipient, DATA,
 * QUIT. Enough to deliver, and nothing that a server could misread.
 *
 * The socket is injectable so a test can stand up a fake server.
 */
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { randomBytes } from "node:crypto";

export type SmtpSecurity = "tls" | "starttls" | "none";

export interface SmtpServer {
  id: string;
  host: string;
  port: number;
  secure: SmtpSecurity;
  user: string;
  /** `Name <address>` or a bare address. */
  from: string;
  name?: string;
}

export interface SmtpMessage {
  to: string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

export interface SmtpResult {
  messageId: string;
  accepted: string[];
  /** The server's reply to DATA, usually with its queue id. */
  response: string;
}

export interface SmtpOptions {
  timeoutMs?: number;
  /** Open the connection. Tests hand in a fake. */
  connect?: (host: string, port: number, tls: boolean) => Socket | TLSSocket;
  /** Upgrade a plain socket after STARTTLS. */
  upgrade?: (socket: Socket, host: string) => TLSSocket;
}

export class SmtpError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "SmtpError";
  }
}

/** The address inside `Name <address>`, or the address itself. */
export function addressOf(value: string): string {
  const match = /<([^>]+)>/.exec(value);
  return (match ? match[1] : value).trim();
}

const CRLF = "\r\n";

class Line {
  private buffer = "";
  private waiting: Array<(line: string) => void> = [];
  private lines: string[] = [];

  feed(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      const take = this.waiting.shift();
      if (take) take(line);
      else this.lines.push(line);
    }
  }

  next(): Promise<string> {
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiting.push(resolve));
  }
}

/** Read one SMTP reply, which may span lines ("250-" then "250 "). */
async function reply(lines: Line, timeoutMs: number): Promise<{ code: number; text: string }> {
  const collected: string[] = [];
  for (;;) {
    const line = await Promise.race([
      lines.next(),
      new Promise<string>((_, reject) => setTimeout(() => reject(new SmtpError(0, "The server stopped answering.")), timeoutMs)),
    ]);
    collected.push(line);
    if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
      return { code: Number(line.slice(0, 3)), text: collected.join("\n") };
    }
  }
}

/** Every line of the body, dot-stuffed and CRLF-terminated. */
export function dotStuff(body: string): string {
  return body
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join(CRLF);
}

/** The message as bytes on the wire: headers, then one part or a multipart/alternative. */
export function buildMime(server: SmtpServer, message: SmtpMessage, messageId: string, date = new Date()): string {
  const headers: string[] = [
    `Date: ${date.toUTCString()}`,
    `From: ${server.from}`,
    `To: ${message.to.join(", ")}`,
    `Subject: ${encodeHeader(message.subject)}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    ...(message.replyTo ? [`Reply-To: ${message.replyTo}`] : []),
    ...Object.entries(message.headers ?? {}).map(([key, value]) => `${key}: ${value}`),
  ];
  if (!message.html) {
    headers.push("Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit");
    return `${headers.join(CRLF)}${CRLF}${CRLF}${dotStuff(message.text)}`;
  }
  const boundary = `=_myna_${randomBytes(9).toString("hex")}`;
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  const parts = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    dotStuff(message.text),
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    dotStuff(message.html),
    `--${boundary}--`,
  ];
  return `${headers.join(CRLF)}${CRLF}${CRLF}${parts.join(CRLF)}`;
}

/** RFC 2047 for a subject with anything outside ASCII. */
function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?utf-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** Deliver one message. Throws SmtpError with the server's own words on refusal. */
export async function sendSmtp(server: SmtpServer & { pass: string }, message: SmtpMessage, options: SmtpOptions = {}): Promise<SmtpResult> {
  if (!message.to.length) throw new SmtpError(0, "No recipient.");
  const timeoutMs = options.timeoutMs ?? 30_000;
  const open = options.connect ?? ((host, port, tls) => (tls ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port })));
  const upgrade = options.upgrade ?? ((socket, host) => tlsConnect({ socket, servername: host }));

  let socket: Socket | TLSSocket = open(server.host, server.port, server.secure === "tls");
  const lines = new Line();
  const attach = (s: Socket | TLSSocket): void => {
    s.setEncoding("utf8");
    s.on("data", (chunk: string) => lines.feed(chunk));
  };
  attach(socket);
  const send = (line: string): void => {
    socket.write(`${line}${CRLF}`);
  };
  const expect = async (codes: number[], what: string): Promise<{ code: number; text: string }> => {
    const answer = await reply(lines, timeoutMs);
    if (!codes.includes(answer.code)) throw new SmtpError(answer.code, `${what}: ${answer.text.replace(/^\d{3}[ -]/gm, "").trim()}`);
    return answer;
  };

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      (socket as Socket).once("connect", () => resolve());
      (socket as TLSSocket).once("secureConnect", () => resolve());
    });
    await expect([220], "greeting");
    const hello = async (): Promise<string> => {
      send(`EHLO myna.local`);
      return (await expect([250], "EHLO")).text;
    };
    let extensions = await hello();

    if (server.secure === "starttls") {
      if (!/STARTTLS/i.test(extensions)) throw new SmtpError(0, `${server.host} does not offer STARTTLS.`);
      send("STARTTLS");
      await expect([220], "STARTTLS");
      const plain = socket as Socket;
      plain.removeAllListeners("data");
      socket = upgrade(plain, server.host);
      attach(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        (socket as TLSSocket).once("secureConnect", () => resolve());
      });
      extensions = await hello();
    }

    if (server.user) {
      const plainAuth = Buffer.from(`\0${server.user}\0${server.pass}`, "utf8").toString("base64");
      if (/AUTH[= ].*PLAIN/i.test(extensions)) {
        send(`AUTH PLAIN ${plainAuth}`);
        await expect([235], "AUTH PLAIN");
      } else {
        send("AUTH LOGIN");
        await expect([334], "AUTH LOGIN");
        send(Buffer.from(server.user, "utf8").toString("base64"));
        await expect([334], "AUTH LOGIN username");
        send(Buffer.from(server.pass, "utf8").toString("base64"));
        await expect([235], "AUTH LOGIN password");
      }
    }

    send(`MAIL FROM:<${addressOf(server.from)}>`);
    await expect([250], "MAIL FROM");
    const accepted: string[] = [];
    for (const recipient of message.to) {
      send(`RCPT TO:<${addressOf(recipient)}>`);
      await expect([250, 251], `RCPT TO ${recipient}`);
      accepted.push(recipient);
    }
    send("DATA");
    await expect([354], "DATA");
    const messageId = `<${randomBytes(12).toString("hex")}@${addressOf(server.from).split("@")[1] ?? server.host}>`;
    socket.write(`${buildMime(server, message, messageId)}${CRLF}.${CRLF}`);
    const done = await expect([250], "message");
    send("QUIT");
    // Wait for the goodbye, so the server has read the QUIT before the
    // socket goes; a server that stays quiet is not worth waiting on.
    await reply(lines, 2_000).catch(() => undefined);
    return { messageId, accepted, response: done.text };
  } finally {
    socket.end();
    socket.destroy();
  }
}
