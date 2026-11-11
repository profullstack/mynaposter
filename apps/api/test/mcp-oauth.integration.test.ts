/**
 * OAuth 2.1 for the hosted MCP server, through the real API routes against a
 * real Postgres. Skipped unless DATABASE_URL is set, like the other
 * integration tests here.
 *
 * What has to hold for claude.ai, ChatGPT and Claude Code: an unauthenticated
 * MCP request is 401 with WWW-Authenticate naming the protected-resource
 * metadata; that metadata's resource is the MCP URL exactly; the
 * authorization server publishes DCR, S256 and refresh; registration takes
 * public clients with the connector redirects; the code flow returns `iss`;
 * the token endpoint takes a form body; the token lists tools and is good
 * nowhere else in the API; refresh rotates. And the operator's key still works.
 */
import { createHash, randomBytes } from "node:crypto";
import { test, expect, beforeAll, afterAll } from "bun:test";
import { migrate, closeDatabase, hasDatabase } from "../src/db/index.ts";
import * as cloud from "../src/cloud.ts";

const enabled = hasDatabase();
const it = enabled ? test : test.skip;

const OPERATOR_KEY = `op_${randomBytes(16).toString("hex")}`;
const PASSWORD = "a long enough password";
const ORIGIN = "https://mynaposter.com";
const unique = () => `m${Date.now()}${Math.random().toString(36).slice(2, 8)}@example.com`;

let fetchApp: (request: Request) => Response | Promise<Response>;

beforeAll(async () => {
  if (!enabled) return;
  process.env.MYNA_API_TOKEN = OPERATOR_KEY;
  delete process.env.MYNA_PUBLIC_URL;
  await migrate();
  fetchApp = (await import("../src/server.ts")).default.fetch;
});
afterAll(async () => {
  if (enabled) await closeDatabase();
});

const call = (path: string, init: RequestInit = {}) => Promise.resolve(fetchApp(new Request(`http://api.test${path}`, init)));
const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const form = (body: Record<string, string>): RequestInit => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
const rpc = (method: string, token?: string, params: Record<string, unknown> = {}) =>
  call("/api/mcp", json({ jsonrpc: "2.0", id: 1, method, params }, token ? { authorization: `Bearer ${token}` } : {}));

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
const CHATGPT = "https://chatgpt.com/connector_platform_oauth_redirect";

async function register(redirect_uris: string[] = [CLAUDE, CHATGPT, "http://localhost/callback", "http://127.0.0.1/callback"]) {
  const res = await call("/v1/oauth/register", json({ client_name: "Claude", redirect_uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }));
  expect(res.status).toBe(201);
  return (await res.json()) as { client_id: string; token_endpoint_auth_method: string };
}

/** Walk the consent page as a browser would: GET, then POST the form with the flow cookie. */
async function authorize(clientId: string, redirectUri: string, challenge: string, email: string, decision = "approve", extra: Record<string, string> = {}) {
  const query = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", state: "st-123", scope: "mcp", resource: `${ORIGIN}/api/mcp`, ...extra });
  const page = await call(`/v1/oauth/authorize?${query}`);
  expect(page.status).toBe(200);
  const html = await page.text();
  const request = /name="request" value="([^"]+)"/.exec(html)![1]!;
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
  const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0]!;
  const posted = await call("/v1/oauth/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({ request, csrf, decision, email, password: PASSWORD }).toString(),
  });
  return { html, posted };
}

it("serves the discovery documents MCP connectors read", async () => {
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/api/mcp"]) {
    const prm = (await (await call(path)).json()) as Record<string, unknown>;
    expect(prm.resource).toBe(`${ORIGIN}/api/mcp`);
    expect((prm.authorization_servers as string[])[0]).toBe(ORIGIN);
  }
  for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/api", "/.well-known/openid-configuration"]) {
    const as = (await (await call(path)).json()) as Record<string, unknown>;
    expect(as.issuer).toBe(ORIGIN);
    expect(as.authorization_endpoint).toBe(`${ORIGIN}/api/v1/oauth/authorize`);
    expect(as.token_endpoint).toBe(`${ORIGIN}/api/v1/oauth/token`);
    expect(as.registration_endpoint).toBe(`${ORIGIN}/api/v1/oauth/register`);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.response_types_supported).toEqual(["code"]);
    expect(as.grant_types_supported).toEqual(expect.arrayContaining(["authorization_code", "refresh_token"]));
    expect(as.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(as.authorization_response_iss_parameter_supported).toBe(true);
  }
});

