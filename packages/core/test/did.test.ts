/**
 * A DID is proved at CoinPay and attached to accounts.
 *
 * What has to hold: the CLI-session door reads the DID from CoinPay's answer
 * and nothing else, and says the right thing when the login has expired or
 * there is no DID; userinfo's did claim is read in either shape; assigning
 * marks accounts with the DID and a role, unassigning clears it; the
 * OpenProfile carries the DID as identity for a person and as Operator for
 * an agent.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assignDid, didFromUserInfo, didStatus, loginWithCoinPayCli, unassignDid } from "../src/core/did.ts";
import { didSession } from "../src/store/did.ts";
import { resetAccountCache, saveAccount, listAccounts } from "../src/store/accounts.ts";
import { buildProfile } from "../src/store/profile.ts";
import { parseOpenProfile } from "../src/core/openprofile.ts";
import { DEFAULT_SETTINGS } from "../src/store/settings.ts";
import type { Account } from "../src/net/types.ts";

let dir = "";
const DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const account = (id: string, network: string): Account => ({ id, network, handle: id.split(":")[1] ?? id, addedAt: "", creds: {}, meta: {} });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-did-"));
  process.env.MYNA_HOME = dir;
  process.env.COINPAY_CONFIG = join(dir, "coinpay.json");
  resetAccountCache();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_HOME;
  delete process.env.COINPAY_CONFIG;
  resetAccountCache();
});

test("the userinfo did claim is read in either shape, and a non-DID is not one", () => {
  expect(didFromUserInfo({ did: DID, did_kind: "human", did_verified: true })).toEqual({ did: DID, kind: "human", label: null, verified: true });
  expect(didFromUserInfo({ did: { did: DID, did_kind: "agent", label: "bot" } })).toEqual({ did: DID, kind: "agent", label: "bot", verified: false });
  expect(didFromUserInfo({ did: "not a did" })).toBeNull();
  expect(didFromUserInfo({})).toBeNull();
});

test("the coinpay CLI door: the DID comes from CoinPay's answer, and expiry or absence are said plainly", async () => {
  writeFileSync(process.env.COINPAY_CONFIG as string, JSON.stringify({ jwtToken: "jwt-1", walletId: "w" }));
  let status = 200;
  const seen: { url: string; auth: string | null }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), auth: new Headers(init?.headers as Record<string, string>).get("authorization") });
    if (status !== 200) return new Response("{}", { status });
    return new Response(JSON.stringify({ did: DID, did_kind: "human", label: "Anthony", verified: true }), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const session = await loginWithCoinPayCli({ server: "https://coinpay.test/", fetch: fetcher });
  expect(session).toMatchObject({ did: DID, kind: "human", label: "Anthony", verified: true, via: "coinpay-cli", server: "https://coinpay.test", accessToken: "jwt-1" });
  expect(seen).toEqual([{ url: "https://coinpay.test/api/reputation/did/me", auth: "Bearer jwt-1" }]);
  expect(didSession()?.did).toBe(DID);

  status = 401;
  await expect(loginWithCoinPayCli({ server: "https://coinpay.test", fetch: fetcher })).rejects.toThrow(/expired/);
  status = 404;
  await expect(loginWithCoinPayCli({ server: "https://coinpay.test", fetch: fetcher })).rejects.toThrow(/no DID there yet/);
});

test("without a coinpay CLI login the door says how to get one", async () => {
  await expect(loginWithCoinPayCli({ fetch: (async () => new Response("{}")) as unknown as typeof fetch })).rejects.toThrow(/coinpay login/);
});

test("assign marks accounts with the DID and a role; unassign clears; status reads it back", async () => {
  writeFileSync(process.env.COINPAY_CONFIG as string, JSON.stringify({ jwtToken: "jwt-1" }));
  await loginWithCoinPayCli({ server: "https://coinpay.test", fetch: (async () => new Response(JSON.stringify({ did: DID, did_kind: "human" }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch });
  saveAccount(account("bluesky:me", "bluesky"));
  saveAccount(account("mastodon:me", "mastodon"));
  saveAccount(account("bluesky:bot", "bluesky"));

  expect(assignDid(["all"]).map((a) => a.id)).toEqual(["bluesky:bot", "bluesky:me", "mastodon:me"]);
  expect(assignDid(["bluesky:bot"], "operator").map((a) => a.id)).toEqual(["bluesky:bot"]);
  expect(() => assignDid(["nope:x"])).toThrow(/No account nope:x/);

  const status = didStatus();
  expect(status.owned.map((a) => a.id)).toEqual(["bluesky:me", "mastodon:me"]);
  expect(status.operated.map((a) => a.id)).toEqual(["bluesky:bot"]);
  expect(listAccounts().find((a) => a.id === "bluesky:bot")?.meta).toEqual({ did: DID, didRole: "operator" });

  expect(unassignDid(["mastodon:me"]).map((a) => a.id)).toEqual(["mastodon:me"]);
  expect(listAccounts().find((a) => a.id === "mastodon:me")?.meta).toEqual({});
});

test("the OpenProfile carries the DID: identity for a person, Operator for an agent", async () => {
  writeFileSync(process.env.COINPAY_CONFIG as string, JSON.stringify({ jwtToken: "jwt-1" }));
  await loginWithCoinPayCli({ server: "https://coinpay.test", fetch: (async () => new Response(JSON.stringify({ did: DID }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch });
  saveAccount(account("bluesky:me", "bluesky"));

  // Not attached yet: the profile does not claim it.
  expect(buildProfile({ ...DEFAULT_SETTINGS, profile: { ...DEFAULT_SETTINGS.profile, name: "Anthony" } })).not.toContain("DID");

  assignDid(["all"]);
  const person = buildProfile({ ...DEFAULT_SETTINGS, profile: { ...DEFAULT_SETTINGS.profile, name: "Anthony", kind: "person" } });
  expect(person).toContain(`- **DID**: ${DID}`);
  expect(parseOpenProfile(person).did).toBe(DID);
  expect(parseOpenProfile(person).operator).toBeNull();

  assignDid(["all"], "operator");
  const agent = buildProfile({ ...DEFAULT_SETTINGS, profile: { ...DEFAULT_SETTINGS.profile, name: "Athena", kind: "agent" } });
  expect(agent).not.toContain(`- **DID**: ${DID}\n- **Resume**`);
  expect(parseOpenProfile(agent).operator).toEqual({ did: DID });
  expect(agent).toContain("## Operator");
});
