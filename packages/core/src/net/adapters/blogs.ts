/**
 * Long-form targets: dev.to, Hashnode, Ghost, WordPress, Micro.blog, Tumblr.
 *
 * These take a title and a body, so a thread-length post becomes an article
 * rather than being split. All of them authenticate with a key you paste,
 * except WordPress, which has genuine application passwords.
 */
import type { Network, TimelineItem } from "../types.ts";
import { getJson, normalizeInstance, postJson, request } from "../../util/http.ts";
import { ghostToken, oauth1Header } from "../../util/crypto/sign.ts";

const firstLine = (text: string): string => text.split("\n")[0].replace(/^#+\s*/, "").slice(0, 200);

export const devto: Network = {
  id: "devto",
  name: "dev.to",
  category: "blog",
  blurb: "Forem. Publishes a Markdown article.",
  auth: {
    kind: "token",
    note: "dev.to → Settings → Extensions → DEV Community API Keys → Generate API Key.",
    fields: [{ key: "apiKey", label: "API key", secret: true }],
  },
  caps: { charLimit: 0, mediaLimit: 0, threads: false, delete: false, timeline: true, notifications: false, stats: true, needsTitle: true },

  async login(input) {
    const me = await getJson<{ username: string; name: string }>("https://dev.to/api/users/me", {
      headers: { "api-key": input.apiKey },
    });
    return { handle: me.username, displayName: me.name, creds: { apiKey: input.apiKey }, meta: {} };
  },

  async post(account, input) {
    const created = await postJson<{ id: number; url: string }>(
      "https://dev.to/api/articles",
      {
        article: {
          title: input.title || firstLine(input.text),
          body_markdown: input.text,
          published: input.extra?.draft !== "true",
          tags: (input.extra?.tags ?? "").split(",").map((tag) => tag.trim().replace(/^#/, "")).filter(Boolean).slice(0, 4),
          ...(input.extra?.canonicalUrl ? { canonical_url: input.extra.canonicalUrl } : {}),
        },
      },
      { headers: { "api-key": account.creds.apiKey } },
    );
    return { id: String(created.id), url: created.url };
  },

  async timeline(account, limit) {
    const articles = await getJson<Record<string, any>[]>(`https://dev.to/api/articles/me?per_page=${limit}`, {
      headers: { "api-key": account.creds.apiKey },
    });
    return articles.map((article): TimelineItem => ({
      id: String(article.id),
      author: account.displayName ?? account.handle,
      handle: account.handle,
      text: article.title,
      createdAt: article.published_at ?? article.created_at ?? "",
      url: article.url,
      likes: article.public_reactions_count,
      replies: article.comments_count,
    }));
  },

  async stats(account, id) {
    const article = await getJson<Record<string, any>>(`https://dev.to/api/articles/${id}`, {
      headers: { "api-key": account.creds.apiKey },
    });
    return { likes: article.public_reactions_count, replies: article.comments_count, views: article.page_views_count };
  },
};

export const hashnode: Network = {
  id: "hashnode",
  name: "Hashnode",
  category: "blog",
  blurb: "GraphQL publishing to your Hashnode publication.",
  auth: {
    kind: "token",
    note: "hashnode.com/settings/developer → Generate New Token. The publication id is in your blog dashboard URL.",
    fields: [
      { key: "token", label: "Personal access token", secret: true },
      { key: "publicationId", label: "Publication id" },
    ],
  },
  caps: { charLimit: 0, mediaLimit: 0, threads: false, delete: false, timeline: false, notifications: false, stats: false, needsTitle: true },

  async login(input) {
    const me = await postJson<{ data: { me: { username: string; name: string } } }>(
      "https://gql.hashnode.com/",
      { query: "{ me { username name } }" },
      { headers: { authorization: input.token } },
    );
    const user = me.data?.me;
    if (!user) throw new Error("Hashnode rejected the token.");
    return {
      handle: user.username,
      displayName: user.name,
      creds: { token: input.token },
      meta: { publicationId: input.publicationId },
    };
  },

  async post(account, input) {
    const result = await postJson<{ data?: { publishPost: { post: { id: string; url: string } } }; errors?: { message: string }[] }>(
      "https://gql.hashnode.com/",
      {
        query: `mutation Publish($input: PublishPostInput!) { publishPost(input: $input) { post { id url } } }`,
        variables: {
          input: {
            publicationId: input.extra?.publicationId || account.meta.publicationId,
            title: input.title || firstLine(input.text),
            contentMarkdown: input.text,
            tags: (input.extra?.tags ?? "")
              .split(",")
              .map((tag) => tag.trim().replace(/^#/, ""))
              .filter(Boolean)
              .map((slug) => ({ slug, name: slug })),
          },
        },
      },
      { headers: { authorization: account.creds.token } },
    );
    // GraphQL reports failures in the body with a 200 status.
    if (result.errors?.length) throw new Error(result.errors.map((error) => error.message).join("; "));
    const post = result.data?.publishPost.post;
    if (!post) throw new Error("Hashnode returned no post.");
    return { id: post.id, url: post.url };
  },
};

export const ghost: Network = {
  id: "ghost",
  name: "Ghost",
  category: "blog",
  blurb: "Self-hosted or Ghost Pro. Admin API key, signed as a short-lived JWT.",
  auth: {
    kind: "token",
    note: "Ghost admin → Settings → Integrations → Add custom integration, then copy the Admin API Key (it looks like id:secret).",
    fields: [
      { key: "url", label: "Blog URL", placeholder: "https://blog.example.com" },
      { key: "adminApiKey", label: "Admin API key", secret: true, placeholder: "6421…:9f8e…" },
    ],
  },
  caps: { charLimit: 0, mediaLimit: 0, threads: false, delete: true, timeline: true, notifications: false, stats: false, needsTitle: true },

  async login(input) {
    const url = normalizeInstance(input.url);
    const site = await getJson<{ site: { title: string } }>(`${url}/ghost/api/admin/site/`, {
      headers: { authorization: `Ghost ${ghostToken(input.adminApiKey)}` },
    });
    return {
      handle: new URL(url).host,
      displayName: site.site.title,
      creds: { adminApiKey: input.adminApiKey },
      meta: { url },
    };
  },

  async post(account, input) {
    const created = await postJson<{ posts: { id: string; url: string }[] }>(
      `${account.meta.url}/ghost/api/admin/posts/?source=html`,
      {
        posts: [
          {
            title: input.title || firstLine(input.text),
            html: `<p>${input.text.replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`,
            status: input.extra?.draft === "true" ? "draft" : "published",
            ...(input.extra?.tags ? { tags: input.extra.tags.split(",").map((name) => ({ name: name.trim() })) } : {}),
          },
        ],
      },
      { headers: { authorization: `Ghost ${ghostToken(account.creds.adminApiKey)}` } },
    );
    const post = created.posts[0];
    return { id: post.id, url: post.url };
  },

  async remove(account, id) {
    await request(`${account.meta.url}/ghost/api/admin/posts/${id}/`, {
      method: "DELETE",
      headers: { authorization: `Ghost ${ghostToken(account.creds.adminApiKey)}` },
    });
  },

  async timeline(account, limit) {
    const result = await getJson<{ posts: Record<string, any>[] }>(
      `${account.meta.url}/ghost/api/admin/posts/?limit=${limit}`,
      { headers: { authorization: `Ghost ${ghostToken(account.creds.adminApiKey)}` } },
    );
    return result.posts.map((post): TimelineItem => ({
      id: post.id,
      author: account.displayName ?? account.handle,
      handle: account.handle,
      text: post.title,
      createdAt: post.published_at ?? post.created_at,
      url: post.url,
    }));
  },
};

export const wordpress: Network = {
  id: "wordpress",
  name: "WordPress",
  category: "blog",
  blurb: "Self-hosted WordPress. Real username with an application password.",
  auth: {
    kind: "password",
    note: "Users → Profile → Application Passwords → Add New. Use that, not your login password.",
    fields: [
      { key: "url", label: "Site URL", placeholder: "https://example.com" },
      { key: "username", label: "Username" },
      { key: "password", label: "Application password", secret: true, placeholder: "xxxx xxxx xxxx xxxx" },
    ],
  },
  caps: { charLimit: 0, mediaLimit: 0, threads: false, delete: true, timeline: true, notifications: false, stats: false, needsTitle: true },

  async login(input) {
    const url = normalizeInstance(input.url);
    const basic = Buffer.from(`${input.username}:${input.password.replace(/\s+/g, "")}`).toString("base64");
    const me = await getJson<{ name: string; slug: string }>(`${url}/wp-json/wp/v2/users/me`, {
      headers: { authorization: `Basic ${basic}` },
    });
    return {
      handle: `${me.slug}@${new URL(url).host}`,
      displayName: me.name,
      creds: { basic },
      meta: { url },
    };
  },

  async post(account, input) {
    const created = await postJson<{ id: number; link: string }>(
      `${account.meta.url}/wp-json/wp/v2/posts`,
      {
        title: input.title || firstLine(input.text),
        content: input.text.replace(/\n\n/g, "</p><p>"),
        status: input.extra?.draft === "true" ? "draft" : "publish",
      },
      { headers: { authorization: `Basic ${account.creds.basic}` } },
    );
    return { id: String(created.id), url: created.link };
  },

  async remove(account, id) {
    await request(`${account.meta.url}/wp-json/wp/v2/posts/${id}`, {
      method: "DELETE",
      headers: { authorization: `Basic ${account.creds.basic}` },
    });
  },

  async timeline(account, limit) {
    const posts = await getJson<Record<string, any>[]>(`${account.meta.url}/wp-json/wp/v2/posts?per_page=${limit}`, {
      headers: { authorization: `Basic ${account.creds.basic}` },
    });
    return posts.map((post): TimelineItem => ({
      id: String(post.id),
      author: account.displayName ?? account.handle,
      handle: account.handle,
      text: post.title?.rendered ?? "",
      createdAt: post.date_gmt ?? "",
      url: post.link,
    }));
  },
};

export const microblog: Network = {
  id: "microblog",
  name: "Micro.blog",
  category: "blog",
  blurb: "Micropub posting to your Micro.blog or any Micropub endpoint.",
  auth: {
    kind: "token",
    note: "micro.blog/account/apps → generate an app token.",
    fields: [
      { key: "token", label: "App token", secret: true },
      { key: "endpoint", label: "Micropub endpoint", optional: true, default: "https://micro.blog/micropub" },
    ],
  },
  caps: { charLimit: 0, mediaLimit: 0, threads: false, delete: false, timeline: false, notifications: false, stats: false },

  async login(input) {
    const endpoint = input.endpoint || "https://micro.blog/micropub";
    const config = await getJson<{ "media-endpoint"?: string }>(`${endpoint}?q=config`, {
      headers: { authorization: `Bearer ${input.token}` },
    });
    return {
      handle: new URL(endpoint).host,
      displayName: "Micro.blog",
      creds: { token: input.token },
      meta: { endpoint, mediaEndpoint: config["media-endpoint"] ?? "" },
    };
  },

  async post(account, input) {
    const form = new URLSearchParams({ h: "entry", content: input.text });
    if (input.title) form.set("name", input.title);
    const response = await request(account.meta.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${account.creds.token}`, "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const url = response.headers.get("location") ?? "";
    return { id: url || "posted", url: url || undefined };
  },
};

export const tumblr: Network = {
  id: "tumblr",
  name: "Tumblr",
  category: "minor",
  blurb: "OAuth 1.0a with your own app keys. No browser round-trip needed.",
  auth: {
    kind: "oauth1",
    note:
      "Register an app at tumblr.com/oauth/apps, then use the API console (api.tumblr.com/console) to get the OAuth token " +
      "and secret for your account. All four values go here.",
    fields: [
      { key: "consumerKey", label: "Consumer key" },
      { key: "consumerSecret", label: "Consumer secret", secret: true },
      { key: "token", label: "OAuth token", secret: true },
      { key: "tokenSecret", label: "OAuth token secret", secret: true },
      { key: "blog", label: "Blog identifier", placeholder: "myblog.tumblr.com" },
    ],
  },
  caps: { charLimit: 0, mediaLimit: 0, threads: false, delete: true, timeline: false, notifications: false, stats: false },

  async login(input) {
    const creds = {
      consumerKey: input.consumerKey,
      consumerSecret: input.consumerSecret,
      token: input.token,
      tokenSecret: input.tokenSecret,
    };
    const url = "https://api.tumblr.com/v2/user/info";
    const me = await getJson<{ response: { user: { name: string } } }>(url, {
      headers: { authorization: oauth1Header("GET", url, {}, creds) },
    });
    return {
      handle: input.blog,
      displayName: me.response.user.name,
      creds,
      meta: { blog: input.blog },
    };
  },

  async post(account, input) {
    const url = `https://api.tumblr.com/v2/blog/${account.meta.blog}/posts`;
    const body = {
      content: [
        ...(input.title ? [{ type: "text", subtype: "heading1", text: input.title }] : []),
        { type: "text", text: input.text },
      ],
      state: input.extra?.draft === "true" ? "draft" : "published",
      tags: (input.extra?.tags ?? "").split(",").map((tag) => tag.trim().replace(/^#/, "")).filter(Boolean).join(","),
    };
    // The signature covers only the OAuth parameters when the body is JSON.
    const created = await postJson<{ response: { id_string?: string; id?: number } }>(url, body, {
      headers: {
        authorization: oauth1Header("POST", url, {}, account.creds as never),
      },
    });
    const id = created.response.id_string ?? String(created.response.id ?? "");
    return { id, url: `https://${account.meta.blog}/post/${id}` };
  },

  async remove(account, id) {
    const url = `https://api.tumblr.com/v2/blog/${account.meta.blog}/post/delete`;
    await request(url, {
      method: "POST",
      headers: {
        authorization: oauth1Header("POST", url, { id }, account.creds as never),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ id }).toString(),
    });
  },
};
