/**
 * X (Twitter), API v2.
 *
 * No password login exists — X removed it. `/login x` opens a browser for the
 * OAuth 2.0 flow, which needs an app from the X developer portal with
 * "Native App / Public client" and the loopback redirect registered.
 */
import type { Account, Network, TimelineItem } from "../types.ts";
import { getJson, postJson, request } from "../../util/http.ts";
import { authorize, refresh, REDIRECT_NOTE, type OAuth2Config } from "../oauth2.ts";

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

export const x: Network = {
  id: "x",
  name: "X",
  category: "major",
  blurb: "Twitter/X v2. Browser OAuth — X has no password API.",
  auth: {
    kind: "oauth2",
    note: `Create an app at developer.x.com, enable OAuth 2.0, set the app type to Native App, and request tweet.read, tweet.write, users.read and offline.access. ${REDIRECT_NOTE}`,
    fields: [
      { key: "clientId", label: "Client id", help: "OAuth 2.0 Client ID from the X developer portal." },
      { key: "clientSecret", label: "Client secret", secret: true, optional: true, help: "Only for confidential clients." },
    ],
  },
  caps: { charLimit: 280, mediaLimit: 4, threads: true, delete: true, timeline: true, notifications: false, stats: true },

  async login(input, ctx) {
    const tokens = await authorize(config(input.clientId, input.clientSecret || undefined), ctx);
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
        expiresAt: String(Date.now() + (tokens.expires_in ?? 7200) * 1000),
      },
    };
  },

  async post(account, input) {
    const token = await accessToken(account);
    const body: Record<string, unknown> = { text: input.text };
    if (input.replyTo) body.reply = { in_reply_to_tweet_id: input.replyTo };

    if (input.media?.length) {
      const ids: string[] = [];
      for (const item of input.media.slice(0, 4)) {
        const form = new FormData();
        form.append("media", new Blob([item.data as unknown as ArrayBuffer], { type: item.mime }), item.path.split("/").pop() ?? "media");
        const uploaded = await request(`${API}/2/media/upload`, {
          method: "POST",
          headers: auth(token),
          body: form as never,
        });
        ids.push(((await uploaded.json()) as { data: { id: string } }).data.id);
      }
      body.media = { media_ids: ids };
    }

    const created = await postJson<{ data: { id: string } }>(`${API}/2/tweets`, body, { headers: auth(token) });
    return { id: created.data.id, url: `https://x.com/${account.handle.replace("@", "")}/status/${created.data.id}` };
  },

  async remove(account, id) {
    await request(`${API}/2/tweets/${id}`, { method: "DELETE", headers: auth(await accessToken(account)) });
  },

  async timeline(account, limit) {
    const token = await accessToken(account);
    const result = await getJson<{ data?: Record<string, any>[]; includes?: { users?: Record<string, any>[] } }>(
      `${API}/2/users/${account.meta.userId}/timelines/reverse_chronological?max_results=${Math.min(Math.max(limit, 5), 100)}` +
        `&tweet.fields=created_at,public_metrics,author_id&expansions=author_id&user.fields=username,name`,
      { headers: auth(token) },
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
    const token = await accessToken(account);
    const result = await getJson<{ data: { public_metrics: Record<string, number> } }>(
      `${API}/2/tweets/${id}?tweet.fields=public_metrics`,
      { headers: auth(token) },
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
