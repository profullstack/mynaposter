/**
 * A send is booked at the clock its caller was acting at.
 *
 * What would be embarrassing: a daemon tick at noon writing history dated
 * whenever the wall clock read, so the next four-hour gap is measured from
 * the wrong moment. Under a fixed test clock that made a whole test fail
 * for the four hours before its second tick, and forever after.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postToAll } from "../src/core/poster.ts";
import { registerNetwork, unregisterNetwork, getNetwork } from "../src/net/registry.ts";
import { NO_CAPS, type Account, type Network } from "../src/net/types.ts";
import { listHistory } from "../src/store/history.ts";
import { saveAccount, resetAccountCache } from "../src/store/accounts.ts";
import { resetPlugins } from "../src/plugins/loader.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-stamp-"));
  process.env.MYNA_HOME = dir;
  resetPlugins();
  resetAccountCache();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
  resetAccountCache();
  resetPlugins();
});

const fake: Network = {
  id: "bluesky",
  name: "Fake Bluesky",
  auth: { kind: "password", fields: [] },
  caps: { ...NO_CAPS, charLimit: 300 },
  async login() {
    throw new Error("not in this test");
  },
  async post() {
    return { id: "1", url: "https://fake.test/1" };
  },
} as unknown as Network;
const account: Account = { id: "bluesky:me", network: "bluesky", handle: "me", addedAt: "2026-09-01T00:00:00.000Z", creds: {}, meta: {} };

async function withFake(run: () => Promise<void>): Promise<void> {
  const real = getNetwork("bluesky");
  registerNetwork(fake);
  saveAccount(account);
  try {
    await run();
  } finally {
    unregisterNetwork("bluesky");
    if (real) registerNetwork(real);
  }
}

test("history is dated at the stamp the caller passes, and at the wall clock without one", async () => {
  await withFake(async () => {
    const tick = Date.parse("2026-09-12T12:00:00.000Z");
    await postToAll([account], { text: "at the tick" }, { at: tick });
    expect(listHistory().find((entry) => entry.text === "at the tick")?.at).toBe("2026-09-12T12:00:00.000Z");

    const before = Date.now();
    await postToAll([account], { text: "at the wall clock" });
    const at = Date.parse(listHistory().find((entry) => entry.text === "at the wall clock")?.at ?? "");
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });
});
