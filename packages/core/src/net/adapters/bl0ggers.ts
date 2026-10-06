/**
 * bl0ggers.com: publish to a bl0ggers publication through its v1 API.
 *
 * A bl0ggers key is scoped to ONE publication, so one myna account is one
 * publication: `bl0ggers:<slug>`. Log in again for each publication you want
 * to post to.
 *
 * Signing in is authorization code + PKCE (S256) over a loopback redirect on a
 * random port, never a pasted token: myna listens on
 * `http://127.0.0.1:<port>/callback`, opens bl0ggers' authorize page, the
 * person picks a publication and approves, and the code that comes back is
 * exchanged (with the verifier) for that publication's key. `--token blg_...`
 * is the headless door for an agent or a box with no browser; the key is
 * checked against the API before anything is stored.
 *
 * A post is a publication, so this is `explicitTarget` + `needsTitle`: it
 * posts only when named in `--to`, never as part of `all`.
 *
 * Retries are idempotent. Every post carries an `external_id`, and bl0ggers
 * updates the post that already has it instead of writing a second one. The
 * id is `--external-id` when given, else the queue entry the daemon is
 * sending, else a hash of the account and the title (myna already refuses a
 * blog title it has carried before, so a title names one post).
 */
import { createServer, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import type { Account, LoginContext, Network, PostInput, PostResult } from "../types.ts";
import { firstParagraph } from "../../util/markdown.ts";
import { bodyWithoutTitle } from "./ownblogs.ts";

export const BL0GGERS_SITE = "https://bl0ggers.com";
export const BL0GGERS_CHANNELS = ["blog", "newsletter", "podcast"] as const;
export type Bl0ggersChannel = (typeof BL0GGERS_CHANNELS)[number];

export interface Bl0ggersPublication {
  id: string;
  slug: string;
  title: string;
  description?: string | null;
  channels?: Bl0ggersChannel[];
  paused?: boolean;
  url: string;
}

export interface Bl0ggersPost {
  id: string;
  slug: string;
  channel: Bl0ggersChannel;
  status: "published" | "draft";
  url: string;
}

/** A failed call, with the HTTP status and bl0ggers' own error string. */
export class Bl0ggersError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "Bl0ggersError";
  }
}

const base64url = (input: Buffer): string =>
  input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** "bl0ggers.com", "https://bl0ggers.com/" and "" all mean https://bl0ggers.com. */
export function normalizeSite(input: string | undefined): string {
  const raw = (input ?? "").trim().replace(/\/+$/, "");
  if (!raw) return BL0GGERS_SITE;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`--site ${JSON.stringify(input)} is not a URL.`);
  }
  return url.origin;
}

/**
 * Call the v1 API and unwrap `{ok, data}`. Uses the global fetch so tests can
 * stand in for the server.
 */
