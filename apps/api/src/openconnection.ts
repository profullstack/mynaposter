/**
 * OpenConnection (https://logicsrc.com/openconnection), server side: the door
 * an app that cannot register walks through.
 *
 * A signed-in person makes a setup token here, pastes it into an app, and
 * the app claims it once for a bearer of its own, scoped to what the person
 * chose. The bridge keeps the list of apps holding one, with a revoke beside
 * each. The setup secret and the bearer are stored hashed and shown once,
 * like the cloud session token. Nothing here holds a social credential and
 * nothing here posts: an app writes through the bridge, reads what the
 * person connected, and reports what it posted with the person's own hands.
 *
 * The pure parts (token encoding, scopes, the descriptor, the limiter) are
 * exported so they can be tested without a database.
 */
import { randomBytes } from "node:crypto";
import { parseOpenProfile, getNetwork } from "@profullstack/myna-core";
import { db } from "./db/index.ts";
import { hashToken, newToken } from "./credentials.ts";
import { siteUrl } from "./handoff.ts";

export const VERSIONS = ["1"] as const;
export const PROFILES = ["social"] as const;

/** Every scope this bridge can put in a token, with the line the person reads. */
export const SCOPES: Record<string, string> = {
  "accounts:read": "The networks and handles this person connected",
  "analyze:create": "Read a product page into a name, description, audience and features",
  "write:create": "Draft posts and comments in this person's voice",
  "suggest:create": "Suggest subreddits, hashtags, keywords and forums for a product",
  "activity:write": "Record a post the app made with the person's own hands",
};

export const DEFAULT_SCOPES = Object.keys(SCOPES);
export const DEFAULT_TTL_MINUTES = 15;
export const MAX_TTL_MINUTES = 24 * 60;

/** The descriptor served at /.well-known/openconnection.json. */
export function descriptor(site = siteUrl()) {
  return {
    bridge: { name: "myna", web: site, operator: "https://logicsrc.com/.well-known/openprofile.md" },
    versions: [...VERSIONS],
    setup: `${site}/connect`,
    profiles: [...PROFILES],
    scopes: { ...SCOPES },
    spec: "https://logicsrc.com/openconnection",
  };
}

export const claimUrlFor = (secret: string, site = siteUrl()): string => `${site}/api/openconnection/claim/${secret}`;
export const accessUrlFor = (site = siteUrl()): string => `${site}/api/openconnection/v1`;

/** A setup token is the claim URL, base64url, no padding. */
export const encodeSetupToken = (claimUrl: string): string => Buffer.from(claimUrl, "utf8").toString("base64url");

/** The claim URL inside a setup token, or a thrown Error when it is not one. */
export function decodeSetupToken(token: string): URL {
  const text = Buffer.from(token.trim(), "base64url").toString("utf8");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("That is not a setup token: it does not decode to a URL.");
  }
  if (url.protocol !== "https:") throw new Error("A setup token's claim URL must be https.");
  return url;
}

/** Scopes as the person or an app named them: an array or a comma list; empty means every scope. */
export function parseScopes(input: unknown): string[] {
  const raw = Array.isArray(input) ? input.map(String) : typeof input === "string" ? input.split(",") : [];
  const scopes = [...new Set(raw.map((entry) => entry.trim()).filter(Boolean))];
  for (const scope of scopes) {
    if (!(scope in SCOPES)) throw new Error(`Unknown scope ${scope}. This bridge offers: ${DEFAULT_SCOPES.join(", ")}.`);
  }
  return scopes.length ? scopes : [...DEFAULT_SCOPES];
}

export const hasScope = (scopes: readonly string[], scope: string): boolean => scopes.includes(scope);

/** A refused claim, with the status and code the spec names. */
export class ClaimError extends Error {
  constructor(
    public status: 403 | 404 | 410,
    public code: "claimed" | "unknown" | "expired",
    message: string,
  ) {
    super(message);
  }
}

/** A refused request, with the code the spec names. Always 401. */
export class AuthError extends Error {
  constructor(
    public code: "unauthorized" | "revoked" | "expired",
    message: string,
  ) {
    super(message);
  }
}

export interface AppInfo {
  name?: string;
  url?: string;
  version?: string;
}

