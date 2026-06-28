import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { publish, publishExpectingReply, pollReply, type BliprConfig } from "./publish.js";

/** Default overall time to wait for a human reply before giving up. */
const DEFAULT_REPLY_TIMEOUT_SECONDS = 120;

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

  server.registerTool(
    "ask",
    {
      title: "Ask the human a yes/no question (BLOCKS until they answer)",
      description:
        "Send a yes/no question to the user's phone via Blipr and BLOCK until they tap an answer, " +
        "then return it. This is a human-in-the-loop approval gate: use it before doing something " +
        "consequential or irreversible (deleting prod data, force-pushing, spending money, sending an " +
        "email) — anything where you'd otherwise ask 'should I proceed?'. The call does not return until " +
        "the human answers or it times out. Returns { answered, approved, value } — ALWAYS branch on " +
        "`approved`: it is true ONLY when the human tapped Yes, and false on No, a timeout, or an error. " +
        "Never treat a non-approval (No / timeout / error) as a go-ahead; on anything but approved:true, do not proceed.",
      inputSchema: {
        message: z.string().describe("The yes/no question to ask the human."),
        title: z.string().optional().describe("Short title, shown bold above the question."),
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
          .describe("1=min/silent … 5=critical. Defaults to 4 (time-sensitive) since it needs an answer."),
        tags: z
          .array(z.string())
          .optional()
          .describe('Tags / emoji shortcodes, e.g. ["question"].'),
        timeout_seconds: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`How long to wait for the human's answer before giving up. Defaults to ${DEFAULT_REPLY_TIMEOUT_SECONDS}s.`),
      },
    },
    async ({ message, title, topic, priority, tags, timeout_seconds }) => {
      try {
        const { topic: sent, id } = await publishExpectingReply(
          { message, title, topic, priority: priority ?? 4, tags, reply: "binary" },
          cfg
        );
        const outcome = await pollReply(
          sent,
          id,
          { timeoutSeconds: timeout_seconds ?? DEFAULT_REPLY_TIMEOUT_SECONDS },
          cfg
        );
        const result =
          outcome.status === "answered"
            ? { answered: true, approved: outcome.value === "yes", value: outcome.value }
            : { answered: false, approved: false, reason: "timeout" };
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (e) {
        return { content: [{ type: "text", text: (e as Error).message }], isError: true };
      }
    }
  );

  server.registerTool(
    "request_ack",
    {
      title: "Request the human's acknowledgement (BLOCKS until they ack)",
      description:
        "Send a message that needs the human to acknowledge it, and BLOCK until they tap 'Acknowledge', " +
        "then return. Use this when the human must see and confirm receipt of something before you continue " +
        "(a heads-up they have to read, a checkpoint reached, 'I'm about to start the long run'). The call " +
        "does not return until the human acks or it times out. Returns { acknowledged: true, replied_at } " +
        'when acked, or { acknowledged: false, reason: "timeout" } if no one acks in time.',
      inputSchema: {
        message: z.string().describe("What the human needs to see and acknowledge."),
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
          .describe("1=min/silent … 5=critical. Defaults to 4 (time-sensitive) since it needs an ack."),
        tags: z
          .array(z.string())
          .optional()
          .describe('Tags / emoji shortcodes, e.g. ["eyes"].'),
        timeout_seconds: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`How long to wait for the acknowledgement before giving up. Defaults to ${DEFAULT_REPLY_TIMEOUT_SECONDS}s.`),
      },
    },
    async ({ message, title, topic, priority, tags, timeout_seconds }) => {
      try {
        const { topic: sent, id } = await publishExpectingReply(
          { message, title, topic, priority: priority ?? 4, tags, reply: "ack" },
          cfg
        );
        const outcome = await pollReply(
          sent,
          id,
          { timeoutSeconds: timeout_seconds ?? DEFAULT_REPLY_TIMEOUT_SECONDS },
          cfg
        );
        const result =
          outcome.status === "answered"
            ? { acknowledged: true, replied_at: outcome.repliedAt }
            : { acknowledged: false, reason: "timeout" };
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (e) {
        return { content: [{ type: "text", text: (e as Error).message }], isError: true };
      }
    }
  );

  return server;
}
