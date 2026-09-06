/**
 * The two self-hosted blog networks.
 *
 * gitblog is exercised against a fake GitHub contents API; htmlblog against
 * a real temporary directory, with blog-post disabled so the native writer
 * is what runs. Neither touches the network or the real blog.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gitblog,
  htmlblog,
  gitblogFile,
  frontmatter,
  yamlValue,
  bodyWithoutTitle,
  publishDate,
  nextPostNumber,
  insertIntoIndex,
  renderHtmlPost,
  postUrl,
} from "../src/net/adapters/ownblogs.ts";
import { getNetwork, authSummary } from "../src/net/registry.ts";
import { tailor } from "../src/core/poster.ts";
import type { Account } from "../src/net/types.ts";

const gitAccount: Account = {
  id: "gitblog:profullstack/hqtui",
  network: "gitblog",
  handle: "profullstack/hqtui",
  addedAt: new Date().toISOString(),
  creds: { token: "ghp_test" },
  meta: { repo: "profullstack/hqtui", branch: "main", dir: "apps/web/content/blog", siteUrl: "https://hqtui.com/blog", author: "Anthony Ettinger", ext: ".md" },
};

test("both are registered, reachable by alias, and never part of `all`", () => {
  expect(getNetwork("gitblog")?.id).toBe("gitblog");
  expect(getNetwork("repo")?.id).toBe("gitblog");
  expect(getNetwork("htmlblog")?.id).toBe("htmlblog");
  expect(getNetwork("static")?.id).toBe("htmlblog");
  expect(gitblog.caps.explicitTarget).toBe(true);
  expect(htmlblog.caps.explicitTarget).toBe(true);
  expect(gitblog.caps.needsTitle).toBe(true);
  expect(htmlblog.caps.needsTitle).toBe(true);
});

test("a local target is described as files, not a login", () => {
  expect(gitblog.auth.kind).toBe("local");
  expect(authSummary(gitblog)).toBe("files on this machine");
  // The GitHub token is optional: GH_TOKEN or `gh auth token` fills it.
  expect(gitblog.auth.fields.find((field) => field.key === "token")?.optional).toBe(true);
});

test("a long post is never truncated or threaded", () => {
  const long = "word ".repeat(2000).trim();
  expect(tailor("gitblog", { text: long, thread: true })).toEqual([long]);
  expect(tailor("htmlblog", { text: long, thread: true })).toEqual([long]);
});

test("frontmatter quotes only what a plain key: value line would misread", () => {
  expect(yamlValue("The board behind Discussions")).toBe("The board behind Discussions");
  expect(yamlValue("Note: quotes")).toBe('"Note: quotes"');
  expect(yamlValue('He said "hi"')).toBe('"He said \\"hi\\""');
  expect(yamlValue("2026-09-05")).toBe('"2026-09-05"');
  expect(frontmatter({ title: "Plain", date: "2026-09-05", tags: ["a", "b c"], draft: true, author: undefined, description: "" })).toBe(
    '---\ntitle: Plain\ndate: "2026-09-05"\ntags: [a, b c]\ndraft: true\n---\n',
  );
});

test("the title line is dropped from the body only when it is the title", () => {
  expect(bodyWithoutTitle("# Hello\n\nBody.", "Hello")).toBe("Body.");
  expect(bodyWithoutTitle("Hello\n\nBody.", "Hello")).toBe("Body.");
  expect(bodyWithoutTitle("Something else\n\nBody.", "Hello")).toBe("Something else\n\nBody.");
});

test("a future date is refused unless asked for", () => {
  const now = new Date("2026-09-05T12:00:00Z");
  expect(publishDate(undefined, now)).toBe(now);
  expect(publishDate({ date: "2026-09-01" }, now).toISOString()).toBe("2026-09-01T00:00:00.000Z");
  expect(() => publishDate({ date: "2026-12-01" }, now)).toThrow(/future/);
  expect(publishDate({ date: "2026-12-01", allowFuture: "true" }, now).toISOString()).toBe("2026-12-01T00:00:00.000Z");
  expect(() => publishDate({ date: "yesterday-ish" }, now)).toThrow(/not a date/);
});

test("a gitblog post is one markdown file with frontmatter, under the posts directory", () => {
  const file = gitblogFile(
    gitAccount,
    { text: "The board is on tsbb 0.2.0\n\nForums can now be filled from RSS.\n\n## What changed\n\nThings.", title: "The board is on tsbb 0.2.0", extra: { tags: "tsbb, release" } },
    new Date("2026-09-05T12:00:00Z"),
  );
  expect(file.path).toBe("apps/web/content/blog/the-board-is-on-tsbb-0-2-0.md");
  expect(file.slug).toBe("the-board-is-on-tsbb-0-2-0");
  expect(file.message).toBe("blog: The board is on tsbb 0.2.0");
  expect(file.content).toBe(
    [
      "---",
      "title: The board is on tsbb 0.2.0",
      'date: "2026-09-05"',
      "description: Forums can now be filled from RSS.",
      "author: Anthony Ettinger",
      "tags: [tsbb, release]",
      "---",
      "",
      "Forums can now be filled from RSS.",
      "",
      "## What changed",
      "",
      "Things.",
      "",
    ].join("\n"),
  );
});

test("gitblog commits through the contents API and links to the site", async () => {
  const calls: { method: string; url: string; body?: Record<string, unknown> }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url: String(url), body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined });
    if (method === "GET") return new Response("Not Found", { status: 404 });
    return new Response(JSON.stringify({ content: { path: "apps/web/content/blog/hello.md", html_url: "https://github.com/x" }, commit: { html_url: "https://github.com/x/commit/1" } }), { status: 201 });
  }) as typeof fetch;
  try {
    const result = await gitblog.post(gitAccount, { text: "Hello\n\nA body.", title: "Hello" });
    expect(result).toEqual({ id: "apps/web/content/blog/hello.md", url: "https://hqtui.com/blog/hello" });
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://api.github.com/repos/profullstack/hqtui/contents/apps/web/content/blog/hello.md?ref=main");
    expect(calls[1].method).toBe("PUT");
    expect(calls[1].body?.branch).toBe("main");
    expect(calls[1].body?.message).toBe("blog: Hello");
    expect(Buffer.from(String(calls[1].body?.content), "base64").toString("utf8")).toContain("title: Hello");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("gitblog refuses to overwrite a post that already exists", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ sha: "abc", path: "x", name: "x", type: "file", html_url: "" }), { status: 200 })) as unknown as typeof fetch;
  try {
    await expect(gitblog.post(gitAccount, { text: "Hello\n\nA body.", title: "Hello" })).rejects.toThrow(/already exists/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- htmlblog against a real directory ---------------------------------------

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myna-htmlblog-"));
  writeFileSync(join(dir, "041-post.html"), '<!doctype html><html><head><title>Old</title><meta name="date" content="2026-09-01T10:00:00Z"></head><body><h1>Old post</h1></body></html>');
  writeFileSync(join(dir, "index.html"), "<html><body><h1>Blog</h1>\n<ul>\n\t<li><a href=\"041-post.html\">Old post</a> &mdash; 2026-09-01</li>\n</ul>\n</body></html>");
  writeFileSync(join(dir, "build-feed.mjs"), 'import { writeFileSync } from "node:fs"; writeFileSync("feed.xml", "<rss/>");');
  process.env.MYNA_BLOG_POST = "none";
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MYNA_BLOG_POST;
});

const htmlAccount = (mirror = ""): Account => ({
  id: "htmlblog:example.com/~me/blog",
  network: "htmlblog",
  handle: "example.com/~me/blog",
  addedAt: new Date().toISOString(),
  creds: {},
  meta: { dir, siteUrl: "https://example.com/~me/blog", mirror },
});

test("numbers continue the sequence at the blog's width", () => {
  expect(nextPostNumber(["041-post.html", "index.html", "009-post.html"])).toBe("042");
  expect(nextPostNumber([])).toBe("001");
  expect(nextPostNumber(["0100-post.html"])).toBe("0101");
});

test("index insertion is idempotent and lands at the top", () => {
  const once = insertIntoIndex("<ul>\n\t<li>old</li>\n</ul>", { file: "002-post.html", title: "New & shiny", date: "2026-09-05T00:00:00Z" });
  expect(once).toBe('<ul>\n\t<li><a href="002-post.html">New &amp; shiny</a> &mdash; 2026-09-05</li>\n\t<li>old</li>\n</ul>');
  expect(insertIntoIndex(once, { file: "002-post.html", title: "New & shiny", date: "2026-09-05T00:00:00Z" })).toBe(once);
});

test("a page has the date and description the feed needs, and no h1 in the body", () => {
  const html = renderHtmlPost({ title: "A & B", description: 'Say "hi"', date: "2026-09-05T12:00:00Z", body: "<p>x</p>" }, { siteTitle: "Mine", author: "Me" });
  expect(html).toContain('<meta name="date" content="2026-09-05T12:00:00Z">');
  expect(html).toContain('<meta name="description" content="Say &quot;hi&quot;">');
  expect(html).toContain("<title>A &amp; B &mdash; Mine</title>");
  expect(html).toContain("<h1>A &amp; B</h1>");
  expect(html).toContain("<p><em>2026-09-05, by Me.</em></p>");
  expect(html).toContain("<p>x</p>");
});

test("htmlblog writes the next page, lists it, rebuilds the feed, and links to it", async () => {
  const result = await htmlblog.post(htmlAccount(), {
    text: "Hello world\n\nA first paragraph that becomes the description.\n\n## More\n\nWith `code`.",
    title: "Hello world",
  });
  expect(result).toEqual({ id: "042-post.html", url: "https://example.com/~me/blog/042-post.html" });
  const page = readFileSync(join(dir, "042-post.html"), "utf8");
  expect(page).toContain("<h1>Hello world</h1>");
  expect(page).toContain('<meta name="description" content="A first paragraph that becomes the description.">');
  expect(page).toContain("<h3>More</h3>");
  expect(page).toContain("With <code>code</code>.");
  expect(page).not.toContain("<h2>Hello world");
  expect(readFileSync(join(dir, "index.html"), "utf8")).toContain('<li><a href="042-post.html">Hello world</a>');
  expect(existsSync(join(dir, "feed.xml"))).toBe(true);
  expect(readdirSync(dir).filter((name) => name.endsWith("-post.html"))).toHaveLength(2);
});

test("htmlblog needs a description, and says how to give one", async () => {
  await expect(htmlblog.post(htmlAccount(), { text: "Only a title", title: "Only a title" })).rejects.toThrow(/--description/);
});

test("the timeline reads titles and dates back off the pages", async () => {
  await htmlblog.post(htmlAccount(), { text: "Newer\n\nBody.", title: "Newer" });
  const items = await htmlblog.timeline!(htmlAccount(), 10);
  expect(items.map((item) => item.text)).toEqual(["Newer", "Old post"]);
  expect(items[1].createdAt).toBe("2026-09-01T10:00:00Z");
  expect(items[0].url).toBe("https://example.com/~me/blog/042-post.html");
});

test("login checks the directory and the URL", async () => {
  const ctx = { report() {}, async openUrl() {} };
  await expect(htmlblog.login({ dir: join(dir, "missing"), siteUrl: "https://x.y/blog" }, ctx)).rejects.toThrow(/not a directory/);
  await expect(htmlblog.login({ dir, siteUrl: "x.y/blog" }, ctx)).rejects.toThrow(/full URL/);
  await expect(htmlblog.login({ dir, siteUrl: "https://x.y/blog", mirror: join(dir, "nope") }, ctx)).rejects.toThrow(/not a repository/);
  const account = await htmlblog.login({ dir, siteUrl: "https://x.y/blog/" }, ctx);
  expect(account.handle).toBe("x.y/blog");
  expect(account.meta.dir).toBe(dir);
  expect(account.meta.siteUrl).toBe("https://x.y/blog");
});

/* ------------------------------------------------------------- canonical --- */

