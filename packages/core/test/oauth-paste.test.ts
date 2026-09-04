/**
 * Paste-the-code sign-in.
 *
 * The loopback redirect only works when the browser is on the same machine as
 * myna, which rules out every SSH session. Three browser flows timed out
 * unclicked before this existed.
 */
import { test, expect } from "bun:test";
import { authorize, callbackFrom, HOSTED_REDIRECT_URI, REDIRECT_URI, PASTE_FIELD } from "../src/net/oauth2.ts";
import { linkedin, LINKEDIN_REDIRECT_URI } from "../src/net/adapters/professional.ts";
import type { LoginContext } from "../src/net/types.ts";

const ctx = (over: Partial<LoginContext> = {}): LoginContext => ({
  report: () => {},
  openUrl: async () => {},
  ...over,
});

test("loopback stays the default", () => {
  expect(callbackFrom({}, ctx()).mode).toBe("loopback");
  expect(callbackFrom({ paste: "" }, ctx()).mode).toBe("loopback");
  expect(callbackFrom({ paste: "no" }, ctx()).mode).toBe("loopback");
});

test("the ways a person says yes all work", () => {
  for (const answer of ["y", "yes", "YES", "Yes", "true", "1", " yes "]) {
    expect(callbackFrom({ paste: answer }, ctx({ ask: async () => "x" })).mode, answer).toBe("paste");
  }
});

test("paste mode needs somewhere to ask, and says so", () => {
  // A desktop or API caller with no prompt must fail clearly, not hang.
  expect(() => callbackFrom({ paste: "yes" }, ctx())).toThrow(/cannot ask for a pasted code/);
});

test("the reader opens the link and returns what was pasted", async () => {
  let opened = "";
  const config = callbackFrom(
    { paste: "yes" },
    ctx({ openUrl: async (url) => { opened = url; }, ask: async () => "  THECODE  " }),
  );
  expect(await config.readCode!("https://example.com/authorize")).toBe("  THECODE  ");
  expect(opened).toBe("https://example.com/authorize");
});

test("the two redirects are different, and the hosted one is https", () => {
  // They must differ: the token exchange has to send back the exact redirect
  // the code was issued for, or the provider rejects it.
  expect(REDIRECT_URI).toContain("127.0.0.1");
  expect(HOSTED_REDIRECT_URI.startsWith("https://")).toBe(true);
  expect(HOSTED_REDIRECT_URI).not.toBe(REDIRECT_URI);
});

test("the field is optional, so it never blocks a normal login", () => {
  expect(PASTE_FIELD.optional).toBe(true);
  expect(PASTE_FIELD.key).toBe("paste");
});

/** Run authorize() up to the moment it hands over the link, then stop. */
async function authorizeLink(over: Record<string, unknown>): Promise<URL> {
  let link = "";
  await authorize(
    {
      authorizeUrl: "https://provider.test/authorize",
      tokenUrl: "https://provider.test/token",
      clientId: "id",
      scopes: [],
      mode: "paste",
      readCode: async (url) => { link = url; throw new Error("stop here"); },
      ...over,
    },
    ctx(),
  ).catch(() => {});
  return new URL(link);
}

test("paste mode sends the shared hosted redirect by default", async () => {
  const link = await authorizeLink({});
  expect(link.searchParams.get("redirect_uri")).toBe(HOSTED_REDIRECT_URI);
});

test("a provider can name its own redirect", async () => {
  const link = await authorizeLink({ redirectUri: "https://mynaposter.com/api/other/callback" });
  expect(link.searchParams.get("redirect_uri")).toBe("https://mynaposter.com/api/other/callback");
});

test("LinkedIn always goes through its HTTPS callback", async () => {
  // LinkedIn rejects http://127.0.0.1, so there is no loopback choice to offer
  // and the note has to say which URL to register.
  expect(LINKEDIN_REDIRECT_URI).toBe("https://mynaposter.com/api/linkedin/callback");
  expect(linkedin.auth.fields.map((field) => field.key)).not.toContain(PASTE_FIELD.key);
  expect(linkedin.auth.note).toContain(LINKEDIN_REDIRECT_URI);

  let link = "";
  await linkedin
    .login(
      { clientId: "id", clientSecret: "secret" },
      ctx({ ask: async (prompt) => { throw new Error(`stop at: ${prompt}`); }, openUrl: async (url) => { link = url; } }),
    )
    .catch(() => {});
  const url = new URL(link);
  expect(url.origin + url.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization");
  expect(url.searchParams.get("redirect_uri")).toBe(LINKEDIN_REDIRECT_URI);
  expect(url.searchParams.get("code_challenge")).toBeNull();
  expect(url.searchParams.get("scope")).toBe("openid profile w_member_social");
});

test("the link ends in state, so a clipped copy cannot damage the scope", async () => {
  // A real failure: the link copied out of a terminal one character short
  // sent LinkedIn scope=w_member_socia, which it refused as unknown.
  const link = await authorizeLink({ scopes: ["openid", "profile", "w_member_social"], pkce: true, authParams: { prompt: "consent" } });
  const keys = [...link.searchParams.keys()];
  expect(keys[keys.length - 1]).toBe("state");
  expect(link.searchParams.get("scope")).toBe("openid profile w_member_social");
});

test("LinkedIn asks for the organization scope only when a page is named", async () => {
  // A token with w_member_social alone posts as the member; an organization
  // author is refused at post time with an opaque "/author" validation error.
  const scopesFor = async (input: Record<string, string>): Promise<string | null> => {
    let link = "";
    await linkedin
      .login(input, ctx({ ask: async () => { throw new Error("stop"); }, openUrl: async (url) => { link = url; } }))
      .catch(() => {});
    return new URL(link).searchParams.get("scope");
  };
  expect(await scopesFor({ clientId: "id", clientSecret: "s" })).toBe("openid profile w_member_social");
  expect(await scopesFor({ clientId: "id", clientSecret: "s", organization: "80868393" })).toBe(
    "openid profile w_member_social w_organization_social",
  );
});
