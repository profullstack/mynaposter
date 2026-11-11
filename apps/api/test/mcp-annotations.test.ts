/**
 * Every MCP tool carries a human title and all of the behaviour hints, on the
 * wire. Connector directories reject a server where any tool lacks them, and a
 * client uses the hints to decide what to confirm with the person first.
 */
import { test, expect } from "bun:test";
import { handleMcp } from "../src/mcp.ts";

interface ListedTool {
  name: string;
  title?: string;
  annotations?: Record<string, unknown>;
}

const listed = async (): Promise<{ tools: ListedTool[] } & Record<string, unknown>> => {
  const reply = (await handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: never };
  return reply.result;
};

test("tools/list gives every tool a title and readOnly/destructive/openWorld hints", async () => {
  const { tools } = await listed();
  expect(tools.length).toBe(63);
  for (const tool of tools) {
    expect(typeof tool.title, tool.name).toBe("string");
    expect(tool.title!.length, tool.name).toBeGreaterThan(0);
    expect(tool.annotations?.title, tool.name).toBe(tool.title);
    for (const hint of ["readOnlyHint", "destructiveHint", "openWorldHint", "idempotentHint"]) {
      expect(typeof tool.annotations?.[hint], `${tool.name}.${hint}`).toBe("boolean");
    }
    // A read never destroys.
    if (tool.annotations?.readOnlyHint) expect(tool.annotations.destructiveHint, tool.name).toBe(false);
  }
});

test("publishing, sending and deleting tools are marked destructive", async () => {
  const { tools } = await listed();
  const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations!]));
  for (const name of ["myna_post", "myna_newsletter_send", "myna_directory_submit", "delete_webhook", "myna_newsletter_delete"]) {
    expect(hints[name].destructiveHint, name).toBe(true);
    expect(hints[name].readOnlyHint, name).toBe(false);
  }
  for (const name of ["myna_accounts", "myna_preview", "myna_queue", "myna_history"]) {
    expect(hints[name].readOnlyHint, name).toBe(true);
  }
});

test("tools/list keeps the cache metadata Claude's client requires", async () => {
  const result = await listed();
  expect(result.resultType).toBe("complete");
  expect(typeof result.ttlMs).toBe("number");
  expect(result.cacheScope).toBe("public");
});