test("a page points at itself, so the copies on dev.to agree with the original", async () => {
  const result = await htmlblog.post(htmlAccount(), { text: "Hello\n\nBody text.", title: "Hello" });
  const page = readFileSync(join(dir, "042-post.html"), "utf8");
  expect(page).toContain('<link rel="canonical" href="https://example.com/~me/blog/042-post.html">');
  // The canonical has to be the URL, not merely a URL for the same page.
  expect(page).toContain(`<link rel="canonical" href="${result.url}">`);
});

test("an explicit canonical wins, for a post first published elsewhere", async () => {
  await htmlblog.post(htmlAccount(), {
    text: "Hello\n\nBody text.",
    title: "Hello",
    extra: { canonicalUrl: "https://elsewhere.example/original" },
  });
  const page = readFileSync(join(dir, "042-post.html"), "utf8");
  expect(page).toContain('<link rel="canonical" href="https://elsewhere.example/original">');
  expect(page).not.toContain("example.com/~me/blog/042-post.html\">");
});

test("a blog with no siteUrl claims no canonical rather than guessing one", () => {
  const page = renderHtmlPost({ title: "T", description: "d", date: "2026-01-01T00:00:00Z", body: "<p>x</p>" });
  expect(page).not.toContain("rel=\"canonical\"");
});

