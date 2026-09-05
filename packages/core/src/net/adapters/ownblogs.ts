/**
 * Blogs you host yourself.
 *
 * Two shapes cover nearly every self-hosted blog that is not a CMS:
 *
 *   gitblog   a repository where a post is one Markdown file with frontmatter
 *             (a Next.js/Astro/Hugo-style `content/blog`). myna commits the
 *             file through the GitHub contents API, so nothing needs a local
 *             checkout and the site's own deploy takes it from there.
 *
 *   htmlblog  a directory of plain HTML pages served as-is, where writing the
 *             file is publishing. myna writes the next numbered page, lists
 *             it in index.html, rebuilds the feed, and pushes a mirror
 *             repository if the blog keeps one.
 *
 * Both are `explicitTarget`: they post only when named in `--to`, never as
 * part of `all`. A social post fanned out by accident is an embarrassment; a
 * blog page fanned out by accident is a publication and a commit.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, copyFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import type { Account, Network, PostInput, TimelineItem } from "../types.ts";
import { getJson, HttpError, request } from "../../util/http.ts";
import { escapeHtml, firstParagraph, renderMarkdown, slugify } from "../../util/markdown.ts";

const GITHUB = "https://api.github.com";

const firstLine = (text: string): string => text.split("\n")[0].replace(/^#+\s*/, "").trim().slice(0, 200);

/**
 * The body without the title line. The poster derives a title from the first
 * line when none is given, and a repository blog renders the title itself, so
 * leaving the line in would print it twice.
 */
export function bodyWithoutTitle(text: string, title: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const head = lines[0]?.replace(/^#+\s*/, "").trim();
  if (head && head === title.trim()) {
    return lines.slice(1).join("\n").replace(/^\s*\n/, "");
  }
  return text;
}

/** ISO 8601 to the second, the form static blogs stamp posts with. */
export function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, "Z");
}

/** The publish date: an explicit `--date`, else now. Never the future. */
export function publishDate(extra: Record<string, string> | undefined, now: Date = new Date()): Date {
  const raw = extra?.date?.trim();
  if (!raw) return now;
  const when = new Date(raw);
  if (Number.isNaN(when.getTime())) throw new Error(`--date ${JSON.stringify(raw)} is not a date.`);
  if (when.getTime() > now.getTime() + 60_000 && extra?.allowFuture !== "true") {
    throw new Error(`--date ${raw} is in the future. A future-dated post pins itself above every real one and some readers hide it. Pass --allow-future true if you mean it.`);
  }
  return when;
}

