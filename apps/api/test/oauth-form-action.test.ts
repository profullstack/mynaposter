/**
 * Chrome applies CSP form-action to the redirect after a form POST: the consent
 * page must allow the client's redirect origin or the sign-in never returns.
 */
import { test, expect } from "bun:test";
import { formActionFor } from "../src/oauth.ts";

test("form-action allows the client's redirect origin, and only that", () => {
  expect(formActionFor("https://claude.ai/api/mcp/auth_callback")).toBe("'self' https://claude.ai");
  expect(formActionFor("https://chatgpt.com/connector_platform_oauth_redirect")).toBe("'self' https://chatgpt.com");
  expect(formActionFor("http://127.0.0.1:8765/callback")).toBe("'self' http://127.0.0.1:8765");
  expect(formActionFor(undefined)).toBe("'self'");
  expect(formActionFor("javascript:alert(1)")).toBe("'self'");
  expect(formActionFor("not a url")).toBe("'self'");
});
