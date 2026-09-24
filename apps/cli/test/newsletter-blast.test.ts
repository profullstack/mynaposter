/**
 * `myna newsletter blast` against a fake SMTP server: step one imports,
 * creates, sends one test copy and stops; the list send only happens with
 * --go; a second send of the same issue is refused while one runs; a partly
 * sent issue resumes without anyone getting it twice; and --go really detaches.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadSettings,
  readNewsletters,
  saveSettings,
  saveSmtpServer,
  sendLockPath,
  sendNewsletter,
  sendProgress,
  subscribers,
  stateDir,
} from "@profullstack/myna-core";
import { runBlast, runGo, runSendWorker, runStatus } from "../src/cli/newsletter-blast.ts";
import { runNewsletter } from "../src/cli/newsletter.ts";

let dir = "";
let printed: string[] = [];
const realWrite = process.stdout.write.bind(process.stdout);
const children: ChildProcess[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-blast-"));
  process.env.MYNA_HOME = dir;
  process.env.MYNA_PASSPHRASE = "test passphrase";
  const settings = loadSettings();
  settings.newsletter.address = "Profullstack, Inc., 1 Main St, San Jose, CA 95112, USA";
  settings.newsletter.unsubscribeUrl = "https://example.com/u/{token}";
  settings.newsletter.paceMs = 0;
  saveSettings(settings);
  printed = [];
  process.stdout.write = ((chunk: string | Uint8Array) => {
    printed.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
});
afterEach(() => {
  process.stdout.write = realWrite;
  for (const child of children.splice(0)) child.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
  delete process.env.MYNA_PASSPHRASE;
});

const output = () => printed.join("");

function fakeSmtp() {
  const rcpts: string[] = [];
  const subjects: string[] = [];
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
          } else if (line.startsWith("Subject: ")) subjects.push(line.slice(9));
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
    subjects,
    listen: () => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port))),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function files(body = "# Hello\n\nThe first issue.") {
  const issue = join(dir, "issue.md");
  const csv = join(dir, "users.csv");
  writeFileSync(issue, body);
  writeFileSync(csv, "email,name\nada@example.com,Ada\nbob@example.com,Bob\ncy@example.com,Cy\n");
  return { issue, csv };
}

const baseFlags = (csv?: string) => ({
  ...(csv ? { csv } : {}),
  list: "profullstack-users",
  id: "profullstack-001",
  subject: "What shipped",
  subjectB: "Five new things",
  service: "a Profullstack, Inc. product",
  replyTo: "anthony@example.com",
  via: "fake",
  tags: "profullstack",
});

async function withFake<T>(fn: (fake: ReturnType<typeof fakeSmtp>) => Promise<T>): Promise<T> {
  const fake = fakeSmtp();
  const port = await fake.listen();
  saveSmtpServer({ id: "fake", host: "127.0.0.1", port, secure: "none", user: "", from: "Profullstack <news@example.com>" }, "");
  try {
    return await fn(fake);
  } finally {
    await fake.close();
  }
}

/** A live process that is not this one, to hold a lock. */
function otherProcess(): number {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  children.push(child);
  return child.pid as number;
}

test("step one imports, creates, sends ONE test copy to the reply-to, prints the split and the --go command, and mails nobody on the list", async () => {
  await withFake(async (fake) => {
    const { issue, csv } = files();
    expect(await runBlast([issue], { ...baseFlags(csv), maxPerDay: "6000" })).toBe(0);

    expect(subscribers("profullstack-users").map((s) => s.contact.email).sort()).toEqual(["ada@example.com", "bob@example.com", "cy@example.com"]);
    expect(subscribers("profullstack-users")[0]?.contact.tags).toContain("profullstack");
    const n = readNewsletters().newsletters[0];
    expect(n?.id).toBe("profullstack-001");
    expect(n?.status).toBe("draft");
    expect(n?.subjectB).toBe("Five new things");
    expect(n?.smtp).toBe("fake");

    expect(fake.rcpts).toEqual(["anthony@example.com"]);
    expect(fake.subjects[0]).toContain("[test]");
    expect(readNewsletters().deliveries["profullstack-001"] ?? {}).toEqual({});

    const text = output();
    expect(text).toContain("Test copy to anthony@example.com as variant");
    expect(text).toContain("3 can be mailed, 0 already have it, 3 to go.");
    expect(text).toMatch(/variants, split over the 3 still due/);
    expect(text).toContain("myna newsletter blast --go profullstack-001 --max-per-day 6000");
    expect(text).not.toMatch(/\u2014/);

    // A plain send without --yes still only previews.
    expect(await runNewsletter(["send", "profullstack-001"], {})).toBe(1);
    expect(fake.rcpts).toHaveLength(1);
  });
});