export async function bl0ggersApi<T>(
  site: string,
  path: string,
  options: { method?: string; token?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<{ status: number; data: T }> {
  const url = `${site}${path}`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw new Error(`bl0ggers: timed out calling ${url}`);
    throw new Error(`bl0ggers: ${(error as Error).message} (${url})`);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text().catch(() => "");
  let envelope: { ok?: boolean; data?: T; error?: string; details?: unknown } | undefined;
  try {
    envelope = text ? JSON.parse(text) : undefined;
  } catch {
    envelope = undefined;
  }

  if (!response.ok || !envelope || envelope.ok !== true) {
    const said = envelope?.error || text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) || response.statusText;
    const hint =
      response.status === 401
        ? " The key was refused; run `myna login bl0ggers` again for this publication."
        : response.status === 409
          ? " Another post already has that slug; pass a different --slug."
          : "";
    throw new Bl0ggersError(response.status, `bl0ggers ${response.status} ${path}: ${said}.${hint}`, envelope?.details);
  }
  return { status: response.status, data: envelope.data as T };
}

/** The publication a key belongs to. */
export async function fetchPublication(site: string, token: string): Promise<Bl0ggersPublication> {
  return (await bl0ggersApi<Bl0ggersPublication>(site, "/api/v1/publication", { token })).data;
}

/* ------------------------------------------------------------- sign-in */

export interface Pkce {
  verifier: string;
  challenge: string;
  state: string;
}

export function makePkce(): Pkce {
  const verifier = base64url(randomBytes(32));
  return {
    verifier,
    challenge: base64url(createHash("sha256").update(verifier).digest()),
    state: base64url(randomBytes(16)),
  };
}

export function authorizeUrl(site: string, redirectUri: string, pkce: Pick<Pkce, "challenge" | "state">): string {
  const url = new URL("/cli/authorize", site);
  url.searchParams.set("client", "myna");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", pkce.state);
  return url.toString();
}

function page(title: string, detail: string): string {
  const esc = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return (
    `<!doctype html><meta charset="utf-8"><title>myna</title>` +
    `<body style="font:16px/1.6 system-ui,sans-serif;background:#0b1020;color:#e6edf3;display:grid;place-items:center;height:100vh;margin:0">` +
    `<div style="text-align:center"><h1 style="font-size:20px;margin:0 0 8px">${esc(title)}</h1>` +
    `<p style="color:#8b98a9;margin:0">${esc(detail)}</p></div>`
  );
}

export interface Loopback {
  redirectUri: string;
  /** Resolves with the code; rejects on an error, a state mismatch or a timeout. */
  code: Promise<string>;
  close(): void;
}

/**
 * Listen on 127.0.0.1 at a port the OS picks, for one redirect. Any callback
 * whose state is not ours is refused and ends the login: it did not come from
 * the authorize page this login opened.
 */
export async function listenForCode(expectedState: string, timeoutMs = 300_000): Promise<Loopback> {
  let server: Server | undefined;
  let settle!: { resolve: (code: string) => void; reject: (error: Error) => void };
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // Nobody may be awaiting yet when it rejects; the caller awaits it later.
  code.catch(() => {});

  const finish = (error: Error | undefined, value?: string) => {
    clearTimeout(timer);
    server?.close();
    server?.closeAllConnections?.();
    if (error) settle.reject(error);
    else settle.resolve(value!);
  };

  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      response.writeHead(404).end("Not found");
      return;
    }
    const reply = (title: string, detail: string) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", connection: "close" });
      response.end(page(title, detail));
    };
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    const got = url.searchParams.get("code");
    if (state !== expectedState) {
      reply("Sign-in refused", "State did not match. Start the login again from myna.");
      finish(new Error("bl0ggers: state mismatch, the callback did not come from the login myna started. Nothing was stored."));
      return;
    }
    if (error) {
      reply("Sign-in cancelled", error === "access_denied" ? "You did not approve it. Nothing was connected." : error);
      finish(new Error(error === "access_denied" ? "bl0ggers: access was denied on the authorize page." : `bl0ggers: the authorize page returned "${error}".`));
      return;
    }
    if (!got) {
      reply("Sign-in failed", "No authorization code came back.");
      finish(new Error("bl0ggers: no authorization code in the callback."));
      return;
    }
    reply("Connected", "You can close this tab and go back to the terminal.");
    finish(undefined, got);
  });

  const timer = setTimeout(() => finish(new Error("bl0ggers: timed out waiting for the browser. Start the login again.")), timeoutMs);
  timer.unref?.();

  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    code,
    close: () => finish(new Error("bl0ggers: login closed.")),
  };
}

export interface TokenGrant {
  token: string;
  publication: Pick<Bl0ggersPublication, "id" | "slug" | "title" | "url">;
}

/** Swap a single-use code for the publication's key. */
export async function exchangeCode(site: string, input: { code: string; verifier: string; redirectUri: string }): Promise<TokenGrant> {
  const { data } = await bl0ggersApi<TokenGrant>(site, "/api/v1/cli/token", {
    method: "POST",
    body: {
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
    },
  });
  if (!data?.token) throw new Error("bl0ggers: the token endpoint returned no key.");
  return data;
}

