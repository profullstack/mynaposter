/**
 * Terminal prompts for the scriptable CLI.
 *
 * `myna login facebook` has to ask the same questions the TUI dialog asks, so
 * these read one field at a time and mask anything secret.
 */
import { createInterface } from "node:readline";

const BACKSPACE = [String.fromCharCode(127), String.fromCharCode(8)];
const INTERRUPT = String.fromCharCode(3);

export function ask(question: string, fallback = ""): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(fallback ? `${question} [${fallback}]: ` : `${question}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || fallback);
    });
  });
}

/** Read a secret without echoing it, showing a dot per character. */
export function askSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(`${question}: `);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();

    let value = "";
    const onData = (chunk: Buffer) => {
      const char = chunk.toString("utf8");

      if (char === "\r" || char === "\n") {
        stdin.off("data", onData);
        stdin.setRawMode?.(wasRaw ?? false);
        stdin.pause();
        process.stdout.write("\n");
        resolve(value);
        return;
      }
      if (char === INTERRUPT) {
        process.stdout.write("\n");
        process.exit(130);
      }
      if (BACKSPACE.includes(char)) {
        if (value.length) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }
      value += char;
      process.stdout.write("*");
    };
    stdin.on("data", onData);
  });
}

export async function confirm(question: string): Promise<boolean> {
  const answer = await ask(`${question} (y/N)`);
  return /^y(es)?$/i.test(answer.trim());
}

/**
 * Read piped stdin, or return "" when nothing is piped.
 *
 * `isTTY` alone is not enough. Under cron, in CI, or from a script that
 * inherited a non-tty stdin nobody will ever write to, waiting for "end" waits
 * forever -- so `myna post "text"` hung with no output and no way to tell why.
 * The grace period bounds that: real piped input arrives immediately, and an
 * idle pipe costs a few milliseconds before myna carries on without it.
 */
export function readStdin(graceMs = 150): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");

  return new Promise((resolve) => {
    let data = "";
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.pause();
      resolve(data.trim());
    };

    // Only starts once something actually arrives, so a pipe that is slow to
    // produce is still read in full rather than cut off at the grace period.
    const timer = setTimeout(finish, graceMs);
    timer.unref?.();

    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
      clearTimeout(timer);
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}
