/** Lemmy. Real username + password login, posts go to a community. */
import type { Network, TimelineItem } from "../types.ts";
import { getJson, normalizeInstance, postJson, request } from "../../util/http.ts";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

interface PostView {
  post: { id: number; name: string; body?: string; url?: string; published: string; ap_id: string };
  creator: { name: string; display_name?: string };
  counts?: { score: number; comments: number };
}

export const lemmy: Network = {
  id: "lemmy",
  name: "Lemmy",
  category: "forum",
  blurb: "Federated link aggregator. Real password login. Posts need a community and a title.",
  auth: {
    kind: "password",
    note: "Your normal Lemmy account. If you have 2FA on, add the current code to the TOTP field.",
    fields: [
      { key: "instance", label: "Instance", placeholder: "lemmy.world" },
      { key: "username", label: "Username or email" },
      { key: "password", label: "Password", secret: true },
      { key: "totp", label: "2FA code", optional: true, help: "Only if two-factor is enabled." },
      { key: "community", label: "Default community", optional: true, placeholder: "technology" },
    ],
  },
  caps: { charLimit: 0, mediaLimit: 1, threads: false, delete: true, timeline: true, notifications: false, stats: true, needsTitle: true },

  async login(input) {
    const instance = normalizeInstance(input.instance);
    const session = await postJson<{ jwt?: string }>(`${instance}/api/v3/user/login`, {
      username_or_email: input.username,
      password: input.password,
      ...(input.totp ? { totp_2fa_token: input.totp } : {}),
    });
    if (!session.jwt) throw new Error("Lemmy accepted the request but returned no token — check the username and password.");
    return {
      handle: `${input.username}@${new URL(instance).host}`,
      displayName: input.username,
      creds: { token: session.jwt },
      meta: { instance, community: input.community ?? "" },
    };
  },

  async post(account, input) {
    const instance = account.meta.instance;
    const name = input.extra?.community || account.meta.community;
    if (!name) throw new Error("Lemmy needs a community. Pass --community <name> or set one on the account.");

    const found = await getJson<{ community_view: { community: { id: number } } }>(
      `${instance}/api/v3/community?name=${encodeURIComponent(name)}`,
      { headers: auth(account.creds.token) },
    );

    const created = await postJson<{ post_view: PostView }>(
      `${instance}/api/v3/post`,
      {
        community_id: found.community_view.community.id,
        name: input.title || input.text.split("\n")[0].slice(0, 200),
        body: input.text,
        ...(input.extra?.url ? { url: input.extra.url } : {}),
      },
      { headers: auth(account.creds.token) },
    );
    return { id: String(created.post_view.post.id), url: created.post_view.post.ap_id };
  },

  async remove(account, id) {
    await request(`${account.meta.instance}/api/v3/post/delete`, {
      method: "POST",
      headers: { ...auth(account.creds.token), "content-type": "application/json" },
      body: JSON.stringify({ post_id: Number(id), deleted: true }),
    });
  },

  async timeline(account, limit) {
    const result = await getJson<{ posts: PostView[] }>(
      `${account.meta.instance}/api/v3/post/list?type_=Subscribed&limit=${limit}`,
      { headers: auth(account.creds.token) },
    );
    return result.posts.map((view): TimelineItem => ({
      id: String(view.post.id),
      author: view.creator.display_name || view.creator.name,
      handle: view.creator.name,
      text: `${view.post.name}${view.post.body ? `\n${view.post.body}` : ""}`,
      createdAt: view.post.published,
      url: view.post.ap_id,
      likes: view.counts?.score,
      replies: view.counts?.comments,
    }));
  },

  async stats(account, id) {
    const result = await getJson<{ post_view: PostView }>(`${account.meta.instance}/api/v3/post?id=${id}`, {
      headers: auth(account.creds.token),
    });
    return { likes: result.post_view.counts?.score, replies: result.post_view.counts?.comments };
  },
};
