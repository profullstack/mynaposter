/**
 * An update to an agenticjobs board goes through the board's own MCP tool.
 *
 * Against a stubbed board: the handshake, then tools/call post_update with the
 * body, the trailing link moved into the link field, and the employer. A board
 * with no MCP endpoint is answered over REST instead; a board that refuses the
 * update over MCP (five a day, same text twice) is not retried over REST,
 * because that would be the sixth.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { agenticjobs, transportOf } from "../src/net/adapters/agenticjobs.ts";
import type { Account } from "../src/net/types.ts";

const account: Account = {
  id: "agenticjobs:me@example.com",
  network: "agenticjobs",
  handle: "me@example.com",
  addedAt: "",
  creds: { token: "tok" },
  meta: { instance: "https://board.example", org: "" },
};

interface Seen {
  url: string;
  method: string;
  auth: string | null;
  body: unknown;
}

let seen: Seen[] = [];
let mode: "mcp" | "no-mcp" | "refuse" = "mcp";
const realFetch = globalThis.fetch;

const json = (value: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });

beforeEach(() => {
  seen = [];
  mode = "mcp";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers((init?.headers ?? {}) as Record<string, string>);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    seen.push({ url, method: init?.method ?? "GET", auth: headers.get("authorization"), body });

    if (url.endsWith("/api/mcp")) {
      if (mode === "no-mcp") return new Response("Not found", { status: 404 });
      const { id, method, params } = body as { id?: number; method: string; params?: Record<string, unknown> };
      if (method === "initialize") {
        return json({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "agenticjobs", version: "0.15.0" }, capabilities: {} } }, 200, { "mcp-session-id": "s1" });
      }
      if (method === "notifications/initialized") return new Response(null, { status: 202 });
      if (method === "tools/call") {
        const name = (params as { name: string }).name;
        const args = (params as { arguments: Record<string, string> }).arguments;
        if (mode === "refuse") {
          return json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Five updates today already." }], isError: true } });
        }
        const posted = { update: { id: "u1", body: args.body, link: args.link ?? null, createdAt: "", author: { kind: "candidate", name: "Me", slug: "me" } }, author: "https://board.example/candidates/me" };
        return json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Posted with ${name}.` }], structuredContent: posted } });
      }
      return json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    }
    if (url.endsWith("/api/v1/updates")) {
      return json({ update: { id: "rest1", body: (body as { body: string }).body, link: null, createdAt: "", author: { kind: "candidate", name: "Me", slug: "me" } }, author: "https://board.example/candidates/me" }, 201);
    }
    return new Response("nope", { status: 500 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.MYNA_AGENTICJOBS_TRANSPORT;
});

test("an update goes through the board's post_update tool, link split out, as the employer asked for", async () => {
  const result = await agenticjobs.post(account, { text: "We closed the backend role. Two more open next month. https://acme.dev/jobs", extra: { org: "acme" } });

  const calls = seen.filter((entry) => entry.url.endsWith("/api/mcp")).map((entry) => (entry.body as { method: string }).method);
  expect(calls).toEqual(["initialize", "notifications/initialized", "tools/call"]);
  const call = seen.find((entry) => (entry.body as { method?: string })?.method === "tools/call")!;
  expect(call.auth).toBe("Bearer tok");
  expect((call.body as { params: unknown }).params).toEqual({
    name: "post_update",
    arguments: { body: "We closed the backend role. Two more open next month.", link: "https://acme.dev/jobs", org: "acme" },
  });
  expect(seen.some((entry) => entry.url.endsWith("/api/v1/updates"))).toBe(false);
  expect(result).toEqual({ id: "u1", url: "https://board.example/candidates/me#u1" });
});

test("a board with no MCP endpoint is answered over REST", async () => {
  mode = "no-mcp";
  const result = await agenticjobs.post(account, { text: "Shipped the thing, finally." });
  expect(seen.map((entry) => entry.url.split("/").slice(-2).join("/"))).toEqual(["api/mcp", "v1/updates"]);
  expect(result.id).toBe("rest1");
});

test("a refusal from the tool is the board's answer and is not retried over REST", async () => {
  mode = "refuse";
  await expect(agenticjobs.post(account, { text: "Sixth update of the day, surely fine." })).rejects.toThrow(/Five updates today already/);
  expect(seen.some((entry) => entry.url.endsWith("/api/v1/updates"))).toBe(false);
});

test("REST can be chosen per account or by the environment", async () => {
  expect(transportOf(account)).toBe("mcp");
  expect(transportOf({ ...account, meta: { ...account.meta, transport: "rest" } })).toBe("rest");
  process.env.MYNA_AGENTICJOBS_TRANSPORT = "rest";
  expect(transportOf(account)).toBe("rest");
  const result = await agenticjobs.post(account, { text: "Straight to the REST door this time." });
  expect(seen.map((entry) => entry.url.split("/").slice(-2).join("/"))).toEqual(["v1/updates"]);
  expect(result.id).toBe("rest1");
});
