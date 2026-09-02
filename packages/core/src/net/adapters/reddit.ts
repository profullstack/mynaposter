/**
 * Reddit.
 *
 * Reddit still honours the OAuth password grant for "script" apps, so this is
 * a genuine username + password login — you just have to register the script
 * app first to get a client id and secret.
 */
import type { Network, TimelineItem } from "../types.ts";
import { getJson, postForm, request, USER_AGENT } from "../../util/http.ts";

const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const API = "https://oauth.reddit.com";

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

/**
 * Tokens last an hour, so every call mints a fresh one rather than storing a
 * token that will be stale by the time the next scheduled post fires.
 */
async function token(account: { creds: Record<string, string> }): Promise<string> {
  const basic = Buffer.from(`${account.creds.clientId}:${account.creds.clientSecret}`).toString("base64");
  const granted = await postForm<TokenResponse>(
    TOKEN_URL,
    { grant_type: "password", username: account.creds.username, password: account.creds.password },
    { headers: { authorization: `Basic ${basic}`, "user-agent": USER_AGENT } },
  );
  if (!granted.access_token) throw new Error("Reddit returned no token — check the client id, secret, username and password.");
  return granted.access_token;
}

const auth = (accessToken: string) => ({ authorization: `Bearer ${accessToken}`, "user-agent": USER_AGENT });

export const reddit: Network = {
  id: "reddit",
  name: "Reddit",
  category: "forum",
  blurb: "Real password login through a script app. Posts need a subreddit and a title.",
  auth: {
    kind: "password",
    note: "Create a 'script' app at reddit.com/prefs/apps to get the client id and secret. Script apps do not work on accounts with 2FA.",
    fields: [
      { key: "clientId", label: "Client id", placeholder: "from reddit.com/prefs/apps" },
      { key: "clientSecret", label: "Client secret", secret: true },
      { key: "username", label: "Reddit username" },
      { key: "password", label: "Password", secret: true },
      { key: "subreddit", label: "Default subreddit", optional: true, placeholder: "test" },
    ],
  },
  caps: { charLimit: 40000, mediaLimit: 0, threads: false, delete: true, timeline: true, notifications: true, stats: true, needsTitle: true },

  async login(input) {
    const creds = {
      clientId: input.clientId.trim(),
      clientSecret: input.clientSecret.trim(),
      username: input.username.trim().replace(/^u\//, ""),
      password: input.password,
    };
    const accessToken = await token({ creds });
    const me = await getJson<{ name: string }>(`${API}/api/v1/me`, { headers: auth(accessToken) });
    return {
      handle: `u/${me.name}`,
      displayName: me.name,
      creds,
      meta: { subreddit: input.subreddit ?? "" },
    };
  },

  async post(account, input) {
    const subreddit = (input.extra?.subreddit || account.meta.subreddit || "").replace(/^r\//, "");
    if (!subreddit) throw new Error("Reddit needs a subreddit. Pass --subreddit <name> or set a default on the account.");

    const accessToken = await token(account);
    const isLink = Boolean(input.extra?.url);
    const form: Record<string, string> = {
      sr: subreddit,
      kind: isLink ? "link" : "self",
      title: input.title || input.text.split("\n")[0].slice(0, 300),
      api_type: "json",
      ...(isLink ? { url: input.extra!.url } : { text: input.text }),
    };

    const result = await postForm<{ json: { errors: string[][]; data?: { id: string; url: string; name: string } } }>(
      `${API}/api/submit`,
      form,
      { headers: auth(accessToken) },
    );

    // Reddit answers 200 with the error inside the body, so this has to be read.
    if (result.json?.errors?.length) {
      throw new Error(result.json.errors.map((error) => error.slice(0, 2).join(": ")).join("; "));
    }
    const data = result.json?.data;
    if (!data) throw new Error("Reddit accepted the request but returned no post.");
    return { id: data.name ?? data.id, url: data.url };
  },

  async remove(account, id) {
    const accessToken = await token(account);
    await postForm(`${API}/api/del`, { id }, { headers: auth(accessToken) });
  },

  async timeline(account, limit) {
    const accessToken = await token(account);
    const result = await getJson<{ data: { children: { data: Record<string, any> }[] } }>(
      `${API}/?limit=${limit}`,
      { headers: auth(accessToken) },
    );
    return result.data.children.map(({ data }): TimelineItem => ({
      id: data.name,
      author: data.author,
      handle: `u/${data.author}`,
      text: `${data.title}${data.selftext ? `\n${String(data.selftext).slice(0, 500)}` : ""}`,
      createdAt: new Date(data.created_utc * 1000).toISOString(),
      url: `https://reddit.com${data.permalink}`,
      likes: data.score,
      replies: data.num_comments,
    }));
  },

  async notifications(account, limit) {
    const accessToken = await token(account);
    const result = await getJson<{ data: { children: { data: Record<string, any> }[] } }>(
      `${API}/message/inbox?limit=${limit}`,
      { headers: auth(accessToken) },
    );
    return result.data.children.map(({ data }): TimelineItem => ({
      id: data.name,
      author: data.author ?? "reddit",
      handle: `u/${data.author ?? ""}`,
      text: `${data.subject ?? ""} ${data.body ?? ""}`.trim(),
      createdAt: new Date(data.created_utc * 1000).toISOString(),
    }));
  },

  async stats(account, id) {
    const accessToken = await token(account);
    const result = await getJson<{ data: { children: { data: Record<string, any> }[] } }>(
      `${API}/api/info?id=${id}`,
      { headers: auth(accessToken) },
    );
    const data = result.data.children[0]?.data ?? {};
    return { likes: data.score, replies: data.num_comments, views: data.view_count ?? undefined };
  },
};
