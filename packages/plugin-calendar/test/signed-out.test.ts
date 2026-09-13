/**
 * The message when Google will no longer refresh a calendar account.
 *
 * What would be embarrassing: a raw "400 oauth2.googleapis.com/token" on every
 * queued post for a week, or a real outage dressed up as a sign-out.
 */
import { describe, expect, test } from "bun:test";
import { signedOutMessage } from "../src/index.ts";

describe("signedOutMessage", () => {
  test("a revoked refresh token says who was signed out and what to run", () => {
    const text = signedOutMessage(
      "gcal:me@example.com",
      new Error("400 oauth2.googleapis.com/token — Token has been expired or revoked."),
    );
    expect(text).toContain("Google has signed gcal:me@example.com out");
    expect(text).toContain("Token has been expired or revoked.");
    expect(text).toContain("Run: myna login gcal");
    expect(text).toContain("seven days");
  });

  test("invalid_grant from a bare body is the same sign-out", () => {
    expect(signedOutMessage("gcal:x", "invalid_grant")).toContain("Run: myna login gcal");
  });

  test("anything else is not a sign-out", () => {
    expect(signedOutMessage("gcal:x", new Error("503 oauth2.googleapis.com/token — Service Unavailable"))).toBeNull();
    expect(signedOutMessage("gcal:x", new TypeError("fetch failed"))).toBeNull();
  });
});
