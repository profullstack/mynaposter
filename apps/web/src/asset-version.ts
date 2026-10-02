/**
 * Cache-busting for the site's own CSS and JS.
 *
 * The server sends every non-HTML file as immutable for a year, so a changed
 * site.css or handoff.js must reach a returning browser under a new URL. The
 * build runs every HTML page it writes through this: each same-origin
 * `href="/x.css"` or `src="/x.js"` without a query gets `?v=<hash>` of that
 * file's bytes. A reference that already carries a query is left alone.
 */
import { createHash } from "node:crypto";

const REF = /\b(href|src)="\/([A-Za-z0-9_\-/.]+\.(?:css|js))"/g;

export function hashFile(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 10);
}

/** `versionOf(path)` returns the hash for `/path`, or null when there is no such file. */
export function versionAssets(html: string, versionOf: (path: string) => string | null): string {
  return html.replace(REF, (whole, attr: string, path: string) => {
    const v = versionOf(path);
    return v ? `${attr}="/${path}?v=${v}"` : whole;
  });
}
