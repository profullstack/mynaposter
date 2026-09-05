/**
 * YouTube, through the Data API v3.
 *
 * YouTube has no "post" in the sense the other networks mean it. A channel has
 * videos, and under each video there are comments. So this adapter does what a
 * person at a terminal actually wants: search for videos on a subject, leave a
 * comment on one, answer a comment, and upload a video when handed a file.
 *
 *   myna search youtube "terminal social media"
 *   myna post youtube "the CLI for this is myna" --video dQw4w9WgXcQ
 *
 * Google issues one-hour access tokens, so the refresh token is what is really
 * kept, and every call refreshes when it has to.
 */
import { randomBytes } from "node:crypto";
import type { Account, Network, PostStats, TimelineItem } from "../types.ts";
import { getJson, postJson, request } from "../../util/http.ts";
import { authorize, callbackFrom, refresh, PASTE_FIELD, REDIRECT_NOTE, type OAuth2Config } from "../oauth2.ts";

const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD = "https://www.googleapis.com/upload/youtube/v3/videos";

/** One scope covers search, comments and uploads; asking for more just adds consent screens. */
const SCOPES = ["https://www.googleapis.com/auth/youtube.force-ssl"];

/** A YouTube comment can run to 10,000 characters. */
const COMMENT_LIMIT = 10_000;
const TITLE_LIMIT = 100;
const DESCRIPTION_LIMIT = 5_000;

const config = (clientId: string, clientSecret?: string): OAuth2Config => ({
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  clientId,
  clientSecret,
  scopes: SCOPES,
  pkce: true,
  // Google only hands out a refresh token for an offline request, and only on
  // a consent screen the person actually sees. Without both, the login works
  // for an hour and then every scheduled post fails.
  authParams: { access_type: "offline", prompt: "consent" },
});

/** Video ids are exactly eleven URL-safe characters. Nothing else on YouTube is. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * The video id from whatever a person pasted: the id itself, a watch link, a
 * youtu.be share link, a Shorts, live or embed URL. Undefined when it is none
 * of those, so the caller can say so rather than sending garbage to the API.
 */
export function videoIdFrom(ref: string): string | undefined {
  const trimmed = ref.trim();
  if (VIDEO_ID.test(trimmed)) return trimmed;

  let url: URL;
  try {
    url = new URL(/^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return undefined;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, "");
  if (host !== "youtube.com" && host !== "youtu.be" && host !== "youtube-nocookie.com") return undefined;

  const candidate =
    host === "youtu.be"
      ? url.pathname.split("/")[1]
      : (url.searchParams.get("v") ?? url.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?]+)/)?.[1]);
  return candidate && VIDEO_ID.test(candidate) ? candidate : undefined;
}

