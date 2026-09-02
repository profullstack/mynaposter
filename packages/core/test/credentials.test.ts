/**
 * The security-critical half of cloud auth, which is testable without Postgres.
 * The SQL around it is not covered here — see the note in the README.
 */
import { test, expect } from "bun:test";
import {
  assertSealedBundle,
  checkPassword,
  hashPassword,
  hashToken,
  newToken,
  normalizeEmail,
  verifyPassword,
} from "../../../apps/api/src/credentials.ts";

test("a password verifies against its own hash", () => {
  const stored = hashPassword("a long enough password");
  expect(verifyPassword("a long enough password", stored)).toBe(true);
});

test("a wrong password does not", () => {
  const stored = hashPassword("a long enough password");
  expect(verifyPassword("a long enough passwerd", stored)).toBe(false);
  expect(verifyPassword("", stored)).toBe(false);
});

test("the same password hashes differently every time", () => {
  // Per-user salt: two accounts with the same password must not look alike.
  const a = hashPassword("a long enough password");
  const b = hashPassword("a long enough password");
  expect(a.hash).not.toBe(b.hash);
  expect(a.salt).not.toBe(b.salt);
  expect(verifyPassword("a long enough password", a)).toBe(true);
  expect(verifyPassword("a long enough password", b)).toBe(true);
});

test("the plaintext never appears in what gets stored", () => {
  const stored = hashPassword("correct horse battery staple");
  expect(JSON.stringify(stored)).not.toContain("correct horse");
});

test("verification uses the parameters on the row, not today's constants", () => {
  // So N can be raised later without invalidating every password already stored.
  const stored = hashPassword("a long enough password");
  const weaker = { ...stored, params: { ...stored.params, N: 1024 } };
  // Same params as were used to hash -> still true; different -> false.
  expect(verifyPassword("a long enough password", stored)).toBe(true);
  expect(verifyPassword("a long enough password", weaker)).toBe(false);
});

test("a missing, empty or malformed hash is a refusal, never a pass", () => {
  // Buffer.from(_, "hex") drops invalid characters silently, so a malformed
  // row once decoded to zero bytes and compared equal to another zero bytes.
  // Any account in that state accepted any password.
  expect(verifyPassword("anything", { hash: null, salt: null })).toBe(false);
  expect(verifyPassword("anything", {})).toBe(false);
  expect(verifyPassword("anything", { hash: "", salt: "" })).toBe(false);
  expect(verifyPassword("anything", { hash: "zz", salt: "zz" })).toBe(false);
  expect(verifyPassword("anything", { hash: "not hex at all", salt: "nope" })).toBe(false);
  // Well-formed hex, but far too short to be a real scrypt output.
  expect(verifyPassword("anything", { hash: "abcd", salt: "abcd" })).toBe(false);
  // Odd-length hex.
  expect(verifyPassword("anything", { hash: "abc", salt: "abc" })).toBe(false);
});

test("short passwords are refused", () => {
  expect(() => checkPassword("short")).toThrow(/at least 10/);
  expect(() => hashPassword("short")).toThrow(/at least 10/);
  expect(() => checkPassword("just long enough")).not.toThrow();
});

test("emails are normalized, and nonsense is refused", () => {
  expect(normalizeEmail("  Alice@Example.COM ")).toBe("alice@example.com");
  expect(() => normalizeEmail("not-an-email")).toThrow();
  expect(() => normalizeEmail("a@b")).toThrow();
  expect(() => normalizeEmail("")).toThrow();
});

test("tokens are unguessable and stored only as a hash", () => {
  const token = newToken();
  expect(token.startsWith("myna_")).toBe(true);
  // 32 random bytes in base64url.
  expect(token.length).toBeGreaterThan(40);
  expect(newToken()).not.toBe(token);

  const digest = hashToken(token);
  expect(digest).toHaveLength(64);
  expect(digest).not.toContain(token.slice(5));
  expect(hashToken(token)).toBe(digest);
});

test("the server refuses to store anything that is not a sealed bundle", () => {
  // The point of the whole design: no readable credential ever rests up there.
  expect(() => assertSealedBundle(JSON.stringify({ myna: "bundle", data: "abc" }))).not.toThrow();
  expect(() => assertSealedBundle(JSON.stringify({ accounts: [{ token: "oops" }] }))).toThrow(/not a sealed myna bundle/);
  expect(() => assertSealedBundle(JSON.stringify({ myna: "bundle" }))).toThrow(/not a sealed/);
  expect(() => assertSealedBundle("not json at all")).toThrow(/not a myna bundle/);
});
