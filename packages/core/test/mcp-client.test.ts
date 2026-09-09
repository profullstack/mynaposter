/**
 * The MCP client myna uses to talk to somebody else's server.
 *
 * The three things worth pinning: a tool result is content blocks and the JSON
 * has to be dug out of them, a server is allowed to answer over SSE instead of
 * JSON, and a tool that fails says so inside a successful HTTP response — read
 * that as success and a rejected listing looks submitted.
 */
import { test, expect, afterEach } from "bun:test";
import { McpClient, McpToolError, parseMessage } from "../src/directories/mcp.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Call {
  method: string;
  params: Record<string, unknown>;
  headers: Headers;
}

/** A stub MCP server. `reply` answers one `tools/call`. */
function stubServer(reply: (params: Record<string, unknown>) => { body: string; contentType: string }): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? {});
    const message = JSON.parse(String(init?.body ?? "{}")) as {
      id?: number;
      method: string;
      params?: Record<string, unknown>;
    };
    calls.push({ method: message.method, params: message.params ?? {}, headers });

    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

    if (message.method === "initialize") {
      return json({
        jsonrpc: "2.0",
        id: message.id,
        result: { protocolVersion: "2025-06-18", serverInfo: { name: "stub", version: "1" } },
      });
    }
    // A notification expects no reply at all.
    if (message.method.startsWith("notifications/")) return new Response("", { status: 202 });

    if (message.method === "tools/call") {
      const { body, contentType } = reply(message.params ?? {});
      return new Response(body, { status: 200, headers: { "content-type": contentType } });
    }
    throw new Error(`unexpected method: ${message.method}`);
  }) as typeof fetch;
  return calls;
}

const toolResponse = (id: number, payload: unknown, isError = false) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: JSON.stringify(payload) }], ...(isError ? { isError: true } : {}) },
  });

test("a tool result's JSON comes back parsed, not as a content block", async () => {
  stubServer(() => ({ body: toolResponse(2, { id: "abc", name: "Widget" }), contentType: "application/json" }));

  const client = new McpClient({ url: "https://directory.test/api/mcp", token: "sr_key" });
  const result = await client.call<{ id: string; name: string }>("create_listing", { name: "Widget" });

  expect(result).toEqual({ id: "abc", name: "Widget" });
});

test("the handshake happens once, however many tools are called", async () => {
  const calls = stubServer(() => ({ body: toolResponse(2, []), contentType: "application/json" }));

  const client = new McpClient({ url: "https://directory.test/api/mcp" });
  await client.call("list_categories");
  await client.call("list_categories");

  expect(calls.filter((call) => call.method === "initialize")).toHaveLength(1);
  expect(calls.filter((call) => call.method === "tools/call")).toHaveLength(2);
});

test("the API key travels as a bearer token on every call", async () => {
  const calls = stubServer(() => ({ body: toolResponse(2, {}), contentType: "application/json" }));

  await new McpClient({ url: "https://directory.test/api/mcp", token: "sr_secret" }).call("create_listing");

  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) expect(call.headers.get("authorization")).toBe("Bearer sr_secret");
});

test("a server answering over SSE is read the same as one answering JSON", async () => {
  stubServer(() => ({
    body: `event: message\ndata: ${toolResponse(2, { id: "sse" })}\n\n`,
    contentType: "text/event-stream",
  }));

  const result = await new McpClient({ url: "https://directory.test/api/mcp" }).call<{ id: string }>("get_product");
  expect(result.id).toBe("sse");
});

test("a tool that reports isError throws rather than returning its message as data", async () => {
  stubServer(() => ({
    body: toolResponse(2, "That website is already listed.", true),
    contentType: "application/json",
  }));

  const client = new McpClient({ url: "https://directory.test/api/mcp", token: "sr_key" });
  const failure = client.call("create_listing", { website: "https://taken.test" });

  await expect(failure).rejects.toThrow(McpToolError);
  await expect(failure).rejects.toThrow(/already listed/);
});

test("parseMessage finds the message whatever the transport wrapped it in", () => {
  const message = '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}';

  expect(parseMessage(message, "application/json")?.result).toEqual({ ok: true });
  expect(parseMessage(`: keep-alive\ndata: ${message}\n\n`, "text/event-stream")?.result).toEqual({ ok: true });
  // A body that is not a message at all must read as nothing, not as an empty
  // success: the caller turns null into "the server sent no response".
  expect(parseMessage("<html>502</html>", "text/html")).toBeNull();
  expect(parseMessage("", "application/json")).toBeNull();
});
