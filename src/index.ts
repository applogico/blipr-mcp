#!/usr/bin/env node
/**
 * Blipr MCP server (stdio entrypoint).
 *
 * Lets an MCP-capable AI agent (Claude Code, Cursor, …) send push notifications
 * to a phone via a Blipr instance. stdio in, outbound HTTPS out — no socket.
 *
 * Config (env):
 *   BLIPR_URL    Base URL of the Blipr server. Default: https://blipr.dev
 *   BLIPR_TOPIC  Default topic when a tool call omits one. Optional.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const cfg = {
  bliprUrl: (process.env.BLIPR_URL ?? "https://blipr.dev").replace(/\/+$/, ""),
  defaultTopic: process.env.BLIPR_TOPIC?.trim() || undefined,
};

const server = createServer(cfg);
await server.connect(new StdioServerTransport());

// stderr is safe for logs; stdout is the MCP channel and must stay clean.
console.error(
  `blipr-mcp ready → ${cfg.bliprUrl}${cfg.defaultTopic ? ` (default topic: ${cfg.defaultTopic})` : ""}`
);