/** A frontmatter value, quoted only when a plain `key: value` line would misread it. */
export function yamlValue(value: string): string {
  const needsQuotes = /[:#"'{}\[\]|>&*!%@`,]/.test(value) || /^\s|\s$/.test(value) || value === "" || /^(true|false|null|yes|no|~)$/i.test(value) || /^[\d.+-]/.test(value);
  return needsQuotes ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;
}

export function frontmatter(fields: Record<string, string | string[] | boolean | undefined>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length) lines.push(`${key}: [${value.map(yamlValue).join(", ")}]`);
    } else if (typeof value === "boolean") {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${yamlValue(value)}`);
    }
  }
  return `---\n${lines.join("\n")}\n---\n`;
}

/** Parse "a, b, #c" into ["a", "b", "c"]. */
const tagList = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((tag) => tag.trim().replace(/^#/, ""))
    .filter(Boolean);

/** Find an executable on PATH, or the override in `env`. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env[`MYNA_${name.toUpperCase().replace(/-/g, "_")}`];
  if (override) return override === "none" ? undefined : override;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// gitblog
// ---------------------------------------------------------------------------

interface GitHubFile {
  name: string;
  path: string;
  sha: string;
  html_url: string;
  type: string;
}

/** The token to use: the one stored, else the environment, else `gh`. */
export function githubToken(stored: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (stored?.trim()) return stored.trim();
  const fromEnv = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (fromEnv) return fromEnv;
  const gh = findOnPath("gh", env);
  if (gh) {
    const result = spawnSync(gh, ["auth", "token"], { encoding: "utf8" });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  throw new Error("No GitHub token. Paste one at login, set GH_TOKEN, or sign in with `gh auth login`.");
}

const ghHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
});

const trimSlashes = (value: string) => value.replace(/^\/+|\/+$/g, "");

async function fileAt(repo: string, path: string, branch: string, token: string): Promise<GitHubFile | undefined> {
  try {
    return await getJson<GitHubFile>(`${GITHUB}/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`, { headers: ghHeaders(token) });
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return undefined;
    throw error;
  }
}

/** What a post to a gitblog account turns into, before anything is sent. */
export function gitblogFile(account: Account, input: PostInput, now: Date = new Date()): { path: string; slug: string; content: string; message: string } {
  const title = input.title || firstLine(input.text);
  const slug = slugify(input.extra?.slug || title);
  const ext = account.meta.ext || ".md";
  const date = publishDate(input.extra, now);
  const body = bodyWithoutTitle(input.text, title).trim();
  const description = input.extra?.description || firstParagraph(body);
  const head = frontmatter({
    title,
    date: date.toISOString().slice(0, 10),
    description,
    author: input.extra?.author || account.meta.author || undefined,
    tags: tagList(input.extra?.tags),
    draft: input.extra?.draft === "true" ? true : undefined,
  });
  return {
    path: `${trimSlashes(account.meta.dir)}/${slug}${ext}`,
    slug,
    content: `${head}\n${body}\n`,
    message: input.extra?.message || `blog: ${title}`,
  };
}

export const gitblog: Network = {
  id: "gitblog",
  name: "Git blog",
  category: "blog",
  blurb: "A repository blog: one Markdown file with frontmatter per post, committed through GitHub.",
  auth: {
    kind: "local",
    note:
      "The post is committed straight to the branch through the GitHub API, so the site's own deploy publishes it. " +
      "A fine-grained token needs Contents: read and write on the repository. Leave the token empty to use GH_TOKEN or `gh auth token`.",
    fields: [
      { key: "repo", label: "Repository", placeholder: "owner/name" },
      { key: "dir", label: "Posts directory", default: "content/blog", help: "Where a post file goes, relative to the repository root." },
      { key: "branch", label: "Branch", optional: true, help: "The repository's default branch when empty." },
      { key: "siteUrl", label: "Where posts appear", optional: true, placeholder: "https://example.com/blog", help: "The post's URL is this plus the slug. Leave empty to link to the commit." },
      { key: "author", label: "Author", optional: true, help: "Written into the frontmatter of every post." },
      { key: "token", label: "GitHub token", secret: true, optional: true },
    ],
  },
  caps: {
    charLimit: 0,
    mediaLimit: 0,
    threads: false,
    delete: true,
    timeline: true,
    notifications: false,
    stats: false,
    needsTitle: true,
    explicitTarget: true,
  },

  async login(input, ctx) {
    const repo = trimSlashes(input.repo?.trim() ?? "").replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Repository must be owner/name.");
    const token = githubToken(input.token);

    ctx.report(`Checking ${repo}…`);
    const info = await getJson<{ full_name: string; default_branch: string; permissions?: { push?: boolean }; html_url: string }>(
      `${GITHUB}/repos/${repo}`,
      { headers: ghHeaders(token) },
    );
    if (info.permissions && info.permissions.push === false) {
      throw new Error(`The token can read ${info.full_name} but cannot push to it.`);
    }
    const branch = input.branch?.trim() || info.default_branch;
    const dir = trimSlashes(input.dir?.trim() || "content/blog");
    const existing = await fileAt(repo, dir, branch, token);
    if (!existing) ctx.report(`${dir}/ does not exist on ${branch} yet; the first post creates it.`);

    return {
      handle: info.full_name,
      displayName: `${info.full_name} · ${dir}`,
      creds: (input.token?.trim() ? { token: input.token.trim() } : {}) as Record<string, string>,
      meta: {
        repo: info.full_name,
        branch,
        dir,
        siteUrl: (input.siteUrl ?? "").trim().replace(/\/+$/, ""),
        author: (input.author ?? "").trim(),
        ext: ".md",
        htmlUrl: info.html_url,
      },
    };
  },

  async post(account, input) {
    const token = githubToken(account.creds.token);
    const { repo, branch } = account.meta;
    const file = gitblogFile(account, input);

    const existing = await fileAt(repo, file.path, branch, token);
    if (existing && input.extra?.overwrite !== "true") {
      throw new Error(`${file.path} already exists on ${branch}. Pass --slug <other> or --overwrite true.`);
    }

    const response = await request(`${GITHUB}/repos/${repo}/contents/${file.path}`, {
      method: "PUT",
      headers: { ...ghHeaders(token), "content-type": "application/json" },
      body: JSON.stringify({
        message: file.message,
        content: Buffer.from(file.content, "utf8").toString("base64"),
        branch,
        ...(existing ? { sha: existing.sha } : {}),
      }),
    });
    const created = (await response.json()) as { content?: GitHubFile; commit?: { html_url?: string } };
    const url = account.meta.siteUrl ? `${account.meta.siteUrl}/${file.slug}` : created.commit?.html_url ?? created.content?.html_url;
    return { id: file.path, url };
  },

  async remove(account, id) {
    const token = githubToken(account.creds.token);
    const { repo, branch } = account.meta;
    const existing = await fileAt(repo, id, branch, token);
    if (!existing) throw new Error(`${id} is not on ${branch}.`);
    await request(`${GITHUB}/repos/${repo}/contents/${id}`, {
      method: "DELETE",
      headers: { ...ghHeaders(token), "content-type": "application/json" },
      body: JSON.stringify({ message: `blog: remove ${basename(id)}`, sha: existing.sha, branch }),
    });
  },

  async timeline(account, limit) {
    const token = githubToken(account.creds.token);
    const { repo, branch, dir } = account.meta;
    let files: GitHubFile[];
    try {
      files = await getJson<GitHubFile[]>(`${GITHUB}/repos/${repo}/contents/${dir}?ref=${encodeURIComponent(branch)}`, { headers: ghHeaders(token) });
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return [];
      throw error;
    }
    return files
      .filter((file) => file.type === "file")
      .sort((a, b) => b.name.localeCompare(a.name))
      .slice(0, limit)
      .map((file): TimelineItem => {
        const slug = file.name.replace(/\.[^.]+$/, "");
        return {
          id: file.path,
          author: account.displayName ?? account.handle,
          handle: account.handle,
          text: slug,
          createdAt: "",
          url: account.meta.siteUrl ? `${account.meta.siteUrl}/${slug}` : file.html_url,
        };
      });
  },
};

// ---------------------------------------------------------------------------
// htmlblog
// ---------------------------------------------------------------------------

const POST_FILE = /^(\d+)-post\.html$/;

interface HtmlBlogConfig {
  siteTitle?: string | null;
  author?: string | null;
  disclosure?: string | null;
}

/** The optional `blog.config.json` beside the posts: site title, byline, disclosure. */
function readBlogConfig(dir: string): HtmlBlogConfig {
  const path = join(dir, "blog.config.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as HtmlBlogConfig;
  } catch {
    return {};
  }
}

/** The next NNN, zero-padded to the width the blog already uses. */
export function nextPostNumber(names: string[]): string {
  let max = 0;
  let width = 3;
  for (const name of names) {
    const match = POST_FILE.exec(name);
    if (!match) continue;
    max = Math.max(max, Number(match[1]));
    width = Math.max(width, match[1].length);
  }
  return String(max + 1).padStart(width, "0");
}

/** A whole page in the shape the plain-HTML blog uses. */
export function renderHtmlPost(
  post: { title: string; description: string; date: string; body: string },
  config: HtmlBlogConfig = {},
): string {
  const day = post.date.slice(0, 10);
  const site = config.siteTitle ? ` &mdash; ${escapeHtml(config.siteTitle)}` : "";
  const byline = config.author ? `<p><em>${day}, by ${escapeHtml(config.author)}.</em></p>` : `<p><em>${day}</em></p>`;
  const disclosure = config.disclosure ? `\n\n<p><small>${config.disclosure}</small></p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(post.title)}${site}</title>
