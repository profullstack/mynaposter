/**
 * An AT Protocol account, made from your OpenProfile.
 *
 * The network behind Bluesky is servers anyone can run, and an account is a
 * request to one of them: a handle under a domain the server offers, an
 * email, a password. Everything that request needs is already in the
 * OpenProfile myna keeps (`myna profile`): the handle you go by, your email,
 * your name, your headline, your home page, your avatar. So signing up is
 * one command, and the new account's profile is the same file pushed up.
 *
 * Nothing here knows about the vault or the accounts file. The CLI saves
 * what comes back; this module only talks to the PDS, so a test can hand it
 * a fetch and never touch the network.
 */
import { randomBytes } from "node:crypto";
import type { Account } from "../net/types.ts";
import { normalizeInstance } from "../util/http.ts";
import { probeAtproto } from "./atproto.ts";
import type { OpenProfile } from "./openprofile.ts";

export interface SignupInput {
  /** The PDS: `https://pds.example`, or anything `atprotoOrigin` understands. */
  service: string;
  /** A full handle (`ada.pds.example`) or just the local part; default: your OpenProfile handle under the PDS's first domain. */
  handle?: string;
  /** Default: the Email line of your OpenProfile. */
  email?: string;
  /** Default: generated, 144 bits, and returned so the caller can keep it. */
  password?: string;
  inviteCode?: string;
  profile: OpenProfile;
  fetch?: typeof fetch;
}

export interface SignupResult {
  account: Account;
  did: string;
  password: string;
  service: string;
}

/** Bluesky's limits on a profile record. */
const DISPLAY_NAME_MAX = 64;
const DESCRIPTION_MAX = 256;
/** A PDS accepts an avatar up to 1 MB. */
const AVATAR_MAX_BYTES = 1_000_000;

type Fetch = typeof fetch;

