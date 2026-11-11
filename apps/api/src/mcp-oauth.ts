/**
 * OAuth 2.1 for the hosted MCP server at mynaposter.com/api/mcp, so claude.ai
 * connectors, ChatGPT apps and Claude Code can sign in without a pasted key.
 *
 * It extends the authorization server the CLI already uses (oauth.ts): the
 * same /v1/oauth/authorize page, the same code, token and refresh tables. What
 * this file adds is the part MCP clients need on top:
 *
 *   - RFC 9728 protected-resource metadata, whose `resource` is the MCP URL
 *   - RFC 8414 authorization-server metadata at the origin, with
 *   - RFC 7591 dynamic client registration (public clients only, no secret)
 *   - redirect rules: https anywhere, http only on a loopback host, and a
 *     loopback redirect may use any port (RFC 8252 §7.3)
 *
 * A registered client's id starts with `mcpc_`, and so does the oauth_sessions
 * row its tokens hang off. cloud.whoami() refuses those tokens unless it is
 * asked on behalf of the MCP route, so a token a connector holds works on
 * /api/mcp and nowhere else in the API.
 */
import { randomBytes } from "node:crypto";
import { db } from "./db/index.ts";

export const MCP_CLIENT_PREFIX = "mcpc_";
export const SCOPE = "mcp";

/** The public origin. Bun reads the environment at run time, so this is safe to vary. */
export function siteOrigin(): string {
  return (process.env.MYNA_PUBLIC_URL || "https://mynaposter.com").replace(/\/+$/, "");
}

export const issuer = (origin = siteOrigin()) => origin;
export const resourceUrl = (origin = siteOrigin()) => `${origin}/api/mcp`;
export const resourceMetadataUrl = (origin = siteOrigin()) => `${origin}/.well-known/oauth-protected-resource`;

export function protectedResourceMetadata(origin = siteOrigin()) {
  return {
    resource: resourceUrl(origin),
    authorization_servers: [issuer(origin)],
    bearer_methods_supported: ["header"],
    scopes_supported: [SCOPE],
    resource_name: "myna",
    resource_documentation: "https://github.com/profullstack/mynaposter#readme",
  };
}

export function authorizationServerMetadata(origin = siteOrigin()) {
  return {
    issuer: issuer(origin),
    authorization_endpoint: `${origin}/api/v1/oauth/authorize`,
    token_endpoint: `${origin}/api/v1/oauth/token`,
    registration_endpoint: `${origin}/api/v1/oauth/register`,
    revocation_endpoint: `${origin}/api/v1/oauth/revoke`,
    device_authorization_endpoint: `${origin}/api/v1/oauth/device_authorization`,
    scopes_supported: [SCOPE],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
    service_documentation: "https://github.com/profullstack/mynaposter#readme",
  };
}

/** OpenID-shaped discovery for clients that only look there. No id_token is issued. */
export function openidConfiguration(origin = siteOrigin()) {
  return { ...authorizationServerMetadata(origin), subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"] };
}

export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-expose-headers": "www-authenticate",
  "access-control-max-age": "86400",
};

// ─── Redirect URIs ───

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** https anywhere (no fragment, no credentials), or http on a loopback host. */
export function isAllowedRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2000) return false;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && LOOPBACK.has(u.hostname);
}

/** Exact match, except a loopback redirect may use any port (Claude Code listens wherever is free). */
export function redirectUriMatches(registered: string[], asked: string): boolean {
  if (registered.includes(asked)) return true;
  let a: URL;
  try {
    a = new URL(asked);
  } catch {
    return false;
  }
  if (a.protocol !== "http:" || !LOOPBACK.has(a.hostname)) return false;
  return registered.some((r) => {
    try {
      const u = new URL(r);
      return u.protocol === "http:" && u.hostname === a.hostname && u.pathname === a.pathname && u.search === a.search;
    } catch {
      return false;
    }
  });
}

/** The MCP resource, with or without a trailing slash. */
export function resourceMatches(value: string): boolean {
  try {
    const u = new URL(value);
    const r = new URL(resourceUrl());
    return u.origin === r.origin && u.pathname.replace(/\/+$/, "") === r.pathname;
  } catch {
    return false;
  }
}

// ─── Clients (RFC 7591) ───

export class RegistrationError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
  body() {
    return { error: this.code, error_description: this.message };
  }
}

export interface McpClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  client_uri: string | null;
}

const cleanName = (v: unknown) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 100) : "");
const optionalHttps = (v: unknown) => {
  if (typeof v !== "string") return null;
  try {
    return new URL(v).protocol === "https:" ? v.slice(0, 500) : null;
  } catch {
    return null;
  }
};

export async function registerClient(body: Record<string, unknown>) {
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 20) {
    throw new RegistrationError("invalid_redirect_uri", "redirect_uris must list 1 to 20 URIs");
  }
  for (const u of uris) {
    if (!isAllowedRedirectUri(u)) {
      throw new RegistrationError("invalid_redirect_uri", `Not allowed: ${String(u).slice(0, 200)} (https, or http on localhost/127.0.0.1)`);
    }
  }
  const method = body.token_endpoint_auth_method ?? "none";
  if (method !== "none") {
    throw new RegistrationError("invalid_client_metadata", "Only public clients are supported: token_endpoint_auth_method must be none");
  }
  const grants = Array.isArray(body.grant_types) ? body.grant_types.map(String) : ["authorization_code", "refresh_token"];
  if (grants.some((g) => g !== "authorization_code" && g !== "refresh_token")) {
    throw new RegistrationError("invalid_client_metadata", "grant_types may only be authorization_code and refresh_token");
  }
  const types = Array.isArray(body.response_types) ? body.response_types.map(String) : ["code"];
  if (types.some((t) => t !== "code")) throw new RegistrationError("invalid_client_metadata", "response_types may only be code");

  const row: McpClient = {
    client_id: `${MCP_CLIENT_PREFIX}${randomBytes(16).toString("hex")}`,
    client_name: cleanName(body.client_name) || "MCP client",
    redirect_uris: [...new Set(uris as string[])],
    client_uri: optionalHttps(body.client_uri),
  };
  await db()`
    insert into oauth_clients (client_id, client_name, redirect_uris, client_uri)
    values (${row.client_id}, ${row.client_name}, ${row.redirect_uris}, ${row.client_uri})
  `;
  return {
    ...row,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: SCOPE,
  };
}

export const isMcpClientId = (v: unknown): v is string => typeof v === "string" && /^mcpc_[0-9a-f]{32}$/.test(v);

export async function getClient(clientId: unknown): Promise<McpClient | null> {
  if (!isMcpClientId(clientId)) return null;
  const rows = await db()`select client_id, client_name, redirect_uris, client_uri from oauth_clients where client_id = ${clientId}`;
  return (rows[0] as McpClient | undefined) ?? null;
}

/**
 * Who may run tools/call over OAuth. The MCP tools act on this instance's
 * connected social accounts and directories, which belong to its operator,
 * not to whoever signs in, so a myna cloud account alone can list the tools
 * but not run them. MYNA_MCP_OPERATORS is a comma-separated list of users.id
 * (never an email: a myna cloud email is not verified).
 */
export function isOperator(userId: string): boolean {
  return (process.env.MYNA_MCP_OPERATORS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(userId.toLowerCase());
}

export function wwwAuthenticate(error?: "invalid_token"): string {
  const parts = [`Bearer resource_metadata="${resourceMetadataUrl()}"`, `scope="${SCOPE}"`];
  if (error) parts.push(`error="${error}"`, `error_description="The access token is invalid or expired"`);
  return parts.join(", ");
}