test("the canonical URL is escaped rather than trusted", () => {
  const page = renderHtmlPost({
    title: "T",
    description: "d",
    date: "2026-01-01T00:00:00Z",
    body: "<p>x</p>",
    canonical: 'https://x.y/"><script>alert(1)</script>',
  });
  expect(page).not.toContain("<script>alert(1)</script>");
});

test("a trailing slash on siteUrl does not double up in the URL or the canonical", () => {
  expect(postUrl("https://x.y/blog/", "007-post.html")).toBe("https://x.y/blog/007-post.html");
  expect(postUrl("https://x.y/blog", "007-post.html")).toBe("https://x.y/blog/007-post.html");
  expect(postUrl("https://x.y/blog///", "007-post.html")).toBe("https://x.y/blog/007-post.html");
});

test("gitblog records the canonical in frontmatter, and omits it when absent", () => {
  const account = {
    id: "gitblog:o/r",
    network: "gitblog",
    handle: "o/r",
    addedAt: "",
    creds: {},
    meta: { repo: "o/r", dir: "content/blog", branch: "main", ext: ".md", author: "" },
  } as unknown as Account;

  const withUrl = gitblogFile(account, {
    text: "Title\n\nBody.",
    title: "Title",
    extra: { canonicalUrl: "https://example.com/blog/x.html" },
  });
  // Quoted, because a bare value holding a colon is not the string YAML reads back.
  expect(withUrl.content).toContain('canonical: "https://example.com/blog/x.html"');

  const without = gitblogFile(account, { text: "Title\n\nBody.", title: "Title" });
  expect(without.content).not.toContain("canonical:");
});