it("answers an unauthenticated or wrongly authenticated MCP request with 401 and the metadata URL", async () => {
  const bare = await rpc("initialize");
  expect(bare.status).toBe(401);
  expect(bare.headers.get("www-authenticate")).toContain(`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`);
  const wrong = await rpc("tools/list", "myna_not_a_real_token");
  expect(wrong.status).toBe(401);
  expect(wrong.headers.get("www-authenticate")).toContain('error="invalid_token"');
});

it("keeps the operator key working: every tool, including tools/call", async () => {
  const list = await rpc("tools/list", OPERATOR_KEY);
  expect(list.status).toBe(200);
  const body = (await list.json()) as { result: { tools: unknown[]; resultType: string; ttlMs: number; cacheScope: string } };
  expect(body.result.tools.length).toBeGreaterThan(10);
  expect(body.result).toMatchObject({ resultType: "complete", cacheScope: "public" });
  expect(typeof body.result.ttlMs).toBe("number");
  const called = (await (await rpc("tools/call", OPERATOR_KEY, { name: "myna_networks", arguments: {} })).json()) as { result: { isError?: boolean } };
  expect(called.result.isError).toBeFalsy();
});

it("registers public clients only, with https or loopback redirects", async () => {
  const ok = await register();
  expect(ok.client_id).toMatch(/^mcpc_[0-9a-f]{32}$/);
  expect(ok.token_endpoint_auth_method).toBe("none");
  const http = await call("/v1/oauth/register", json({ redirect_uris: ["http://evil.example/cb"] }));
  expect(http.status).toBe(400);
  expect(((await http.json()) as { error: string }).error).toBe("invalid_redirect_uri");
  const secret = await call("/v1/oauth/register", json({ redirect_uris: [CLAUDE], token_endpoint_auth_method: "client_secret_basic" }));
  expect(((await secret.json()) as { error: string }).error).toBe("invalid_client_metadata");
});

it("refuses an unknown client or unregistered redirect without following it", async () => {
  const { challenge } = pkce();
  const unknown = await call(`/v1/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: "mcpc_00000000000000000000000000000000", redirect_uri: CLAUDE, code_challenge: challenge, code_challenge_method: "S256" })}`);
  expect(unknown.status).toBe(400);
  const client = await register([CLAUDE]);
  const foreign = await call(`/v1/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: "https://evil.example/cb", code_challenge: challenge, code_challenge_method: "S256" })}`);
  expect(foreign.status).toBe(400);
  expect(foreign.headers.get("location")).toBeNull();
  const noPkce = await call(`/v1/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: CLAUDE })}`);
  expect(noPkce.status).toBe(302);
  const back = new URL(noPkce.headers.get("location")!);
  expect(back.searchParams.get("error")).toBe("invalid_request");
  expect(back.searchParams.get("iss")).toBe(ORIGIN);
});

