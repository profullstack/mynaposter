import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

test("myna account archive/restore: listed as banned with the note, queued posts cancelled, targeting refused", () => {
  const home = mkdtempSync(join(tmpdir(), "myna-account-archive-"));
  const env = { ...process.env, MYNA_HOME: home };
  const root = resolve(import.meta.dir, "../../..");
  const myna = (...args: string[]) =>
    spawnSync(process.execPath, ["apps/cli/src/main.ts", ...args], { cwd: root, env, encoding: "utf8", timeout: 15000 });
  try {
    const setup = spawnSync(process.execPath, ["--eval", `
      import { saveAccount } from "./packages/core/src/store/accounts.ts";
      import { enqueue } from "./packages/core/src/store/queue.ts";
      for (const network of ["bluesky", "mastodon"]) {
        saveAccount({ id: network + ":fixture", network, handle: "fixture", addedAt: "", creds: { token: "t" }, meta: {} });
      }
      enqueue({ scheduledFor: "2099-01-01T00:00:00.000Z", targets: ["mastodon:fixture"], text: "queued for mastodon" });
      enqueue({ scheduledFor: "2099-01-01T00:00:00.000Z", targets: ["bluesky:fixture"], text: "queued for bluesky" });
    `], { cwd: root, env, encoding: "utf8" });
    expect(setup.status).toBe(0);

    const archived = myna("account", "archive", "mastodon:fixture", "--banned", "--note", "login disabled by the instance");
    expect(archived.stderr).toBe("");
    expect(archived.status).toBe(0);
    expect(archived.stdout).toContain("mastodon:fixture is banned");
    expect(archived.stdout).toContain("1 queued post cancelled");

    const list = myna("accounts");
    expect(list.stdout).toMatch(/mastodon:fixture.*banned \d{4}-\d{2}-\d{2}/);
    expect(list.stdout).toMatch(/bluesky:fixture.*active/);
    expect(list.stdout).toContain("mastodon:fixture: login disabled by the instance");

    const only = myna("accounts", "--archived");
    expect(only.stdout).toContain("mastodon:fixture");
    expect(only.stdout).not.toContain("bluesky:fixture");

    const queue = JSON.parse(myna("queue", "--json").stdout) as Array<{ targets: string[]; status: string; lastError?: string }>;
    const forMastodon = queue.filter((entry) => entry.targets.includes("mastodon:fixture"));
    expect(forMastodon.every((entry) => entry.status === "cancelled")).toBe(true);
    expect(forMastodon[0]?.lastError).toContain("login disabled by the instance");
    expect(queue.find((entry) => entry.targets.includes("bluesky:fixture"))?.status).toBe("pending");

    // Explicit target: refused, with the note, and never read as post text.
    const refused = myna("post", "mastodon:fixture", "hello", "--dry-run");
    expect(refused.status).not.toBe(0);
    expect(refused.stderr + refused.stdout).toContain("login disabled by the instance");

    // `all` leaves it out.
    const all = myna("post", "all", "hello", "--dry-run");
    expect(all.status).toBe(0);
    expect(all.stdout).toContain("bluesky:fixture");
    expect(all.stdout).not.toContain("mastodon:fixture");

    const restored = myna("account", "restore", "mastodon:fixture");
    expect(restored.stdout).toContain("Restored mastodon:fixture");
    const back = myna("post", "mastodon:fixture", "hello", "--dry-run");
    expect(back.status).toBe(0);
    expect(back.stdout).toContain("mastodon:fixture");
    expect(myna("accounts").stdout).toMatch(/mastodon:fixture.*active/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