<link rel="alternate" type="application/rss+xml" href="feed.xml">
<meta name="date" content="${escapeHtml(post.date)}">
<meta name="description" content="${escapeHtml(post.description)}">
</head>
<body>

<article>

<h1>${escapeHtml(post.title)}</h1>

${byline}${disclosure}

<nav>
	<a href="../blog">back to my blog postings</a>
</nav>

${post.body}

<nav>
	<a href="../blog">back to my blog postings</a>
</nav>

</article>

</body>
</html>
`;
}

/** Splice a post into index.html's first list, newest first. */
export function insertIntoIndex(html: string, post: { file: string; title: string; date: string }): string {
  if (html.includes(`href="${post.file}"`)) return html;
  const open = html.indexOf("<ul>");
  if (open === -1) return html;
  const at = open + "<ul>".length;
  const li = `\t<li><a href="${post.file}">${escapeHtml(post.title)}</a> &mdash; ${post.date.slice(0, 10)}</li>`;
  return `${html.slice(0, at)}\n${li}${html.slice(at)}`;
}

function runQuiet(command: string, args: string[], cwd: string): { ok: boolean; output: string } {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { ok: result.status === 0, output: result.error ? result.error.message : output };
}

/**
 * Write the post with the blog's own tool when it has one.
 *
 * `blog-post` (profullstack/cli-tools) knows the blog's byline, identity links
 * and analytics tags from its config; a page written by it is identical to
 * one written by hand. When it is not installed, myna writes the page itself
 * in the same shape, minus what only that config knows.
 */
function writeWithBlogPost(tool: string, dir: string, post: { title: string; description: string; date: string; body: string }): string {
  const scratch = mkdtempSync(join(tmpdir(), "myna-blog-"));
  const bodyFile = join(scratch, "body.html");
  writeFileSync(bodyFile, post.body);
  const result = runQuiet(tool, ["new", post.title, "--description", post.description, "--body", bodyFile, "--date", post.date, "--dir", dir], dir);
  if (!result.ok) throw new Error(`blog-post failed: ${result.output || "no output"}`);
  const created = /created\s+(\S+-post\.html)/.exec(result.output);
  if (!created) throw new Error(`blog-post did not say which file it created:\n${result.output}`);
  return created[1];
}

function writeNatively(dir: string, post: { title: string; description: string; date: string; body: string }): string {
  const file = `${nextPostNumber(readdirSync(dir))}-post.html`;
  // 'wx': two writers that both read the directory would pick the same number.
  writeFileSync(join(dir, file), renderHtmlPost(post, readBlogConfig(dir)), { flag: "wx" });
  const indexPath = join(dir, "index.html");
  if (existsSync(indexPath)) {
    writeFileSync(indexPath, insertIntoIndex(readFileSync(indexPath, "utf8"), { file, title: post.title, date: post.date }));
  }
  const feedScript = join(dir, "build-feed.mjs");
  if (existsSync(feedScript)) {
    const result = runQuiet(process.execPath, [feedScript], dir);
    if (!result.ok) throw new Error(`${file} is written, but build-feed.mjs failed: ${result.output}`);
  }
  return file;
}

/** Copy the changed files into the mirror checkout, commit, push. */
function pushMirror(dir: string, mirror: string, files: string[], message: string): string {
  const changed = files.filter((file) => existsSync(join(dir, file)));
  for (const file of changed) copyFileSync(join(dir, file), join(mirror, file));
  const steps: [string, string[]][] = [
    ["git", ["add", "--", ...changed]],
    ["git", ["commit", "-q", "-m", message]],
    ["git", ["push", "-q"]],
  ];
  for (const [command, args] of steps) {
    const result = runQuiet(command, args, mirror);
    if (!result.ok) return `mirror ${args[0]} failed in ${mirror}: ${result.output}`;
  }
  return "";
}

export const htmlblog: Network = {
  id: "htmlblog",
  name: "HTML blog",
  category: "blog",
  blurb: "A directory of plain HTML pages, where writing the file is publishing. Optional mirror repository.",
  auth: {
    kind: "local",
    note:
      "Posts are NNN-post.html files beside an index.html; the feed is rebuilt by the blog's own build-feed.mjs when it has one. " +
      "If profullstack/cli-tools' `blog-post` is installed the page is written by it, byline and all.",
    fields: [
      { key: "dir", label: "Blog directory", default: join(homedir(), "public_html", "blog") },
      { key: "siteUrl", label: "Where it is served", placeholder: "https://example.com/~you/blog", help: "The post's URL is this plus the file name." },
      { key: "mirror", label: "Mirror repository", optional: true, help: "A checkout to copy each post into, commit and push. Leave empty for none." },
    ],
  },
  caps: {
    charLimit: 0,
    mediaLimit: 0,
    threads: false,
    delete: false,
    timeline: true,
    notifications: false,
    stats: false,
    needsTitle: true,
    explicitTarget: true,
  },

  async login(input, ctx) {
    const dir = resolve((input.dir ?? "").trim().replace(/^~(?=$|\/)/, homedir()) || join(homedir(), "public_html", "blog"));
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`${dir} is not a directory.`);
    if (!existsSync(join(dir, "index.html"))) ctx.report(`${dir} has no index.html; posts will not be listed anywhere until it exists.`);
    const siteUrl = (input.siteUrl ?? "").trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(siteUrl)) throw new Error("Where it is served must be a full URL.");

    const mirror = (input.mirror ?? "").trim().replace(/^~(?=$|\/)/, homedir());
    if (mirror) {
      const path = resolve(mirror);
      if (!existsSync(join(path, ".git"))) throw new Error(`${path} is not a repository checkout.`);
    }
    const tool = findOnPath("blog-post");
    ctx.report(tool ? `Pages will be written by ${tool}.` : "blog-post is not installed; myna writes pages itself.");

    const url = new URL(siteUrl);
    return {
      handle: `${url.host}${url.pathname.replace(/\/+$/, "")}`,
      displayName: readBlogConfig(dir).siteTitle ?? basename(dir),
      creds: {},
      meta: { dir, siteUrl, mirror: mirror ? resolve(mirror) : "" },
    };
  },

  async post(account, input) {
    const { dir, siteUrl, mirror } = account.meta;
    const title = input.title || firstLine(input.text);
    const date = isoSeconds(publishDate(input.extra));
    const markdown = bodyWithoutTitle(input.text, title).trim();
    const description = input.extra?.description || firstParagraph(markdown);
    if (!description) throw new Error("A post needs a description for the feed. Write a first paragraph, or pass --description.");
    const post = { title, description, date, body: renderMarkdown(markdown) };

    const tool = findOnPath("blog-post");
    const file = tool ? writeWithBlogPost(tool, dir, post) : writeNatively(dir, post);
    const url = `${siteUrl}/${file}`;

    if (mirror) {
      const problem = pushMirror(dir, mirror, [file, "index.html", "feed.xml"], `${file.replace(/-post\.html$/, "")}: ${title}`);
      // The page is live either way; a mirror that did not take it is a
      // warning, not a failed post.
      if (problem) process.stderr.write(`${url} is published, but ${problem}\n`);
    }
    return { id: file, url };
  },

  async timeline(account, limit) {
    const { dir, siteUrl } = account.meta;
    return readdirSync(dir)
      .filter((name) => POST_FILE.test(name))
      .sort((a, b) => Number(POST_FILE.exec(b)![1]) - Number(POST_FILE.exec(a)![1]))
      .slice(0, limit)
      .map((name): TimelineItem => {
        const html = readFileSync(join(dir, name), "utf8");
        const title = /<h1>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? /<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? name;
        const date = /<meta name="date" content="([^"]*)"/.exec(html)?.[1] ?? "";
        return {
          id: name,
          author: account.displayName ?? account.handle,
          handle: account.handle,
          text: title.replace(/<[^>]+>/g, "").replace(/&mdash;/g, "—").trim(),
          createdAt: date,
          url: `${siteUrl}/${name}`,
        };
      });
  },
};
