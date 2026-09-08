/**
 * X (Twitter), API v2.
 *
 * No password login exists — X removed it. `/login x` opens a browser for the
 * OAuth 2.0 flow, which needs an app from the X developer portal with
 * "Native App / Public client" and the loopback redirect registered. OAuth 1.0a
 * is gone: X issues those keys per app rather than per user, so the four values
 * only ever signed in as the app owner, and every other path here has to
 * refresh a bearer token anyway.
 */
import type { Account, Network, Profile, TimelineItem } from "../types.ts";
import { getJson, postJson, request } from "../../util/http.ts";
import { authorize, callbackFrom, currentToken, PASTE_FIELD, REDIRECT_NOTE, type OAuth2Config } from "../oauth2.ts";

const API = "https://api.x.com";
// follows.* are what the follow graph needs. An account signed in before they
// were added has a token without them; `myna login x` again fixes that.
const SCOPES = ["tweet.read", "tweet.write", "users.read", "follows.read", "follows.write", "offline.access"];

const config = (clientId: string, clientSecret?: string): OAuth2Config => ({
  authorizeUrl: "https://x.com/i/oauth2/authorize",
  tokenUrl: `${API}/2/oauth2/token`,
  clientId,
  clientSecret,
  scopes: SCOPES,
  pkce: true,
  basicAuth: Boolean(clientSecret),
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * The Authorization header for one request. X access tokens last two hours, so
 * anything scheduled further out than that signs with a token refreshed here.
 */
const bearer = async (account: Account): Promise<Record<string, string>> =>
  auth(await currentToken(account, config(account.creds.clientId, account.creds.clientSecret), { lifetime: 7200 }));

export const x: Network = {
  id: "x",
  name: "X",
  category: "major",
  blurb: "Twitter/X v2. Browser OAuth — X has no password API.",
  auth: {
    kind: "oauth2",
    note:
      "In the X developer portal open your app, then Keys and tokens for the OAuth 2.0 Client ID and Client " +
      `Secret — not the API key. User authentication settings must have Read and write turned on. ${REDIRECT_NOTE}`,
    docsUrl: "https://developer.x.com/en/portal/dashboard",
    fields: [
      { key: "clientId", label: "OAuth 2.0 client id", help: "From Keys and tokens, under OAuth 2.0 Client ID and Client Secret." },
      { key: "clientSecret", label: "OAuth 2.0 client secret", secret: true, optional: true, help: "Confidential clients only. Leave blank for a public/native app." },
      PASTE_FIELD,
    ],
  },
  caps: { charLimit: 280, mediaLimit: 4, threads: true, delete: true, timeline: true, notifications: false, stats: true, repost: true, follow: true },

  async login(input, ctx) {
    if (!input.clientId) {
      throw new Error("Give the OAuth 2.0 client id from the X developer portal (Keys and tokens).");
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
          headers: await bearer(account),
          body: form as never,
        });
        ids.push(((await uploaded.json()) as { data: { id: string } }).data.id);
      }
      body.media = { media_ids: ids };
    }

    const created = await postJson<{ data: { id: string } }>(`${API}/2/tweets`, body, {
      headers: await bearer(account),
    });
    return { id: created.data.id, url: `https://x.com/${account.handle.replace("@", "")}/status/${created.data.id}` };
  },

  async remove(account, id) {
    await request(`${API}/2/tweets/${id}`, {
      method: "DELETE",
      headers: await bearer(account),
    });
  },

  async repost(account, ref) {
    const id = xPostId(ref);
    const url = `${API}/2/users/${account.meta.userId}/retweets`;
    await postJson<{ data: { retweeted: boolean } }>(url, { tweet_id: id }, {
      headers: await bearer(account),
    });
    return { id, url: `https://x.com/i/status/${id}` };
  },

  async timeline(account, limit) {
    const url =
      `${API}/2/users/${account.meta.userId}/timelines/reverse_chronological?max_results=${Math.min(Math.max(limit, 5), 100)}` +
      `&tweet.fields=created_at,public_metrics,author_id&expansions=author_id&user.fields=username,name`;
    const result = await getJson<{ data?: Record<string, any>[]; includes?: { users?: Record<string, any>[] } }>(
      url,
      { headers: await bearer(account) },
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
      { headers: await bearer(account) },
    );
    const metrics = result.data.public_metrics ?? {};
    return {
      likes: metrics.like_count,
      reposts: metrics.retweet_count,
      replies: metrics.reply_count,
      views: metrics.impression_count,
    };
  },

  /**
   * Reading a following list is not on X's free tier: the free plan exposes
   * only posting and `users/me`, and anything on this endpoint answers 402 or
   * 403 until the app is on Basic or above. The error is passed through as X
   * words it, which names the plan.
   */
  async following(account, handle, limit) {
    const user = await xUser(account, handle);
    const out: Profile[] = [];
    let token: string | undefined;
    while (out.length < limit) {
      const url =
        `${API}/2/users/${user.id}/following?max_results=${Math.min(1000, Math.max(limit - out.length, 1))}` +
        `&user.fields=description,public_metrics,username,name${token ? `&pagination_token=${token}` : ""}`;
      const page = await getJson<{ data?: Record<string, any>[]; meta?: { next_token?: string } }>(url, {
        headers: await bearer(account),
      });
      for (const item of page.data ?? []) {
        out.push({
          handle: `@${item.username}`,
          id: item.id,
          displayName: item.name,
          bio: item.description || undefined,
          followers: item.public_metrics?.followers_count,
          following: item.public_metrics?.following_count,
          url: `https://x.com/${item.username}`,
        });
      }
      token = page.meta?.next_token;
      if (!token || !page.data?.length) break;
    }
    return out.slice(0, limit);
  },

  async follow(account, handle) {
    const user = await xUser(account, handle);
    const url = `${API}/2/users/${account.meta.userId}/following`;
    // X answers the same way whether the follow is new or already there, so
    // "already" cannot be told apart without a second call. Not worth one.
    await postJson<{ data: { following: boolean; pending_follow: boolean } }>(url, { target_user_id: user.id }, {
      headers: await bearer(account),
    });
    return { id: user.id, url: `https://x.com/${user.username}` };
  },
};

