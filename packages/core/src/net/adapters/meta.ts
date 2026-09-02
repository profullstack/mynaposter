/**
 * Facebook Pages, Instagram and Threads — all on Meta's Graph API.
 *
 * None of them accept a password. Facebook and Instagram also refuse to post
 * to a personal profile at all: you need a Page, and for Instagram a Business
 * or Creator account linked to one. That is a Meta rule, not a myna limitation.
 */
import type { Account, Network, TimelineItem } from "../types.ts";
import { getJson, postJson, request } from "../../util/http.ts";
import { authorize, REDIRECT_NOTE, type OAuth2Config } from "../oauth2.ts";

const GRAPH = "https://graph.facebook.com/v21.0";
const THREADS = "https://graph.threads.net/v1.0";

const facebookConfig = (clientId: string, clientSecret: string, scopes: string[]): OAuth2Config => ({
  authorizeUrl: "https://www.facebook.com/v21.0/dialog/oauth",
  tokenUrl: `${GRAPH}/oauth/access_token`,
  clientId,
  clientSecret,
  scopes,
  pkce: false,
  scopeSeparator: ",",
});

interface Page {
  id: string;
  name: string;
  access_token: string;
}

/** Exchange the short-lived user token for the 60-day one. */
async function longLived(clientId: string, clientSecret: string, token: string): Promise<string> {
  const result = await getJson<{ access_token: string }>(
    `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${clientId}` +
      `&client_secret=${encodeURIComponent(clientSecret)}&fb_exchange_token=${encodeURIComponent(token)}`,
  );
  return result.access_token;
}

export const facebook: Network = {
  id: "facebook",
  name: "Facebook",
  category: "major",
  blurb: "Posts to a Page. Browser OAuth — Meta has no password API and personal profiles cannot be posted to.",
  auth: {
    kind: "oauth2",
    note:
      "Create an app at developers.facebook.com with the Facebook Login product, and add pages_manage_posts and pages_read_engagement. " +
      `You must be an admin of the Page. ${REDIRECT_NOTE}`,
    fields: [
      { key: "clientId", label: "App id" },
      { key: "clientSecret", label: "App secret", secret: true },
      { key: "page", label: "Page name or id", optional: true, help: "Leave blank to use the first Page you administer." },
    ],
  },
  caps: { charLimit: 63206, mediaLimit: 1, threads: false, delete: true, timeline: true, notifications: false, stats: true },

  async login(input, ctx) {
    const tokens = await authorize(
      facebookConfig(input.clientId, input.clientSecret, [
        "pages_manage_posts",
        "pages_read_engagement",
        "pages_show_list",
        "public_profile",
      ]),
      ctx,
    );
    const userToken = await longLived(input.clientId, input.clientSecret, tokens.access_token);

    ctx.report("Looking up the Pages you administer…");
    const pages = await getJson<{ data: Page[] }>(`${GRAPH}/me/accounts?access_token=${encodeURIComponent(userToken)}`);
    if (!pages.data?.length) {
      throw new Error("This account administers no Facebook Pages. Facebook does not allow posting to a personal profile.");
    }
    const wanted = input.page?.trim().toLowerCase();
    const page = wanted
      ? pages.data.find((entry) => entry.id === wanted || entry.name.toLowerCase() === wanted)
      : pages.data[0];
    if (!page) throw new Error(`No Page called "${input.page}". Found: ${pages.data.map((entry) => entry.name).join(", ")}`);

    return {
      handle: page.name,
      displayName: page.name,
      // The Page token, not the user token, is what posts.
      creds: { pageToken: page.access_token, userToken, clientId: input.clientId, clientSecret: input.clientSecret },
      meta: { pageId: page.id },
    };
  },

  async post(account, input) {
    const endpoint = input.media?.length ? "photos" : "feed";
    if (input.media?.length) {
      const form = new FormData();
      form.append("access_token", account.creds.pageToken);
      form.append("caption", input.text);
      const item = input.media[0];
      form.append("source", new Blob([item.data as unknown as ArrayBuffer], { type: item.mime }), item.path.split("/").pop() ?? "photo");
      const response = await request(`${GRAPH}/${account.meta.pageId}/photos`, { method: "POST", body: form as never });
      const created = (await response.json()) as { id: string; post_id?: string };
      return { id: created.post_id ?? created.id, url: `https://facebook.com/${created.post_id ?? created.id}` };
    }
    const created = await postJson<{ id: string }>(`${GRAPH}/${account.meta.pageId}/${endpoint}`, {
      message: input.text,
      access_token: account.creds.pageToken,
      ...(input.extra?.url ? { link: input.extra.url } : {}),
    });
    return { id: created.id, url: `https://facebook.com/${created.id}` };
  },

  async remove(account, id) {
    await request(`${GRAPH}/${id}?access_token=${encodeURIComponent(account.creds.pageToken)}`, { method: "DELETE" });
  },

  async timeline(account, limit) {
    const result = await getJson<{ data: Record<string, any>[] }>(
      `${GRAPH}/${account.meta.pageId}/posts?limit=${limit}&fields=message,created_time,permalink_url` +
        `&access_token=${encodeURIComponent(account.creds.pageToken)}`,
    );
    return (result.data ?? []).map((post): TimelineItem => ({
      id: post.id,
      author: account.handle,
      handle: account.handle,
      text: post.message ?? "",
      createdAt: post.created_time ?? "",
      url: post.permalink_url,
    }));
  },

  async stats(account, id) {
    const result = await getJson<{ likes?: { summary: { total_count: number } }; comments?: { summary: { total_count: number } } }>(
      `${GRAPH}/${id}?fields=likes.summary(true),comments.summary(true)&access_token=${encodeURIComponent(account.creds.pageToken)}`,
    );
    return { likes: result.likes?.summary.total_count, replies: result.comments?.summary.total_count };
  },
};

