import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

test("myna account mirror: shown as `mirror of`, queue dropped, targeting refused, --restore from archive, --off", () => {
  const home = mkdtempSync(join(tmpdir(), "myna-account-mirror-"));
  const env = { ...process.env, MYNA_HOME: home };
  const root = resolve(import.meta.dir, "../../..");
  const myna = (...args: string[]) =>
    spawnSync(process.execPath, ["apps/cli/src/main.ts", ...args], { cwd: root, env, encoding: "utf8", timeout: 15000 });
  try {
    const setup = spawnSync(process.execPath, ["--eval", `
      import { saveAccount, archiveAccount } from "./packages/core/src/store/accounts.ts";
      import { enqueue } from "./packages/core/src/store/queue.ts";
      for (const handle of ["source", "echo"]) {
        saveAccount({ id: "bluesky:" + handle, network: "bluesky", handle, addedAt: "", creds: { password: "p" }, meta: {} });
      }
      enqueue({ scheduledFor: "2099-01-01T00:00:00.000Z", targets: ["bluesky:echo"], text: "queued for echo" });
      archiveAccount("bluesky:echo", { note: "paused" });
    `], { cwd: root, env, encoding: "utf8" });
    expect(setup.status).toBe(0);

    // Archived: refused without --restore, and it stays archived.
    const refused = myna("account", "mirror", "bluesky:echo", "--from", "bluesky:source");
    expect(refused.status).not.toBe(0);
    expect(refused.stderr + refused.stdout).toContain("--restore");
    expect(myna("accounts").stdout).toMatch(/bluesky:echo.*archived/);

    const on = myna("account", "mirror", "bluesky:echo", "--from", "bluesky:source", "--restore");
    expect(on.stderr).toBe("");
    expect(on.status).toBe(0);
    expect(on.stdout).toContain("bluesky:echo is a mirror of bluesky:source");
    expect(on.stdout).toContain("reposts and likes");

    const list = myna("accounts");
    expect(list.stdout).toMatch(/bluesky:echo.*mirror of bluesky:source/);
    expect(list.stdout).toMatch(/bluesky:source.*active/);

    const json = JSON.parse(myna("accounts", "--json").stdout) as Array<{ id: string; mirror?: { like: boolean; repost: boolean }; archived?: unknown }>;
    const echo = json.find((a) => a.id === "bluesky:echo")!;
    expect(echo.archived).toBeUndefined();
    expect(echo.mirror).toMatchObject({ like: true, repost: true });

    // Explicit target and `all`: never an original post from the mirror.
    const explicit = myna("post", "bluesky:echo", "hello", "--dry-run");
    expect(explicit.status).not.toBe(0);
    expect(explicit.stderr + explicit.stdout).toContain("mirror of bluesky:source");
    const all = myna("post", "all", "hello", "--dry-run");
    expect(all.stdout).toContain("bluesky:source");
    expect(all.stdout).not.toContain("bluesky:echo");

    const queue = JSON.parse(myna("queue", "--json").stdout) as Array<{ targets: string[]; status: string }>;
    expect(queue.filter((e) => e.targets.includes("bluesky:echo") && e.status === "pending")).toHaveLength(0);

    // --like alone: only likes.
    myna("account", "mirror", "bluesky:echo", "--from", "bluesky:source", "--like");
    const likeOnly = JSON.parse(myna("accounts", "--json").stdout).find((a: { id: string }) => a.id === "bluesky:echo");
    expect(likeOnly.mirror).toMatchObject({ like: true, repost: false });

    const status = myna("account", "mirror", "bluesky:echo");
    expect(status.stdout).toContain("0 pending, 0 done");

    const off = myna("account", "mirror", "bluesky:echo", "--off");
    expect(off.stdout).toContain("no longer a mirror");
    expect(myna("accounts").stdout).toMatch(/bluesky:echo.*active/);
    expect(myna("post", "bluesky:echo", "hello", "--dry-run").status).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
