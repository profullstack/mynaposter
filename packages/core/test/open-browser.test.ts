/**
 * Raising a browser must never take the login down with it.
 *
 * On a server with no desktop there is no xdg-open. spawn() reports that as an
 * asynchronous "error" event, not a throw, so the try/catch around it caught
 * nothing and the unhandled event killed `myna login x` a moment after it had
 * printed the paste-the-code prompt. The link was already on screen; the user
 * only needed the process to stay alive.
 */
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBrowser } from "../src/net/oauth2.ts";

test("a missing browser opener is not fatal", async () => {
  const path = process.env.PATH;
  const uncaught: unknown[] = [];
  const catchAll = (error: unknown) => { uncaught.push(error); };
  process.env.PATH = mkdtempSync(join(tmpdir(), "myna-nopath-"));
  process.on("uncaughtException", catchAll);
  try {
    await openBrowser("https://example.test/authorize");
    // The spawn error arrives on a later tick; give it time to surface.
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    process.env.PATH = path;
    process.removeListener("uncaughtException", catchAll);
  }
  expect(uncaught).toEqual([]);
});
