/**
 * A queued repost shares a post that already exists.
 *
 * The composing path does not apply to it: there is no text to pace against,
 * no media and no thread. The scheduler has to notice that and call the
 * network's repost API instead, or a scheduled retweet quietly goes out as a
 * new post whose body is the URL.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDuePosts } from "../src/core/scheduler.ts";
import { enqueue, listQueue } from "../src/store/queue.ts";
import { resetAccountCache, saveAccount } from "../src/store/accounts.ts";
import { registerNetwork, unregisterNetwork } from "../src/net/registry.ts";
import type { Account, Network } from "../src/net/types.ts";

let dir = "";
const registered: string[] = [];

const reposted: { account: string; ref: string }[] = [];
const posted: string[] = [];

function useNetwork(id: string, canRepost: boolean): void {
  registerNetwork(fakeNetwork(id, canRepost));
  registered.push(id);
}

function fakeNetwork(id: string, canRepost: boolean): Network {
  return {
    id,
    name: id,
    caps: { charLimit: 280, mediaLimit: 4, threads: false, delete: false, timeline: false, notifications: false, stats: false, repost: canRepost, follow: false },
    async login() {
      throw new Error("not used");
    },
    async post(account: Account, options: { text: string }) {
      posted.push(options.text);
      return [{ id: "new", url: `https://${id}/new` }];
    },
    ...(canRepost
      ? {
          async repost(account: Account, ref: string) {
            reposted.push({ account: account.id, ref });
            return { id: "rt", url: `https://${id}/rt` };
          },
        }
      : {}),
  } as unknown as Network;
}

function account(id: string, network: string): Account {
  return { id, network, handle: id, displayName: id, creds: {}, meta: {} } as unknown as Account;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-repost-"));
  process.env.MYNA_HOME = dir;
  reposted.length = 0;
  posted.length = 0;
  resetAccountCache();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
  // NETWORKS is module-level and outlives this file; leaving a stand-in in
  // it fails the suites that assert every network is well formed.
  while (registered.length) unregisterNetwork(registered.pop() as string);
  resetAccountCache();
});

test("a due repost calls the network's repost API and composes nothing", async () => {
  useNetwork("rtnet", true);
  saveAccount(account("rtnet:@company", "rtnet"));

  const entry = enqueue({
    scheduledFor: new Date(Date.now() - 1000).toISOString(),
    targets: ["rtnet:@company"],
    text: "repost https://rtnet/status/1",
    repostOf: "https://rtnet/status/1",
  });

  const results = await runDuePosts();

  expect(reposted).toEqual([{ account: "rtnet:@company", ref: "https://rtnet/status/1" }]);
  // The whole point: nothing was written as a new post.
  expect(posted).toEqual([]);
  expect(results).toHaveLength(1);

  const stored = listQueue().find((item) => item.id === entry.id);
  expect(stored?.status).toBe("sent");
  expect(stored?.results?.["rtnet:@company"]?.url).toBe("https://rtnet/rt");
});

test("a network with no repost API fails the entry instead of posting the URL", async () => {
  useNetwork("plainnet", false);
  saveAccount(account("plainnet:@company", "plainnet"));

  const entry = enqueue({
    scheduledFor: new Date(Date.now() - 1000).toISOString(),
    targets: ["plainnet:@company"],
    text: "repost https://plainnet/status/1",
    repostOf: "https://plainnet/status/1",
  });

  await runDuePosts();

  expect(posted).toEqual([]);
  const stored = listQueue().find((item) => item.id === entry.id);
  expect(stored?.status).toBe("failed");
  expect(stored?.lastError).toMatch(/no repost API/i);
});

test("an ordinary queued post still goes through the composing path", async () => {
  useNetwork("rtnet2", true);
  saveAccount(account("rtnet2:@company", "rtnet2"));

  enqueue({
    scheduledFor: new Date(Date.now() - 1000).toISOString(),
    targets: ["rtnet2:@company"],
    text: "an ordinary post",
  });

  await runDuePosts();

  expect(posted).toEqual(["an ordinary post"]);
  expect(reposted).toEqual([]);
});
