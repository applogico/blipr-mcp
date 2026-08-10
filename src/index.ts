#!/usr/bin/env node
/**
 * Blipr MCP server (stdio entrypoint).
 *
 * Lets an MCP-capable AI agent (Claude Code, Cursor, …) send push notifications
 * to a phone via a Blipr instance. stdio in, outbound HTTPS out — no socket.
 *
 * Config:
 *   BLIPR_URL      Base URL of the Blipr server (env). Default: https://blipr.dev
 *   .blipr-topic   Per-project default topic — nearest file from the launch
 *                  directory upward. Optional.
 *   BLIPR_TOPIC    Global fallback topic (env), used only when no per-call
 *                  `topic` and no `.blipr-topic` file. Optional.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveDefaultTopic } from "./config.js";
import { createServer } from "./server.js";

const defaultTopic = resolveDefaultTopic(process.cwd());
const cfg = {
  bliprUrl: (process.env.BLIPR_URL ?? "https://blipr.dev").replace(/\/+$/, ""),
  defaultTopic: defaultTopic?.topic,
  // Trimmed so a stray newline from a host config can't malform the header.
  token: process.env.BLIPR_TOKEN?.trim() || undefined,
};

const server = createServer(cfg);
await server.connect(new StdioServerTransport());

// stderr is safe for logs; stdout is the MCP channel and must stay clean.
const topicNote = defaultTopic
  ? ` (default topic: ${defaultTopic.topic}, from ${
      defaultTopic.source === "file" ? defaultTopic.path : "BLIPR_TOPIC env"
    })`
  : " (no default topic — tool calls must pass `topic`)";
// Presence only, never the value.
const tokenNote = cfg.token ? " (token: set)" : "";
console.error(`@blipr/mcp ready → ${cfg.bliprUrl}${topicNote}${tokenNote}`);
