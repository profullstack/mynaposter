/**
 * mynaposter.com/api is the API: the prefix comes off, the API's own /api/mcp
 * stays reachable, and the forward carries method, body and query through.
 */
import { test, expect } from "bun:test";
import { apiPath, forward } from "../src/proxy.ts";

test("site paths map onto API paths", () => {
  expect(apiPath("/")).toBeNull();
  expect(apiPath("/apiary")).toBeNull();
  expect(apiPath("/api")).toBe("/");
  expect(apiPath("/api/")).toBe("/");
  expect(apiPath("/api/health")).toBe("/health");
  expect(apiPath("/api/v1/accounts")).toBe("/v1/accounts");
  expect(apiPath("/api/v1/reshare/profile.md")).toBe("/v1/reshare/profile.md");
  expect(apiPath("/api/mcp")).toBe("/api/mcp");
  expect(apiPath("/api/api/mcp")).toBe("/api/mcp");
});

test("the forward keeps method, query, body and headers, and says so when the API is down", async () => {
  const upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      return Response.json({ path: url.pathname, query: url.search, method: request.method, auth: request.headers.get("authorization"), host: request.headers.get("x-forwarded-host"), body: await request.text() });
    },
  });
  try {
    const base = `http://127.0.0.1:${upstream.port}`;
    const request = new Request("https://mynaposter.com/api/v1/post?dry=1", { method: "POST", headers: { authorization: "Bearer t", host: "mynaposter.com" }, body: "{\"text\":\"hi\"}" });
    const answer = await forward(request, apiPath("/api/v1/post") as string, base);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ path: "/v1/post", query: "?dry=1", method: "POST", auth: "Bearer t", host: "mynaposter.com", body: "{\"text\":\"hi\"}" });

    const down = await forward(new Request("https://mynaposter.com/api/health"), "/health", "http://127.0.0.1:9");
    expect(down.status).toBe(502);
    expect(((await down.json()) as { error: string }).error).toMatch(/not answering/);
  } finally {
    upstream.stop(true);
  }
});
