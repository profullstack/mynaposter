/**
 * The dashboard's session cookie, without a database.
 *
 * What has to hold: the cookie is HttpOnly, Secure, SameSite=Strict and
 * scoped to /api; the bearer header wins over it; and the cookie is only
 * read on GET and HEAD, so no write anywhere in the API can ride on it.
 */
import { test, expect } from "bun:test";
import { clearedCookie, COOKIE, readCookie, sessionCookie, tokenFrom } from "../src/session.ts";

const request = (method: string, headers: Record<string, string>) => ({
  method,
  header: (name: string) => headers[name.toLowerCase()],
});

test("the cookie cannot be read by script, crosses no site and reaches only the API", () => {
  const cookie = sessionCookie("myna_abc");
  expect(cookie.startsWith(`${COOKIE}=myna_abc;`)).toBe(true);
  for (const part of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/api", "Max-Age=2592000"]) expect(cookie).toContain(part);
  expect(clearedCookie()).toContain("Max-Age=0");
  expect(clearedCookie()).toContain("Path=/api");
});

test("one cookie is picked out of a header carrying several", () => {
  expect(readCookie(`a=1; ${COOKIE}=myna_x%2By; b=2`)).toBe("myna_x+y");
  expect(readCookie("a=1; b=2")).toBe("");
  expect(readCookie(undefined)).toBe("");
  expect(readCookie(`not_${COOKIE}=nope`)).toBe("");
});

test("bearer first; the cookie only on a read", () => {
  const cookie = `${COOKIE}=myna_cookie`;
  expect(tokenFrom(request("GET", { authorization: "Bearer myna_bearer", cookie }))).toBe("myna_bearer");
  expect(tokenFrom(request("GET", { cookie }))).toBe("myna_cookie");
  expect(tokenFrom(request("HEAD", { cookie }))).toBe("myna_cookie");
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(tokenFrom(request(method, { cookie }))).toBe("");
  expect(tokenFrom(request("POST", { authorization: "Bearer myna_bearer", cookie }))).toBe("myna_bearer");
  expect(tokenFrom(request("GET", {}))).toBe("");
});
