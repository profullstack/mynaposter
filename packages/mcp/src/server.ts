#!/usr/bin/env bun
/**
 * The myna MCP server, over stdio.
 *
 * For an assistant that launches a subprocess. The tools themselves live in
 * tools.ts, which the HTTP transport on the API serves too, so the two cannot
 * offer different things.
 *
 *   { "mcpServers": { "myna": { "command": "bunx", "args": ["@profullstack/myna-mcp"] } } }
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, callTool } from "./tools.ts";

const server = new Server({ name: "myna", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (request) =>
  callTool(request.params.name, request.params.arguments ?? {}),
);

await server.connect(new StdioServerTransport());
