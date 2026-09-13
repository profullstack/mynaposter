/**
 * OutreachGraph, both ways.
 *
 * OutreachGraph (outreachgraph.com) finds the people who matter for what you
 * sell and ranks them by opportunity. This plugin pulls that list, keeps the
 * ones with a social identity on a network myna can follow on, and hands them
 * to the follow graph as seeds. The graph then reads who *they* follow and
 * follows the accounts they agree on — which is the point: the people an
 * influencer chooses to follow are a better list than the people who follow
 * the influencer.
 *
 * It also sends people the other way. Every account myna follows can be
 * handed to OutreachGraph for assessment: it opens a person, reads their
 * profile and home page into an OpenProfile.md, and works out which offer to
 * reach them with once it has their contact details.
 *
 *   myna outreachgraph login          email + password, kept in the vault
 *   myna outreachgraph people         what OutreachGraph ranks for you
 *   myna outreachgraph sync           pull them in as seeds
 *   myna outreachgraph push <acct>    hand who you follow (or --followers) over
 *   myna follow ... --outreachgraph   hand each person followed over, as you go
 *   myna config graph.outreachgraph true   ...and from the graph and the daemon
 *   myna run                          the daemon does the sync every 6 hours
 *
 * This is also the reference for a third-party plugin: it only imports types
 * from @profullstack/myna-core, and everything it needs at runtime arrives
 * through the PluginContext.
 */
import type { Account, FollowedEvent, MynaPlugin, PluginContext, Profile, SeedInput } from "@profullstack/myna-core";

export const DEFAULT_URL = "https://outreachgraph.com";
const SESSION_COOKIE = "og_session";
/** Sessions last 30 days server-side; re-login a little early. */
const SESSION_TTL_MS = 29 * 86_400_000;
const SYNC_EVERY_MS = 6 * 3_600_000;
/** Below this, OutreachGraph is not sure the handle is the same person. */
const MIN_CONFIDENCE = 0.6;
/** OutreachGraph takes at most this many people per request. */
export const PUSH_CHUNK = 100;

/** OutreachGraph network names that myna can follow on, and what myna calls them. */
const NETWORK_MAP: Record<string, string> = {
  bluesky: "bluesky",
  mastodon: "mastodon",
  x: "x",
  nostr: "nostr",
  misskey: "misskey",
};

/**
 * The other direction: what OutreachGraph calls each network myna follows on.
 * The Fediverse is one network to OutreachGraph, so Misskey and Pixelfed
 * accounts go over as Mastodon handles, which is what their `user@host` is.
 */
const OUTREACHGRAPH_NETWORK: Record<string, string> = {
  bluesky: "bluesky",
  mastodon: "mastodon",
  misskey: "mastodon",
  pixelfed: "mastodon",
  x: "x",
  nostr: "nostr",
};

interface PersonRow {
  id: string;
  display_name: string;
  current_title?: string | null;
  current_company?: string | null;
  opportunity?: number | null;
  identity_confidence?: number | null;
}

interface IdentityRow {
  network: string;
  handle?: string | null;
  platform_user_id?: string | null;
  profile_url?: string | null;
  confidence: number;
}

/** One person as OutreachGraph's `/people/from-social` takes them. */
export interface SocialPerson {
  network: string;
  handle: string;
  profileUrl?: string;
  platformUserId?: string;
  displayName?: string;
  bio?: string;
  followers?: number;
  via?: string;
}

export interface PushResult {
  created: number;
  existing: number;
  queued: number;
  rejected: { handle: string; reason: string }[];
  campaignId?: string;
  /** People on networks OutreachGraph has no name for; never sent. */
  skipped: number;
}

interface Secrets {
  url: string;
  email: string;
  password: string;
  cookie?: string;
  cookieExpires?: string;
}

class OutreachGraphError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OutreachGraphError";
  }
}

function secretsOf(ctx: PluginContext): Secrets | undefined {
  const stored = ctx.secrets.get();
  if (!stored.email || !stored.password) return undefined;
  return { url: stored.url || DEFAULT_URL, email: stored.email, password: stored.password, cookie: stored.cookie, cookieExpires: stored.cookieExpires };
}

async function readError(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    if (typeof parsed.error === "string") return parsed.error;
    return parsed.error?.message ?? parsed.message ?? body.slice(0, 160);
  } catch {
    return body.slice(0, 160) || response.statusText;
  }
}