async function call<T>(doFetch: Fetch, url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const response = await doFetch(url, {
    ...rest,
    headers: { accept: "application/json", ...(json !== undefined ? { "content-type": "application/json" } : {}), ...(rest.headers ?? {}) },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  const text = await response.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok) {
    const error = parsed as { error?: string; message?: string };
    throw new Error(error.message ?? error.error ?? `${url} answered ${response.status}`);
  }
  return parsed as T;
}

/** The value of an identity line, by key, however it was capitalised. */
export function identityValue(profile: OpenProfile, key: string): string | undefined {
  const wanted = key.toLowerCase();
  const pair = profile.identity.find((entry) => entry.key.trim().toLowerCase() === wanted);
  return pair?.value.trim() || undefined;
}

/** What a handle's local part may contain: letters, digits, hyphens, no edge hyphen. */
function localPart(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^@/, "")
    .split(/[.@]/)[0]!
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

/**
 * The handle to ask for. A full handle is taken as given; a bare name goes
 * under the server's first user domain; with nothing given, the OpenProfile
 * handle's local part does (`chovyfu.bsky.social` becomes `chovyfu` at the
 * new server).
 */
export function handleFor(profile: OpenProfile, userDomains: readonly string[], override?: string): string {
  const domain = userDomains[0];
  const given = override?.trim().replace(/^@/, "");
  if (given && given.includes(".")) return given.toLowerCase();
  const local = localPart(given || profile.handle || profile.name || "");
  if (!local) throw new Error("No handle to sign up with. Set one with --handle, or put a Handle line in your OpenProfile (myna profile).");
  if (!domain) throw new Error("This server offers no handle domains, so a full handle is needed: --handle you.your-domain.example");
  return `${local}${domain.startsWith(".") ? domain : `.${domain}`}`.toLowerCase();
}

/** 144 random bits, URL-safe. Long enough that nobody types it; the vault holds it. */
export const generatePassword = (): string => randomBytes(18).toString("base64url");

/** Create the account. The PDS is probed first so a relay or a dead host fails with a reason, not a 404. */
export async function createAccount(input: SignupInput): Promise<SignupResult> {
  const doFetch = input.fetch ?? fetch;
  const service = normalizeInstance(input.service);
  const probe = await probeAtproto(service, { fetch: doFetch });
  if (!probe.online) throw new Error(`Nothing at ${service} answered as an AT Protocol server${probe.error ? `: ${probe.error}` : "."}`);
  if (probe.kind !== "pds") throw new Error(`${service} is a ${probe.kind}, not a PDS. Accounts are made on a PDS; myna atproto list --kind pds shows some.`);
  if (probe.inviteCodeRequired && !input.inviteCode) throw new Error(`${service} needs an invite code: --invite <code>.`);

  const handle = handleFor(input.profile, probe.userDomains, input.handle);
  const email = input.email?.trim() || identityValue(input.profile, "email");
  if (!email) throw new Error("The PDS needs an email. Pass --email, or add an Email line to your OpenProfile (myna profile).");
  const password = input.password || generatePassword();

  const created = await call<{ did: string; handle: string; accessJwt: string }>(doFetch, `${service}/xrpc/com.atproto.server.createAccount`, {
    method: "POST",
    json: { handle, email, password, ...(input.inviteCode ? { inviteCode: input.inviteCode } : {}) },
  });

  const account: Account = {
    id: `bluesky:${created.handle}`,
    network: "bluesky",
    handle: created.handle,
    displayName: input.profile.name ?? created.handle,
    addedAt: new Date().toISOString(),
    creds: { password },
    meta: { service, did: created.did },
  };
  return { account, did: created.did, password, service };
}

export interface ProfileRecord {
  $type: "app.bsky.actor.profile";
  displayName?: string;
  description?: string;
  avatar?: unknown;
  [key: string]: unknown;
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/**
 * The Bluesky profile an OpenProfile describes: the name, and a description
 * made of the headline, the home page and the topics, within Bluesky's
 * limits. Fields the OpenProfile does not speak to (banner, labels, an
 * avatar already set when none is given) are kept from `existing`.
 */
export function profileRecordFrom(profile: OpenProfile, existing: Record<string, unknown> = {}): ProfileRecord {
  const record: ProfileRecord = { ...existing, $type: "app.bsky.actor.profile" };
  const name = profile.name?.trim();
  if (name) record.displayName = clip(name, DISPLAY_NAME_MAX);

  const parts: string[] = [];
  if (profile.headline?.trim()) parts.push(profile.headline.trim());
  if (profile.web?.trim()) parts.push(profile.web.trim());
  if (profile.topics.length) parts.push(profile.topics.map((topic) => topic.trim()).filter(Boolean).join(", "));
  if (parts.length) record.description = clip(parts.join("\n\n"), DESCRIPTION_MAX);
  return record;
}

export interface PushOptions {
  fetch?: typeof fetch;
  dryRun?: boolean;
}

export interface PushResult {
  record: ProfileRecord;
  /** True when the OpenProfile's Avatar was fetched and uploaded. */
  avatar: boolean;
  /** Why the avatar was left alone, when it was. */
  avatarNote?: string;
}

/** Write the profile record on the account's PDS, keeping what the OpenProfile does not describe. */
export async function pushProfile(account: Account, profile: OpenProfile, options: PushOptions = {}): Promise<PushResult> {
  const doFetch = options.fetch ?? fetch;
  const service = account.meta.service || "https://bsky.social";
  const session = await call<{ accessJwt: string; did: string }>(doFetch, `${service}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    json: { identifier: account.handle, password: account.creds.password },
  });
  const auth = { authorization: `Bearer ${session.accessJwt}` };

  let existing: Record<string, unknown> = {};
  let cid: string | undefined;
  try {
    const found = await call<{ cid?: string; value: Record<string, unknown> }>(
      doFetch,
      `${service}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(session.did)}&collection=app.bsky.actor.profile&rkey=self`,
      { headers: auth },
    );
    existing = found.value ?? {};
    cid = found.cid;
  } catch {
    // No profile record yet: a fresh account. Fine.
  }

  const record = profileRecordFrom(profile, existing);
  const result: PushResult = { record, avatar: false };

  const avatarUrl = identityValue(profile, "avatar");
  if (avatarUrl && !options.dryRun) {
    try {
      const picture = await doFetch(avatarUrl, { headers: { accept: "image/*" } });
      const mime = picture.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
      const bytes = new Uint8Array(await picture.arrayBuffer());
      if (!picture.ok || !mime.startsWith("image/")) result.avatarNote = `${avatarUrl} is not an image (${picture.status}, ${mime || "no type"})`;
      else if (bytes.byteLength > AVATAR_MAX_BYTES) result.avatarNote = `${avatarUrl} is ${Math.round(bytes.byteLength / 1024)} KB; a PDS takes up to 1000 KB`;
      else {
        const uploaded = await call<{ blob: unknown }>(doFetch, `${service}/xrpc/com.atproto.repo.uploadBlob`, {
          method: "POST",
          headers: { ...auth, "content-type": mime },
          body: bytes,
        });
        record.avatar = uploaded.blob;
        result.avatar = true;
      }
    } catch (error) {
      result.avatarNote = `avatar not set: ${(error as Error).message}`;
    }
  }

  if (options.dryRun) return result;
  await call(doFetch, `${service}/xrpc/com.atproto.repo.putRecord`, {
    method: "POST",
    headers: auth,
    json: { repo: session.did, collection: "app.bsky.actor.profile", rkey: "self", record, ...(cid ? { swapRecord: cid } : {}) },
  });
  return result;
}
