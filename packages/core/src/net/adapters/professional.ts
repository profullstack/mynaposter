/** LinkedIn, Pinterest and TikTok. All browser OAuth; none accept a password. */
import type { Network, TimelineItem } from "../types.ts";
import { getJson, postJson, request } from "../../util/http.ts";
import { authorize, REDIRECT_NOTE } from "../oauth2.ts";

export const linkedin: Network = {
  id: "linkedin",
  name: "LinkedIn",
  category: "major",
  blurb: "Personal or organization posts through the UGC API.",
  auth: {
    kind: "oauth2",
    note:
      "Create an app at linkedin.com/developers, add the 'Share on LinkedIn' and 'Sign In with OpenID Connect' products, " +
      `then request w_member_social. ${REDIRECT_NOTE}`,
    fields: [
      { key: "clientId", label: "Client id" },
      { key: "clientSecret", label: "Client secret", secret: true },
      { key: "organization", label: "Organization id", optional: true, help: "Post as a company page instead of yourself." },
    ],
  },
  caps: { charLimit: 3000, mediaLimit: 0, threads: false, delete: true, timeline: false, notifications: false, stats: false },

  async login(input, ctx) {
    const tokens = await authorize(
      {
        authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
        tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        scopes: ["openid", "profile", "w_member_social"],
        pkce: false,
      },
      ctx,
    );
    const me = await getJson<{ sub: string; name: string }>("https://api.linkedin.com/v2/userinfo", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    return {
      handle: me.name,
      displayName: me.name,
      creds: { token: tokens.access_token },
      meta: {
        // The API addresses people and companies as URNs, not ids.
        author: input.organization ? `urn:li:organization:${input.organization}` : `urn:li:person:${me.sub}`,
      },
    };
  },

  async post(account, input) {
    const created = await postJson<{ id: string }>(
      "https://api.linkedin.com/v2/ugcPosts",
      {
        author: account.meta.author,
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text: input.text },
            shareMediaCategory: input.extra?.url ? "ARTICLE" : "NONE",
            ...(input.extra?.url
              ? { media: [{ status: "READY", originalUrl: input.extra.url, ...(input.title ? { title: { text: input.title } } : {}) }] }
              : {}),
          },
        },
        visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
      },
      {
        headers: {
          authorization: `Bearer ${account.creds.token}`,
          "x-restli-protocol-version": "2.0.0",
        },
      },
    );
    return { id: created.id, url: `https://www.linkedin.com/feed/update/${created.id}` };
  },

  async remove(account, id) {
    await request(`https://api.linkedin.com/v2/ugcPosts/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${account.creds.token}`, "x-restli-protocol-version": "2.0.0" },
    });
  },
};

