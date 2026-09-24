/**
 * `myna newsletter track connect <site>`: tracking set up from a CrawlProof
 * project with the token myna already holds, against a faked CrawlProof.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectTracking, newsletterTracking } from "../src/core/newsletter.ts";
import { setPluginSecrets } from "../src/store/accounts.ts";
import { loadSettings } from "../src/store/settings.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-connect-"));
  process.env.MYNA_HOME = dir;
  process.env.MYNA_PASSPHRASE = "test passphrase";
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
  delete process.env.MYNA_PASSPHRASE;
});

const SECRET = "c17c71958f0649cd9ea5f949a0df64bc72b890b7a4468fb1009c11ce894118cd";

function crawlproof(enabled: boolean) {
  const calls: string[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    expect(new Headers(init?.headers as Record<string, string>).get("authorization")).toBe("Bearer crp_test");
    if (url === "https://crawlproof.test/api/v1/email-tracking/moshcode.sh?secret=1") {
      return Response.json({ site: "moshcode.sh", tracking_id: "e960e0a69972a7f34ea197bb", enabled, secret: SECRET });
    }
    if (url === "https://crawlproof.test/api/v1/email-tracking/moshcode.sh/enable" && init?.method === "POST") {
      return Response.json({ site: "moshcode.sh", tracking_id: "e960e0a69972a7f34ea197bb", enabled: true });
    }
    return Response.json({ error: "No such project, or more than one matches. Use the project id." }, { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

test("connect reads the id and secret, switches tracking on when off, and keeps both", async () => {
  setPluginSecrets("crawlproof", { token: "crp_test", url: "https://crawlproof.test/" });
  const cp = crawlproof(false);
  const connected = await connectTracking("moshcode.sh", { fetcher: cp.fetcher });
  expect(connected).toEqual({ site: "moshcode.sh", trackingId: "e960e0a69972a7f34ea197bb", enabled: true, host: "https://crawlproof.test" });
  expect(cp.calls).toEqual([
    "GET https://crawlproof.test/api/v1/email-tracking/moshcode.sh?secret=1",
    "POST https://crawlproof.test/api/v1/email-tracking/moshcode.sh/enable",
  ]);
  expect(newsletterTracking()).toEqual({ id: "e960e0a69972a7f34ea197bb", secret: SECRET, host: "https://crawlproof.test" });
  expect(loadSettings().newsletter.trackingHost).toBe("https://crawlproof.test");
});

test("an already-on project is not switched again, and failures say why", async () => {
  setPluginSecrets("crawlproof", { token: "crp_test", url: "https://crawlproof.test" });
  const on = crawlproof(true);
  expect((await connectTracking("moshcode.sh", { fetcher: on.fetcher })).enabled).toBe(false);
  expect(on.calls).toHaveLength(1);
  await expect(connectTracking("nope.dev", { fetcher: on.fetcher })).rejects.toThrow("CrawlProof: 404 No such project");
});

test("without a CrawlProof token it says how to get one", async () => {
  setPluginSecrets("crawlproof", {});
  await expect(connectTracking("moshcode.sh", { fetcher: crawlproof(true).fetcher })).rejects.toThrow("myna crawlproof login");
});
