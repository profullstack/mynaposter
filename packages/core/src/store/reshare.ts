/**
 * The client half of the reshare network, and the local ledger.
 *
 * The network lives on the same server as cloud backup and uses the same
 * sign-in, so `myna cloud login` is the only account anyone needs. What goes
 * up is public by design: an OpenProfile.md (who you are, what you will
 * reshare, what it costs) and, for your own posts, the URLs you want
 * amplified. No token for any social network ever leaves this machine; the
 * reshares themselves are done here, by this install, with its own accounts.
 *
 * The ledger is `reshare.json`: when this install joined, and every reshare it
 * has done for somebody else, so the daily limit can be counted without
 * asking the server and so `myna reshare log` works offline.
 */
import { readJson, writeJson } from "../util/json.ts";
import { RESHARE_FILE } from "../util/paths.ts";
import { getJson, postJson, request } from "../util/http.ts";
import { requireSession, session, type CloudSession } from "./cloud.ts";

export interface ResharePost {
  network: string;
  url: string;
  id?: string;
}

/** A request as the network hands it to a sharer: what to share, and where. */
export interface ReshareMatch {
  id: string;
  /** Who asked, by handle, so a sharer can see whose post it is. */
  author: string;
  title: string | null;
  text: string | null;
  topics: string[];
  posts: ResharePost[];
  /** A page any network can quote when the post itself is not on it. */
  link: string | null;
  bountyUsd: number;
  /** Networks this sharer was matched on. */
  networks: string[];
  score: number;
  createdAt: string;
}

export interface ReshareRequestInput {
  title?: string;
  text?: string;
  topics: string[];
  posts: ResharePost[];
  link?: string | null;
  bountyUsd: number;
  maxSharers: number;
}

export interface ReshareRequestRow {
  id: string;
  title: string | null;
  topics: string[];
  posts: ResharePost[];
  bountyUsd: number;
  maxSharers: number;
  status: string;
  createdAt: string;
  claims: Array<{ id: string; sharer: string; network: string; status: string; url: string | null; bountyUsd: number; paidAt: string | null }>;
}

export interface ReshareClaim {
  id: string;
  requestId: string;
  network: string;
  status: "claimed" | "done" | "failed";
}

export interface LedgerRow {
  id: string;
  requestId: string;
  /** The other party, by handle. */
  who: string;
  network: string;
  url: string | null;
  bountyUsd: number;
  /** Where to send the money, from the sharer's profile. */
  pay: string | null;
  doneAt: string;
  paidAt: string | null;
  payRef: string | null;
}

export interface ReshareProfileStatus {
  joined: boolean;
  handle: string | null;
  topics: string[];
  networks: string[];
  rateUsd: number;
  perDay: number;
  updatedAt: string | null;
  /** How many reshares this profile has done for others, as the server counts them. */
  done: number;
  /** How many of this person's own requests are open. */
  open: number;
}

/** What the run loop needs from the server. Injected, so tests can fake it. */
export interface ReshareApi {
  matches(limit: number): Promise<ReshareMatch[]>;
  claim(requestId: string, network: string): Promise<ReshareClaim>;
  report(claimId: string, outcome: { ok: boolean; url?: string; error?: string }): Promise<void>;
}

const auth = (current: CloudSession) => ({ authorization: `Bearer ${current.token}` });

type Reply<T> = { ok: true } & T;
type Fail = { ok: false; error?: string };

function unwrap<T>(reply: Reply<T> | Fail, fallback: string): T {
  if (!reply.ok) throw new Error(reply.error ?? fallback);
  return reply;
}

export async function join(markdown: string): Promise<ReshareProfileStatus> {
  const current = requireSession();
  const reply = await request(`${current.server}/v1/reshare/profile`, {
    method: "PUT",
    headers: { ...auth(current), "content-type": "application/json" },
    body: JSON.stringify({ markdown }),
  });
  const parsed = (await reply.json()) as Reply<{ profile: ReshareProfileStatus }> | Fail;
  const status = unwrap(parsed, "The network refused that profile.").profile;
  const file = ledger();
  file.joinedAt = file.joinedAt ?? new Date().toISOString();
  saveLedger(file);
  return status;
}

export async function leave(): Promise<boolean> {
  const current = requireSession();
  const reply = await request(`${current.server}/v1/reshare/profile`, { method: "DELETE", headers: auth(current) });
  const parsed = (await reply.json()) as { ok: boolean };
  const file = ledger();
  delete file.joinedAt;
  saveLedger(file);
  return parsed.ok;
}

export async function status(): Promise<ReshareProfileStatus> {
  const current = requireSession();
  const reply = await getJson<Reply<{ profile: ReshareProfileStatus }> | Fail>(`${current.server}/v1/reshare/profile`, {
    headers: auth(current),
  });
  return unwrap(reply, "Could not read the profile.").profile;
}