const cleanApp = (input: unknown): AppInfo => {
  const app = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out: AppInfo = {};
  if (typeof app.name === "string" && app.name.trim()) out.name = app.name.trim().slice(0, 80);
  if (typeof app.url === "string" && /^https?:\/\//.test(app.url)) out.url = app.url.trim().slice(0, 200);
  if (typeof app.version === "string" && app.version.trim()) out.version = app.version.trim().slice(0, 40);
  return out;
};

/* ------------------------------------------------------------ setup ---- */

export interface SetupToken {
  token: string;
  claimUrl: string;
  scopes: string[];
  expires: string;
}

export async function issueSetup(userId: string, options: { scopes?: unknown; minutes?: unknown } = {}): Promise<SetupToken> {
  const scopes = parseScopes(options.scopes);
  const minutes = Math.min(MAX_TTL_MINUTES, Math.max(1, Number(options.minutes) || DEFAULT_TTL_MINUTES));
  const secret = randomBytes(24).toString("base64url");
  const rows = (await db()`
    insert into oc_setup_tokens (user_id, secret_hash, scopes, expires_at)
    values (${userId}, ${hashToken(secret)}, ${scopes}, now() + (${minutes} || ' minutes')::interval)
    returning expires_at
  `) as unknown as { expires_at: Date }[];
  const claimUrl = claimUrlFor(secret);
  return { token: encodeSetupToken(claimUrl), claimUrl, scopes, expires: new Date(rows[0].expires_at).toISOString() };
}

/* ------------------------------------------------------------ claim ---- */

export interface ClaimResult {
  access_url: string;
  token: string;
  auth: "bearer";
  scopes: string[];
  profiles: string[];
  expires: string | null;
  principal: { name: string };
}

interface SetupRow {
  id: string;
  user_id: string;
  scopes: string[];
  expires_at: Date;
  claimed_at: Date | null;
}

export async function principalName(userId: string): Promise<string> {
  const markdown = await profileMarkdown(userId);
  const name = markdown ? parseOpenProfile(markdown).name : null;
  if (name) return name;
  const rows = (await db()`select email from users where id = ${userId}`) as unknown as { email: string }[];
  return rows[0]?.email.split("@")[0] ?? "someone";
}

export async function claim(secret: string, appInput: unknown): Promise<ClaimResult> {
  const app = cleanApp(appInput);
  const rows = (await db()`select id, user_id, scopes, expires_at, claimed_at from oc_setup_tokens where secret_hash = ${hashToken(secret)}`) as unknown as SetupRow[];
  const row = rows[0];
  if (!row) throw new ClaimError(404, "unknown", "No such setup token.");
  if (row.claimed_at) {
    await db()`update oc_setup_tokens set reclaims = reclaims + 1 where id = ${row.id}`;
    throw new ClaimError(403, "claimed", "This setup token was already claimed. Someone else saw it; make a new one.");
  }
  if (new Date(row.expires_at).getTime() < Date.now()) throw new ClaimError(410, "expired", "This setup token expired. Make a new one.");

  // First claim wins, in one statement, so two racing claims get one token.
  const claimed = (await db()`
    update oc_setup_tokens set claimed_at = now(), claimed_by = ${db().json(app as never)}
    where id = ${row.id} and claimed_at is null
    returning id
  `) as unknown as { id: string }[];
  if (!claimed[0]) throw new ClaimError(403, "claimed", "This setup token was already claimed. Someone else saw it; make a new one.");

  const token = `oc_${newToken()}`;
  await db()`
    insert into oc_access_tokens (user_id, setup_id, token_hash, app, scopes)
    values (${row.user_id}, ${row.id}, ${hashToken(token)}, ${db().json(app as never)}, ${row.scopes})
  `;
  return {
    access_url: accessUrlFor(),
    token,
    auth: "bearer",
    scopes: row.scopes,
    profiles: [...PROFILES],
    expires: null,
    principal: { name: await principalName(row.user_id) },
  };
}

/* ------------------------------------------------------ authenticate ---- */

export interface Connection {
  id: string;
  userId: string;
  email: string;
  app: AppInfo;
  scopes: string[];
  issuedAt: string;
  expiresAt: string | null;
}

interface AccessRow {
  id: string;
  user_id: string;
  app: AppInfo;
  scopes: string[];
  issued_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  email: string;
}

/** The connection behind a bearer, or a thrown AuthError with the code the spec names. */
export async function authenticate(bearer: string): Promise<Connection> {
  if (!bearer) throw new AuthError("unauthorized", "Send the token as Authorization: Bearer <token>.");
  const rows = (await db()`
    select t.id, t.user_id, t.app, t.scopes, t.issued_at, t.expires_at, t.revoked_at, u.email
    from oc_access_tokens t join users u on u.id = t.user_id
    where t.token_hash = ${hashToken(bearer)}
  `) as unknown as AccessRow[];
  const row = rows[0];
  if (!row) throw new AuthError("unauthorized", "Unknown token.");
  if (row.revoked_at) throw new AuthError("revoked", "This connection was revoked. Ask the person for a new setup token.");
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) throw new AuthError("expired", "This connection expired. Ask the person for a new setup token.");
  await db()`update oc_access_tokens set last_used_at = now() where id = ${row.id}`;
  return {
    id: row.id,
    userId: row.user_id,
    email: row.email,
    app: row.app ?? {},
    scopes: row.scopes,
    issuedAt: new Date(row.issued_at).toISOString(),
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
  };
}

