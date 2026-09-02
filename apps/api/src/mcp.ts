/**
 * MCP over HTTP.
 *
 * The stdio server suits an assistant that can launch a subprocess. This is for
 * the ones that cannot — a hosted agent, something in a browser, anything that
 * only has a URL. It serves the same tool table as `packages/mcp`, imported
 * rather than restated, so the two transports cannot offer different things.
 *
 * The transport is one JSON-RPC message per POST, which is the subset of
 * streamable HTTP that request/response tools need. There is no long-lived
 * stream because nothing here streams: every tool answers once.
 */
import { VERSION } from "@profullstack/myna-core";
import { TOOLS, callTool } from "@profullstack/myna-mcp/tools";

const PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const ok = (id: JsonRpcRequest["id"], result: unknown) => ({ jsonrpc: "2.0" as const, id, result });

const fail = (id: JsonRpcRequest["id"], code: number, message: string) => ({
  jsonrpc: "2.0" as const,
  id,
  error: { code, message },
});

/**
 * Handle one JSON-RPC message.
 * Returns null for a notification, which by the spec gets no reply at all.
 */
export async function handleMcp(message: JsonRpcRequest): Promise<object | null> {
  const { id = null, method, params = {} } = message ?? ({} as JsonRpcRequest);

  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "myna", version: VERSION },
        instructions:
          "myna posts to social networks. Call myna_accounts first to see what is connected; " +
          "posting to an account that is not connected will fail. myna_post publishes immediately " +
          "and several networks cannot delete afterwards, so confirm wording with the user and use " +
          "myna_preview or dry_run when unsure.",
      });

    // Notifications carry no id and expect no response.
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return ok(id, {});

    case "tools/list":
      return ok(id, { tools: TOOLS });

    case "tools/call": {
      const name = String(params.name ?? "");
      if (!name) return fail(id, -32602, "tools/call needs a tool name");
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      return ok(id, await callTool(name, args));
    }

    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}

/** A whole POST body, which may be one message or a batch. */
export async function handleMcpBody(body: unknown): Promise<object | object[] | null> {
  if (Array.isArray(body)) {
    const replies = await Promise.all(body.map((message) => handleMcp(message as JsonRpcRequest)));
    const answered = replies.filter((reply): reply is object => reply !== null);
    return answered.length ? answered : null;
  }
  return handleMcp(body as JsonRpcRequest);
}
