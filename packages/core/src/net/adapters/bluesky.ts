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
import { buildPostRecord } from "./bluesky-facets.ts";

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
  caps: { charLimit: 300, mediaLimit: 4, threads: true, delete: true, timeline: true, notifications: true, stats: true, repost: true },

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

    // buildPostRecord does the facets and both of Bluesky's length limits.
    const record = buildPostRecord(input.text, new Date().toISOString());

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

  async repost(account, ref) {
    const base = service(account);
    const { accessJwt, did } = await session(account);
    const target = blueskyPostRef(ref);

    // A bsky.app URL names the author by handle; the record needs their DID.
    let uri = target.uri;
    if (!uri) {
      const resolved = await getJson<{ did: string }>(
        `${base}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(target.actor)}`,
        { headers: auth(accessJwt) },
      );
      uri = `at://${resolved.did}/app.bsky.feed.post/${target.rkey}`;
    }

    // A repost record points at a specific version of the post, so it needs
    // the cid as well as the uri.
    let cid = target.cid;
    if (!cid) {
      const found = await getJson<{ posts: { cid: string }[] }>(
        `${base}/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(uri)}`,
        { headers: auth(accessJwt) },
      );
      cid = found.posts[0]?.cid;
      if (!cid) throw new Error(`Bluesky could not find that post: ${ref}`);
    }

    const created = await postJson<{ uri: string; cid: string }>(
      `${base}/xrpc/com.atproto.repo.createRecord`,
      {
        repo: did,
        collection: "app.bsky.feed.repost",
        record: { $type: "app.bsky.feed.repost", subject: { uri, cid }, createdAt: new Date().toISOString() },
      },
      { headers: auth(accessJwt) },
    );
    return { id: `${created.uri}|${created.cid}`, url: `https://bsky.app/profile/${target.actor}/post/${target.rkey}` };
  },
};

/**
 * Where a post lives, from what a person pastes: the bsky.app URL, an at://
 * uri, or the `uri|cid` composite that `post` returns.
 */
export function blueskyPostRef(ref: string): { uri: string; cid?: string; actor: string; rkey: string } {
  const trimmed = ref.trim();
  if (trimmed.startsWith("at://")) {
    const [uri, cid] = trimmed.split("|");
    const [actor, collection, rkey] = uri.slice("at://".length).split("/");
    if (collection !== "app.bsky.feed.post" || !rkey) throw new Error(`Not a Bluesky post: ${ref}`);
    return { uri, cid: cid || undefined, actor, rkey };
  }
  const match = /^https?:\/\/(?:www\.)?bsky\.app\/profile\/([^/]+)\/post\/([^/?#]+)/i.exec(trimmed);
  if (!match) throw new Error(`Not a Bluesky post: ${ref}`);
  const [, actor, rkey] = match;
  return { uri: actor.startsWith("did:") ? `at://${actor}/app.bsky.feed.post/${rkey}` : "", actor, rkey };
}

/** Exported for the compose screen's live counter. */
export const blueskyLength = (text: string): number => countChars(text);