/* --------------------------------------------------------- the list ---- */

export interface ConnectedApp {
  id: string;
  app: AppInfo;
  scopes: string[];
  issuedAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  /** Times the setup token behind this connection was claimed again after it was used. */
  reclaims: number;
}

export async function listApps(userId: string, options: { all?: boolean } = {}): Promise<ConnectedApp[]> {
  const rows = (await db()`
    select t.id, t.app, t.scopes, t.issued_at, t.last_used_at, t.expires_at, t.revoked_at, coalesce(s.reclaims, 0) as reclaims
    from oc_access_tokens t left join oc_setup_tokens s on s.id = t.setup_id
    where t.user_id = ${userId} ${options.all ? db()`` : db()`and t.revoked_at is null`}
    order by t.issued_at desc limit 200
  `) as unknown as Array<{ id: string; app: AppInfo; scopes: string[]; issued_at: Date; last_used_at: Date | null; expires_at: Date | null; revoked_at: Date | null; reclaims: number }>;
  const iso = (value: Date | null) => (value ? new Date(value).toISOString() : null);
  return rows.map((row) => ({
    id: row.id,
    app: row.app ?? {},
    scopes: row.scopes,
    issuedAt: new Date(row.issued_at).toISOString(),
    lastUsedAt: iso(row.last_used_at),
    expiresAt: iso(row.expires_at),
    revokedAt: iso(row.revoked_at),
    reclaims: Number(row.reclaims),
  }));
}

/** The person revokes one app. */
export async function revokeApp(userId: string, id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const rows = (await db()`update oc_access_tokens set revoked_at = coalesce(revoked_at, now()) where id = ${id} and user_id = ${userId} returning id`) as unknown as { id: string }[];
  return rows.length > 0;
}

/** The app leaves. */
export async function revokeToken(tokenId: string): Promise<void> {
  await db()`update oc_access_tokens set revoked_at = coalesce(revoked_at, now()) where id = ${tokenId}`;
}

/* --------------------------------------------------------- accounts ---- */

/**
 * The person's OpenProfile.md, from the reshare profile they published or
 * the settings they synced. The cloud never holds their vault, so the
 * accounts an app sees are the ones the person wrote down as theirs.
 */
export async function profileMarkdown(userId: string): Promise<string | null> {
  const published = (await db()`select markdown from reshare_profiles where user_id = ${userId}`) as unknown as { markdown: string }[];
  if (published[0]?.markdown) return published[0].markdown;
  const synced = (await db()`select body from settings_snapshots where user_id = ${userId} order by revision desc limit 1`) as unknown as { body: { files?: Record<string, { content?: string }> } }[];
  const content = synced[0]?.body?.files?.["openprofile.md"]?.content;
  return typeof content === "string" && content.trim() ? content : null;
}

export interface SocialAccount {
  id: string;
  kind: "social";
  network: string;
  handle: string;
  name: string;
  org: { name: string; url: string };
  url: string;
}

export interface AccountSet {
  accounts: SocialAccount[];
  errlist: Array<{ code: string; msg: string }>;
}

const handleOf = (url: string, label: string): string => {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    const last = path.split("/").filter(Boolean).pop() ?? "";
    return last.replace(/^@/, "") || label;
  } catch {
    return label;
  }
};

