/**
 * One turn of the reshare loop, against a fake network and a fake server.
 *
 * What has to hold: a match is claimed before it is shared, shared through
 * the repost API where there is one and as a quote post where there is not,
 * reported either way, counted against the daily limit, and written to the
 * ledger and the history so `myna reshare log` and `myna history` both show
 * it. And none of it happens before joining.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runReshare } from "../src/core/reshare.ts";
import { ledger, saveLedger, type ReshareApi, type ReshareMatch } from "../src/store/reshare.ts";
import { saveSession } from "../src/store/cloud.ts";
import { listHistory } from "../src/store/history.ts";
import { resetAccountCache, saveAccount } from "../src/store/accounts.ts";
import { registerNetwork, unregisterNetwork } from "../src/net/registry.ts";
import { DEFAULT_RESHARE } from "../src/store/settings.ts";
import type { Account, Network } from "../src/net/types.ts";

let dir = "";
const registered: string[] = [];
const reposted: { account: string; ref: string }[] = [];
const posted: { account: string; text: string }[] = [];

function useNetwork(id: string, canRepost: boolean, charLimit = 280): void {
  registerNetwork({
    id,
    name: id,
    caps: { charLimit, mediaLimit: 4, threads: false, delete: false, timeline: false, notifications: false, stats: false, repost: canRepost, follow: false },
    async login() {
      throw new Error("not used");
    },
    async post(account: Account, options: { text: string }) {
      posted.push({ account: account.id, text: options.text });
      return { id: "new", url: `https://${id}/new` };
    },
    ...(canRepost
      ? {
          async repost(account: Account, ref: string) {
            if (ref.endsWith("/boom")) throw new Error("gone");
            reposted.push({ account: account.id, ref });
            return { id: "rt", url: `https://${id}/rt` };
          },
        }
      : {}),
  } as unknown as Network);
  registered.push(id);
}

const account = (id: string, network: string): Account => ({ id, network, handle: id, addedAt: "", creds: {}, meta: {} });

function fakeApi(matches: ReshareMatch[]) {
  const claims: { requestId: string; network: string }[] = [];
  const reports: { claimId: string; ok: boolean; url?: string; error?: string }[] = [];
  const api: ReshareApi = {
    async matches() {
      return matches;
    },
    async claim(requestId, network) {
      if (requestId === "full") throw new Error("That request has all the sharers it asked for.");
      claims.push({ requestId, network });
      return { id: `claim-${claims.length}`, requestId, network, status: "claimed" };
    },
    async report(claimId, outcome) {
      reports.push({ claimId, ...outcome });
    },
  };
  return { api, claims, reports };
}

const match = (id: string, extra: Partial<ReshareMatch> = {}): ReshareMatch => ({
  id,
  author: "ada",
  title: "A post worth sharing",
  text: null,
  topics: ["rust"],
  posts: [{ network: "rtnet", url: `https://rtnet/status/${id}` }],
  link: null,
  bountyUsd: 0,
  networks: ["rtnet"],
  score: 1,
  createdAt: new Date().toISOString(),
  ...extra,
});

function joinedHere(): void {
  saveSession({ server: "https://example.test", email: "me@example.test", token: "t", since: new Date().toISOString() });
  saveLedger({ joinedAt: new Date().toISOString(), done: [] });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-reshare-"));
  process.env.MYNA_HOME = dir;
  reposted.length = 0;
  posted.length = 0;
  resetAccountCache();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
  while (registered.length) unregisterNetwork(registered.pop() as string);
  resetAccountCache();
});

test("nothing happens before joining", async () => {
  useNetwork("rtnet", true);
  saveAccount(account("rtnet:me", "rtnet"));
  const { api, claims } = fakeApi([match("1")]);
  const turn = await runReshare({ api, settings: DEFAULT_RESHARE });
  expect(turn.skipped).toContain("not joined");
  expect(claims).toEqual([]);
  expect(reposted).toEqual([]);
});

test("a match is claimed, reposted through the API, reported, and written down", async () => {
  useNetwork("rtnet", true);
  saveAccount(account("rtnet:me", "rtnet"));
  joinedHere();
  const { api, claims, reports } = fakeApi([match("1")]);

  const turn = await runReshare({ api, settings: DEFAULT_RESHARE });

  expect(claims).toEqual([{ requestId: "1", network: "rtnet" }]);
  expect(reposted).toEqual([{ account: "rtnet:me", ref: "https://rtnet/status/1" }]);
  expect(posted).toEqual([]);
  expect(reports).toEqual([{ claimId: "claim-1", ok: true, url: "https://rtnet/rt" }]);
  expect(turn.done).toEqual([{ requestId: "1", network: "rtnet", accountId: "rtnet:me", ok: true, url: "https://rtnet/rt", how: "repost" }]);

  const book = ledger();
  expect(book.done).toHaveLength(1);
  expect(book.done[0]).toMatchObject({ requestId: "1", claimId: "claim-1", author: "ada", ok: true, how: "repost" });
  const history = listHistory();
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({ accountId: "rtnet:me", type: "reshare", ok: true, url: "https://rtnet/rt" });
});

test("a network with no repost API gets a quote post carrying the link, unless quote is off", async () => {
  useNetwork("plainnet", false, 60);
  saveAccount(account("plainnet:me", "plainnet"));
  joinedHere();
  const long = match("2", {
    title: "A very long title that will not fit in sixty characters with a url",
    posts: [{ network: "plainnet", url: "https://plainnet/status/2" }],
    networks: ["plainnet"],
  });

  const off = await runReshare({ api: fakeApi([long]).api, settings: { ...DEFAULT_RESHARE, quote: false } });
  expect(off.done).toEqual([]);
  expect(posted).toEqual([]);

  const { api, reports } = fakeApi([long]);
  const on = await runReshare({ api, settings: DEFAULT_RESHARE });
  expect(on.done[0]).toMatchObject({ how: "quote", ok: true, url: "https://plainnet/new" });
  expect(posted).toHaveLength(1);
  const text = posted[0]?.text ?? "";
  expect(text.endsWith("\nhttps://plainnet/status/2")).toBe(true);
  expect(text.length).toBeLessThanOrEqual(60);
  expect(text).toContain("…");
  expect(reports[0]).toMatchObject({ ok: true, url: "https://plainnet/new" });
});

test("a failed share is reported as failed, and does not spend the daily budget", async () => {
  useNetwork("rtnet", true);
  saveAccount(account("rtnet:me", "rtnet"));
  joinedHere();
  const { api, reports } = fakeApi([
    match("boom", { posts: [{ network: "rtnet", url: "https://rtnet/status/boom" }] }),
    match("3"),
  ]);

  const turn = await runReshare({ api, settings: { ...DEFAULT_RESHARE, perDay: 1 } });

  expect(reports).toEqual([
    { claimId: "claim-1", ok: false, error: "gone" },
    { claimId: "claim-2", ok: true, url: "https://rtnet/rt" },
  ]);
  expect(turn.done.map((entry) => entry.ok)).toEqual([false, true]);
});

test("the daily limit counts what this install already did today", async () => {
  useNetwork("rtnet", true);
  saveAccount(account("rtnet:me", "rtnet"));
  joinedHere();
  const book = ledger();
  book.done.push({ at: new Date().toISOString(), requestId: "old", claimId: "c", network: "rtnet", accountId: "rtnet:me", author: "x", ok: true, bountyUsd: 0, how: "repost" });
  book.done.push({ at: new Date(Date.now() - 25 * 3_600_000).toISOString(), requestId: "older", claimId: "d", network: "rtnet", accountId: "rtnet:me", author: "x", ok: true, bountyUsd: 0, how: "repost" });
  saveLedger(book);
  const { api, claims } = fakeApi([match("4"), match("5")]);

  const turn = await runReshare({ api, settings: { ...DEFAULT_RESHARE, perDay: 2 } });

  expect(claims).toHaveLength(1);
  expect(turn.done).toHaveLength(1);

  const again = await runReshare({ api, settings: { ...DEFAULT_RESHARE, perDay: 2 } });
  expect(again.skipped).toContain("daily limit");
});

test("a claim somebody else won, a network this install lacks, and a network it will not use are skipped", async () => {
  useNetwork("rtnet", true);
  useNetwork("othernet", true);
  saveAccount(account("rtnet:me", "rtnet"));
  saveAccount(account("othernet:me", "othernet"));
  joinedHere();
  const { api, claims } = fakeApi([
    match("full"),
    match("6", { posts: [{ network: "nowhere", url: "https://nowhere/1" }], networks: ["nowhere"] }),
    match("7", { posts: [{ network: "othernet", url: "https://othernet/1" }], networks: ["othernet"] }),
    match("8"),
  ]);

  const turn = await runReshare({ api, settings: { ...DEFAULT_RESHARE, networks: "rtnet" } });

  expect(claims).toEqual([{ requestId: "8", network: "rtnet" }]);
  expect(turn.done.map((entry) => entry.requestId)).toEqual(["8"]);
});
