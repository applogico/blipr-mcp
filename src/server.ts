import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { publish, type BliprConfig } from "./publish.js";

/** Build a configured Blipr MCP server with its tools registered. */
export function createServer(cfg: BliprConfig): McpServer {
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
        const sent = await publish({ message, title, topic, priority, tags, click }, cfg);
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
        const sent = await publish({ message, title, topic, priority: 5, tags: ["rotating_light"] }, cfg);
        return { content: [{ type: "text", text: `Paged "${sent}" (priority 5 / critical).` }] };
      } catch (e) {
        return { content: [{ type: "text", text: (e as Error).message }], isError: true };
      }
    }
  );

  return server;
}