/** Sign in and store the session cookie beside the credentials. */
export async function login(ctx: PluginContext, secrets: Secrets): Promise<Secrets> {
  const response = await fetch(`${secrets.url}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "myna-plugin-outreachgraph" },
    body: JSON.stringify({ email: secrets.email, password: secrets.password }),
  });
  if (!response.ok) throw new OutreachGraphError(response.status, `OutreachGraph login failed: ${await readError(response)}`);

  const cookie = cookieFrom(response.headers.get("set-cookie"));
  if (!cookie) throw new Error("OutreachGraph did not return a session cookie.");
  const next: Secrets = { ...secrets, cookie, cookieExpires: new Date(Date.now() + SESSION_TTL_MS).toISOString() };
  ctx.secrets.set(next as unknown as Record<string, string>);
  return next;
}

/** The og_session value out of a Set-Cookie header. Exported for the test. */
export function cookieFrom(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = new RegExp(`(?:^|,\\s*|;\\s*)${SESSION_COOKIE}=([^;,\\s]+)`).exec(header);
  return match?.[1];
}

/** Call a JSON route with the session, signing in again once if the session is gone. */
async function api<T>(ctx: PluginContext, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let secrets = secretsOf(ctx);
  if (!secrets) throw new Error("Not signed in to OutreachGraph. Run: myna outreachgraph login");
  if (!secrets.cookie || !secrets.cookieExpires || Date.parse(secrets.cookieExpires) < Date.now()) secrets = await login(ctx, secrets);

  const send = (cookie: string) =>
    fetch(`${secrets!.url}/api/v1${path}`, {
      method: init.method ?? "GET",
      headers: {
        cookie: `${SESSION_COOKIE}=${cookie}`,
        "user-agent": "myna-plugin-outreachgraph",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

  let response = await send(secrets.cookie!);
  if (response.status === 401) {
    secrets = await login(ctx, secrets);
    response = await send(secrets.cookie!);
  }
  if (!response.ok) throw new OutreachGraphError(response.status, `OutreachGraph ${path}: ${await readError(response)}`);
  return (await response.json()) as T;
}

export async function people(ctx: PluginContext, limit: number): Promise<PersonRow[]> {
  const result = await api<{ people: PersonRow[] }>(ctx, `/people?limit=${limit}`);
  return result.people;
}

/**
 * Turn one person's identities into seeds. Pure, so the mapping can be tested
 * without a server: which networks count, the confidence floor, and how the
 * opportunity score becomes a weight.
 */
export function seedsFor(person: PersonRow, identities: IdentityRow[]): SeedInput[] {
  const seeds: SeedInput[] = [];
  // 0–100 opportunity becomes a 1–2 weight, so the best prospect counts twice
  // as much as an unscored one and never drowns everyone else out.
  const weight = 1 + Math.min(100, Math.max(0, person.opportunity ?? 0)) / 100;

  for (const identity of identities) {
    const network = NETWORK_MAP[identity.network];
    if (!network || identity.confidence < MIN_CONFIDENCE) continue;
    let handle = identity.handle?.trim() ?? "";
    // A Fediverse handle without its host is ambiguous; the profile URL is not.
    if ((network === "mastodon" || network === "misskey") && !handle.includes("@") && identity.profile_url) handle = identity.profile_url;
    if (!handle && identity.profile_url) handle = identity.profile_url;
    if (!handle) continue;
    seeds.push({
      network,
      handle,
      id: identity.platform_user_id ?? undefined,
      displayName: person.display_name,
      source: "outreachgraph",
      weight: Math.round(weight * 100) / 100,
    });
  }
  return seeds;
}

async function fetchSeeds(ctx: PluginContext, limit: number): Promise<{ seeds: SeedInput[]; people: number }> {
  const rows = await people(ctx, limit);
  const seeds: SeedInput[] = [];
  for (const person of rows) {
    const { identities } = await api<{ identities: IdentityRow[] }>(ctx, `/people/${encodeURIComponent(person.id)}/identities`);
    seeds.push(...seedsFor(person, identities));
  }
  return { seeds, people: rows.length };
}

/**
 * One profile as OutreachGraph takes it. Pure, and exported for the test:
 * which networks go over, how a Fediverse handle keeps its host, and which
 * ids are worth sending as a platform id (a DID or an npub is; a Mastodon
 * adapter's `id`, which is the profile URL, is not).
 */
export function personFrom(profile: Profile, network: string, via?: string): SocialPerson | undefined {
  const target = OUTREACHGRAPH_NETWORK[network];
  if (!target) return undefined;
  const handle = profile.handle.trim().replace(/^@/, "");
  if (!handle) return undefined;
  const id = profile.id?.trim();
  const platformUserId = id && (id.startsWith("did:") || (network === "nostr" && !/^https?:/.test(id))) ? id : undefined;
  return {
    network: target,
    handle,
    ...(profile.url ? { profileUrl: profile.url } : {}),
    ...(platformUserId ? { platformUserId } : {}),
    ...(profile.displayName ? { displayName: profile.displayName } : {}),
    ...(profile.bio ? { bio: profile.bio } : {}),
    ...(profile.followers !== undefined ? { followers: profile.followers } : {}),
    ...(via ? { via } : {}),
  };
}

/** Split a list into requests OutreachGraph accepts. Exported for the test. */
export function chunks<T>(items: T[], size = PUSH_CHUNK): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

/** Hand people to OutreachGraph's `/people/from-social`, a page at a time. */
export async function pushPeople(ctx: PluginContext, everyone: SocialPerson[]): Promise<PushResult> {
  const total: PushResult = { created: 0, existing: 0, queued: 0, rejected: [], skipped: 0 };
  for (const page of chunks(everyone)) {
    const result = await api<PushResult>(ctx, "/people/from-social", { method: "POST", body: { source: "myna", people: page } });
    total.created += result.created;
    total.existing += result.existing;
    total.queued += result.queued;
    total.rejected.push(...(result.rejected ?? []));
    total.campaignId = result.campaignId ?? total.campaignId;
  }
  return total;
}

const limitFrom = (ctx: PluginContext, fallback: number): number => {
  const raw = Number(ctx.flags.limit ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? Math.min(500, Math.floor(raw)) : fallback;
};

function summarise(result: PushResult, sent: number): string {
  return (
    `${sent} handed to OutreachGraph: ${result.created} new, ${result.existing} known, ${result.queued} queued for an OpenProfile` +
    (result.skipped ? `, ${result.skipped} skipped (no OutreachGraph network)` : "") +
    (result.rejected.length ? `, ${result.rejected.length} rejected` : "") +
    (result.campaignId ? ` in campaign ${result.campaignId}` : "")
  );
}

const plugin: MynaPlugin = {
  id: "outreachgraph",
  name: "OutreachGraph",
  version: "0.6.0",
  description: "Seeds the follow graph with the people OutreachGraph ranks for you, and hands who you follow back for assessment.",

  commands: [
    {
      name: "outreachgraph",
      summary: "Sign in to OutreachGraph, pull its ranked people in as seeds, hand who you follow back",
      usage: [
        "outreachgraph login [--url <base>]   Sign in. Credentials go in the vault",
        "outreachgraph status                 Who is signed in, and the last sync",
        "outreachgraph people [--limit N]     The ranked list, with followable handles",
        "outreachgraph sync [--limit N]       Pull them into the follow graph as seeds",
        "outreachgraph push <account> [handle] [--followers] [--limit N]",
        "                                     Hand who an account follows (or who follows it)",
        "                                     to OutreachGraph for assessment + an OpenProfile",
        "outreachgraph logout                 Forget the credentials",
      ],
      async run(args, ctx) {
        const [sub = "status"] = args;
        switch (sub) {
          case "login": {
            if (!ctx.ask) throw new Error("outreachgraph login needs a terminal to ask for the password.");
            const url = String(ctx.flags.url ?? ctx.secrets.get().url ?? DEFAULT_URL).replace(/\/+$/, "");
            const email = (await ctx.ask("OutreachGraph email")).trim();
            const password = await ctx.ask("Password", { secret: true });
            if (!email || !password) throw new Error("Email and password are both needed.");
            await login(ctx, { url, email, password });
            ctx.out(`Signed in to ${url} as ${email}.`);
            ctx.out("Run `myna outreachgraph sync` to pull seeds now, or `myna run` to keep them fresh.");
            return 0;
          }
          case "logout": {
            ctx.secrets.clear();
            ctx.out("Forgot the OutreachGraph credentials.");
            return 0;
          }
          case "status": {
            const secrets = secretsOf(ctx);
            if (!secrets) {
              ctx.out("Not signed in. Run: myna outreachgraph login");
              return 0;
            }
            ctx.out(`url       ${secrets.url}`);
            ctx.out(`email     ${secrets.email}`);
            ctx.out(`session   ${secrets.cookie ? `until ${secrets.cookieExpires}` : "none yet"}`);
            const last = ctx.secrets.get().lastSyncAt;
            ctx.out(`last sync ${last ?? "never"}`);
            ctx.out(`hand-over ${ctx.settings().graph.outreachgraph ? "every follow (graph.outreachgraph)" : "only with --outreachgraph or outreachgraph push"}`);
            return 0;
          }
          case "people": {
            const rows = await people(ctx, limitFrom(ctx, 50));
            if (ctx.flags.json) {
              ctx.out(JSON.stringify(rows, null, 2));
              return 0;
            }
            for (const person of rows) {
              const { identities } = await api<{ identities: IdentityRow[] }>(ctx, `/people/${encodeURIComponent(person.id)}/identities`);
              const handles = seedsFor(person, identities).map((seed) => `${seed.network}:${seed.handle}`);
              ctx.out(
                `${String(person.opportunity ?? "-").padStart(3)}  ${person.display_name}` +
                  `${person.current_title ? `, ${person.current_title}` : ""}${person.current_company ? ` @ ${person.current_company}` : ""}` +
                  (handles.length ? `\n     ${handles.join("  ")}` : ""),
              );
            }
            return 0;
          }
          case "sync": {
            const { seeds, people: count } = await fetchSeeds(ctx, limitFrom(ctx, 100));
            const result = ctx.graph.addSeeds(seeds);
            ctx.secrets.set({ ...ctx.secrets.get(), lastSyncAt: new Date().toISOString() });
            ctx.out(`${count} people, ${seeds.length} followable identities: ${result.added} new seeds, ${result.updated} refreshed.`);
            if (!seeds.length && count) ctx.out("None of them have a Bluesky, Mastodon, X, Nostr or Misskey identity yet.");
            return 0;
          }
          case "push": {
            // myna outreachgraph push <account> [handle] [--followers] [--limit N]
            const [, spec, handle] = args;
            if (!spec) throw new Error("Usage: myna outreachgraph push <account> [handle] [--followers] [--limit N]");
            if (!secretsOf(ctx)) throw new Error("Not signed in to OutreachGraph. Run: myna outreachgraph login");
            const account = ctx.accounts().find((entry: Account) => entry.id === spec || entry.network === spec || `${entry.network}:${entry.handle}` === spec);
            if (!account) throw new Error(`No connected account matching "${spec}".`);
            const direction = ctx.flags.followers ? "followers" : "following";
            const who = handle ?? account.handle;
            const limit = limitFrom(ctx, 500);
            ctx.out(`reading ${direction === "followers" ? `who follows ${who}` : `who ${who} follows`} on ${account.network}…`);
            const read = ctx.graph[direction];
            if (!read) throw new Error("This myna cannot read follow lists for a plugin; update myna.");
            const profiles = await read(account, who, limit);
            const via = `${direction}:${account.network}|${who}`;
            const everyone = profiles.map((profile) => personFrom(profile, account.network, via)).filter((entry): entry is SocialPerson => Boolean(entry));
            const skipped = profiles.length - everyone.length;
            if (!everyone.length) {
              ctx.out(`${profiles.length} read, none on a network OutreachGraph knows.`);
              return 0;
            }
            if (ctx.flags.dryRun) {
              ctx.out(`would hand ${everyone.length} to OutreachGraph${skipped ? ` (${skipped} skipped)` : ""}:`);
              for (const person of everyone) ctx.out(`  ${person.network}:${person.handle}${person.displayName ? `  ${person.displayName}` : ""}`);
              return 0;
            }
            const result = await pushPeople(ctx, everyone);
            result.skipped = skipped;
            ctx.out(summarise(result, everyone.length));
            for (const entry of result.rejected) ctx.out(`  rejected ${entry.handle}: ${entry.reason}`);
            return 0;
          }
          default:
            throw new Error(`Unknown outreachgraph command "${sub}". Try: login, status, people, sync, push, logout`);
        }
      },
    },
  ],

  seeds: [
    {
      id: "people",
      everyMs: SYNC_EVERY_MS,
      async fetch(ctx) {
        if (!secretsOf(ctx)) return [];
        const { seeds } = await fetchSeeds(ctx, 100);
        ctx.secrets.set({ ...ctx.secrets.get(), lastSyncAt: new Date().toISOString() });
        return seeds;
      },
    },
  ],

  /**
   * Hand each person followed to OutreachGraph, when asked: `--outreachgraph`
   * on the command, or `graph.outreachgraph` for the graph and the daemon.
   * Quiet otherwise, so following someone never talks to a server the person
   * did not point myna at.
   */
  async afterFollow(event: FollowedEvent, ctx: PluginContext) {
    const wanted = Boolean(ctx.flags.outreachgraph) || ctx.settings().graph.outreachgraph;
    if (!wanted) return;
    if (!secretsOf(ctx)) return "not signed in to OutreachGraph; run: myna outreachgraph login";
    const person = personFrom(
      { handle: event.handle, id: event.id, displayName: event.displayName, url: event.url, bio: event.bio, followers: event.followers },
      event.network,
      event.via ?? event.source,
    );
    if (!person) return `${event.network} is not a network OutreachGraph knows; ${event.handle} not handed over`;
    const result = await pushPeople(ctx, [person]);
    const rejected = result.rejected[0];
    if (rejected) return `OutreachGraph rejected ${event.handle}: ${rejected.reason}`;
    return `handed ${event.handle} to OutreachGraph (${result.created ? "new" : "known"}${result.queued ? ", OpenProfile queued" : ""})`;
  },
};

export default plugin;
