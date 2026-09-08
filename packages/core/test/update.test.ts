import { test, expect, describe } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetFor, cpuHasAvx2, isNewer, selfUpdate } from "../src/core/update.ts";

describe("isNewer", () => {
  test("compares numerically, not as strings", () => {
    // The bug this guards: "0.9.0" > "0.10.0" is true for strings, which would
    // have parked every install on 0.9.x forever.
    expect(isNewer("0.10.0", "0.9.0")).toBe(true);
    expect(isNewer("0.9.0", "0.10.0")).toBe(false);
    expect(isNewer("1.0.0", "0.14.0")).toBe(true);
    expect(isNewer("0.14.1", "0.14.0")).toBe(true);
  });

  test("the same version is not an update, in either spelling", () => {
    expect(isNewer("0.14.0", "0.14.0")).toBe(false);
    expect(isNewer("v0.14.0", "0.14.0")).toBe(false);
  });

  test("a shorter version is padded, not treated as missing", () => {
    expect(isNewer("1.1", "1.0.9")).toBe(true);
    expect(isNewer("1.0", "1.0.0")).toBe(false);
  });
});

describe("assetFor", () => {
  test("names the asset the release workflow actually uploads", () => {
    expect(assetFor("linux", "x64")).toBe("myna-linux-x86_64");
    expect(assetFor("linux", "arm64")).toBe("myna-linux-aarch64");
    expect(assetFor("darwin", "x64")).toBe("myna-darwin-x86_64");
    expect(assetFor("darwin", "arm64")).toBe("myna-darwin-arm64");
    expect(assetFor("win32", "x64")).toBe("myna-windows-x86_64.exe");
  });

  test("a CPU without AVX2 gets the baseline build", () => {
    // Picking wrong here means an illegal instruction rather than an error
    // message, so this is the one platform detail worth a test of its own.
    expect(assetFor("linux", "x64", false)).toBe("myna-linux-x86_64-baseline");
    // Only x86_64 Linux has a baseline build to fall back to.
    expect(assetFor("linux", "arm64", false)).toBe("myna-linux-aarch64");
    expect(assetFor("darwin", "x64", false)).toBe("myna-darwin-x86_64");
  });

  test("an architecture with no build says so instead of guessing", () => {
    expect(() => assetFor("linux", "ia32")).toThrow(/No myna build for ia32/);
    expect(() => assetFor("win32", "arm64")).toThrow(/No Windows build/);
  });
});

test("an unreadable /proc/cpuinfo is assumed modern, not assumed broken", () => {
  expect(
    cpuHasAvx2(() => {
      throw new Error("no /proc here");
    }),
  ).toBe(true);
});

test("running from source refuses to overwrite Bun itself", async () => {
  // process.execPath under `bun test` IS bun, which is exactly the case this
  // guard exists for: no target override, so it takes the real path.
  const result = await selfUpdate();
  expect(result.installed).toBe(false);
  // Says what is newest, and how to update this kind of install, rather than
  // writing a myna binary over the Bun that is executing it.
  expect(result.reason).toMatch(/running under Bun/i);
  expect(result.reason).toMatch(/install\.sh|bun add -g|git pull/);
});

test("a fake binary is replaced atomically, and never left half written", async () => {
  const dir = mkdtempSync(join(tmpdir(), "myna-update-test-"));
  const target = join(dir, "myna");
  writeFileSync(target, "old binary", { mode: 0o755 });

  // No network here: the point is that a failing download leaves the existing
  // binary exactly as it was, which is the property that makes an in-place
  // update safe to offer at all.
  await expect(
    selfUpdate({ target, version: "0.0.0-does-not-exist" }),
  ).rejects.toThrow();

  expect(readFileSync(target, "utf8")).toBe("old binary");
  expect(statSync(target).mode & 0o777).toBe(0o755);
});
