import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

test("comma-separated positional targets preserve the piped message and target subset", () => {
  const home = mkdtempSync(join(tmpdir(), "myna-post-targets-"));
  const env = { ...process.env, MYNA_HOME: home };
  const root = resolve(import.meta.dir, "../../..");
  try {
    const setup = spawnSync(process.execPath, ["--eval", `
      import { saveAccount } from "./packages/core/src/store/accounts.ts";
      for (const network of ["bluesky", "mastodon", "linkedin"]) {
        saveAccount({ id: network + ":fixture", network, handle: "fixture", addedAt: "", creds: {}, meta: {} });
      }
    `], { cwd: root, env, encoding: "utf8" });
    expect(setup.status).toBe(0);
    for (const targets of ["bluesky,mastodon", "bluesky:fixture,mastodon:fixture"]) {
      const result = spawnSync(process.execPath, ["apps/cli/src/main.ts", "post", targets, "--dry-run"], {
        cwd: root, env, encoding: "utf8", input: "The actual campaign message.\n", timeout: 10000,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Would post to 2 accounts");
      expect(result.stdout).toContain("The actual campaign message.");
      expect(result.stdout).toContain("bluesky:fixture");
      expect(result.stdout).toContain("mastodon:fixture");
      expect(result.stdout).not.toContain("linkedin:fixture");
      expect(result.stdout).not.toContain("\nbluesky,mastodon\n");
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
