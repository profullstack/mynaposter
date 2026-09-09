/**
 * A small MCP client, for talking to somebody else's MCP server.
 *
 * myna already *serves* MCP (`packages/mcp`); this is the other direction. A
 * directory that accepts listings over MCP is a better target than a bespoke
 * REST client per directory: the tool table is discoverable, the argument
 * schemas come from the server, and a directory that adds a field does not
 * need a new myna release.
 *
 * Written against the JSON-RPC wire format rather than the MCP SDK for the
 * same reason saasrow's server is: the SDK's transports assume a long-lived
 * process, and every call here is one request and one response.
 *
 * Transport is "streamable HTTP". A server may answer a POST with either
 * `application/json` or a `text/event-stream` carrying one message, so both
 * are read. Session ids are echoed back when a server issues one, which keeps
 * this usable against stateful servers even though the ones we talk to are not.
 */
import { request, HttpError } from "../util/http.ts";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpServerInfo {
  protocolVersion: string;
  serverInfo?: { name?: string; version?: string; websiteUrl?: string };
  capabilities?: Record<string, unknown>;
  instructions?: string;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface ToolResult {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpClientOptions {
  url: string;
  /** Sent as `Authorization: Bearer …`. Omitted for the read-only tools. */
  token?: string;
  /** How myna introduces itself in `initialize`. */
  clientName?: string;
  clientVersion?: string;
  timeoutMs?: number;
}

/**
 * A tool that answered with `isError`. Kept distinct from a transport failure
 * so a caller can tell "the directory rejected this listing" (worth showing to
 * the person, verbatim) from "the directory is down" (worth retrying).
 */
export class McpToolError extends Error {
  constructor(
    readonly tool: string,
    message: string,
  ) {
    super(message);
    this.name = "McpToolError";
  }
}

export class McpClient {
  private nextId = 1;
  private sessionId?: string;
  private negotiated = MCP_PROTOCOL_VERSION;
  private ready?: Promise<McpServerInfo>;

  constructor(private readonly options: McpClientOptions) {
    if (!options.url) throw new Error("An MCP client needs a URL.");
  }

  get url(): string {
    return this.options.url;
  }

  /**
   * Handshake, at most once per client. Several call sites want to be sure the
   * server is there before doing anything; without the cached promise a
   * `submit` that lists categories first would shake hands twice.
   */
  initialize(): Promise<McpServerInfo> {
    this.ready ??= this.handshake();
    return this.ready;
  }

  private async handshake(): Promise<McpServerInfo> {
    const info = (await this.rpc("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: this.options.clientName ?? "myna",
        version: this.options.clientVersion ?? "0",
      },
    })) as McpServerInfo;
    if (typeof info?.protocolVersion === "string") this.negotiated = info.protocolVersion;
    // A notification: no id, and by the spec no reply is expected.
    await this.notify("notifications/initialized");
    return info;
  }

  async listTools(): Promise<McpTool[]> {
    await this.initialize();
    const result = (await this.rpc("tools/list", {})) as { tools?: McpTool[] };
    return result?.tools ?? [];
  }

  /**
   * Call one tool and return its payload already parsed.
   *
   * MCP tool results are content blocks, and a server that answers with JSON
   * puts it in a text block. Servers that also send `structuredContent` are
   * preferred where they do. A block that is not JSON comes back as a string,
   * which is what a tool that answers in prose means to return.
   */
  async call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    await this.initialize();
    const result = (await this.rpc("tools/call", { name, arguments: args })) as ToolResult;
    const text = (result?.content ?? [])
      .filter((block) => block?.type === "text" || typeof block?.text === "string")
      .map((block) => block.text ?? "")
      .join("\n")
      .trim();

    if (result?.isError) throw new McpToolError(name, text || `${name} failed.`);
    if (result?.structuredContent !== undefined) return result.structuredContent as T;
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      // A server may answer either way; say we take both.
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": this.negotiated,
    };
    if (this.options.token) headers.authorization = `Bearer ${this.options.token}`;
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    return headers;
  }

  private async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    try {
      await request(this.options.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ jsonrpc: "2.0", method, params }),
        timeoutMs: this.options.timeoutMs ?? 30_000,
      });
    } catch {
      // A notification that does not arrive changes nothing we can act on, and
      // failing the whole call here would turn a working server into an error.
    }
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    let response: Response;
    try {
      response = await request(this.options.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        timeoutMs: this.options.timeoutMs ?? 30_000,
      });
    } catch (error) {
      if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
        throw new Error(`${error.message} — the API key was rejected. Log in again.`);
      }
      throw error;
    }

    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;

    const body = await response.text();
    const message = parseMessage(body, response.headers.get("content-type") ?? "");
    if (!message) throw new Error(`${method}: the MCP server sent no JSON-RPC response.`);
    if (message.error) throw new Error(`${method}: ${message.error.message}`);
    return message.result;
  }
}

/**
 * Read one JSON-RPC message out of a response body.
 *
 * Plain JSON is the common case. An SSE body carries `data:` lines, possibly
 * several events, of which we want the first that parses — a server is allowed
 * to send comments and keep-alives around it.
 */
export function parseMessage(body: string, contentType: string): JsonRpcResponse | null {
  const text = body.trim();
  if (!text) return null;

  if (contentType.includes("text/event-stream") || text.startsWith("event:") || text.startsWith("data:")) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        return JSON.parse(payload) as JsonRpcResponse;
      } catch {
        continue;
      }
    }
    return null;
  }

  try {
    return JSON.parse(text) as JsonRpcResponse;
  } catch {
    return null;
  }
}