export const instagram: Network = {
  id: "instagram",
  name: "Instagram",
  category: "major",
  blurb: "Business/Creator accounts only, and every post needs an image URL.",
  auth: {
    kind: "oauth2",
    note:
      "Needs an Instagram Business or Creator account linked to a Facebook Page, and an app with instagram_basic and " +
      `instagram_content_publish. ${REDIRECT_NOTE}`,
    fields: [
      { key: "clientId", label: "App id" },
      { key: "clientSecret", label: "App secret", secret: true },
    ],
  },
  caps: { charLimit: 2200, mediaLimit: 1, threads: false, delete: false, timeline: true, notifications: false, stats: true },

  async login(input, ctx) {
    const tokens = await authorize(
      facebookConfig(input.clientId, input.clientSecret, [
        "instagram_basic",
        "instagram_content_publish",
        "pages_show_list",
        "pages_read_engagement",
      ]),
      ctx,
    );
    const userToken = await longLived(input.clientId, input.clientSecret, tokens.access_token);

    const pages = await getJson<{ data: Page[] }>(`${GRAPH}/me/accounts?access_token=${encodeURIComponent(userToken)}`);
    for (const page of pages.data ?? []) {
      const linked = await getJson<{ instagram_business_account?: { id: string; username?: string } }>(
        `${GRAPH}/${page.id}?fields=instagram_business_account{id,username}&access_token=${encodeURIComponent(page.access_token)}`,
      );
      const account = linked.instagram_business_account;
      if (account) {
        return {
          handle: `@${account.username ?? account.id}`,
          displayName: account.username ?? page.name,
          creds: { pageToken: page.access_token, userToken },
          meta: { igUserId: account.id, pageId: page.id },
        };
      }
    }
    throw new Error("No Instagram Business account is linked to any Page on this login. Link one in Meta Business Suite first.");
  },

  /**
   * Instagram publishes in two steps and will only fetch media from a public
   * URL — it does not accept an upload. Pass --image-url, or let the
   * infographic backend upload somewhere public first.
   */
  async post(account, input) {
    const imageUrl = input.extra?.imageUrl;
    if (!imageUrl) {
      throw new Error("Instagram needs a publicly reachable image URL (--image-url). Its API cannot accept a file upload.");
    }
    const container = await postJson<{ id: string }>(`${GRAPH}/${account.meta.igUserId}/media`, {
      image_url: imageUrl,
      caption: input.text,
      access_token: account.creds.pageToken,
    });
    const published = await postJson<{ id: string }>(`${GRAPH}/${account.meta.igUserId}/media_publish`, {
      creation_id: container.id,
      access_token: account.creds.pageToken,
    });
    return { id: published.id, url: `https://instagram.com/p/${published.id}` };
  },

  async timeline(account, limit) {
    const result = await getJson<{ data: Record<string, any>[] }>(
      `${GRAPH}/${account.meta.igUserId}/media?limit=${limit}&fields=caption,timestamp,permalink,like_count,comments_count` +
        `&access_token=${encodeURIComponent(account.creds.pageToken)}`,
    );
    return (result.data ?? []).map((media): TimelineItem => ({
      id: media.id,
      author: account.handle,
      handle: account.handle,
      text: media.caption ?? "",
      createdAt: media.timestamp ?? "",
      url: media.permalink,
      likes: media.like_count,
      replies: media.comments_count,
    }));
  },

  async stats(account, id) {
    const media = await getJson<{ like_count?: number; comments_count?: number }>(
      `${GRAPH}/${id}?fields=like_count,comments_count&access_token=${encodeURIComponent(account.creds.pageToken)}`,
    );
    return { likes: media.like_count, replies: media.comments_count };
  },
};

