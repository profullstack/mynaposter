/**
 * Paste-the-code sign-in.
 *
 * The loopback redirect only works when the browser is on the same machine as
 * myna, which rules out every SSH session. Three browser flows timed out
 * unclicked before this existed.
 */
import { test, expect } from "bun:test";
import { callbackFrom, HOSTED_REDIRECT_URI, REDIRECT_URI, PASTE_FIELD } from "../src/net/oauth2.ts";
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
