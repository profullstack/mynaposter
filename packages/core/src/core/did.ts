/**
 * `myna did`: prove a DID, then attach it to accounts.
 *
 * Proving it is CoinPay's job. Two ways in: an OAuth grant with the `did`
 * scope, through the same loopback flow every OAuth network uses, which is
 * the right door for anyone; or the coinpay CLI's own session on this
 * machine, which is the short door for someone who already ran
 * `coinpay login`. Either way the DID comes from CoinPay's answer, never
 * from what was typed.
 *
 * Attaching it is myna's job. An account's meta gets `did` and `didRole`:
 * `owner` means the DID is the person behind the account; `operator` means
 * the DID is answerable for an account that is itself an agent. Both show
 * in the OpenProfile: the identity block carries the DID, and an agent's
 * Operator section names it.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { authorize } from "../net/oauth2.ts";
import type { Account, LoginContext } from "../net/types.ts";
import { listAccounts, saveAccount } from "../store/accounts.ts";
import { loadSettings } from "../store/settings.ts";
import { didSession, isDid, saveDidSession, type DidSession } from "../store/did.ts";

export const DEFAULT_DID_SERVER = "https://coinpayportal.com";

/** The OAuth client myna is registered as at CoinPay: public, PKCE, loopback redirect. */
export const DEFAULT_DID_CLIENT_ID = "cp_3aedc5cd194ff147d86341a2";

export type DidRole = "owner" | "operator";

export interface DidLoginOptions {
  ctx: LoginContext;
  server?: string;
  clientId?: string;
  fetch?: typeof fetch;
}

interface UserInfo {
  sub?: string;
  name?: string;
  email?: string;
  did?: string | { did?: string; did_kind?: string; label?: string; verified?: boolean };
  did_kind?: string;
  did_label?: string;
  did_verified?: boolean;
}

function noDid(server: string): Error {
  return new Error(
    `CoinPay knows you, but you have no DID there yet. Claim one in the CoinPay dashboard (${server}/dashboard, Reputation), then run myna did login again.`,
  );
}

/** What userinfo said about the DID, whichever shape the claim takes. */
export function didFromUserInfo(info: UserInfo): { did: string; kind: string | null; label: string | null; verified: boolean } | null {
  if (typeof info.did === "string" && isDid(info.did)) {
    return { did: info.did, kind: info.did_kind ?? null, label: info.did_label ?? null, verified: Boolean(info.did_verified) };
  }
  if (info.did && typeof info.did === "object" && typeof info.did.did === "string" && isDid(info.did.did)) {
    return { did: info.did.did, kind: info.did.did_kind ?? null, label: info.did.label ?? null, verified: Boolean(info.did.verified) };
  }
  return null;
}

/** Prove the DID through a CoinPay OAuth grant with the `did` scope. */
export async function loginWithCoinPay(options: DidLoginOptions): Promise<DidSession> {
  const settings = loadSettings();
  const server = (options.server ?? settings.did.server ?? DEFAULT_DID_SERVER).replace(/\/+$/, "");
  const clientId = options.clientId ?? settings.did.clientId ?? DEFAULT_DID_CLIENT_ID;
  if (!clientId) throw new Error("No OAuth client id for CoinPay. Set one with: myna did set clientId <id>");
  const fetcher = options.fetch ?? fetch;

  const tokens = await authorize(
    {
      authorizeUrl: `${server}/api/oauth/authorize`,
      tokenUrl: `${server}/api/oauth/token`,
      clientId,
      scopes: ["openid", "profile", "did"],
      pkce: true,
      mode: "loopback",
    },
    options.ctx,
  );

  const response = await fetcher(`${server}/api/oauth/userinfo`, { headers: { authorization: `Bearer ${tokens.access_token}`, accept: "application/json" } });
  if (!response.ok) throw new Error(`CoinPay would not say who you are (${response.status}).`);
  const info = (await response.json()) as UserInfo;
  const found = didFromUserInfo(info);
  if (!found) throw noDid(server);

  const session: DidSession = {
    server,
    via: "oauth",
    ...found,
    name: info.name ?? null,
    email: info.email ?? null,
    accessToken: tokens.access_token,
    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    since: new Date().toISOString(),
  };
  saveDidSession(session);
  return session;
}

