/**
 * X (Twitter), API v2.
 *
 * No password login exists — X removed it. `/login x` opens a browser for the
 * OAuth 2.0 flow, which needs an app from the X developer portal with
 * "Native App / Public client" and the loopback redirect registered.
 */
import type { Account, Network, TimelineItem } from "../types.ts";
import { getJson, postJson, request } from "../../util/http.ts";
import { oauth1Header, type OAuth1Credentials } from "../../util/crypto/sign.ts";
import { authorize, callbackFrom, refresh, PASTE_FIELD, REDIRECT_NOTE, type OAuth2Config } from "../oauth2.ts";

const API = "https://api.x.com";
const SCOPES = ["tweet.read", "tweet.write", "users.read", "offline.access"];

const config = (clientId: string, clientSecret?: string): OAuth2Config => ({
  authorizeUrl: "https://x.com/i/oauth2/authorize",
  tokenUrl: `${API}/2/oauth2/token`,
  clientId,
  clientSecret,
  scopes: SCOPES,
  pkce: true,
  basicAuth: Boolean(clientSecret),
});

/**
 * X access tokens last two hours, so anything scheduled more than two hours out
 * would fail without this. The refreshed pair is written back to the vault.
 */
async function accessToken(account: Account): Promise<string> {
  const expiresAt = Number(account.meta.expiresAt || 0);
  if (account.creds.accessToken && Date.now() < expiresAt - 60_000) return account.creds.accessToken;
  if (!account.creds.refreshToken) return account.creds.accessToken;

  const tokens = await refresh(config(account.creds.clientId, account.creds.clientSecret), account.creds.refreshToken);
  account.creds.accessToken = tokens.access_token;
  if (tokens.refresh_token) account.creds.refreshToken = tokens.refresh_token;
  account.meta.expiresAt = String(Date.now() + (tokens.expires_in ?? 7200) * 1000);
  const { saveAccount } = await import("../../store/accounts.ts");
  saveAccount(account);
  return tokens.access_token;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

const isOAuth1 = (account: Account): boolean => Boolean(account.creds.apiKey && account.creds.accessToken);

const oauth1Creds = (account: Account): OAuth1Credentials => ({
  consumerKey: account.creds.apiKey,
  consumerSecret: account.creds.apiSecret,
  token: account.creds.accessToken,
  tokenSecret: account.creds.accessSecret,
});

/**
 * The Authorization header for one request.
 *
 * X accepts either scheme on v2. OAuth 1.0a signs per request and never
 * expires, which is why it needs no refresh and no browser; OAuth 2.0 carries a
 * bearer token that lasts two hours and has to be refreshed. Both are here
 * because the first is far easier to set up and the second is what X pushes you
 * toward in the portal.
 */
async function authorizeRequest(account: Account, method: string, url: string): Promise<Record<string, string>> {
  if (isOAuth1(account)) {
    return { authorization: oauth1Header(method, url, {}, oauth1Creds(account)) };
  }
  return auth(await accessToken(account));
}

export const x: Network = {
  id: "x",
  name: "X",
  category: "major",
  blurb: "Twitter/X v2. Browser OAuth — X has no password API.",
  auth: {
    kind: "oauth2",
    note:
      "Two ways in. Simplest: paste the four OAuth 1.0a values from Keys and tokens (API key and secret, " +
      "access token and secret) and myna signs each request, with no browser at all. Otherwise give the " +
      `OAuth 2.0 client id and sign in through the browser. ${REDIRECT_NOTE}`,
    fields: [
      // Masked even though it is the public half of the OAuth 1.0a pair. The
      // rule that every *_key field is masked is worth more than the small
      // convenience of reading this one back, and apiKey on other networks
      // (dev.to) is a real secret, so exempting the name would unmask that too.
      { key: "apiKey", label: "API key", secret: true, optional: true, help: "OAuth 1.0a. Fill these four to skip the browser." },
      { key: "apiSecret", label: "API key secret", secret: true, optional: true },
      { key: "accessToken", label: "Access token", secret: true, optional: true },
      { key: "accessSecret", label: "Access token secret", secret: true, optional: true },
      { key: "clientId", label: "OAuth 2.0 client id", optional: true, help: "Only for the browser flow." },
      { key: "clientSecret", label: "OAuth 2.0 client secret", secret: true, optional: true },
      PASTE_FIELD,
    ],
  },
  caps: { charLimit: 280, mediaLimit: 4, threads: true, delete: true, timeline: true, notifications: false, stats: true },

  async login(input, ctx) {
    // The four OAuth 1.0a values, if given, are enough on their own.
    if (input.apiKey && input.apiSecret && input.accessToken && input.accessSecret) {
      const creds = {
        apiKey: input.apiKey.trim(),
        apiSecret: input.apiSecret.trim(),
        accessToken: input.accessToken.trim(),
        accessSecret: input.accessSecret.trim(),
      };
      const url = `${API}/2/users/me`;
      ctx.report("Checking the keys against X...");
      const who = await getJson<{ data: { id: string; username: string; name: string } }>(url, {
        headers: {
          authorization: oauth1Header("GET", url, {}, {
            consumerKey: creds.apiKey,
            consumerSecret: creds.apiSecret,
            token: creds.accessToken,
            tokenSecret: creds.accessSecret,
          }),
        },
      });
      return {
        handle: `@${who.data.username}`,
        displayName: who.data.name,
        creds,
        meta: { userId: who.data.id, scheme: "oauth1", expiresAt: "" } as Record<string, string>,
      };
    }

    if (!input.clientId) {
      throw new Error("Give either the four OAuth 1.0a values, or an OAuth 2.0 client id for the browser flow.");
    }

    const tokens = await authorize({ ...config(input.clientId, input.clientSecret || undefined), ...callbackFrom(input, ctx) }, ctx);
    const me = await getJson<{ data: { id: string; username: string; name: string } }>(`${API}/2/users/me`, {
      headers: auth(tokens.access_token),
    });
    return {
      handle: `@${me.data.username}`,
      displayName: me.data.name,
      creds: {
        clientId: input.clientId,
        clientSecret: input.clientSecret ?? "",
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? "",
      },
      meta: {
        userId: me.data.id,
        scheme: "oauth2",
        expiresAt: String(Date.now() + (tokens.expires_in ?? 7200) * 1000),
      },
    };
  },

  async post(account, input) {
    const body: Record<string, unknown> = { text: input.text };
    if (input.replyTo) body.reply = { in_reply_to_tweet_id: input.replyTo };

    if (input.media?.length) {
      const ids: string[] = [];
      for (const item of input.media.slice(0, 4)) {
        const form = new FormData();
        form.append("media", new Blob([item.data as unknown as ArrayBuffer], { type: item.mime }), item.path.split("/").pop() ?? "media");
        const uploaded = await request(`${API}/2/media/upload`, {
          method: "POST",
          headers: await authorizeRequest(account, "POST", `${API}/2/media/upload`),
          body: form as never,
        });
        ids.push(((await uploaded.json()) as { data: { id: string } }).data.id);
      }
      body.media = { media_ids: ids };
    }

    const created = await postJson<{ data: { id: string } }>(`${API}/2/tweets`, body, {
      headers: await authorizeRequest(account, "POST", `${API}/2/tweets`),
    });
    return { id: created.data.id, url: `https://x.com/${account.handle.replace("@", "")}/status/${created.data.id}` };
  },

  async remove(account, id) {
    await request(`${API}/2/tweets/${id}`, {
      method: "DELETE",
      headers: await authorizeRequest(account, "DELETE", `${API}/2/tweets/${id}`),
    });
  },

  async timeline(account, limit) {
    const url =
      `${API}/2/users/${account.meta.userId}/timelines/reverse_chronological?max_results=${Math.min(Math.max(limit, 5), 100)}` +
      `&tweet.fields=created_at,public_metrics,author_id&expansions=author_id&user.fields=username,name`;
    const result = await getJson<{ data?: Record<string, any>[]; includes?: { users?: Record<string, any>[] } }>(
      url,
      { headers: await authorizeRequest(account, "GET", url) },
    );
    const users = new Map((result.includes?.users ?? []).map((user) => [user.id, user]));
    return (result.data ?? []).map((tweet): TimelineItem => {
      const author = users.get(tweet.author_id) ?? {};
      return {
        id: tweet.id,
        author: author.name ?? "",
        handle: author.username ? `@${author.username}` : "",
        text: tweet.text,
        createdAt: tweet.created_at ?? "",
        url: author.username ? `https://x.com/${author.username}/status/${tweet.id}` : undefined,
        likes: tweet.public_metrics?.like_count,
        reposts: tweet.public_metrics?.retweet_count,
        replies: tweet.public_metrics?.reply_count,
      };
    });
  },

  async stats(account, id) {
    const url = `${API}/2/tweets/${id}?tweet.fields=public_metrics`;
    const result = await getJson<{ data: { public_metrics: Record<string, number> } }>(
      url,
      { headers: await authorizeRequest(account, "GET", url) },
    );
    const metrics = result.data.public_metrics ?? {};
    return {
      likes: metrics.like_count,
      reposts: metrics.retweet_count,
      replies: metrics.reply_count,
      views: metrics.impression_count,
    };
  },
};
