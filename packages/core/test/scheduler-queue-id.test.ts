/**
 * A queued post hands the adapter its queue entry id, so a network that
 * dedupes on a client id (bl0ggers' external_id) can make a retry of the
 * entry update the post it already wrote. The id is passed at send time and
 * never stored on the entry.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDuePosts } from "../src/core/scheduler.ts";
import { enqueue, listQueue } from "../src/store/queue.ts";
import { resetAccountCache, saveAccount } from "../src/store/accounts.ts";
import { registerNetwork, unregisterNetwork } from "../src/net/registry.ts";
import { NO_CAPS, type Account, type Network, type PostInput } from "../src/net/types.ts";

let dir = "";
const seen: PostInput[] = [];

const net: Network = {
  id: "qidnet",
  name: "qidnet",
  category: "minor",
  blurb: "Test double.",
  auth: { kind: "token", fields: [] },
  caps: { ...NO_CAPS },
  async login() {
    throw new Error("not used");
  },
  async post(_account, input) {
    seen.push(input);
    return { id: "1", url: "https://qidnet/1" };
  },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-qid-"));
  process.env.MYNA_HOME = dir;
  seen.length = 0;
  resetAccountCache();
  registerNetwork(net);
});

afterEach(() => {
  unregisterNetwork("qidnet");
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
  resetAccountCache();
});

test("the daemon passes the entry id as extra.queueId and does not store it", async () => {
  saveAccount({ id: "qidnet:me", network: "qidnet", handle: "me", addedAt: new Date().toISOString(), creds: {}, meta: {} } as Account);
  const entry = enqueue({
    scheduledFor: new Date(Date.now() - 1000).toISOString(),
    targets: ["qidnet:me"],
    text: "hello from the queue",
    extra: { tags: "a" },
  });

  await runDuePosts();

  expect(seen).toHaveLength(1);
  expect(seen[0].extra).toEqual({ tags: "a", queueId: entry.id });
  const stored = listQueue().find((item) => item.id === entry.id);
  expect(stored?.status).toBe("sent");
  expect(stored?.extra).toEqual({ tags: "a" });
});
