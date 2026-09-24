/**
 * Relay sign-in: the provider redirects to the registered HTTPS page, which
 * hands the code straight back to myna's loopback listener.
 *
 * Google "Web application" clients only redirect to URLs listed on the client.
 * The loopback URL was not listed, so `myna login gcal` failed with
 * redirect_uri_mismatch (2026-09-22) and the only way in was pasting a code.
 */
import { test, expect } from "bun:test";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { authorize, CALLBACK_PORT } from "../src/net/oauth2.ts";
import type { LoginContext } from "../src/net/types.ts";

const HOSTED = "https://mynaposter.com/api/v1/google/oauth/callback";

test("relay: registered page in the link, port in the state, code comes back to loopback", async () => {
  let tokenForm: URLSearchParams | undefined;
  const tokenServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      tokenForm = new URLSearchParams(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "AT", refresh_token: "RT", expires_in: 3600 }));
    });
  });
  await new Promise<void>((r) => tokenServer.listen(0, "127.0.0.1", r));
  const tokenPort = (tokenServer.address() as { port: number }).port;

  let link!: URL;
  const ctx: LoginContext = {
    report: () => {},
    // Play the provider and the hosted page: redirect to the registered URL, which relays to loopback.
    openUrl: async (url) => {
      link = new URL(url);
      const state = link.searchParams.get("state")!;
      const port = /^lb(\d+)\./.exec(state)![1];
      await fetch(`http://127.0.0.1:${port}/callback?code=THECODE&state=${encodeURIComponent(state)}`);
    },
  };

  const tokens = await authorize(
    { authorizeUrl: "https://provider.test/authorize", tokenUrl: `http://127.0.0.1:${tokenPort}/token`, clientId: "id", clientSecret: "s", scopes: ["cal"], mode: "relay", redirectUri: HOSTED },
    ctx,
    10_000,
  );
  tokenServer.close();

  expect(tokens.access_token).toBe("AT");
  expect(link.searchParams.get("redirect_uri")).toBe(HOSTED);
  expect(link.searchParams.get("state")!.startsWith(`lb${CALLBACK_PORT}.`)).toBe(true);
  // The exchange must name the redirect the code was issued for: the hosted page, not loopback.
  expect(tokenForm!.get("redirect_uri")).toBe(HOSTED);
  expect(tokenForm!.get("code")).toBe("THECODE");
  expect(tokenForm!.get("code_verifier")).toBeTruthy();
});

test("relay without a registered page is refused up front", async () => {
  const ctx: LoginContext = { report: () => {}, openUrl: async () => {} };
  await expect(authorize({ authorizeUrl: "https://p/a", tokenUrl: "https://p/t", clientId: "id", scopes: [], mode: "relay" }, ctx, 1000)).rejects.toThrow(/registered redirect/);
});

/** Run the hosted page's script against a fake browser and report where it navigated. */
function runPage(search: string): string | null {
  const src = readFileSync(new URL("../../../apps/web/assets/oauth-callback.js", import.meta.url), "utf8");
  let navigated: string | null = null;
  const el = () => ({ textContent: "", hidden: false, classList: { add() {}, remove() {} }, addEventListener() {}, innerHTML: "", value: "" });
  const els: Record<string, ReturnType<typeof el>> = {};
  const document = { getElementById: (id: string) => (els[id] ??= el()), createElement: () => el() };
  const location = { search, pathname: "/api/v1/google/oauth/callback", replace: (u: string) => { navigated = u; } };
  const history = { replaceState() {} };
  try {
    new Function("document", "location", "history", "navigator", "URLSearchParams", "setTimeout", src)(document, location, history, {}, URLSearchParams, setTimeout);
  } catch (e) {
    if ((e as Error).message !== "relayed") throw e;
  }
  return navigated;
}

test("hosted page relays a myna state to loopback, with the query intact", () => {
  expect(runPage("?code=abc&state=lb8765.xyz")).toBe("http://127.0.0.1:8765/callback?code=abc&state=lb8765.xyz");
  expect(runPage("?error=access_denied&state=lb8765.xyz")).toBe("http://127.0.0.1:8765/callback?error=access_denied&state=lb8765.xyz");
});

test("hosted page never relays anything else", () => {
  expect(runPage("?code=abc&state=plainstate")).toBeNull(); // paste mode: show the code
  expect(runPage("?code=abc&state=lb80.x")).toBeNull(); // privileged port
  expect(runPage("?code=abc&state=lb99999.x")).toBeNull(); // not a port
  expect(runPage("?code=abc&state=lbevil.com.x")).toBeNull(); // not a number
});