export const threads: Network = {
  id: "threads",
  name: "Threads",
  category: "major",
  blurb: "Meta's microblog. Separate API from Instagram, also two-step publishing.",
  auth: {
    kind: "oauth2",
    note: `Create a Threads app at developers.facebook.com with threads_basic and threads_content_publish. ${REDIRECT_NOTE}`,
    fields: [
      { key: "clientId", label: "App id" },
      { key: "clientSecret", label: "App secret", secret: true },
    ],
  },
  caps: { charLimit: 500, mediaLimit: 1, threads: true, delete: false, timeline: true, notifications: false, stats: true },

  async login(input, ctx) {
    const tokens = await authorize(
      {
        authorizeUrl: "https://threads.net/oauth/authorize",
        tokenUrl: `${THREADS}/oauth/access_token`,
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        scopes: ["threads_basic", "threads_content_publish"],
        pkce: false,
        scopeSeparator: ",",
      },
      ctx,
    );
    const me = await getJson<{ id: string; username: string }>(
      `${THREADS}/me?fields=id,username&access_token=${encodeURIComponent(tokens.access_token)}`,
    );
    return {
      handle: `@${me.username}`,
      displayName: me.username,
      creds: { token: tokens.access_token },
      meta: { userId: me.id },
    };
  },

  async post(account, input) {
    const container = await postJson<{ id: string }>(`${THREADS}/${account.meta.userId}/threads`, {
      media_type: "TEXT",
      text: input.text,
      ...(input.replyTo ? { reply_to_id: input.replyTo } : {}),
      access_token: account.creds.token,
    });
    const published = await postJson<{ id: string }>(`${THREADS}/${account.meta.userId}/threads_publish`, {
      creation_id: container.id,
      access_token: account.creds.token,
    });
    return { id: published.id };
  },

  async timeline(account, limit) {
    const result = await getJson<{ data: Record<string, any>[] }>(
      `${THREADS}/${account.meta.userId}/threads?limit=${limit}&fields=text,timestamp,permalink` +
        `&access_token=${encodeURIComponent(account.creds.token)}`,
    );
    return (result.data ?? []).map((post): TimelineItem => ({
      id: post.id,
      author: account.handle,
      handle: account.handle,
      text: post.text ?? "",
      createdAt: post.timestamp ?? "",
      url: post.permalink,
    }));
  },

  async stats(account, id) {
    const result = await getJson<{ data: { name: string; values: { value: number }[] }[] }>(
      `${THREADS}/${id}/insights?metric=likes,replies,views&access_token=${encodeURIComponent(account.creds.token)}`,
    );
    const read = (name: string) => result.data?.find((metric) => metric.name === name)?.values?.[0]?.value;
    return { likes: read("likes"), replies: read("replies"), views: read("views") };
  },
};
