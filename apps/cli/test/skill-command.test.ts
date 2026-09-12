/**
 * `myna skill`: list, init, show, path, add, default, rotate, remove, against
 * a temporary config dir with two accounts in its vault.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHeadless } from "../src/cli/headless.ts";
import { accountSkillPath, networkSkillPath, resetAccountCache, saveAccount, type Account } from "@profullstack/myna-core";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-cli-skill-"));
  process.env.MYNA_HOME = dir;
  resetAccountCache();
  saveAccount(blog);
  saveAccount(bsky);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
  resetAccountCache();
});

const blog: Account = {
  id: "htmlblog:dev.profullstack.com/~anthony/blog",
  network: "htmlblog",
  handle: "dev.profullstack.com/~anthony/blog",
  addedAt: "2026-09-05T22:00:00.000Z",
  creds: {},
  meta: { dir: "/tmp/blog", siteUrl: "https://dev.profullstack.com/~anthony/blog" },
};
const bsky: Account = { id: "bluesky:chovyfu.bsky.social", network: "bluesky", handle: "chovyfu.bsky.social", addedAt: "2026-09-01T00:00:00.000Z", creds: { token: "t" }, meta: {} };

async function run(command: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const chunks: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((text: string) => {
    chunks.push(String(text));
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await runHeadless(command, args);
    return { code, out: chunks.join(""), err: "" };
  } catch (error) {
    return { code: 1, out: chunks.join(""), err: (error as Error).message };
  } finally {
    process.stdout.write = realOut;
  }
}

test("list shows every network and account, which skill is on, and the effective limits", async () => {
  const result = await run("skill", ["list"]);
  expect(result.code).toBe(0);
  expect(result.out).toContain("htmlblog");
  expect(result.out).toContain("blog");
  expect(result.out).toContain("htmlblog:dev.profullstack.com/~anthony/blog");
  expect(result.out).toContain("4/day");
  expect(result.out).toContain("major-features-only");
  expect(result.out).toContain("300 chars");
  expect(result.out).toContain("still the built-in template");

  const json = JSON.parse((await run("skill", ["list", "--json"])).out) as { accounts: Array<{ account: string; selected: string; limits: { maxPerDay: number } }> };
  expect(json.accounts.find((row) => row.account === blog.id)?.limits.maxPerDay).toBe(4);
  expect(json.accounts.find((row) => row.account === blog.id)?.selected).toBe("skill");
});

test("init writes the missing files once and keeps them after that", async () => {
  const first = await run("skill", ["init"]);
  expect(first.code).toBe(0);
  expect(first.out).toContain("wrote");
  expect(first.out).toContain("4 written, 0 left as they were");
  expect(existsSync(networkSkillPath("htmlblog"))).toBe(true);
  expect(existsSync(networkSkillPath("bluesky"))).toBe(true);
  expect(existsSync(accountSkillPath("htmlblog", blog.handle))).toBe(true);
  expect(existsSync(accountSkillPath("bluesky", bsky.handle))).toBe(true);

  const path = accountSkillPath("htmlblog", blog.handle);
  writeFileSync(path, readFileSync(path, "utf8") + "\nMine.\n");
  const second = await run("skill", ["init"]);
  expect(second.out).toContain("0 written, 4 left as they were");
  expect(readFileSync(path, "utf8")).toContain("Mine.");
});

test("show prints the file, for a network or an account, and path says where it is", async () => {
  const network = await run("skill", ["show", "htmlblog"]);
  expect(network.code).toBe(0);
  expect(network.out).toMatch(/^---\nname: myna-htmlblog\n/);
  expect(network.out).toContain("At most 4 posts a day");

  const account = await run("skill", ["show", "htmlblog:dev.profullstack.com/~anthony/blog"]);
  expect(account.code).toBe(0);
  expect(account.out).toContain("name: myna-htmlblog-dev.profullstack.com-~anthony-blog");
  expect(account.out).toContain("effective limits");

  // The slug form of the handle works as well, since that is what a URL carries.
  expect((await run("skill", ["show", "htmlblog:dev.profullstack.com-~anthony-blog"])).code).toBe(0);

  const path = await run("skill", ["path", "htmlblog:dev.profullstack.com/~anthony/blog"]);
  expect(path.out.trim()).toBe(accountSkillPath("htmlblog", blog.handle));
  expect((await run("skill", ["path", "bluesky"])).out.trim()).toBe(networkSkillPath("bluesky"));

  const missing = await run("skill", ["show", "bluesky:nobody"]);
  expect(missing.code).toBe(1);
  expect(missing.err).toContain("No connected account");
});

test("add, default, rotate and remove manage an account's skills", async () => {
  const file = join(dir, "quiet.md");
  writeFileSync(file, "---\nmaxPerDay: 1\n---\n\nOne a day, no more.\n");
  const added = await run("skill", ["add", "bluesky:chovyfu.bsky.social", "quiet", "--from", file]);
  expect(added.code).toBe(0);
  expect(added.out).toContain("wrote");
  expect(added.out).toContain("myna skill default");
  expect(readFileSync(accountSkillPath("bluesky", bsky.handle, "quiet"), "utf8")).toContain("One a day, no more.");

  const pinned = await run("skill", ["default", "bluesky:chovyfu.bsky.social", "quiet"]);
  expect(pinned.code).toBe(0);
  let list = await run("skill", ["list"]);
  expect(list.out).toContain("pinned quiet");
  expect(list.out).toContain("1/day");

  const rotate = await run("skill", ["rotate", "bluesky:chovyfu.bsky.social", "on"]);
  expect(rotate.code).toBe(0);
  expect(rotate.out).toContain("rotation on");
  expect(rotate.out).toContain("skill > quiet");
  list = await run("skill", ["list"]);
  expect(list.out).toContain("rotating");

  expect((await run("skill", ["rotate", "bluesky:chovyfu.bsky.social", "off"])).out).toContain("rotation off");

  const removed = await run("skill", ["remove", "bluesky:chovyfu.bsky.social", "quiet"]);
  expect(removed.code).toBe(0);
  expect(existsSync(accountSkillPath("bluesky", bsky.handle, "quiet"))).toBe(false);
  const noDefault = await run("skill", ["remove", "bluesky:chovyfu.bsky.social", "skill"]);
  expect(noDefault.code).toBe(1);
  expect(noDefault.err).toContain("default");
});
