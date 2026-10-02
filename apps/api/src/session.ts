/**
 * The browser's myna cloud session: the same account and the same kind of
 * token the CLI holds, carried in a cookie the page's script cannot read.
 *
 *   POST   /v1/cloud/session {email, password}   sign in, set the cookie
 *   DELETE /v1/cloud/session                     sign out, revoke the token
 *
 * The CLI keeps sending `Authorization: Bearer`, which wins when both are
 * present. The cookie is HttpOnly, Secure, SameSite=Strict and scoped to
 * /api, and it is honoured for reads only (GET and HEAD): every write the
 * API has still needs the bearer header, so a page somewhere else cannot
 * make a signed-in browser change anything, and the cookie alone can never
 * do more than read. The dashboard's one write, marking a card done, needs
 * no sign-in at all; the card's link is its permission.
 *
 * The house pattern is magic link + passkey. This is the existing email and
 * password sign-in reused for the browser, not a new auth system.
 */
import { Hono } from "hono";
import * as cloud from "./cloud.ts";

export const COOKIE = "myna_session";

/** Thirty days, then sign in again. The token itself is revoked on sign-out. */
export const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** The site serves the API under /api, so that is all the cookie needs to reach. */
export const COOKIE_PATH = "/api";

/** One cookie's value out of a Cookie header, or "" when it is not there. */
export function readCookie(header: string | undefined | null, name = COOKIE): string {
  if (!header) return "";
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at === -1) continue;
    if (part.slice(0, at).trim() !== name) continue;
    const value = part.slice(at + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return "";
}

export function sessionCookie(token: string, maxAge = MAX_AGE_SECONDS): string {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=${COOKIE_PATH}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearedCookie(): string {
  return `${COOKIE}=; Path=${COOKIE_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

interface RequestLike {
  method: string;
  header(name: string): string | undefined;
}

const READS = new Set(["GET", "HEAD"]);

/**
 * The caller's token: the bearer header when there is one, otherwise the
 * session cookie, and the cookie only on a read.
 */
export function tokenFrom(request: RequestLike): string {
  const header = request.header("authorization") ?? "";
  if (header.startsWith("Bearer ")) return header.slice(7);
  if (!READS.has(request.method.toUpperCase())) return "";
  return readCookie(request.header("cookie"));
}

export const sessionRoutes = new Hono();

sessionRoutes.post("/", async (context) => {
  const input = (await context.req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const { user, token } = await cloud.login(String(input.email ?? ""), String(input.password ?? ""), "web");
    context.header("set-cookie", sessionCookie(token));
    context.header("cache-control", "no-store");
    // The token goes in the cookie and nowhere else, so the page never holds it.
    return context.json({ ok: true, email: user.email });
  } catch (error) {
    return context.json({ ok: false, error: (error as Error).message }, 401);
  }
});

sessionRoutes.delete("/", async (context) => {
  const token = readCookie(context.req.header("cookie"));
  if (token) await cloud.logout(token);
  context.header("set-cookie", clearedCookie());
  context.header("cache-control", "no-store");
  return context.json({ ok: true });
});
