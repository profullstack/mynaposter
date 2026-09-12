/**
 * Who you are, as a decentralized identifier.
 *
 * A DID is a name that resolves to keys rather than to a company: did:key
 * carries the key in the name, did:web resolves at a domain, did:plc is what
 * Bluesky's network hands out. CoinPay issues one to each account (and to
 * each agent an account runs) and lets an agent's DID be delegated by a
 * person's, which is the relationship OpenProfile calls Operator.
 *
 * `did.json` holds the session that proved a DID belongs to this person:
 * where it came from, the DID, and the token that fetched it. Attaching the
 * DID to accounts is a separate step, so one DID can own some accounts and
 * operate others.
 */
import { readJson, writeJson } from "../util/json.ts";

export const DID_FILE = "did.json";

export interface DidSession {
  /** The issuer's origin. */
  server: string;
  /** How the DID was proved: an OAuth grant, or the coinpay CLI's own login. */
  via: "oauth" | "coinpay-cli";
  did: string;
  /** human, agent, service. */
  kind: string | null;
  label: string | null;
  verified: boolean;
  name: string | null;
  email: string | null;
  /** The token the DID was read with. An OAuth access token, or the CLI's session JWT. */
  accessToken: string;
  refreshToken?: string;
  since: string;
}

export function didSession(): DidSession | null {
  return readJson<DidSession | null>(DID_FILE, null);
}

export function saveDidSession(session: DidSession): void {
  writeJson(DID_FILE, session);
}

export function clearDidSession(): void {
  writeJson(DID_FILE, null);
}

export function requireDidSession(): DidSession {
  const current = didSession();
  if (!current?.did) throw new Error("No DID yet. Run: myna did login");
  return current;
}

/** did:method:identifier, and nothing that is not one. */
export function isDid(value: string): boolean {
  return /^did:[a-z0-9]+:[A-Za-z0-9.\-_:%]+$/.test(value.trim());
}