/** The whole browser sign-in: listen, open, wait, exchange. */
export async function browserSignIn(site: string, ctx: LoginContext, timeoutMs?: number): Promise<TokenGrant> {
  const pkce = makePkce();
  // Listen before opening the browser, or a fast redirect races the server.
  const loopback = await listenForCode(pkce.state, timeoutMs);
  try {
    ctx.report("Opening bl0ggers to pick a publication and approve myna…");
    await ctx.openUrl(authorizeUrl(site, loopback.redirectUri, pkce));
    const code = await loopback.code;
    ctx.report("Exchanging the code for the publication's key…");
    return await exchangeCode(site, { code, verifier: pkce.verifier, redirectUri: loopback.redirectUri });
  } finally {
    loopback.close();
  }
}

/* --------------------------------------------------------------- posting */

function channelOf(raw: string | undefined, allowed: string[] | undefined, flag: string): Bl0ggersChannel | undefined {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return undefined;
  if (!(BL0GGERS_CHANNELS as readonly string[]).includes(value)) {
    throw new Error(`${flag} ${JSON.stringify(raw)} is not a bl0ggers channel. Use one of: ${BL0GGERS_CHANNELS.join(", ")}.`);
  }
  if (allowed?.length && !allowed.includes(value)) {
    throw new Error(`This publication does not have the ${value} channel enabled (it has: ${allowed.join(", ")}).`);
  }
  return value as Bl0ggersChannel;
}

