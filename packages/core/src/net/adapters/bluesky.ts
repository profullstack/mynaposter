/**
 * Bluesky / AT Protocol.
 *
 * One of the few networks where `/login` means what people expect: a real
 * handle and a real password. Use an App Password from Settings → App
 * Passwords rather than the account password.
 */
import type { Account, Network, PostInput, PostResult, TimelineItem } from "../types.ts";
import { getJson, normalizeInstance, postJson, request } from "../../util/http.ts";
import { countChars } from "../../util/text.ts";

interface Session {
  accessJwt: string;
  refreshJwt: string;
  did: string;
  handle: string;
}

const DEFAULT_SERVICE = "https://bsky.social";

const service = (account: Account): string => account.meta.service || DEFAULT_SERVICE;

async function session(account: Account): Promise<Session> {
  return postJson<Session>(`${service(account)}/xrpc/com.atproto.server.createSession`, {
    identifier: account.handle,
    password: account.creds.password,
  });
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * Bluesky renders links and mentions from byte-offset facets, not from the
 * text itself, so a URL posted without one is inert. Offsets are into UTF-8
 * bytes, which is why this walks the encoded buffer rather than the string.
 */
function linkFacets(text: string): unknown[] {
  const encoder = new TextEncoder();
  const facets: unknown[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"]+/g)) {
    const before = encoder.encode(text.slice(0, match.index)).length;
    const uri = match[0].replace(/[.,;:!?)]+$/, "");
    facets.push({
      index: { byteStart: before, byteEnd: before + encoder.encode(uri).length },
      features: [{ $type: "app.bsky.richtext.facet#link", uri }],
    });
  }
  for (const match of text.matchAll(/(^|\s)(#[\p{L}\p{N}_]+)/gu)) {
    const tagStart = (match.index ?? 0) + match[1].length;
    const before = encoder.encode(text.slice(0, tagStart)).length;
    facets.push({
      index: { byteStart: before, byteEnd: before + encoder.encode(match[2]).length },
      features: [{ $type: "app.bsky.richtext.facet#tag", tag: match[2].slice(1) }],
    });
  }
  return facets;
}

async function uploadBlob(base: string, token: string, item: { data: Uint8Array; mime: string }): Promise<unknown> {
  const response = await request(`${base}/xrpc/com.atproto.repo.uploadBlob`, {
    method: "POST",
    headers: { ...auth(token), "content-type": item.mime },
    body: item.data,
  });
  return ((await response.json()) as { blob: unknown }).blob;
}

export const bluesky: Network = {
  id: "bluesky",
  name: "Bluesky",
  category: "major",
  blurb: "AT Protocol. Real password login via an App Password.",
  auth: {
    kind: "password",
    note: "Create an App Password at Settings → Privacy and Security → App Passwords. Your main password works but is a bad idea.",
    fields: [
      { key: "handle", label: "Handle", placeholder: "alice.bsky.social" },
      { key: "password", label: "App password", secret: true, placeholder: "xxxx-xxxx-xxxx-xxxx" },
      { key: "service", label: "PDS", optional: true, default: DEFAULT_SERVICE, help: "Only change this for a self-hosted PDS." },
    ],
  },
  caps: { charLimit: 300, mediaLimit: 4, threads: true, delete: true, timeline: true, notifications: true, stats: true },

  async login(input) {
    const base = input.service ? normalizeInstance(input.service) : DEFAULT_SERVICE;
    const created = await postJson<Session>(`${base}/xrpc/com.atproto.server.createSession`, {
      identifier: input.handle.trim().replace(/^@/, ""),
      password: input.password,
    });
    return {
      handle: created.handle,
      displayName: created.handle,
      creds: { password: input.password },
      meta: { service: base, did: created.did },
    };
  },

  async post(account, input) {
    const base = service(account);
    const { accessJwt, did } = await session(account);

    const record: Record<string, unknown> = {
      $type: "app.bsky.feed.post",
      text: input.text,
      createdAt: new Date().toISOString(),
      facets: linkFacets(input.text),
    };

    if (input.media?.length) {
      const images = [];
      for (const item of input.media.slice(0, 4)) {
        images.push({ image: await uploadBlob(base, accessJwt, item), alt: item.alt ?? "" });
      }
      record.embed = { $type: "app.bsky.embed.images", images };
    }

    if (input.replyTo) {
      // A reply carries both the immediate parent and the thread root, and the
      // root has to be looked up or the reply detaches into its own thread.
      const [rootUri, rootCid, parentUri, parentCid] = input.replyTo.split("|");
      record.reply = {
        root: { uri: rootUri, cid: rootCid },
        parent: { uri: parentUri ?? rootUri, cid: parentCid ?? rootCid },
      };
    }

    const created = await postJson<{ uri: string; cid: string }>(
      `${base}/xrpc/com.atproto.repo.createRecord`,
      { repo: did, collection: "app.bsky.feed.post", record },
      { headers: auth(accessJwt) },
    );

    const rkey = created.uri.split("/").pop() ?? "";
    return {
      // The composite id is what `replyTo` above expects for the next part.
      id: `${created.uri}|${created.cid}`,
      url: `https://bsky.app/profile/${account.handle}/post/${rkey}`,
    };
  },

  async remove(account, id) {
    const base = service(account);
    const { accessJwt, did } = await session(account);
    const uri = id.split("|")[0];
    await postJson(
      `${base}/xrpc/com.atproto.repo.deleteRecord`,
      { repo: did, collection: "app.bsky.feed.post", rkey: uri.split("/").pop() },
      { headers: auth(accessJwt) },
    );
  },

  async timeline(account, limit) {
    const base = service(account);
    const { accessJwt } = await session(account);
    const feed = await getJson<{ feed: { post: Record<string, any> }[] }>(
      `${base}/xrpc/app.bsky.feed.getTimeline?limit=${limit}`,
      { headers: auth(accessJwt) },
    );
    return feed.feed.map(({ post }): TimelineItem => ({
      id: `${post.uri}|${post.cid}`,
      author: post.author?.displayName || post.author?.handle || "",
      handle: post.author?.handle ?? "",
      text: post.record?.text ?? "",
      createdAt: post.record?.createdAt ?? "",
      url: `https://bsky.app/profile/${post.author?.handle}/post/${String(post.uri).split("/").pop()}`,
      likes: post.likeCount,
      reposts: post.repostCount,
      replies: post.replyCount,
    }));
  },

  async notifications(account, limit) {
    const base = service(account);
    const { accessJwt } = await session(account);
    const result = await getJson<{ notifications: Record<string, any>[] }>(
      `${base}/xrpc/app.bsky.notification.listNotifications?limit=${limit}`,
      { headers: auth(accessJwt) },
    );
    return result.notifications.map((item): TimelineItem => ({
      id: item.uri,
      author: item.author?.displayName || item.author?.handle || "",
      handle: item.author?.handle ?? "",
      text: `${item.reason}: ${item.record?.text ?? ""}`.trim(),
      createdAt: item.indexedAt ?? "",
    }));
  },

  async stats(account, id) {
    const base = service(account);
    const { accessJwt } = await session(account);
    const uri = id.split("|")[0];
    const result = await getJson<{ posts: Record<string, any>[] }>(
      `${base}/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(uri)}`,
      { headers: auth(accessJwt) },
    );
    const post = result.posts[0] ?? {};
    return { likes: post.likeCount, reposts: post.repostCount, replies: post.replyCount };
  },
};

/** Exported for the compose screen's live counter. */
export const blueskyLength = (text: string): number => countChars(text);
