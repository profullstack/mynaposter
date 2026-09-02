/**
 * The version was a literal in six files. A release that updated five of them
 * would ship a binary reporting the wrong one, and nothing would fail.
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/version.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8")) as { version?: string };

test("VERSION looks like a version", () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
});

test("every published package agrees with it", () => {
  for (const path of ["packages/core/package.json", "packages/mcp/package.json", "apps/cli/package.json"]) {
    expect(read(path).version, path).toBe(VERSION);
  }
});