/** Where the coinpay CLI keeps its login. */
export function coinpayCliSessionPath(): string {
  return process.env.COINPAY_CONFIG ?? join(homedir(), ".coinpay.json");
}

/** Prove the DID with the coinpay CLI's own session, for someone who already ran `coinpay login`. */
export async function loginWithCoinPayCli(options: { server?: string; fetch?: typeof fetch } = {}): Promise<DidSession> {
  const settings = loadSettings();
  const server = (options.server ?? settings.did.server ?? DEFAULT_DID_SERVER).replace(/\/+$/, "");
  const path = coinpayCliSessionPath();
  if (!existsSync(path)) throw new Error(`No coinpay CLI login at ${path}. Run: coinpay login   (or: myna did login, for the browser flow)`);
  const file = JSON.parse(readFileSync(path, "utf8")) as { jwtToken?: string };
  if (!file.jwtToken) throw new Error(`${path} has no session token. Run: coinpay login`);

  const fetcher = options.fetch ?? fetch;
  const response = await fetcher(`${server}/api/reputation/did/me`, { headers: { authorization: `Bearer ${file.jwtToken}`, accept: "application/json" } });
  if (response.status === 401) throw new Error("The coinpay CLI login has expired. Run: coinpay login");
  if (response.status === 404) throw noDid(server);
  if (!response.ok) throw new Error(`CoinPay answered ${response.status} to the DID lookup.`);
  const me = (await response.json()) as { did?: string; did_kind?: string; label?: string | null; verified?: boolean };
  if (!me.did || !isDid(me.did)) throw noDid(server);

  const session: DidSession = {
    server,
    via: "coinpay-cli",
    did: me.did,
    kind: me.did_kind ?? null,
    label: me.label ?? null,
    verified: Boolean(me.verified),
    name: null,
    email: null,
    accessToken: file.jwtToken,
    since: new Date().toISOString(),
  };
  saveDidSession(session);
  return session;
}

/** The accounts named, or every account for `all`. */
export function resolveDidTargets(specs: string[], accounts = listAccounts()): Account[] {
  if (!specs.length || specs.includes("all")) return accounts;
  const wanted = new Set(specs.map((spec) => spec.trim()));
  const found = accounts.filter((account) => wanted.has(account.id) || wanted.has(account.network));
  const missing = [...wanted].filter((spec) => !accounts.some((account) => account.id === spec || account.network === spec));
  if (missing.length) throw new Error(`No account ${missing.join(", ")}. myna accounts lists them.`);
  return found;
}

/** Attach the proved DID to accounts, as their owner or their operator. */
export function assignDid(specs: string[], role: DidRole = "owner", session = didSession()): Account[] {
  if (!session?.did) throw new Error("No DID yet. Run: myna did login");
  const targets = resolveDidTargets(specs);
  for (const account of targets) {
    saveAccount({ ...account, meta: { ...account.meta, did: session.did, didRole: role } });
  }
  return targets;
}

export function unassignDid(specs: string[]): Account[] {
  const targets = resolveDidTargets(specs).filter((account) => account.meta.did);
  for (const account of targets) {
    const { did: _did, didRole: _role, ...rest } = account.meta;
    saveAccount({ ...account, meta: rest });
  }
  return targets;
}

export interface DidStatus {
  session: DidSession | null;
  owned: Account[];
  operated: Account[];
  /** Accounts carrying some other DID than the session's. */
  foreign: Account[];
}

export function didStatus(): DidStatus {
  const session = didSession();
  const accounts = listAccounts();
  const mine = (account: Account): boolean => Boolean(session?.did) && account.meta.did === session?.did;
  return {
    session,
    owned: accounts.filter((account) => mine(account) && account.meta.didRole !== "operator"),
    operated: accounts.filter((account) => mine(account) && account.meta.didRole === "operator"),
    foreign: accounts.filter((account) => account.meta.did && !mine(account)),
  };
}