/** Search results come back HTML-escaped; a title of "Q&amp;A" is not a title. */
function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function accessToken(account: Account): Promise<string> {
  const expiresAt = Number(account.meta.expiresAt || 0);
  if (account.creds.accessToken && Date.now() < expiresAt - 60_000) return account.creds.accessToken;
  if (!account.creds.refreshToken) return account.creds.accessToken;

  const tokens = await refresh(config(account.creds.clientId, account.creds.clientSecret), account.creds.refreshToken);
  account.creds.accessToken = tokens.access_token;
  // Google keeps the same refresh token across refreshes, but honour a new one if it sends it.
  if (tokens.refresh_token) account.creds.refreshToken = tokens.refresh_token;
  account.meta.expiresAt = String(Date.now() + (tokens.expires_in ?? 3600) * 1000);
  const { saveAccount } = await import("../../store/accounts.ts");
  saveAccount(account);
  return tokens.access_token;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

interface CommentSnippet {
  videoId?: string;
  likeCount?: number;
}

interface VideoItem {
  id: string;
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
}

const watchUrl = (videoId: string, commentId?: string) =>
  `https://www.youtube.com/watch?v=${videoId}${commentId ? `&lc=${commentId}` : ""}`;

export const youtube: Network = {
  id: "youtube",
  name: "YouTube",
  category: "major",
  blurb: "Search videos and comment on them, or upload one. Needs a Google Cloud OAuth client.",
  auth: {
    kind: "oauth2",
    note:
      "Create a project at console.cloud.google.com, enable the YouTube Data API v3, and add an OAuth client id of " +
      "type 'Web application'. Comments go out as your channel, so the Google account needs one. While the app's " +
      "consent screen is still in testing, Google expires the sign-in after seven days; publishing it makes the " +
      `sign-in permanent. ${REDIRECT_NOTE}`,
    fields: [
      { key: "clientId", label: "Client id", placeholder: "….apps.googleusercontent.com" },
      { key: "clientSecret", label: "Client secret", secret: true },
      PASTE_FIELD,
    ],
  },
  caps: {
    charLimit: COMMENT_LIMIT,
    mediaLimit: 1,
    threads: false,
    delete: true,
    timeline: false,
    notifications: false,
    stats: true,
    search: true,
  },

  async login(input, ctx) {
    const tokens = await authorize(
      { ...config(input.clientId.trim(), input.clientSecret.trim()), ...callbackFrom(input, ctx) },
      ctx,
    );

    const me = await getJson<{ items?: { id: string; snippet: { title: string; customUrl?: string } }[] }>(
      `${API}/channels?part=snippet&mine=true`,
      { headers: auth(tokens.access_token) },
    );
    const channel = me.items?.[0];
    if (!channel) {
      throw new Error("This Google account has no YouTube channel. Create one at youtube.com first; comments are posted as a channel.");
    }

    return {
      handle: channel.snippet.customUrl ?? channel.snippet.title,
      displayName: channel.snippet.title,
      creds: {
        clientId: input.clientId.trim(),
        clientSecret: input.clientSecret.trim(),
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? "",
      },
      meta: {
        channelId: channel.id,
        expiresAt: String(Date.now() + (tokens.expires_in ?? 3600) * 1000),
      },
    };
  },

  async post(account, input) {
    const token = await accessToken(account);

    // Answering a comment. Its id is what `search` and `stats` hand back for comments.
    const parent = input.extra?.replyTo?.trim();
    if (parent) {
      const reply = await postJson<{ id: string; snippet: CommentSnippet }>(
        `${API}/comments?part=snippet`,
        { snippet: { parentId: parent, textOriginal: input.text } },
        { headers: auth(token) },
      );
      const videoId = reply.snippet?.videoId;
      return { id: reply.id, url: videoId ? watchUrl(videoId, reply.id) : undefined };
    }

    // A comment under a video: the main event.
    if (input.extra?.video) {
      const videoId = videoIdFrom(input.extra.video);
      if (!videoId) throw new Error(`"${input.extra.video}" is not a YouTube video id or URL.`);
      const thread = await postJson<{ id: string }>(
        `${API}/commentThreads?part=snippet`,
        { snippet: { videoId, topLevelComment: { snippet: { textOriginal: input.text } } } },
        { headers: auth(token) },
      );
      return { id: thread.id, url: watchUrl(videoId, thread.id) };
    }

    // An upload, when there is a video file to upload.
    const clip = input.media?.find((item) => item.mime.startsWith("video/"));
    if (clip) return uploadVideo(token, clip.mime, clip.data, input.text, input.title, input.extra?.privacy);

    throw new Error(
      "YouTube posts are comments or uploads. Pass --video <id or url> to comment on a video, " +
        "--reply-to <comment id> to answer a comment, or --media clip.mp4 to upload one.",
    );
  },

  async remove(account, id) {
    const token = await accessToken(account);
    const resource = VIDEO_ID.test(id) ? "videos" : "comments";
    await request(`${API}/${resource}?id=${encodeURIComponent(id)}`, { method: "DELETE", headers: auth(token) });
  },

  async search(account, query, limit) {
    const token = await accessToken(account);
    const params = new URLSearchParams({
      part: "snippet",
      type: "video",
      q: query,
      maxResults: String(Math.max(1, Math.min(limit, 50))),
      order: "relevance",
    });
    const result = await getJson<{
      items?: {
        id: { videoId?: string };
        snippet: { title: string; description: string; channelTitle: string; publishedAt: string };
      }[];
    }>(`${API}/search?${params}`, { headers: auth(token) });

    return (result.items ?? [])
      .filter((item) => item.id.videoId)
      .map(
        (item): TimelineItem => ({
          id: item.id.videoId!,
          author: decodeEntities(item.snippet.channelTitle),
          handle: decodeEntities(item.snippet.channelTitle),
          text: decodeEntities(`${item.snippet.title}${item.snippet.description ? `\n${item.snippet.description}` : ""}`),
          createdAt: item.snippet.publishedAt,
          url: watchUrl(item.id.videoId!),
        }),
      );
  },

  async stats(account, id) {
    const token = await accessToken(account);

    if (VIDEO_ID.test(id)) {
      const result = await getJson<{ items?: VideoItem[] }>(`${API}/videos?part=statistics&id=${id}`, { headers: auth(token) });
      const stats = result.items?.[0]?.statistics ?? {};
      return {
        likes: stats.likeCount === undefined ? undefined : Number(stats.likeCount),
        replies: stats.commentCount === undefined ? undefined : Number(stats.commentCount),
        views: stats.viewCount === undefined ? undefined : Number(stats.viewCount),
      };
    }

    // A reply id carries its parent before a dot; only a top-level comment is a thread.
    if (id.includes(".")) {
      const result = await getJson<{ items?: { snippet: CommentSnippet }[] }>(
        `${API}/comments?part=snippet&id=${encodeURIComponent(id)}`,
        { headers: auth(token) },
      );
      return { likes: result.items?.[0]?.snippet.likeCount };
    }

    const result = await getJson<{ items?: { snippet: { totalReplyCount?: number; topLevelComment?: { snippet: CommentSnippet } } }[] }>(
      `${API}/commentThreads?part=snippet&id=${encodeURIComponent(id)}`,
      { headers: auth(token) },
    );
    const thread = result.items?.[0]?.snippet;
    const stats: PostStats = { likes: thread?.topLevelComment?.snippet.likeCount, replies: thread?.totalReplyCount };
    return stats;
  },
};

/**
 * One multipart request: the metadata, then the bytes. Fine up to the 100 MB
 * that `loadMedia` allows; anything larger would want the resumable protocol.
 */
async function uploadVideo(
  token: string,
  mime: string,
  data: Uint8Array,
  text: string,
  title: string | undefined,
  privacy: string | undefined,
): Promise<{ id: string; url: string }> {
  const boundary = `myna-${randomBytes(12).toString("hex")}`;
  // YouTube rejects angle brackets in a title outright.
  const safeTitle = (title || text.split("\n")[0]).replace(/[<>]/g, "").trim().slice(0, TITLE_LIMIT) || "Untitled";
  const metadata = JSON.stringify({
    snippet: { title: safeTitle, description: text.slice(0, DESCRIPTION_LIMIT) },
    status: { privacyStatus: privacy || "public", selfDeclaredMadeForKids: false },
  });

  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=utf-8\r\n\r\n${metadata}\r\n--${boundary}\r\ncontent-type: ${mime}\r\n\r\n`),
    Buffer.from(data),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const response = await request(`${UPLOAD}?uploadType=multipart&part=snippet,status`, {
    method: "POST",
    headers: { ...auth(token), "content-type": `multipart/related; boundary=${boundary}` },
    body,
    // A 100 MB upload on a slow link is many minutes, not thirty seconds.
    timeoutMs: 600_000,
  });
  const created = (await response.json()) as { id: string };
  return { id: created.id, url: watchUrl(created.id) };
}
