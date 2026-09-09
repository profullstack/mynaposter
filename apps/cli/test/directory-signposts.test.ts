/**
 * Being sent to the right command instead of being told no.
 *
 * A directory is deliberately not in the network registry, and that separation
 * is load-bearing: it is what keeps a directory out of `--to all`. But it also
 * means `myna login saasrow` and `myna networks` are dead ends unless they say
 * where the thing actually lives. Somebody who has read about SaaSRow reaches
 * for those two first, which is exactly what happened.
 */
import { test, expect } from "bun:test";
import { runHeadless } from "../src/cli/headless.ts";
import { getDirectory, getNetwork } from "@profullstack/myna-core";

/** Run a command and capture what it wrote, so the text itself can be asserted. */
async function run(command: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const chunks: string[] = [];
  const errors: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((text: string) => {
    chunks.push(String(text));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((text: string) => {
    errors.push(String(text));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await runHeadless(command, args);
    return { code, out: chunks.join(""), err: errors.join("") };
  } catch (error) {
    // `runHeadless` throws; `main` is what turns that into `myna: <message>`
    // on stderr and exit 1. The message is the thing being asserted here.
    return { code: 1, out: chunks.join(""), err: `${errors.join("")}${(error as Error).message}` };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

test("the registries stay separate, which is the reason the signposts are needed", () => {
  // If this ever stops being true, a directory has become a posting target.
  expect(getNetwork("saasrow")).toBeUndefined();
  expect(getDirectory("saasrow")?.id).toBe("saasrow");
});

test("`myna login saasrow` names the command that does work", async () => {
  const result = await run("login", ["saasrow"]);
  expect(result.code).toBe(1);
  expect(result.err).toContain("directory, not a network");
  expect(result.err).toContain("myna directory login saasrow");
});

test("`myna networks` says directories exist and where they are", async () => {
  const result = await run("networks", []);
  expect(result.code).toBe(0);
  // saasrow must not be in the table itself.
  expect(result.out).toContain("saasrow");
  expect(result.out).toContain("myna directory");
});

test("a genuinely unknown name still reads as unknown, not as a directory", async () => {
  const result = await run("login", ["nosuchthing"]);
  expect(result.code).toBe(1);
  expect(result.err).toContain('Unknown network "nosuchthing"');
  expect(result.err).not.toContain("directory, not a network");
});

test("`myna directory bluesky` points back the other way", async () => {
  const result = await run("directory", ["bluesky", "https://example.com"]);
  expect(result.code).toBe(1);
  expect(result.err).toContain("network, not a directory");
  expect(result.err).toContain("myna post --to bluesky");
});
