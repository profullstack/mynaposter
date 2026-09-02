/**
 * The mynaposter.com marketing site.
 *
 * Static files with a tiny server in front, because the site is four pages and
 * a stylesheet. No framework, no build step, no client-side JavaScript beyond
 * the copy button.
 */
import { join, extname, normalize } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "public");
const port = Number(process.env.PORT ?? 3000);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".json": "application/json",
};

/** Resolve a URL path to a file, refusing anything that escapes the root. */
function resolve(pathname: string): string | null {
  const clean = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  let candidate = join(root, clean);
  if (!candidate.startsWith(root)) return null;

  if (existsSync(candidate) && statSync(candidate).isDirectory()) candidate = join(candidate, "index.html");
  if (existsSync(candidate)) return candidate;

  // Extensionless URLs map to .html, so /docs serves docs.html.
  const asHtml = `${candidate}.html`;
  return existsSync(asHtml) ? asHtml : null;
}

const server = Bun.serve({
  port,
  fetch(request) {
    const url = new URL(request.url);
    const file = resolve(url.pathname);

    if (!file) {
      const notFound = join(root, "404.html");
      return new Response(existsSync(notFound) ? readFileSync(notFound) : "Not found", {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    const type = TYPES[extname(file)] ?? "application/octet-stream";
    // Assets are content-addressed by name; HTML is not, so it revalidates.
    const cache = type.startsWith("text/html") ? "public, max-age=0, must-revalidate" : "public, max-age=31536000, immutable";

    return new Response(readFileSync(file), {
      headers: {
        "content-type": type,
        "cache-control": cache,
        "x-content-type-options": "nosniff",
        "referrer-policy": "strict-origin-when-cross-origin",
        "content-security-policy":
          "default-src 'none'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'",
      },
    });
  },
});

console.log(`mynaposter.com on :${server.port}`);
