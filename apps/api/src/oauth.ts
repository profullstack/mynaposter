/** OAuth 2.1 authorization code + PKCE and RFC 8628 device authorization for myna CLI. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import type postgres from "postgres";
import { db, hasDatabase } from "./db/index.ts";
import * as cloud from "./cloud.ts";
import { hashToken, newToken } from "./credentials.ts";
import { readCookie } from "./session.ts";

export const CLI_CLIENT_ID = "myna-cli";
export const ACCESS_TOKEN_SECONDS = 15 * 60;
export const DEVICE_CODE_SECONDS = 15 * 60;
export const DEVICE_POLL_SECONDS = 5;

type TokenReply = { access_token: string; token_type: "Bearer"; expires_in: number; refresh_token: string; email: string };
type AuthRequest = {
  id: string;
  csrf_hash: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state: string;
  login_hint: string;
  expires_at: Date;
};

const oauthRoutes = new Hono();
let lastCleanupAt = 0;
oauthRoutes.use("*", async (context, next) => {
  if (!hasDatabase()) return context.json({ error: "OAuth sign-in is unavailable: this instance has no database." }, 503);
  context.header("cache-control", "no-store");
  context.header("pragma", "no-cache");
  if (Date.now() - lastCleanupAt > 15 * 60_000) {
    lastCleanupAt = Date.now();
    const sql = db();
    await Promise.all([
      sql`delete from oauth_sessions where expires_at <= now() or revoked_at is not null`,
      sql`delete from api_tokens where oauth_session_id is not null and expires_at <= now()`,
      sql`delete from oauth_refresh_tokens where used_at is not null and expires_at <= now()`,
      sql`delete from oauth_authorization_requests where expires_at <= now()`,
      sql`delete from oauth_authorization_codes where expires_at <= now() or used_at < now() - interval '1 day'`,
      sql`delete from oauth_device_codes where expires_at <= now()`,
    ]);
  }
  return next();
});

const base64urlHash = (value: string): string => createHash("sha256").update(value, "ascii").digest("base64url");
const isVerifier = (value: string): boolean => /^[A-Za-z0-9._~-]{43,128}$/.test(value);
const isChallenge = (value: string): boolean => /^[A-Za-z0-9_-]{43,128}$/.test(value);
const isState = (value: string): boolean => /^[A-Za-z0-9._~-]{1,256}$/.test(value);
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const apiPrefix = (url: string, forwarded = ""): string => forwarded || new URL(url).pathname.replace(/\/v1\/oauth(?:\/.*)?$/, "");
const apiPath = (url: string, path: string, forwarded = ""): string => `${apiPrefix(url, forwarded)}/v1/oauth${path}`;
const publicOrigin = (context: { req: { url: string; header(name: string): string | undefined } }): string => {
  const host = context.req.header("x-forwarded-host");
  const protocol = context.req.header("x-forwarded-proto") ?? "https";
  return host ? `${protocol}://${host}` : new URL(context.req.url).origin;
};
const flowCookieName = (id: string): string => `myna_oauth_${id}`;
const flowCookie = (id: string, secret: string, prefix: string): string =>
  `${flowCookieName(id)}=${encodeURIComponent(secret)}; Path=${prefix}/v1/oauth; Max-Age=300; HttpOnly; Secure; SameSite=Strict`;
const sameSecret = (a: string, b: string): boolean => a.length === b.length && a === b;

async function page(context: { header(name: string, value: string): unknown; html(body: string, status?: number): Response | Promise<Response> }, title: string, content: string, status = 200): Promise<Response> {
  context.header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  context.header("x-frame-options", "DENY");
  context.header("referrer-policy", "no-referrer");
  context.header("x-content-type-options", "nosniff");
  return context.html(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · myna</title>
<style>body{margin:0;background:#101522;color:#e8edf6;font:16px/1.5 system-ui,sans-serif;display:grid;min-height:100vh;place-items:center}.card{box-sizing:border-box;width:min(92vw,440px);padding:32px;border:1px solid #303a4d;border-radius:18px;background:#171f2e}h1{font-size:24px;margin:0 0 8px}p{color:#aebbd0;margin:8px 0 20px}label{display:block;margin:14px 0 5px;font-size:14px;color:#c7d1e2}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #3d4a60;border-radius:9px;background:#0e1420;color:#fff;font:inherit}button{padding:11px 16px;border:0;border-radius:9px;background:#a8d9ff;color:#102036;font:600 15px system-ui;cursor:pointer;margin:18px 8px 0 0}.quiet{background:transparent;color:#c3cada;border:1px solid #3d4a60}.error{color:#ffb5a7}.fine{color:#9be3ba}.muted{font-size:13px;color:#8f9eb4}</style>
<body><main class="card"><h1>${escapeHtml(title)}</h1>${content}</main></body></html>`, status);
}

function authorizeMarkup(id: string, csrf: string, prefix: string, loginHint: string, email?: string, error?: string): string {
  const message = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
  const identity = email
    ? `<p>Continue as <strong>${escapeHtml(email)}</strong> to sign in to myna on this device.</p>`
    : `<p>Sign in to myna cloud to authorize this CLI. Your password is sent only to mynaposter.com over HTTPS.</p>
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(loginHint)}">
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>`;
  return `${message}<form method="post" action="${prefix}/v1/oauth/authorize">
<input type="hidden" name="request" value="${escapeHtml(id)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
${identity}<p class="muted">myna CLI will be able to use your cloud account, including backups and newsletter unsubscribe sync. Access tokens expire after 15 minutes; refresh tokens rotate automatically.</p>
<button name="decision" value="approve">Authorize myna CLI</button><button class="quiet" name="decision" value="deny" formnovalidate>Cancel</button></form>`;
}

async function authRequest(id: string): Promise<AuthRequest | undefined> {
  const rows = await db()`
    select id, csrf_hash, client_id, redirect_uri, code_challenge, state, login_hint, expires_at
    from oauth_authorization_requests where id = ${id} and expires_at > now()
  `;
  return rows[0] as AuthRequest | undefined;
}

function validRedirectUri(value: string): boolean {
  try {
    const uri = new URL(value);
    return uri.protocol === "http:" &&
      (uri.hostname === "127.0.0.1" || uri.hostname === "localhost") &&
      Boolean(uri.port) && uri.pathname === "/callback" && !uri.username && !uri.password && !uri.search && !uri.hash;
  } catch {
    return false;
  }
}

oauthRoutes.get("/authorize", async (context) => {
  const query = context.req.query();
  const redirectUri = query.redirect_uri ?? "";
  const challenge = query.code_challenge ?? "";
  const state = query.state ?? "";
  const loginHint = (query.login_hint ?? "").trim().slice(0, 254);
  if (query.client_id !== CLI_CLIENT_ID || query.response_type !== "code" || query.code_challenge_method !== "S256" ||
      !validRedirectUri(redirectUri) || !isChallenge(challenge) || !isState(state)) {
    return page(context, "Can't authorize myna", "<p class=\"error\">This sign-in request is invalid or has expired. Return to the terminal and start again.</p>", 400);
  }

  const id = randomUUID();
  const csrf = randomBytes(32).toString("base64url");
  await db()`
    insert into oauth_authorization_requests (id, csrf_hash, client_id, redirect_uri, code_challenge, state, login_hint, expires_at)
    values (${id}, ${hashToken(csrf)}, ${CLI_CLIENT_ID}, ${redirectUri}, ${challenge}, ${state}, ${loginHint}, now() + interval '5 minutes')
  `;
  const existing = await cloud.whoami(readCookie(context.req.header("cookie")));
  const prefix = apiPrefix(context.req.url, context.req.header("x-forwarded-prefix"));
  context.header("set-cookie", flowCookie(id, csrf, prefix));
  return page(context, "Authorize myna CLI", authorizeMarkup(id, csrf, prefix, loginHint, existing?.email));
});

oauthRoutes.post("/authorize", async (context) => {
  const form = new URLSearchParams(await context.req.text());
  const id = form.get("request") ?? "";
  const csrf = form.get("csrf") ?? "";
  const decision = form.get("decision") ?? "";
  const cookie = readCookie(context.req.header("cookie"), flowCookieName(id));
  const request = /^[0-9a-f-]{36}$/i.test(id) ? await authRequest(id) : undefined;
  if (!request || !sameSecret(cookie, csrf) || hashToken(csrf) !== request.csrf_hash) {
    return page(context, "Sign-in expired", "<p class=\"error\">This sign-in request expired. Return to the terminal and start again.</p>", 400);
  }

  const redirect = new URL(request.redirect_uri);
  if (decision !== "approve") {
    await db()`delete from oauth_authorization_requests where id = ${id}`;
    redirect.searchParams.set("error", "access_denied");
    redirect.searchParams.set("state", request.state);
    context.header("set-cookie", `${flowCookieName(id)}=; Path=${apiPrefix(context.req.url, context.req.header("x-forwarded-prefix"))}/v1/oauth; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
    return context.redirect(redirect.toString());
  }

  let user = await cloud.whoami(readCookie(context.req.header("cookie")));
  if (!user) {
    try {
      user = await cloud.authenticatePassword(form.get("email") ?? "", form.get("password") ?? "");
    } catch (error) {
      return page(context, "Authorize myna CLI", authorizeMarkup(id, csrf, apiPrefix(context.req.url, context.req.header("x-forwarded-prefix")), form.get("email") ?? request.login_hint, undefined, (error as Error).message), 401);
    }
  }

  const code = newToken();
  const codeId = randomUUID();
  const saved = await db().begin(async (sql) => {
    const active = await sql`
      delete from oauth_authorization_requests where id = ${id} and csrf_hash = ${request.csrf_hash} and expires_at > now()
      returning id
    `;
    if (!active.length) return false;
    await sql`
      insert into oauth_authorization_codes (id, code_hash, user_id, client_id, redirect_uri, code_challenge, expires_at)
      values (${codeId}, ${hashToken(code)}, ${user.id}, ${request.client_id}, ${request.redirect_uri}, ${request.code_challenge}, now() + interval '2 minutes')
    `;
    return true;
  });
  if (!saved) return page(context, "Sign-in expired", "<p class=\"error\">This sign-in request has already been used. Return to the terminal and start again.</p>", 400);
  redirect.searchParams.set("code", code);
  redirect.searchParams.set("state", request.state);
  context.header("set-cookie", `${flowCookieName(id)}=; Path=${apiPrefix(context.req.url, context.req.header("x-forwarded-prefix"))}/v1/oauth; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
  return context.redirect(redirect.toString());
});

function tokenJson(context: { header(name: string, value: string): unknown; json(body: unknown): Response }, reply: TokenReply): Response {
  context.header("cache-control", "no-store");
  context.header("pragma", "no-cache");
  return context.json(reply);
}

function oauthError(context: { header(name: string, value: string): unknown; json(body: unknown, status?: number): Response }, error: string, status = 400, interval?: number): Response {
  context.header("cache-control", "no-store");
  context.header("pragma", "no-cache");
  return context.json({ error, ...(interval ? { interval } : {}) }, status);
}

async function makeTokenSet(sql: postgres.TransactionSql, userId: string, clientId: string, sessionId = randomUUID()): Promise<TokenReply> {
  const users = await sql`select email from users where id = ${userId}`;
  const email = (users[0] as { email: string } | undefined)?.email;
  if (!email) throw new Error("OAuth account no longer exists.");
  const accessToken = newToken();
  const refreshToken = newToken();
  await sql`
    insert into oauth_sessions (id, user_id, client_id, expires_at)
    values (${sessionId}, ${userId}, ${clientId}, now() + interval '30 days')
  `;
  await sql`
    insert into api_tokens (user_id, token_hash, name, expires_at, oauth_session_id)
    values (${userId}, ${hashToken(accessToken)}, 'myna-cli', now() + make_interval(secs => ${ACCESS_TOKEN_SECONDS}), ${sessionId})
  `;
  await sql`
    insert into oauth_refresh_tokens (id, session_id, token_hash, expires_at)
    values (${randomUUID()}, ${sessionId}, ${hashToken(refreshToken)}, now() + interval '30 days')
  `;
  return { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TOKEN_SECONDS, refresh_token: refreshToken, email };
}

oauthRoutes.post("/token", async (context) => {
  const form = new URLSearchParams(await context.req.text());
  if (form.get("client_id") !== CLI_CLIENT_ID) return oauthError(context, "invalid_client");
  const grant = form.get("grant_type");

  if (grant === "authorization_code") {
    const code = form.get("code") ?? "";
    const verifier = form.get("code_verifier") ?? "";
    const redirectUri = form.get("redirect_uri") ?? "";
    if (!isVerifier(verifier)) return oauthError(context, "invalid_grant");
    const result = await db().begin(async (sql) => {
      const rows = (await sql`
        select id, user_id, client_id, redirect_uri, code_challenge, expires_at, used_at
        from oauth_authorization_codes where code_hash = ${hashToken(code)} for update
      `) as unknown as { id: string; user_id: string; client_id: string; redirect_uri: string; code_challenge: string; expires_at: Date; used_at: Date | null }[];
      const row = rows[0];
      if (!row || row.used_at || new Date(row.expires_at).getTime() <= Date.now() || row.client_id !== CLI_CLIENT_ID ||
          row.redirect_uri !== redirectUri || base64urlHash(verifier) !== row.code_challenge) return null;
      const spent = await sql`update oauth_authorization_codes set used_at = now() where id = ${row.id} and used_at is null returning user_id`;
      if (!spent.length) return null;
      return row.user_id;
    });
    if (!result) return oauthError(context, "invalid_grant");
    const reply = await db().begin((sql) => makeTokenSet(sql, result, CLI_CLIENT_ID));
    return tokenJson(context, reply as TokenReply);
  }

  if (grant === "refresh_token") {
    const refreshToken = form.get("refresh_token") ?? "";
    const rotated = await db().begin(async (sql) => {
      const rows = (await sql`
        select r.id, r.session_id, r.expires_at, r.used_at, s.user_id, s.client_id, s.expires_at as session_expires_at, s.revoked_at, u.email
        from oauth_refresh_tokens r join oauth_sessions s on s.id = r.session_id join users u on u.id = s.user_id
        where r.token_hash = ${hashToken(refreshToken)} for update of r, s
      `) as unknown as { id: string; session_id: string; expires_at: Date; used_at: Date | null; user_id: string; client_id: string; session_expires_at: Date; revoked_at: Date | null; email: string }[];
      const row = rows[0];
      if (!row) return null;
      if (row.used_at) {
        await sql`update oauth_sessions set revoked_at = coalesce(revoked_at, now()) where id = ${row.session_id}`;
        return null;
      }
      if (row.revoked_at || new Date(row.expires_at).getTime() <= Date.now() || new Date(row.session_expires_at).getTime() <= Date.now() || row.client_id !== CLI_CLIENT_ID) {
        await sql`update oauth_sessions set revoked_at = coalesce(revoked_at, now()) where id = ${row.session_id}`;
        return null;
      }
      const spent = await sql`update oauth_refresh_tokens set used_at = now() where id = ${row.id} and used_at is null returning id`;
      if (!spent.length) {
        await sql`update oauth_sessions set revoked_at = coalesce(revoked_at, now()) where id = ${row.session_id}`;
        return null;
      }
      await sql`update oauth_sessions set expires_at = now() + interval '30 days' where id = ${row.session_id}`;
      const accessToken = newToken();
      const nextRefreshToken = newToken();
      await sql`
        insert into api_tokens (user_id, token_hash, name, expires_at, oauth_session_id)
        values (${row.user_id}, ${hashToken(accessToken)}, 'myna-cli', now() + make_interval(secs => ${ACCESS_TOKEN_SECONDS}), ${row.session_id})
      `;
      await sql`
        insert into oauth_refresh_tokens (id, session_id, token_hash, expires_at)
        values (${randomUUID()}, ${row.session_id}, ${hashToken(nextRefreshToken)}, now() + interval '30 days')
      `;
      return { access_token: accessToken, token_type: "Bearer" as const, expires_in: ACCESS_TOKEN_SECONDS, refresh_token: nextRefreshToken, email: row.email };
    });
    if (!rotated) return oauthError(context, "invalid_grant");
    return tokenJson(context, rotated as TokenReply);
  }

  if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
    const deviceCode = form.get("device_code") ?? "";
    const result = await db().begin(async (sql) => {
      const rows = (await sql`
        select id, status, user_id, expires_at, interval_seconds, last_polled_at, consumed_at
        from oauth_device_codes where device_code_hash = ${hashToken(deviceCode)} and client_id = ${CLI_CLIENT_ID} for update
      `) as unknown as { id: string; status: string; user_id: string | null; expires_at: Date; interval_seconds: number; last_polled_at: Date | null; consumed_at: Date | null }[];
      const row = rows[0];
      if (!row || row.consumed_at) return { error: "expired_token" as const };
      if (new Date(row.expires_at).getTime() <= Date.now()) return { error: "expired_token" as const };
      if (row.status === "denied") return { error: "access_denied" as const };
      if (row.status === "pending") {
        const tooSoon = row.last_polled_at && Date.now() - new Date(row.last_polled_at).getTime() < row.interval_seconds * 1000;
        const interval = tooSoon ? row.interval_seconds + 5 : row.interval_seconds;
        await sql`update oauth_device_codes set last_polled_at = now(), interval_seconds = ${interval} where id = ${row.id}`;
        return { error: tooSoon ? "slow_down" as const : "authorization_pending" as const, interval };
      }
      if (row.status !== "approved" || !row.user_id) return { error: "invalid_grant" as const };
      const used = await sql`update oauth_device_codes set consumed_at = now() where id = ${row.id} and consumed_at is null returning user_id`;
      const userId = (used[0] as { user_id: string } | undefined)?.user_id;
      return userId ? { userId } : { error: "expired_token" as const };
    });
    if (!result.userId) return oauthError(context, result.error ?? "invalid_grant", 400, "interval" in result ? result.interval : undefined);
    const reply = await db().begin((sql) => makeTokenSet(sql, result.userId, CLI_CLIENT_ID));
    return tokenJson(context, reply as TokenReply);
  }

  return oauthError(context, "unsupported_grant_type");
});

oauthRoutes.post("/revoke", async (context) => {
  const form = new URLSearchParams(await context.req.text());
  if (form.get("client_id") === CLI_CLIENT_ID) await cloud.logout(form.get("token") ?? "");
  context.header("cache-control", "no-store");
  return context.body(null, 200);
});

const DEVICE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newUserCode(): string {
  let value = "";
  while (value.length < 10) {
    for (const byte of randomBytes(16)) {
      if (byte < 248) value += DEVICE_ALPHABET[byte % DEVICE_ALPHABET.length];
      if (value.length === 10) break;
    }
  }
  return `${value.slice(0, 5)}-${value.slice(5)}`;
}

oauthRoutes.post("/device_authorization", async (context) => {
  const form = new URLSearchParams(await context.req.text());
  if (form.get("client_id") !== CLI_CLIENT_ID) return oauthError(context, "invalid_client");
  const deviceCode = newToken();
  const userCode = newUserCode();
  const id = randomUUID();
  await db()`
    insert into oauth_device_codes (id, device_code_hash, user_code_hash, client_id, expires_at, interval_seconds)
    values (${id}, ${hashToken(deviceCode)}, ${hashToken(userCode)}, ${CLI_CLIENT_ID}, now() + make_interval(secs => ${DEVICE_CODE_SECONDS}), ${DEVICE_POLL_SECONDS})
  `;
  const forwarded = context.req.header("x-forwarded-prefix");
  const pagePath = apiPath(context.req.url, "/device", forwarded);
  const verificationUri = `${publicOrigin(context)}${pagePath}`;
  context.header("cache-control", "no-store");
  return context.json({ device_code: deviceCode, user_code: userCode, verification_uri: verificationUri, verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(userCode)}`, expires_in: DEVICE_CODE_SECONDS, interval: DEVICE_POLL_SECONDS });
});

function deviceMarkup(userCode: string, csrf: string, cookieName: string, prefix: string, email?: string, error?: string): string {
  const identity = email
    ? `<p>Continue as <strong>${escapeHtml(email)}</strong> to authorize this device.</p>`
    : `<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>`;
  return `${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}<p>Enter the code shown in your terminal to connect that myna CLI.</p>
<form method="post" action="${prefix}/v1/oauth/device"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="cookie" value="${escapeHtml(cookieName)}">
<label for="user_code">Device code</label><input id="user_code" name="user_code" autocomplete="one-time-code" required value="${escapeHtml(userCode)}">
${identity}
<button name="decision" value="approve">Authorize this device</button><button class="quiet" name="decision" value="deny" formnovalidate>Cancel</button></form>`;
}

oauthRoutes.get("/device", async (context) => {
  const csrf = randomBytes(32).toString("base64url");
  const cookieId = randomUUID();
  const name = flowCookieName(cookieId);
  const prefix = apiPrefix(context.req.url, context.req.header("x-forwarded-prefix"));
  context.header("set-cookie", flowCookie(cookieId, csrf, prefix));
  const user = await cloud.whoami(readCookie(context.req.header("cookie")));
  // The cookie name is included in the form so parallel device pages do not share state.
  const markup = deviceMarkup(context.req.query("user_code") ?? "", csrf, name, prefix, user?.email);
  return page(context, "Connect a device", markup);
});

oauthRoutes.post("/device", async (context) => {
  const form = new URLSearchParams(await context.req.text());
  const csrf = form.get("csrf") ?? "";
  const cookieName = form.get("cookie") ?? "";
  const cookieId = cookieName.startsWith("myna_oauth_") ? cookieName.slice("myna_oauth_".length) : "";
  const cookie = /^[0-9a-f-]{36}$/i.test(cookieId) ? readCookie(context.req.header("cookie"), cookieName) : "";
  const prefix = apiPrefix(context.req.url, context.req.header("x-forwarded-prefix"));
  if (!csrf || !sameSecret(cookie, csrf)) return page(context, "Sign-in expired", "<p class=\"error\">This page expired. Open the device link again.</p>", 400);
  const userCode = (form.get("user_code") ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const digest = hashToken(userCode);
  const devices = userCode.length === 10 ? await db()`
    select id, status from oauth_device_codes where user_code_hash = ${digest} and client_id = ${CLI_CLIENT_ID} and expires_at > now()
  ` : [];
  const device = devices[0] as { id: string; status: string } | undefined;
  const browserUser = await cloud.whoami(readCookie(context.req.header("cookie")));
  if (!device || device.status !== "pending") {
    return page(context, "Connect a device", deviceMarkup(form.get("user_code") ?? "", csrf, cookieName, prefix, browserUser?.email, "That device code has expired or was already used."), 400);
  }
  const decision = form.get("decision");
  if (decision === "deny") {
    await db()`update oauth_device_codes set status = 'denied' where id = ${device.id} and status = 'pending'`;
    return page(context, "Device cancelled", "<p>The CLI will stop waiting shortly. You can close this page.</p>");
  }
  let authenticated = browserUser;
  if (!authenticated) {
    try {
      authenticated = await cloud.authenticatePassword(form.get("email") ?? "", form.get("password") ?? "");
    } catch (error) {
      return page(context, "Connect a device", deviceMarkup(form.get("user_code") ?? "", csrf, cookieName, prefix, undefined, (error as Error).message), 401);
    }
  }
  const approved = await db()`
    update oauth_device_codes set status = 'approved', user_id = ${authenticated.id}
    where id = ${device.id} and status = 'pending' and expires_at > now() returning id
  `;
  if (!approved.length) return page(context, "Device code expired", "<p class=\"error\">Return to the terminal and start again.</p>", 400);
  return page(context, "Device connected", `<p class="fine">${escapeHtml(authenticated.email)} authorized the myna CLI.</p><p>You can close this page.</p>`);
});

export { oauthRoutes };