export const pinterest: Network = {
  id: "pinterest",
  name: "Pinterest",
  category: "major",
  blurb: "Creates a Pin on a board. Every Pin needs an image.",
  auth: {
    kind: "oauth2",
    note: `Create an app at developers.pinterest.com with boards:read, pins:read and pins:write. ${REDIRECT_NOTE}`,
    fields: [
      { key: "clientId", label: "App id" },
      { key: "clientSecret", label: "App secret", secret: true },
      { key: "board", label: "Default board", optional: true, help: "Board name or id." },
    ],
  },
  // Pin analytics need a business account and an explicit date range, so myna
  // does not claim stats it cannot deliver.
  caps: { charLimit: 500, mediaLimit: 1, threads: false, delete: true, timeline: true, notifications: false, stats: false, needsTitle: true },

  async login(input, ctx) {
    const tokens = await authorize(
      {
        authorizeUrl: "https://www.pinterest.com/oauth/",
        tokenUrl: "https://api.pinterest.com/v5/oauth/token",
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        scopes: ["boards:read", "pins:read", "pins:write"],
        pkce: false,
        basicAuth: true,
        scopeSeparator: ",",
      },
      ctx,
    );
    const me = await getJson<{ username: string }>("https://api.pinterest.com/v5/user_account", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });

    let boardId = "";
    if (input.board) {
      const boards = await getJson<{ items: { id: string; name: string }[] }>("https://api.pinterest.com/v5/boards", {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      });
      boardId =
        boards.items.find((board) => board.id === input.board || board.name.toLowerCase() === input.board.toLowerCase())?.id ?? "";
      if (!boardId) throw new Error(`No board called "${input.board}". Found: ${boards.items.map((b) => b.name).join(", ")}`);
    }

    return {
      handle: me.username,
      displayName: me.username,
      creds: { token: tokens.access_token, refreshToken: tokens.refresh_token ?? "" },
      meta: { boardId },
    };
  },

  async post(account, input) {
    const boardId = input.extra?.boardId || account.meta.boardId;
    if (!boardId) throw new Error("Pinterest needs a board. Set one on the account or pass --board.");

    const item = input.media?.[0];
    const source = input.extra?.imageUrl
      ? { source_type: "image_url", url: input.extra.imageUrl }
      : item
        ? { source_type: "image_base64", content_type: item.mime, data: Buffer.from(item.data).toString("base64") }
        : null;
    if (!source) throw new Error("Every Pin needs an image. Attach one or pass --image-url.");

    const created = await postJson<{ id: string }>(
      "https://api.pinterest.com/v5/pins",
      {
        board_id: boardId,
        title: input.title || input.text.split("\n")[0].slice(0, 100),
        description: input.text,
        media_source: source,
        ...(input.extra?.url ? { link: input.extra.url } : {}),
      },
      { headers: { authorization: `Bearer ${account.creds.token}` } },
    );
    return { id: created.id, url: `https://pinterest.com/pin/${created.id}` };
  },

  async remove(account, id) {
    await request(`https://api.pinterest.com/v5/pins/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${account.creds.token}` },
    });
  },

  async timeline(account, limit) {
    const result = await getJson<{ items: Record<string, any>[] }>(`https://api.pinterest.com/v5/pins?page_size=${limit}`, {
      headers: { authorization: `Bearer ${account.creds.token}` },
    });
    return (result.items ?? []).map((pin): TimelineItem => ({
      id: pin.id,
      author: account.handle,
      handle: account.handle,
      text: `${pin.title ?? ""}\n${pin.description ?? ""}`.trim(),
      createdAt: pin.created_at ?? "",
      url: `https://pinterest.com/pin/${pin.id}`,
    }));
  },
};

export const tiktok: Network = {
  id: "tiktok",
  name: "TikTok",
  category: "major",
  blurb: "Direct video post. Unaudited apps can only post privately.",
  auth: {
    kind: "oauth2",
    note:
      "Create an app at developers.tiktok.com with the Content Posting API and video.publish scope. Until the app passes " +
      `audit, every post is forced to SELF_ONLY visibility — that is TikTok's rule. ${REDIRECT_NOTE}`,
    fields: [
      { key: "clientKey", label: "Client key" },
      { key: "clientSecret", label: "Client secret", secret: true },
    ],
  },
  caps: { charLimit: 2200, mediaLimit: 1, threads: false, delete: false, timeline: false, notifications: false, stats: false },

  async login(input, ctx) {
    const tokens = await authorize(
      {
        authorizeUrl: "https://www.tiktok.com/v2/auth/authorize/",
        tokenUrl: "https://open.tiktokapis.com/v2/oauth/token/",
        clientId: input.clientKey,
        clientSecret: input.clientSecret,
        scopes: ["user.info.basic", "video.publish"],
        pkce: true,
        // TikTok names the parameter client_key, not client_id.
        authParams: { client_key: input.clientKey },
      },
      ctx,
    );
    const me = await getJson<{ data: { user: { display_name: string; open_id: string } } }>(
      "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name",
      { headers: { authorization: `Bearer ${tokens.access_token}` } },
    );
    return {
      handle: me.data.user.display_name,
      displayName: me.data.user.display_name,
      creds: { token: tokens.access_token, refreshToken: tokens.refresh_token ?? "" },
      meta: { openId: me.data.user.open_id },
    };
  },

  async post(account, input) {
    const videoUrl = input.extra?.videoUrl;
    if (!videoUrl) throw new Error("TikTok posts a video. Pass --video-url with a publicly reachable file.");
    const created = await postJson<{ data: { publish_id: string } }>(
      "https://open.tiktokapis.com/v2/post/publish/video/init/",
      {
        post_info: {
          title: input.text.slice(0, 2200),
          privacy_level: input.extra?.privacy || "SELF_ONLY",
        },
        source_info: { source: "PULL_FROM_URL", video_url: videoUrl },
      },
      { headers: { authorization: `Bearer ${account.creds.token}` } },
    );
    return { id: created.data.publish_id };
  },
};