test("--test-to wins, a rerun updates the draft, and without --csv an empty list is refused", async () => {
  await withFake(async (fake) => {
    const { issue, csv } = files();
    await expect(runBlast([issue], baseFlags())).rejects.toThrow(/Nobody on profullstack-users can be mailed yet/);
    expect(await runBlast([issue], { ...baseFlags(csv), testTo: "me@example.com" })).toBe(0);
    writeFileSync(issue, "# Hello\n\nThe second draft.");
    expect(await runBlast([issue], { ...baseFlags(), subject: "What shipped, take two" })).toBe(0);
    const n = readNewsletters().newsletters;
    expect(n).toHaveLength(1);
    expect(n[0]?.body).toContain("second draft");
    expect(n[0]?.subject).toBe("What shipped, take two");
    expect(fake.rcpts).toEqual(["me@example.com", "anthony@example.com"]);
    expect(output()).toContain("Updated the draft profullstack-001");
  });
});

test("--clean imports only what email-cleaner keeps and prints the reasons; a missing cleaner is one line", async () => {
  await withFake(async () => {
    const { issue, csv } = files();
    const fakeCleaner = join(dir, "email-cleaner");
    writeFileSync(
      fakeCleaner,
      `#!/bin/sh
cat > /dev/null
cat <<'JSON'
{"valid":[{"email":"ada@example.com"},{"email":"bob@example.com"}],"invalid":[{"email":"cy@example.com","reasons":["unlikely","duplicate"]}],"stats":{"total":3,"valid":2,"invalid":1,"byReason":{"unlikely":1,"duplicate":1}}}
JSON
`,
    );
    chmodSync(fakeCleaner, 0o755);
    expect(await runBlast([issue], { ...baseFlags(csv), clean: true }, { cleaner: fakeCleaner })).toBe(0);
    expect(output()).toContain("Cleaned users.csv: 2 kept, 1 rejected (unlikely 1, duplicate 1).");
    expect(subscribers("profullstack-users").map((s) => s.contact.email).sort()).toEqual(["ada@example.com", "bob@example.com"]);

    await expect(runBlast([issue], { ...baseFlags(csv), clean: true }, { cleaner: join(dir, "no-such-cleaner") })).rejects.toThrow(/needs .*no-such-cleaner.* on PATH/);
    await expect(runBlast([issue], { ...baseFlags(), clean: true })).rejects.toThrow(/--clean cleans the --csv file/);
  });
});

test("--go refuses while another live process holds the issue's lock; a stale lock is cleared", async () => {
  await withFake(async (fake) => {
    const { issue, csv } = files();
    await runBlast([issue], baseFlags(csv));
    mkdirSync(stateDir(), { recursive: true });
    const pid = otherProcess();
    writeFileSync(sendLockPath("profullstack-001"), JSON.stringify({ pid, id: "profullstack-001", startedAt: new Date().toISOString() }));

    await expect(runGo("profullstack-001", {})).rejects.toThrow(new RegExp(`already being sent by pid ${pid}`));
    await expect(runNewsletter(["send", "profullstack-001"], { yes: true })).rejects.toThrow(/already being sent/);
    await expect(runBlast([issue], baseFlags())).rejects.toThrow(/already being sent/);
    expect(await runSendWorker("profullstack-001", { yes: true })).toBe(1);
    expect(output()).toContain("not started:");
    expect(fake.rcpts).toHaveLength(1);

    // The holder dies: its lock is stale, and the next send goes ahead.
    writeFileSync(sendLockPath("profullstack-001"), JSON.stringify({ pid: 2 ** 22 + 12345, id: "profullstack-001", startedAt: new Date().toISOString() }));
    expect(sendProgress("profullstack-001").stale?.pid).toBe(2 ** 22 + 12345);
    expect(await runSendWorker("profullstack-001", { yes: true })).toBe(0);
    expect(fake.rcpts.slice(1).sort()).toEqual(["ada@example.com", "bob@example.com", "cy@example.com"]);
    expect(existsSync(sendLockPath("profullstack-001"))).toBe(false);
  });
});

