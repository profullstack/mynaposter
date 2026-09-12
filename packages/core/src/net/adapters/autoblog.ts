/**
 * Autoblog: post to any blog that speaks the OpenStream-adjacent autoblog
 * webhook protocol (`@profullstack/autoblog`).
 *
 * A growing set of Profullstack blogs receive posts as signed CloudEvents
 * webhooks rather than through a bespoke API: logicsrc.com, crawlproof.com,
 * and anything else built on the same receiver. One target speaks to all of
 * them. You register a receiver's webhook URL and its shared secret; myna
 * renders the post to HTML, signs the event, and delivers it.
 *
 * Guest posts fall straight out of this. A post carries whatever
 * `--canonical-url` names as its original, so publishing to an autoblog
 * target with the source URL as canonical is exactly a syndicated guest
 * post: the receiver stores the canonical and points search engines back at
 * the source, never competing with it. No canonical means the post is
 * original to that blog.
 */
import { buildEvent, sendWebhook, type Post } from "@profullstack/autoblog";
import type { Network } from "../types.ts";
import { firstParagraph, renderMarkdown, slugify } from "../../util/markdown.ts";

const firstLine = (text: string): string => (text.split("\n")[0] ?? "").replace(/^#+\s*/, "").slice(0, 200);

function tagsOf(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((tag) => tag.trim().replace(/^#/, ""))
    .filter(Boolean);
}

export const autoblog: Network = {
  id: "autoblog",
  name: "Autoblog",
  category: "blog",
  blurb: "A blog that receives signed autoblog webhooks (logicsrc, crawlproof, and the like).",
  auth: {
    kind: "token",
    note: "The receiver's webhook URL and its shared secret. The blog's operator gives you both; on a Profullstack blog they are the autoblog integration's endpoint and access token.",
    docsUrl: "https://crawlproof.com/docs/autoblog-webhook",
    fields: [
      { key: "url", label: "Webhook URL", placeholder: "https://logicsrc.com/api/webhooks/blog" },
      { key: "secret", label: "Webhook secret", secret: true },
      { key: "name", label: "A name for this blog", optional: true, placeholder: "logicsrc", help: "What you type after autoblog: in --to. Defaults to the URL's host." },
      { key: "siteUrl", label: "Blog site URL", optional: true, placeholder: "https://logicsrc.com", help: "Where a post of yours lives on this blog, for its own URL when not a guest post." },
      { key: "author", label: "Default author name", optional: true },
    ],
  },
  caps: {
    charLimit: 0,
    mediaLimit: 0,
    threads: false,
    delete: false,
    timeline: false,
    notifications: false,
    stats: false,
    needsTitle: true,
    // A post here is a publication; a stray `all` fan-out must never create one.
    explicitTarget: true,
  },

  async login(input) {
    const url = (input.url ?? "").trim();
    if (!/^https?:\/\/.+/i.test(url)) throw new Error("The webhook URL must be an http(s) URL.");
    if (!(input.secret ?? "").trim()) throw new Error("A webhook secret is required.");
    let host = "";
    try {
      host = new URL(url).host;
    } catch {
      throw new Error("The webhook URL is not a valid URL.");
    }
    const handle = (input.name ?? "").trim() || host;
    const meta: Record<string, string> = { webhookUrl: url };
    if (input.siteUrl?.trim()) meta.siteUrl = input.siteUrl.trim().replace(/\/+$/, "");
    if (input.author?.trim()) meta.author = input.author.trim();
    return { handle, displayName: host, creds: { secret: input.secret.trim() }, meta };
  },

  async post(account, input) {
    const webhookUrl = account.meta.webhookUrl;
    const secret = account.creds.secret;
    if (!webhookUrl || !secret) throw new Error("This autoblog account has no webhook URL or secret; add it again.");

    const title = input.title || firstLine(input.text);
    const slug = slugify(input.extra?.slug || title);
    const markdown = input.text;
    const html = renderMarkdown(markdown);
    const canonical = input.extra?.canonicalUrl?.trim();
    const siteUrl = account.meta.siteUrl;
    // A guest post's own URL is its source; an original's is its page on this blog.
    const url = canonical || (siteUrl ? `${siteUrl}/blog/${slug}` : `${new URL(webhookUrl).origin}/blog/${slug}`);
    const now = new Date().toISOString();
    const authorName = (input.extra?.author ?? account.meta.author)?.trim();
    const excerpt = input.extra?.description?.trim() || firstParagraph(markdown) || null;

    const post: Post = {
      id: input.extra?.id?.trim() || url,
      url,
      ...(canonical ? { canonical_url: canonical } : {}),
      title,
      slug,
      excerpt,
      html,
      markdown,
      status: input.extra?.draft === "true" ? "draft" : "published",
      published_at: input.extra?.date?.trim() || now,
      updated_at: now,
      author: authorName ? { name: authorName } : null,
      tags: tagsOf(input.extra?.tags),
      categories: tagsOf(input.extra?.categories),
      featured_image: null,
    };

    // CloudEvents source is the blog's own origin, so its event type is
    // namespaced to the receiver rather than to myna.
    const source = siteUrl || new URL(webhookUrl).origin;
    const event = buildEvent(post, { source });
    const result = await sendWebhook(webhookUrl, event, { secret });
    if (!result.ok) {
      throw new Error(`autoblog: ${webhookUrl} rejected the post (status ${result.status ?? "none"}${result.error ? `, ${result.error}` : ""})`);
    }
    return { id: post.id, url };
  },
};
