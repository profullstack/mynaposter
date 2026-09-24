/**
 * The newsletter in the TUI: /newsletter drives core against a fake SMTP
 * server, the body comes from the compose box, a list send waits for a yes,
 * and the screen renders what is there.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { createServer, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToHtml } from "@profullstack/hqtui";
import { loadSettings, readNewsletters, saveSettings, saveSmtpServer } from "@profullstack/myna-core";
import { createState } from "../src/tui/state.ts";
import { newsletterScreen, runNewsletterCommand } from "../src/tui/newsletter.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-tui-newsletter-"));
  process.env.MYNA_HOME = dir;
  process.env.MYNA_PASSPHRASE = "test passphrase";
  const settings = loadSettings();
  settings.newsletter.address = "Profullstack, Inc., 1 Main St, San Jose, CA 95112, USA";
  settings.newsletter.unsubscribeUrl = "https://example.com/u/{token}";
  settings.newsletter.paceMs = 0;
  saveSettings(settings);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
  delete process.env.MYNA_PASSPHRASE;
});

function fakeSmtp() {
  const rcpts: string[] = [];
  const server = createServer((socket: Socket) => {
    let inData = false;
    let buffer = "";
    socket.write("220 fake\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let i: number;
      while ((i = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            socket.write("250 queued\r\n");
          }
          continue;
        }
        if (line.startsWith("EHLO")) socket.write("250 fake\r\n");
        else if (line.startsWith("MAIL")) socket.write("250 ok\r\n");
        else if (line.startsWith("RCPT")) {
          rcpts.push(line.slice(9, -1));
          socket.write("250 ok\r\n");
        } else if (line === "DATA") {
          inData = true;
          socket.write("354 go\r\n");
        } else if (line === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        } else socket.write("500 what\r\n");
      }
    });
  });
  return {
    rcpts,
    listen: () => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port))),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

test("write in the compose box, /newsletter new, test copy, then a send that waits for yes", async () => {
  const fake = fakeSmtp();
  const port = await fake.listen();
  saveSmtpServer({ id: "fake", host: "127.0.0.1", port, secure: "none", user: "", from: "News <news@example.com>" }, "");
  const state = createState([]);
  const redraw = () => undefined;
  try {
    await expect(runNewsletterCommand(state, "new moshcode Hello", redraw)).rejects.toThrow(/compose box is empty/);
    state.compose.set("# Hello\n\nThe first issue.");
    await runNewsletterCommand(state, "new moshcode Hello there", redraw);
    expect(state.screen).toBe("newsletter");
    expect(readNewsletters().newsletters.map((n) => [n.id, n.body])).toEqual([["hello-there", "# Hello\n\nThe first issue."]]);

    await runNewsletterCommand(state, "subscribe moshcode ada@example.com bob@example.com", redraw);
    await runNewsletterCommand(state, "test hello-there me@example.com", redraw);
    expect(fake.rcpts).toEqual(["me@example.com"]);

    await runNewsletterCommand(state, "send hello-there", redraw);
    expect(state.mode).toBe("confirm");
    expect(state.confirm?.message).toContain("to 2 on moshcode");
    expect(fake.rcpts).toHaveLength(1);
    state.confirm?.onYes();
    for (let i = 0; i < 20 && fake.rcpts.length < 3; i++) await settle();
    await settle();
    expect(fake.rcpts.slice(1).sort()).toEqual(["ada@example.com", "bob@example.com"]);
    expect(readNewsletters().newsletters[0]?.status).toBe("sent");

    const html = renderToHtml(({ ui, theme }) => ui.column({ size: "1fr" }, (root) => newsletterScreen(root, state, theme)), { width: 120, height: 40 });
    expect(html).toContain("hello-there");
    expect(html).toContain("moshcode");
    expect(html).toContain("sent");
  } finally {
    await fake.close();
  }
});

test("schedule and unsubscribe from the TUI", async () => {
  const state = createState([]);
  state.compose.set("Body");
  await runNewsletterCommand(state, "new weekly Weekly one", () => undefined);
  await runNewsletterCommand(state, "schedule weekly-one tomorrow 9am", () => undefined);
  expect(readNewsletters().newsletters[0]?.status).toBe("scheduled");
  await runNewsletterCommand(state, "subscribe weekly ada@example.com", () => undefined);
  await runNewsletterCommand(state, "unsubscribe ada@example.com", () => undefined);
  const html = renderToHtml(({ ui, theme }) => ui.column({ size: "1fr" }, (root) => newsletterScreen(root, state, theme)), { width: 120, height: 40 });
  expect(html).toContain("scheduled");
  await expect(runNewsletterCommand(state, "bogus", () => undefined)).rejects.toThrow(/Unknown/);
});
