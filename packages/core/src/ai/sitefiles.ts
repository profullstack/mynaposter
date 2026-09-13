/**
 * What a site says about itself, before its HTML is read.
 *
 * A directory reads a publisher's own files instead of scraping it, and a
 * writer should too: `/.well-known/openprofile.md` (https://logicsrc.com/openprofile)
 * is who the site is and where else it lives, `/llms.txt` is what the site
 * wants a model to know. Both are fetched from the origin of the page, both
 * are optional, and a missing one is absent rather than an error.
 */

export interface SiteFiles {
  origin: string;
  /** The OpenProfile.md text, or null when the site serves none. */
  openprofile: string | null;
  /** The llms.txt text, or null. */
  llms: string | null;
  /** Which of the two answered, in the order they were read. */
  readFrom: Array<"openprofile" | "llms">;
}

/** Enough for a profile or an llms.txt; a file past this is cut, not refused. */
export const MAX_SITE_FILE = 16_000;

const HTML = /^\s*<(!doctype|html|head|body)/i;

/** An OpenProfile.md starts with a heading and has at least one section or the identity block. */
export function looksLikeOpenProfile(text: string): boolean {
  if (!text || HTML.test(text)) return false;
  const head = text.slice(0, 400);
  return /^#\s+\S/m.test(head) && (/^##\s+\S/m.test(text) || /^(Web|Kind|Name|Handle):/m.test(text));
}

/** llms.txt is Markdown: a title, usually a blockquote summary, and links. Never HTML. */
export function looksLikeLlms(text: string): boolean {
  if (!text || HTML.test(text)) return false;
  return /^#\s+\S/m.test(text.slice(0, 400));
}

async function readText(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<string | null> {
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "text/markdown, text/plain;q=0.9, */*;q=0.1", "user-agent": "myna (+https://mynaposter.com)" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
    if (!response.ok) return null;
    const type = response.headers.get("content-type") ?? "";
    if (/json|image|octet-stream/i.test(type)) return null;
    const text = await response.text();
    return text.slice(0, MAX_SITE_FILE);
  } catch {
    return null;
  }
}

/** Read both files from the page's origin. Neither is required; neither error is raised. */
export async function readSiteFiles(pageUrl: string, fetchImpl: typeof fetch = fetch, timeoutMs = 8_000): Promise<SiteFiles> {
  const target = /^https?:\/\//.test(pageUrl) ? pageUrl : `https://${pageUrl}`;
  const origin = new URL(target).origin;
  const [profile, llms] = await Promise.all([
    readText(`${origin}/.well-known/openprofile.md`, fetchImpl, timeoutMs),
    readText(`${origin}/llms.txt`, fetchImpl, timeoutMs),
  ]);
  const files: SiteFiles = { origin, openprofile: null, llms: null, readFrom: [] };
  if (profile && looksLikeOpenProfile(profile)) {
    files.openprofile = profile;
    files.readFrom.push("openprofile");
  }
  if (llms && looksLikeLlms(llms)) {
    files.llms = llms;
    files.readFrom.push("llms");
  }
  return files;
}
