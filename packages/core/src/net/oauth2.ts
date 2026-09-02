/**
 * OAuth 2.0 authorization code flow with PKCE, driven from the terminal.
 *
 * The big networks stopped accepting passwords years ago, so `/login x` opens a
 * browser instead. myna listens on a loopback port for the redirect, which is
 * why the app you register must list http://127.0.0.1:<port>/callback as a
 * redirect URI.
 */
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import type { LoginContext } from "./types.ts";
import { postForm } from "../util/http.ts";

export const CALLBACK_PORT = 8765;
export const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}/callback`;

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  [key: string]: unknown;
}

export interface OAuth2Config {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  /** Extra query parameters on the authorize URL. */
  authParams?: Record<string, string>;
  /** PKCE. Off only for the few providers that reject the parameters. */
  pkce?: boolean;
  /** Send the client credentials as a Basic header rather than form fields. */
  basicAuth?: boolean;
  scopeSeparator?: string;
}

const base64url = (input: Buffer): string =>
  input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Open a URL in the desktop browser. Printing it is the fallback that always works. */
export async function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    /* the caller prints the URL too */
  }
}

/** Wait for the provider to redirect back, and hand the browser something readable. */
function awaitCallback(expectedState: string, timeoutMs: number): Promise<{ code: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${CALLBACK_PORT}`);
      if (url.pathname !== "/callback") {
        response.writeHead(404).end("Not found");
        return;
      }

      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      const done = (title: string, detail: string) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          `<!doctype html><meta charset="utf-8"><title>myna</title>` +
            `<body style="font:16px/1.6 system-ui,sans-serif;background:#0b1020;color:#e6edf3;display:grid;place-items:center;height:100vh;margin:0">` +
            `<div style="text-align:center"><h1 style="font-size:20px;margin:0 0 8px">${title}</h1>` +
            `<p style="color:#8b98a9;margin:0">${detail}</p></div>`,
        );
      };

      if (error) {
        done("Authorization failed", error);
        server.close();
        reject(new Error(`The provider returned "${error}"`));
        return;
      }
      if (state !== expectedState) {
        done("Authorization failed", "State did not match. Start the login again.");
        server.close();
        reject(new Error("OAuth state mismatch — the callback did not come from the login myna started."));
        return;
      }
      if (!code) {
        done("Authorization failed", "No authorization code came back.");
        server.close();
        reject(new Error("No authorization code in the callback"));
        return;
      }

      done("Connected", "You can close this tab and go back to the terminal.");
      server.close();
      resolve({ code });
    });

    server.on("error", (error) =>
      reject(
        (error as NodeJS.ErrnoException).code === "EADDRINUSE"
          ? new Error(`Port ${CALLBACK_PORT} is already in use — close whatever is holding it and try again.`)
          : error,
      ),
    );

    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for the browser. Start the login again."));
    }, timeoutMs);
    timer.unref?.();

    server.listen(CALLBACK_PORT, "127.0.0.1");
  });
}

export async function authorize(config: OAuth2Config, ctx: LoginContext, timeoutMs = 180_000): Promise<TokenSet> {
  const state = base64url(randomBytes(16));
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());

  const authorizeUrl = new URL(config.authorizeUrl);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", config.clientId);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("state", state);
  if (config.scopes.length) authorizeUrl.searchParams.set("scope", config.scopes.join(config.scopeSeparator ?? " "));
  if (config.pkce !== false) {
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
  }
  for (const [key, value] of Object.entries(config.authParams ?? {})) authorizeUrl.searchParams.set(key, value);

  // Listen before opening the browser, or a fast redirect races the server.
  const callback = awaitCallback(state, timeoutMs);
  ctx.report("Opening your browser to authorize…");
  await ctx.openUrl(authorizeUrl.toString());
  const { code } = await callback;

  ctx.report("Exchanging the code for a token…");
  const form: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: config.clientId,
  };
  if (config.pkce !== false) form.code_verifier = verifier;

  const headers: Record<string, string> = {};
  if (config.basicAuth && config.clientSecret) {
    headers.authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
  } else if (config.clientSecret) {
    form.client_secret = config.clientSecret;
  }

  const tokens = await postForm<TokenSet>(config.tokenUrl, form, { headers });
  if (!tokens.access_token) throw new Error("The provider returned no access token.");
  return tokens;
}

/** Swap a refresh token for a fresh access token. */
export async function refresh(config: OAuth2Config, refreshToken: string): Promise<TokenSet> {
  const form: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
  };
  const headers: Record<string, string> = {};
  if (config.basicAuth && config.clientSecret) {
    headers.authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
  } else if (config.clientSecret) {
    form.client_secret = config.clientSecret;
  }
  return postForm<TokenSet>(config.tokenUrl, form, { headers });
}

/** Shared by every OAuth adapter's login dialog. */
export const OAUTH_FIELDS = (provider: string, where: string) => [
  { key: "clientId", label: "Client id", help: `From your ${provider} app at ${where}` },
  { key: "clientSecret", label: "Client secret", secret: true, optional: true },
];

export const REDIRECT_NOTE = `Add ${REDIRECT_URI} as an allowed redirect URI on the app first, or the browser step will fail.`;
