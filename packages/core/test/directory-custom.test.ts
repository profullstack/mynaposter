/**
 * A directory reached by URL, with no adapter written for it.
 *
 * The whole point is that the server describes itself, so these cover the
 * describing: finding the tool that creates a listing whatever it is called,
 * and calling myna's fields by whatever names that tool's schema uses. A
 * directory whose field is `product_url` must work without a line of code
 * here, and that is what the second test asserts.
 */
import { test, expect, afterEach } from "bun:test";
import { mcpDirectory, resolveTools } from "../src/directories/custom.ts";
import type { McpTool } from "../src/directories/mcp.ts";
import type { DirectoryAccount } from "../src/directories/types.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const tool = (name: string, properties: Record<string, unknown> = {}, required: string[] = []): McpTool => ({
  name,
  description: `${name} does a thing.`,
  inputSchema: { type: "object", properties, required },
});

const str = { type: "string" };

const account: DirectoryAccount = {
  directory: "elsewhere",
  handle: "elsewhere.test",
  addedAt: new Date().toISOString(),
  creds: { key: "key_123" },
  meta: { url: "https://elsewhere.test/api/mcp" },
};

/** A stub MCP server with a given tool table; records every tools/call. */
function stubServer(tools: McpTool[], result: unknown = {}): Array<{ name: string; args: Record<string, unknown> }> {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const message = JSON.parse(String(init?.body ?? "{}")) as {
      id?: number;
      method: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    const json = (value: unknown) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: value }), {
        headers: { "content-type": "application/json" },
      });

    if (message.method === "initialize") return json({ protocolVersion: "2025-06-18" });
    if (message.method.startsWith("notifications/")) return new Response("", { status: 202 });
    if (message.method === "tools/list") return json({ tools });
    if (message.method === "tools/call") {
      calls.push({ name: message.params?.name ?? "", args: message.params?.arguments ?? {} });
      return json({ content: [{ type: "text", text: JSON.stringify(result) }] });
    }
    throw new Error(`unexpected method: ${message.method}`);
  }) as unknown as typeof fetch;
  return calls;
}

test("the tool that creates a listing is found whatever it is called", () => {
  const resolved = resolveTools([tool("search"), tool("submit_product", { title: str, product_url: str })]);
  expect(resolved.tools.get("create")).toBe("submit_product");
  expect(resolved.fields.get("name")).toBe("title");
  expect(resolved.fields.get("website")).toBe("product_url");
});

test("a name myna would not guess can be given outright", () => {
  const tools = [tool("weird_create_thing", { name: str })];
  expect(resolveTools(tools, { create: "weird_create_thing" }).tools.get("create")).toBe("weird_create_thing");
  // And naming one the server does not have says what it does have.
  expect(() => resolveTools(tools, { create: "nope" })).toThrow(/weird_create_thing/);
});

test("a server with no create tool resolves to no create tool, rather than guessing", () => {
  expect(resolveTools([tool("search_products"), tool("get_product")]).tools.get("create")).toBeUndefined();
});

test("myna's fields are sent under the names that server's schema uses", async () => {
  const calls = stubServer(
    [tool("create_listing", { title: str, product_url: str, summary: str, keywords: { type: "array" } }, ["title", "product_url"])],
    { id: "x1", title: "Widget", product_url: "https://widget.test", status: "pending" },
  );

  const directory = mcpDirectory({ id: "elsewhere", url: "https://elsewhere.test/api/mcp" });
  const listing = await directory.submit(account, {
    name: "Widget",
    website: "https://widget.test",
    description: "Widget frobs things.",
    tags: ["frobbing"],
    // This server's create tool declares no category, so it must not be sent.
    category: "Software",
  });

  expect(calls).toHaveLength(1);
  expect(calls[0].args).toEqual({
    title: "Widget",
    product_url: "https://widget.test",
    summary: "Widget frobs things.",
    keywords: ["frobbing"],
  });
  // And the answer is read back through the same synonyms.
  expect(listing.id).toBe("x1");
  expect(listing.name).toBe("Widget");
  expect(listing.website).toBe("https://widget.test");
  expect(listing.status).toBe("pending");
});

test("a field the server marks required, and myna has not got, fails before the call", async () => {
  const calls = stubServer([tool("create_listing", { name: str, website: str, pricing_model: str }, ["name", "website", "pricing_model"])]);

  const directory = mcpDirectory({ id: "elsewhere", url: "https://elsewhere.test/api/mcp" });
  const failure = directory.submit(account, { name: "Widget", website: "https://widget.test", description: "Frobs." });

  await expect(failure).rejects.toThrow(/pricing_model/);
  expect(calls).toHaveLength(0);
});

test("a job the server has no tool for says so, and names what it does offer", async () => {
  stubServer([tool("create_listing", { name: str, website: str, description: str })]);
  const directory = mcpDirectory({ id: "elsewhere", url: "https://elsewhere.test/api/mcp" });

  await expect(directory.listings(account)).rejects.toThrow(/create_listing/);
});

test("rows come back whatever wrapper the server put them in", async () => {
  stubServer([tool("list_categories")], { categories: [{ name: "Analytics", count: 3 }, { name: "Design" }] });
  const directory = mcpDirectory({ id: "elsewhere", url: "https://elsewhere.test/api/mcp" });

  expect(await directory.categories!(account)).toEqual([
    { name: "Analytics", count: 3 },
    { name: "Design", count: undefined },
  ]);
});

test("a URL that is not http is refused when the directory is built, not when it is used", () => {
  expect(() => mcpDirectory({ id: "elsewhere", url: "ftp://elsewhere.test" })).toThrow(/not an http/);
  expect(() => mcpDirectory({ id: "", url: "https://elsewhere.test/api/mcp" })).toThrow(/needs an id/);
});

test("signing in reads the tool table, and refuses a server that cannot take a listing", async () => {
  stubServer([tool("search_products"), tool("get_product")]);
  const directory = mcpDirectory({ id: "elsewhere", url: "https://elsewhere.test/api/mcp" });
  const reported: string[] = [];

  await expect(
    directory.login({ key: "key_123" }, { report: (line) => reported.push(line), openUrl: async () => {} }),
  ).rejects.toThrow(/no tool that creates a listing/);

  // And with no key at all it never reaches the network.
  await expect(
    directory.login({}, { report: (line) => reported.push(line), openUrl: async () => {} }),
  ).rejects.toThrow(/API key is required/);
});