const tagList = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((tag) => tag.trim().replace(/^#/, ""))
    .filter(Boolean);

const truthy = (raw: string | undefined) => /^(true|yes|1)$/i.test((raw ?? "").trim());

/** The idempotency key for one post to one publication. */
export function externalIdFor(account: Pick<Account, "id">, title: string, extra: Record<string, string> | undefined): string {
  const given = extra?.externalId?.trim();
  if (given) return given;
  const queued = extra?.queueId?.trim();
  if (queued) return `myna:q:${queued}`;
  const hash = createHash("sha256").update(`${account.id}\n${title.trim()}`).digest("hex").slice(0, 32);
  return `myna:${hash}`;
}

/** The JSON body for POST /api/v1/posts. Exported so it can be tested without a server. */
export function postBody(account: Account, input: PostInput): Record<string, unknown> {
  const extra = input.extra ?? {};
  const title = (input.title || extra.title || "").trim();
  if (!title) throw new Error("bl0ggers needs a title. Pass --title.");
  const markdown = bodyWithoutTitle(input.text, title);
  const channels = account.meta.channels ? account.meta.channels.split(",").filter(Boolean) : undefined;
  const channel = channelOf(extra.channel, channels, "--channel") ?? channelOf(account.meta.channel, undefined, "The account's default channel");
  const excerpt = (extra.excerpt || extra.description || "").trim() || firstParagraph(markdown) || undefined;
  const tags = tagList(extra.tags);
  const body: Record<string, unknown> = {
    title,
    markdown,
    status: truthy(extra.draft) ? "draft" : "published",
    external_id: externalIdFor(account, title, extra),
  };
  if (channel) body.channel = channel;
  if (extra.slug?.trim()) body.slug = extra.slug.trim();
  if (excerpt) body.excerpt = excerpt;
  const image = (extra.imageUrl || extra.image || "").trim();
  if (image) body.image_url = image;
  const audio = (extra.audioUrl || extra.audio || "").trim();
  if (audio) body.audio_url = audio;
  if (extra.canonicalUrl?.trim()) body.canonical_url = extra.canonicalUrl.trim();
  if (tags.length) body.tags = tags;
  // Email the issue to confirmed subscribers when it goes live. Left out
  // unless asked, so bl0ggers' default applies: on for a newsletter, off
  // for everything else.
  if (extra.broadcast?.trim()) body.broadcast = truthy(extra.broadcast);
  return body;
}

export const bl0ggers: Network = {
  id: "bl0ggers",
  name: "bl0ggers",
  category: "blog",
  blurb: "A bl0ggers.com publication: blog, newsletter or podcast. One account per publication.",
  auth: {
    kind: "oauth2",
    note:
      "Signs in through your browser: pick the publication on bl0ggers and approve myna. One account per publication; " +
      "log in again for another. With no browser on this machine, pass --token blg_... (the publication's API key) instead.",
    docsUrl: "https://bl0ggers.com/skill.md",
    fields: [
      {
        key: "channel",
        label: "Default channel",
        optional: true,
        placeholder: "blog",
        help: "blog, newsletter or podcast. Empty lets bl0ggers choose (blog when enabled). --channel on a post overrides it.",
      },
      {
        key: "site",
        label: "bl0ggers site",
        optional: true,
        default: BL0GGERS_SITE,
        help: "Only for a bl0ggers server other than bl0ggers.com.",
      },
      {
        key: "token",
        label: "Publication API key",
        secret: true,
        optional: true,
        placeholder: "blg_...",
        help: "Leave empty to sign in in the browser (the normal way). For agents and headless boxes only.",
      },
    ],
  },
  caps: {
    charLimit: 0,
    mediaLimit: 0,
    threads: false,
    delete: true,
    timeline: false,
    notifications: false,
    stats: false,
    needsTitle: true,
    // A post here is a publication; a stray `all` fan-out must never create one.
    explicitTarget: true,
  },

  async login(input, ctx) {
    const site = normalizeSite(input.site);
    const channel = channelOf(input.channel, undefined, "--channel");
    const pasted = (input.token ?? "").trim();

    let token: string;
    if (pasted) {
      if (!pasted.startsWith("blg_")) throw new Error("A bl0ggers key starts with blg_.");
      token = pasted;
      ctx.report("Checking the key…");
    } else {
      token = (await browserSignIn(site, ctx)).token;
    }
    // Whatever handed us the key, the publication it is scoped to is the
    // source of truth for the account's name and channels.
    const publication = await fetchPublication(site, token);
    if (channel && publication.channels?.length && !publication.channels.includes(channel)) {
      throw new Error(`${publication.slug} does not have the ${channel} channel enabled (it has: ${publication.channels.join(", ")}).`);
    }
    if (publication.paused) ctx.report(`${publication.slug} is paused: posts will be saved as drafts until it is resumed.`);

    const host = new URL(site).host;
    const handle = site === BL0GGERS_SITE ? publication.slug : `${publication.slug}@${host}`;
    const meta: Record<string, string> = {
      site,
      publicationId: publication.id,
      slug: publication.slug,
      title: publication.title,
      // Where posts are served: read by the UTM tagger and the skill header.
      siteUrl: publication.url,
    };
    if (publication.channels?.length) meta.channels = publication.channels.join(",");
    if (channel) meta.channel = channel;
    return { handle, displayName: publication.title, creds: { token }, meta };
  },

  async post(account, input): Promise<PostResult> {
    const token = account.creds.token;
    if (!token) throw new Error(`${account.id} has no key; run \`myna login bl0ggers\` again.`);
    const site = normalizeSite(account.meta.site);
    const { data } = await bl0ggersApi<Bl0ggersPost>(site, "/api/v1/posts", { token, body: postBody(account, input) });
    if (!data?.url) throw new Error("bl0ggers accepted the post but returned no URL.");
    return { id: data.id, url: data.url };
  },

  async remove(account, id) {
    const token = account.creds.token;
    if (!token) throw new Error(`${account.id} has no key; run \`myna login bl0ggers\` again.`);
    await bl0ggersApi(normalizeSite(account.meta.site), `/api/v1/posts/${encodeURIComponent(id)}`, { token, method: "DELETE" });
  },
};