it("runs the whole PKCE flow: consent names the client, code + iss, form token, MCP only, refresh rotates", async () => {
  const email = unique();
  const { user } = await cloud.signup(email, PASSWORD);
  const client = await register();
  const { verifier, challenge } = pkce();

  const { html, posted } = await authorize(client.client_id, CLAUDE, challenge, email);
  expect(html).toContain("Connect Claude");
  expect(posted.status).toBe(302);
  const back = new URL(posted.headers.get("location")!);
  expect(`${back.origin}${back.pathname}`).toBe(CLAUDE);
  expect(back.searchParams.get("state")).toBe("st-123");
  expect(back.searchParams.get("iss")).toBe(ORIGIN);
  const code = back.searchParams.get("code")!;

  const badVerifier = await call("/v1/oauth/token", form({ grant_type: "authorization_code", client_id: client.client_id, code, redirect_uri: CLAUDE, code_verifier: pkce().verifier }));
  expect(badVerifier.status).toBe(400);

  // The bad verifier did not burn the code: PKCE is checked before it is spent.
  const tokenRes = await call("/v1/oauth/token", form({ grant_type: "authorization_code", client_id: client.client_id, code, redirect_uri: CLAUDE, code_verifier: verifier }));
  expect(tokenRes.status).toBe(200);
  const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string; token_type: string; expires_in: number; scope: string };
  expect(tokens.token_type).toBe("Bearer");
  expect(tokens.scope).toBe("mcp");
  expect(tokens.expires_in).toBeLessThanOrEqual(3600);

  const replay = await call("/v1/oauth/token", form({ grant_type: "authorization_code", client_id: client.client_id, code, redirect_uri: CLAUDE, code_verifier: verifier }));
  expect(replay.status).toBe(400);

  const list = await rpc("tools/list", tokens.access_token);
  expect(list.status).toBe(200);
  expect(((await list.json()) as { result: { tools: unknown[] } }).result.tools.length).toBeGreaterThan(10);

  // Not an operator: signed in, can list, cannot run.
  delete process.env.MYNA_MCP_OPERATORS;
  const refused = (await (await rpc("tools/call", tokens.access_token, { name: "myna_networks", arguments: {} })).json()) as { result: { isError: boolean; content: { text: string }[] } };
  expect(refused.result.isError).toBe(true);
  expect(refused.result.content[0]!.text).toContain("operator");
  process.env.MYNA_MCP_OPERATORS = `00000000-0000-0000-0000-000000000000, ${user.id}`;
  const allowed = (await (await rpc("tools/call", tokens.access_token, { name: "myna_networks", arguments: {} })).json()) as { result: { isError?: boolean } };
  expect(allowed.result.isError).toBeFalsy();
  delete process.env.MYNA_MCP_OPERATORS;

  // A connector's token is not a key to the rest of the API.
  const me = await call("/v1/cloud/me", { headers: { authorization: `Bearer ${tokens.access_token}` } });
  expect(me.status).toBe(401);

  const refreshed = await call("/v1/oauth/token", form({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token }));
  expect(refreshed.status).toBe(200);
  const next = (await refreshed.json()) as { access_token: string; refresh_token: string };
  expect(next.refresh_token).not.toBe(tokens.refresh_token);
  expect((await rpc("tools/list", next.access_token)).status).toBe(200);

  // Reusing a rotated refresh token ends the whole grant.
  const reused = await call("/v1/oauth/token", form({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token }));
  expect(reused.status).toBe(400);
  expect((await rpc("tools/list", next.access_token)).status).toBe(401);
});

it("lets a loopback redirect use any port, and a denial goes back with iss", async () => {
  const email = unique();
  await cloud.signup(email, PASSWORD);
  const client = await register(["http://localhost/callback"]);
  const { verifier, challenge } = pkce();
  const redirect = "http://localhost:53122/callback";
  const { posted } = await authorize(client.client_id, redirect, challenge, email);
  const back = new URL(posted.headers.get("location")!);
  expect(back.port).toBe("53122");
  const ok = await call("/v1/oauth/token", form({ grant_type: "authorization_code", client_id: client.client_id, code: back.searchParams.get("code")!, redirect_uri: redirect, code_verifier: verifier }));
  expect(ok.status).toBe(200);

  const denied = await authorize(client.client_id, redirect, pkce().challenge, email, "deny");
  const no = new URL(denied.posted.headers.get("location")!);
  expect(no.searchParams.get("error")).toBe("access_denied");
  expect(no.searchParams.get("iss")).toBe(ORIGIN);
});

it("leaves the CLI's own sign-in as it was: its token works on the API", async () => {
  const email = unique();
  await cloud.signup(email, PASSWORD);
  const { verifier, challenge } = pkce();
  const redirect = "http://127.0.0.1:40111/callback";
  const query = new URLSearchParams({ response_type: "code", client_id: "myna-cli", redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "cli-state" });
  const page = await call(`/v1/oauth/authorize?${query}`);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain("Authorize myna CLI");
  const request = /name="request" value="([^"]+)"/.exec(html)![1]!;
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
  const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0]!;
  const posted = await call("/v1/oauth/authorize", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie }, body: new URLSearchParams({ request, csrf, decision: "approve", email, password: PASSWORD }).toString() });
  const code = new URL(posted.headers.get("location")!).searchParams.get("code")!;
  const tokens = (await (await call("/v1/oauth/token", form({ grant_type: "authorization_code", client_id: "myna-cli", code, redirect_uri: redirect, code_verifier: verifier }))).json()) as { access_token: string; email: string };
  expect(tokens.email).toBe(email);
  const me = await call("/v1/cloud/me", { headers: { authorization: `Bearer ${tokens.access_token}` } });
  expect(me.status).toBe(200);
});