test("a partly sent issue refuses a changed body, resumes with the same one, and nobody gets it twice", async () => {
  await withFake(async (fake) => {
    const { issue, csv } = files();
    await runBlast([issue], baseFlags(csv));
    const first = await sendNewsletter("profullstack-001", { limit: 1, paceMs: 0 });
    expect(first.sent).toHaveLength(1);
    expect(readNewsletters().newsletters[0]?.status).toBe("sending");

    writeFileSync(issue, "# Hello\n\nA changed body.");
    await expect(runBlast([issue], baseFlags())).rejects.toThrow(/already gone to 1 people/);

    writeFileSync(issue, "# Hello\n\nThe first issue.");
    printed = [];
    expect(await runBlast([issue], baseFlags())).toBe(0);
    expect(output()).toContain("Resuming profullstack-001");
    expect(output()).toContain("3 can be mailed, 1 already have it, 2 to go.");
    expect(fake.rcpts).toHaveLength(2); // the first test copy and the one list message; no second test copy

    expect(await runSendWorker("profullstack-001", { yes: true })).toBe(0);
    const list = fake.rcpts.slice(1);
    expect(list.sort()).toEqual(["ada@example.com", "bob@example.com", "cy@example.com"]);
    expect(readNewsletters().newsletters[0]?.status).toBe("sent");

    // Once more: everyone has it, nothing goes.
    printed = [];
    expect(await runGo("profullstack-001", {})).toBe(0);
    expect(output()).toContain("already has profullstack-001");
    expect(fake.rcpts).toHaveLength(4);

    printed = [];
    expect(await runStatus("profullstack-001", {})).toBe(0);
    expect(output()).toContain("sent       3 of 3 (100.0%)");
    expect(output()).toContain("remaining  0");
  });
});

test("--go detaches: the terminal comes back, the child sends the list, logs, and lets go of the lock", async () => {
  await withFake(async (fake) => {
    const { issue, csv } = files();
    await runBlast([issue], baseFlags(csv));
    const main = join(import.meta.dir, "..", "src", "main.ts");
    const started = Date.now();
    expect(await runGo("profullstack-001", { maxPerDay: "6000" }, { self: [process.execPath, main] })).toBe(0);
    const text = output();
    expect(text).toMatch(/Sending profullstack-001 in the background, pid \d+|already finished/);
    expect(text).toContain("myna newsletter status profullstack-001 --watch");

    for (let i = 0; i < 150 && readNewsletters().newsletters[0]?.status !== "sent"; i++) await new Promise((r) => setTimeout(r, 100));
    expect(readNewsletters().newsletters[0]?.status).toBe("sent");
    for (let i = 0; i < 50 && existsSync(sendLockPath("profullstack-001")); i++) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(sendLockPath("profullstack-001"))).toBe(false);
    expect(fake.rcpts.slice(1).sort()).toEqual(["ada@example.com", "bob@example.com", "cy@example.com"]);
    expect(Date.now() - started).toBeLessThan(20_000);

    const progress = sendProgress("profullstack-001");
    expect(progress.sent).toBe(3);
    expect(progress.log).not.toBeNull();
    printed = [];
    await runStatus("profullstack-001", {});
    expect(output()).toContain("done: 3 sent, 0 failed, 0 left");
  });
}, 30_000);
