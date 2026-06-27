#!/usr/bin/env node
/**
 * Blipr MCP server (stdio).
 *
 * A thin client that lets an MCP-capable AI agent (Claude Code, Cursor, …) send
 * push notifications to a phone via a Blipr instance. The agent calls a tool;
 * this process POSTs to `${BLIPR_URL}/api/notify/<topic>`. No inbound socket —
 * stdio in, outbound HTTPS out.
 *
 * Config (env):
 *   BLIPR_URL    Base URL of the Blipr server. Default: https://blipr.dev
 *   BLIPR_TOPIC  Default topic when a tool call omits one. Optional.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BLIPR_URL = (process.env.BLIPR_URL ?? "https://blipr.dev").replace(/\/+$/, "");
const DEFAULT_TOPIC = process.env.BLIPR_TOPIC?.trim() || undefined;

interface PublishOpts {
  message: string;
  topic?: string;
  title?: string;
  priority?: number;
  tags?: string[];
  click?: string;
}

/** POST a message to a Blipr topic; returns the resolved topic on success. */
async function publish(opts: PublishOpts): Promise<string> {
  const topic = (opts.topic ?? DEFAULT_TOPIC ?? "").trim();
  if (!topic) {
    throw new Error(
      "No topic given and BLIPR_TOPIC is not set. Pass `topic`, or set the BLIPR_TOPIC env var."
    );
  }

  const headers: Record<string, string> = { "Content-Type": "text/plain" };
  if (opts.title) headers["X-Title"] = opts.title;
  if (opts.priority) headers["X-Priority"] = String(opts.priority);
  if (opts.tags?.length) headers["X-Tags"] = opts.tags.join(",");
  if (opts.click) headers["X-Click"] = opts.click;

  let res: Response;
  try {
    res = await fetch(`${BLIPR_URL}/api/notify/${encodeURIComponent(topic)}`, {
      method: "POST",
      headers,
      body: opts.message,
    });
  } catch (e) {
    throw new Error(`Could not reach Blipr at ${BLIPR_URL}: ${(e as Error).message}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Blipr returned ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`);
  }
  return topic;
}

const server = new McpServer({ name: "blipr", version: "0.1.0" });

server.registerTool(
  "send_alert",
  {
    title: "Send a Blipr alert",
    description:
      "Send a push notification to the user's phone via Blipr. Use this to reach the human: a long task finished, a build broke, you need approval, or you're blocked and need input. Priority 1 (silent) to 5 (critical); defaults to 3.",
    inputSchema: {
      message: z.string().describe("The alert body — what happened or what you need."),
      title: z.string().optional().describe("Short title, shown bold above the message."),
      topic: z
        .string()
        .optional()
        .describe("Topic to publish to. Defaults to the BLIPR_TOPIC env var."),
      priority: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe("1=min/silent, 2=low, 3=default, 4=time-sensitive (breaks Focus), 5=critical."),
      tags: z
        .array(z.string())
        .optional()
        .describe('Tags / emoji shortcodes, e.g. ["warning", "rocket"].'),
      click: z.string().url().optional().describe("URL opened when the notification is tapped."),
    },
  },
  async ({ message, title, topic, priority, tags, click }) => {
    try {
      const sent = await publish({ message, title, topic, priority, tags, click });
      return { content: [{ type: "text", text: `Sent to "${sent}" (priority ${priority ?? 3}).` }] };
    } catch (e) {
      return { content: [{ type: "text", text: (e as Error).message }], isError: true };
    }
  }
);

server.registerTool(
  "send_critical",
  {
    title: "Page the user (critical)",
    description:
      "Send a priority-5 critical page. Use ONLY for things that genuinely cannot wait (production down, urgent approval, safety). Bypasses silent/Focus when the Blipr app has Apple's Critical Alerts entitlement enabled; otherwise it is delivered as time-sensitive.",
    inputSchema: {
      message: z.string().describe("What is wrong or what you need, urgently."),
      title: z.string().optional().describe("Short title."),
      topic: z.string().optional().describe("Topic. Defaults to BLIPR_TOPIC."),
    },
  },
  async ({ message, title, topic }) => {
    try {
      const sent = await publish({ message, title, topic, priority: 5, tags: ["rotating_light"] });
      return { content: [{ type: "text", text: `Paged "${sent}" (priority 5 / critical).` }] };
    } catch (e) {
      return { content: [{ type: "text", text: (e as Error).message }], isError: true };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
// stderr is safe for logs; stdout is the MCP channel and must stay clean.
console.error(`blipr-mcp ready → ${BLIPR_URL}${DEFAULT_TOPIC ? ` (default topic: ${DEFAULT_TOPIC})` : ""}`);
