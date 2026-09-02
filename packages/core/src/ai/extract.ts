/**
 * Turning a pasted link into something worth writing about.
 *
 * Reading the page beats guessing from the URL, so this fetches it. Some sites
 * refuse anything that is not a browser; for those, r.jina.ai returns the
 * rendered text and is tried second rather than first.
 */
import { request } from "../util/http.ts";

export interface PageSummary {
  url: string;
  title: string;
  description: string;
  siteName: string;
  author: string;
  /** Body text, already stripped and capped. */
  text: string;
  /** og:image, when the page declares one. */
  image: string;
}

const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

const MAX_TEXT = 8000;

function meta(html: string, ...names: string[]): string {
  for (const name of names) {
    const pattern = new RegExp(
      `<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']|` +
        `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`,
      "i",
    );
    const match = html.match(pattern);
    const value = match?.[1] ?? match?.[2];
    if (value) return decode(value.trim());
  }
  return "";
}

function decode(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

/** Strip a page to readable prose, dropping the furniture that adds no meaning. */
function readable(html: string): string {
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(nav|header|footer|aside|form|svg)[\s\S]*?<\/\1>/gi, " ");

  // Prefer the article body when the page marks one up.
  const article = body.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1] ?? body;

  return decode(
    article
      .replace(/<\/(p|div|li|h[1-6]|br)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n\s*\n+/g, "\n\n")
      .trim(),
  ).slice(0, MAX_TEXT);
}

export async function fetchPage(url: string): Promise<PageSummary> {
  const target = /^https?:\/\//.test(url) ? url : `https://${url}`;
  let html = "";

  try {
    const response = await request(target, {
      headers: { "user-agent": BROWSER_UA, accept: "text/html,application/xhtml+xml" },
      timeoutMs: 20_000,
    });
    html = await response.text();
  } catch {
    // Sites that block non-browser clients still read fine through Jina.
    const response = await request(`https://r.jina.ai/${target}`, { timeoutMs: 30_000 });
    const text = await response.text();
    return {
      url: target,
      title: text.match(/^Title:\s*(.+)$/m)?.[1]?.trim() ?? new URL(target).hostname,
      description: "",
      siteName: new URL(target).hostname,
      author: "",
      text: text.slice(0, MAX_TEXT),
      image: "",
    };
  }

  const title =
    meta(html, "og:title", "twitter:title") || decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "");

  return {
    url: target,
    title: title || new URL(target).hostname,
    description: meta(html, "og:description", "twitter:description", "description"),
    siteName: meta(html, "og:site_name") || new URL(target).hostname,
    author: meta(html, "author", "article:author"),
    text: readable(html),
    image: meta(html, "og:image", "twitter:image"),
  };
}
