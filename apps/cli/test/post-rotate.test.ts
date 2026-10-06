import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

test("--rotate narrows a post to one target and says who is next; bad modes are refused", () => {
  const home = mkdtempSync(join(tmpdir(), "myna-post-rotate-"));
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

    // --rotate before the target must not swallow it.
    const result = spawnSync(process.execPath, ["apps/cli/src/main.ts", "post", "--rotate", "bluesky,mastodon", "--dry-run"], {
      cwd: root, env, encoding: "utf8", input: "Rotated message.\n", timeout: 10000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("rotate bluesky:fixture  (cycle, has room today; next: mastodon:fixture)");
    expect(result.stdout).toContain("Would post to 1 account");
    expect(result.stdout).toContain("Rotated message.");
    expect(result.stdout).not.toContain("  mastodon:fixture\n");

    const random = spawnSync(process.execPath, ["apps/cli/src/main.ts", "post", "bluesky,mastodon,linkedin", "Hi", "--rotate=random", "--dry-run"], {
      cwd: root, env, encoding: "utf8", timeout: 10000,
    });
    expect(random.status).toBe(0);
    expect(random.stdout).toMatch(/rotate (bluesky|mastodon|linkedin):fixture {2}\(random/);

    const bad = spawnSync(process.execPath, ["apps/cli/src/main.ts", "post", "bluesky", "Hi", "--rotate=sideways", "--dry-run"], {
      cwd: root, env, encoding: "utf8", timeout: 10000,
    });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr + bad.stdout).toContain("--rotate is cycle (the default) or random");

    const empty = spawnSync(process.execPath, ["apps/cli/src/main.ts", "rotation"], { cwd: root, env, encoding: "utf8", timeout: 10000 });
    expect(empty.stdout).toContain("No rotated posts yet");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
