import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

// Every subcommand must reach its own branch. 0.49.0 read the subcommand one
// slot too far, so `myna hubs scan` printed the status and drafted nothing.
test("myna hubs subcommands reach their branch", () => {
  const home = mkdtempSync(join(tmpdir(), "myna-hubs-cli-"));
  const env = { ...process.env, MYNA_HOME: home };
  const root = resolve(import.meta.dir, "../../..");
  const run = (...args: string[]) => spawnSync(process.execPath, ["apps/cli/src/main.ts", "hubs", ...args], { cwd: root, env, encoding: "utf8", timeout: 20000 });
  try {
    const added = run("add", "bluesky", "hub.example", "--score", "3");
    expect(added.stdout).toContain("Added bluesky:hub.example.");
    const listed = run();
    expect(listed.stdout).toContain("bluesky:hub.example");
    const drafts = run("drafts");
    expect(drafts.stdout).toContain("No pending drafts.");
    const removed = run("rm", "bluesky:hub.example");
    expect(removed.stdout).toContain("Removed bluesky:hub.example.");
    const unknown = run("sideways");
    expect(unknown.stdout).toContain("No such thing as myna hubs sideways");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
