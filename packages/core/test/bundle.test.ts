import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seal, open, describe as describeBundle, type BundlePayload } from "../src/store/bundle.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-bundle-"));
  process.env.MYNA_HOME = dir;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
});

const payload = (): BundlePayload => ({
  accounts: [
    {
      id: "bluesky:alice.bsky.social",
      network: "bluesky",
      handle: "alice.bsky.social",
      addedAt: new Date().toISOString(),
      creds: { password: "hunter2-app-password" },
      meta: { service: "https://bsky.social" },
    },
  ],
  queue: [],
  settings: { defaultTargets: "all" } as never,
  savedAt: "2026-09-02T12:00:00.000Z",
  savedBy: "alice@laptop",
});

test("a sealed bundle opens with the right passphrase", () => {
  const opened = open(seal(payload(), "correct horse battery"), "correct horse battery");
  expect(opened.accounts[0].creds.password).toBe("hunter2-app-password");
  expect(opened.savedBy).toBe("alice@laptop");
});

test("no credential is readable in the sealed file", () => {
  const raw = JSON.stringify(seal(payload(), "correct horse battery"));
  expect(raw).not.toContain("hunter2-app-password");
  expect(raw).not.toContain("alice.bsky.social");
});

test("the wrong passphrase is refused, and the message admits both causes", () => {
  const sealed = seal(payload(), "correct horse battery");
  expect(() => open(sealed, "wrong")).toThrow(/passphrase is wrong, or the file has been altered/);
});

test("a tampered bundle is refused even with the right passphrase", () => {
  const sealed = seal(payload(), "correct horse battery");
  const bytes = Buffer.from(sealed.data, "base64");
  bytes[0] ^= 0xff;
  sealed.data = bytes.toString("base64");
  expect(() => open(sealed, "correct horse battery")).toThrow(/altered/);
});

test("a throwaway passphrase is refused outright", () => {
  // This file is every token at once; "1234" is not a passphrase for it.
  expect(() => seal(payload(), "1234")).toThrow(/at least 8 characters/);
});

test("something that is not a bundle says so", () => {
  expect(() => open({ hello: "world" } as never, "whatever")).toThrow(/not a myna bundle/);
});

test("a bundle from a newer myna asks you to update rather than failing oddly", () => {
  const sealed = seal(payload(), "correct horse battery");
  sealed.version = 99;
  expect(() => open(sealed, "correct horse battery")).toThrow(/newer myna/);
});

test("the header describes the bundle without the passphrase", () => {
  const sealed = seal(payload(), "correct horse battery");
  expect(describeBundle(sealed)).toContain("1 account");
  expect(describeBundle(sealed)).toContain("alice@laptop");
});