export async function submit(input: ReshareRequestInput): Promise<{ id: string; matched: number }> {
  const current = requireSession();
  const reply = await postJson<Reply<{ id: string; matched: number }> | Fail>(`${current.server}/v1/reshare/requests`, input, {
    headers: auth(current),
  });
  return unwrap(reply, "The network refused that request.");
}

export async function requests(): Promise<ReshareRequestRow[]> {
  const current = requireSession();
  const reply = await getJson<Reply<{ requests: ReshareRequestRow[] }> | Fail>(`${current.server}/v1/reshare/requests`, {
    headers: auth(current),
  });
  return unwrap(reply, "Could not list requests.").requests;
}

export async function close(id: string): Promise<boolean> {
  const current = requireSession();
  const reply = await request(`${current.server}/v1/reshare/requests/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: auth(current),
  });
  return ((await reply.json()) as { ok: boolean }).ok;
}

export async function matches(limit = 10): Promise<ReshareMatch[]> {
  const current = requireSession();
  const reply = await getJson<Reply<{ matches: ReshareMatch[] }> | Fail>(
    `${current.server}/v1/reshare/matches?limit=${limit}`,
    { headers: auth(current) },
  );
  return unwrap(reply, "Could not fetch matches.").matches;
}

export async function claim(requestId: string, network: string): Promise<ReshareClaim> {
  const current = requireSession();
  const reply = await postJson<Reply<{ claim: ReshareClaim }> | Fail>(
    `${current.server}/v1/reshare/claims`,
    { requestId, network },
    { headers: auth(current) },
  );
  return unwrap(reply, "That request could not be claimed.").claim;
}

export async function report(claimId: string, outcome: { ok: boolean; url?: string; error?: string }): Promise<void> {
  const current = requireSession();
  const reply = await request(`${current.server}/v1/reshare/claims/${encodeURIComponent(claimId)}`, {
    method: "PATCH",
    headers: { ...auth(current), "content-type": "application/json" },
    body: JSON.stringify(outcome),
  });
  unwrap((await reply.json()) as Reply<object> | Fail, "The outcome was not recorded.");
}

/** What you owe, and what you are owed. */
export async function ledgerRemote(): Promise<{ owed: LedgerRow[]; earned: LedgerRow[] }> {
  const current = requireSession();
  const reply = await getJson<Reply<{ owed: LedgerRow[]; earned: LedgerRow[] }> | Fail>(`${current.server}/v1/reshare/ledger`, {
    headers: auth(current),
  });
  return unwrap(reply, "Could not read the ledger.");
}

/** Mark a reshare you owe for as paid, with the reference you paid under. */
export async function markPaid(claimId: string, ref: string): Promise<void> {
  const current = requireSession();
  const reply = await request(`${current.server}/v1/reshare/claims/${encodeURIComponent(claimId)}/paid`, {
    method: "PATCH",
    headers: { ...auth(current), "content-type": "application/json" },
    body: JSON.stringify({ ref }),
  });
  unwrap((await reply.json()) as Reply<object> | Fail, "The payment was not recorded.");
}

/** The real client, in the shape the run loop takes. */
export const api: ReshareApi = { matches, claim, report };

// --- the local ledger ------------------------------------------------------

export interface DoneReshare {
  at: string;
  requestId: string;
  claimId: string;
  network: string;
  accountId: string;
  /** Whose post it was. */
  author: string;
  ok: boolean;
  url?: string;
  error?: string;
  bountyUsd: number;
  /** `repost` through the network's API, or `quote`, a new post carrying the link. */
  how: "repost" | "quote";
}

export interface ReshareLedger {
  joinedAt?: string;
  done: DoneReshare[];
}

const LIMIT = 2000;

export function ledger(): ReshareLedger {
  const file = readJson<Partial<ReshareLedger>>(RESHARE_FILE, {});
  return { ...(file.joinedAt ? { joinedAt: file.joinedAt } : {}), done: Array.isArray(file.done) ? file.done : [] };
}

export function saveLedger(file: ReshareLedger): void {
  if (file.done.length > LIMIT) file.done = file.done.slice(-LIMIT);
  writeJson(RESHARE_FILE, file);
}

export function recordDone(entry: DoneReshare): void {
  const file = ledger();
  file.done.push(entry);
  saveLedger(file);
}

/** Joined, as far as this machine knows. The server is the authority; this is the cheap check. */
export function joined(): boolean {
  return Boolean(session()?.token) && Boolean(ledger().joinedAt);
}

/** Successful reshares in the last rolling day. */
export function doneToday(now = Date.now()): DoneReshare[] {
  const since = now - 24 * 3_600_000;
  return ledger().done.filter((entry) => entry.ok && Date.parse(entry.at) >= since);
}