async function xUser(account: Account, ref: string): Promise<{ id: string; username: string }> {
  const username = xUsername(ref);
  const url = `${API}/2/users/by/username/${encodeURIComponent(username)}`;
  const found = await getJson<{ data?: { id: string; username: string } }>(url, { headers: await bearer(account) });
  if (!found.data) throw new Error(`No X account named @${username}`);
  return found.data;
}

/** Top-level paths on x.com that are pages, not people. */
const X_RESERVED = new Set(["i", "home", "explore", "search", "settings", "messages", "notifications", "intent", "hashtag", "compose", "login", "signup", "share"]);

/** The username behind `@alice`, `alice`, or an x.com / twitter.com profile URL. */
export function xUsername(ref: string): string {
  const trimmed = ref.trim();
  const match = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i.exec(trimmed);
  if (match && !X_RESERVED.has(match[1].toLowerCase())) return match[1];
  if (match) throw new Error(`Not an X account: ${ref}`);
  const bare = trimmed.replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(bare)) throw new Error(`Not an X account: ${ref}`);
  return bare;
}

/**
 * The tweet id behind what a person pastes: a bare id, or the post URL from
 * x.com or twitter.com (`/<user>/status/<id>`, with or without a query string).
 */
export function xPostId(ref: string): string {
  const trimmed = ref.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const match = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:[^/]+\/status(?:es)?|i\/(?:web\/)?status)\/(\d+)/i.exec(trimmed);
  if (!match) throw new Error(`Not an X post: ${ref}`);
  return match[1];
}