/** The accounts named in an OpenProfile.md, as the social profile lists them. */
export function accountsFromProfile(markdown: string): SocialAccount[] {
  const profile = parseOpenProfile(markdown);
  const seen = new Set<string>();
  const accounts: SocialAccount[] = [];
  for (const account of profile.accounts) {
    if (!/^https?:\/\//.test(account.url)) continue;
    const network = getNetwork(account.network);
    const handle = handleOf(account.url, account.label);
    const id = `${account.network}:${handle}`;
    if (seen.has(id)) continue;
    seen.add(id);
    let origin = "";
    try {
      origin = new URL(account.url).origin;
    } catch {
      origin = "";
    }
    accounts.push({
      id,
      kind: "social",
      network: account.network,
      handle,
      name: profile.name ?? handle,
      org: { name: network?.name ?? account.label, url: origin },
      url: account.url,
    });
  }
  return accounts;
}

export async function accountsFor(userId: string): Promise<AccountSet> {
  const markdown = await profileMarkdown(userId);
  if (!markdown) {
    return {
      accounts: [],
      errlist: [{ code: "no-profile", msg: "No OpenProfile.md on the cloud yet. Run `myna profile write` then `myna synconfig save`, or `myna reshare join`." }],
    };
  }
  return { accounts: accountsFromProfile(markdown), errlist: [] };
}

/* --------------------------------------------------------- activity ---- */

export interface ActivityInput {
  network?: unknown;
  kind?: unknown;
  url?: unknown;
  text?: unknown;
  project?: unknown;
  at?: unknown;
}

export interface Activity {
  id: string;
  app: string | null;
  network: string;
  kind: string;
  url: string | null;
  text: string | null;
  project: string | null;
  at: string;
}

export async function recordActivity(connection: Connection, input: ActivityInput): Promise<{ id: string }> {
  const network = typeof input.network === "string" ? input.network.trim().toLowerCase().slice(0, 40) : "";
  if (!network) throw new Error("activity needs a network.");
  const kind = typeof input.kind === "string" && input.kind.trim() ? input.kind.trim().toLowerCase().slice(0, 40) : "post";
  const url = typeof input.url === "string" && /^https?:\/\//.test(input.url) ? input.url.slice(0, 500) : null;
  const text = typeof input.text === "string" ? input.text.slice(0, 5000) : null;
  const project = typeof input.project === "string" ? input.project.slice(0, 200) : null;
  const at = typeof input.at === "string" && !Number.isNaN(Date.parse(input.at)) ? new Date(input.at) : new Date();
  const rows = (await db()`
    insert into oc_activity (user_id, token_id, app, network, kind, url, text, project, at)
    values (${connection.userId}, ${connection.id}, ${connection.app.name ?? null}, ${network}, ${kind}, ${url}, ${text}, ${project}, ${at})
    returning id
  `) as unknown as { id: string }[];
  return { id: rows[0].id };
}

export async function listActivity(userId: string, limit = 100): Promise<Activity[]> {
  const rows = (await db()`
    select id, app, network, kind, url, text, project, at from oc_activity
    where user_id = ${userId} order by at desc limit ${Math.min(500, Math.max(1, limit))}
  `) as unknown as Array<Omit<Activity, "at"> & { at: Date }>;
  return rows.map((row) => ({ ...row, at: new Date(row.at).toISOString() }));
}

/* ----------------------------------------------------------- forums ---- */

export interface Forum {
  name: string;
  url: string;
}

/**
 * Real forums from nichedb.dev's forums collection, matched on the
 * product's keywords: the boards where those words are already being said.
 * Keyless, and an outage is an empty list, not an error.
 */
export async function forumsFor(keywords: string[], fetchImpl: typeof fetch = fetch): Promise<Forum[]> {
  const q = keywords.map((entry) => entry.trim()).filter(Boolean).slice(0, 3).join(" ");
  if (!q) return [];
  try {
    const response = await fetchImpl(`https://nichedb.dev/api/v1/search?q=${encodeURIComponent(q)}&collection=forums&limit=30`, {
      headers: { accept: "application/json", "user-agent": "myna (+https://mynaposter.com)" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return [];
    const data = (await response.json()) as { items?: Array<{ data?: { board?: string; forum?: string; forumName?: string } }> };
    const seen = new Set<string>();
    const forums: Forum[] = [];
    for (const item of data.items ?? []) {
      const board = item.data?.board;
      const forum = item.data?.forum;
      if (!board || !forum || !/^https?:\/\//.test(board)) continue;
      const url = `${board.replace(/\/+$/, "")}/f/${forum}`;
      if (seen.has(url)) continue;
      seen.add(url);
      forums.push({ name: `${item.data?.forumName ?? forum} on ${new URL(board).hostname}`, url });
    }
    return forums.slice(0, 10);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------- rate limit ---- */

/** A sliding window per key, in memory: enough for one API process, and the spec says 429 + Retry-After. */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    public limit: number,
    public windowMs: number,
  ) {}

  take(key: string, now = Date.now()): { ok: boolean; retryAfter: number } {
    const since = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((stamp) => stamp > since);
    if (recent.length >= this.limit) {
      const retryAfter = Math.max(1, Math.ceil((recent[0] + this.windowMs - now) / 1000));
      this.hits.set(key, recent);
      return { ok: false, retryAfter };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { ok: true, retryAfter: 0 };
  }
}
