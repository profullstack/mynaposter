/**
 * The API under the site: mynaposter.com/api is the myna API.
 *
 * The site and the API are two services in one project, and the site is the
 * one with the domain. Anything under /api is handed to the API over the
 * project's private network with the prefix taken off, so
 * mynaposter.com/api/v1/accounts is the API's /v1/accounts and
 * mynaposter.com/api/mcp is its /api/mcp. One host, one certificate, no CORS
 * and no second DNS record to keep alive.
 */

/** Where the API listens, private. Railway's private network is IPv6, so the API binds `::`. */
export const DEFAULT_UPSTREAM = "http://mynaposter-api.railway.internal:8787";

/** The API path for a site path, or null when the request is not for the API. */
export function apiPath(pathname: string): string | null {
  if (pathname !== "/api" && !pathname.startsWith("/api/")) return null;
  const rest = pathname.slice("/api".length) || "/";
  // The API's own MCP door is /api/mcp, so /api/mcp on the site means that,
  // and so does /api/api/mcp, which is what a client with server=/api builds.
  if (rest === "/mcp" || rest === "/mcp/") return "/api/mcp";
  return rest;
}

const HOP = new Set(["host", "connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-connection"]);

/** Forward one request to the API and hand its answer back, streaming. */
export async function forward(request: Request, target: string, upstream = process.env.MYNA_API_UPSTREAM ?? DEFAULT_UPSTREAM): Promise<Response> {
  const incoming = new URL(request.url);
  const url = new URL(target + incoming.search, upstream);
  const headers = new Headers();
  for (const [key, value] of request.headers) if (!HOP.has(key.toLowerCase())) headers.set(key, value);
  headers.set("x-forwarded-host", incoming.host);
  headers.set("x-forwarded-proto", incoming.protocol.replace(":", ""));
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  let answer: Response;
  try {
    answer = await fetch(url, { method: request.method, headers, body, redirect: "manual" });
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: `The API is not answering: ${(error as Error).message}` }), {
      status: 502,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  const out = new Headers(answer.headers);
  for (const key of ["connection", "keep-alive", "transfer-encoding"]) out.delete(key);
  return new Response(answer.body, { status: answer.status, headers: out });
}
