import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  publish,
  publishExpectingReply,
  pollReply,
  checkReply,
  type BliprConfig,
} from "./publish.js";

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
        "the human answers or it times out. Returns { responded, approved, value, message_id, topic } — ALWAYS " +
        "branch on `approved`: it is true ONLY when the human tapped Yes, and false on No, a timeout, or an error. " +
        "Never treat a non-approval as a go-ahead. On timeout (or if your client cancels the call) the human may " +
        "still answer within ~30 min — call check_reply with the returned message_id to resume rather than re-asking.",
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
          .describe(`How long to block waiting for the answer before giving up. Defaults to ${DEFAULT_REPLY_TIMEOUT_SECONDS}s. Some MCP clients cancel a long tool call before this elapses; on timeout or cancel, use check_reply with the returned message_id (replies are retained ~30 min).`),
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
            ? {
                responded: true,
                approved: outcome.value === "yes",
                value: outcome.value,
                message_id: id,
                topic: sent,
              }
            : { responded: false, approved: false, reason: "timeout", message_id: id, topic: sent };
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
        "does not return until the human acks or it times out. Returns { responded, message_id, topic } plus " +
        '`replied_at` when acked (responded:true), or { responded: false, reason: "timeout" } if no one acks in ' +
        "time. On timeout/cancel, call check_reply with the returned message_id (replies are retained ~30 min).",
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
          .describe(`How long to block waiting for the acknowledgement before giving up. Defaults to ${DEFAULT_REPLY_TIMEOUT_SECONDS}s. Some MCP clients cancel a long tool call early; on timeout or cancel, use check_reply with the returned message_id (replies are retained ~30 min).`),
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
            ? { responded: true, replied_at: outcome.repliedAt, message_id: id, topic: sent }
            : { responded: false, reason: "timeout", message_id: id, topic: sent };
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (e) {
        return { content: [{ type: "text", text: (e as Error).message }], isError: true };
      }
    }
  );

  server.registerTool(
    "check_reply",
    {
      title: "Check for a reply to an earlier ask / request_ack (non-blocking by default)",
      description:
        "Look up whether the human has replied to a question or ack you sent earlier — use it to resume after " +
        "`ask`/`request_ack` returned a timeout, or after your client cancelled the blocking call. Pass the " +
        "`message_id` (and `topic`) you got back from that call. Returns immediately by default; set `wait_seconds` " +
        'to briefly long-poll. Returns { responded, value?, replied_at? } — `value` is "yes"/"no" (a yes/no ' +
        'question) or "ack". For an approval gate, only proceed when value === "yes". Replies are kept only ~30 ' +
        "minutes after the original message was sent.",
      inputSchema: {
        message_id: z.string().describe("The message_id returned by a prior ask / request_ack call."),
        topic: z
          .string()
          .optional()
          .describe("Topic the original message was sent to. Defaults to the BLIPR_TOPIC env var."),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Seconds to long-poll for an answer (0 = instant check; default 0)."),
      },
    },
    async ({ message_id, topic, wait_seconds }) => {
      try {
        const t = (topic ?? cfg.defaultTopic ?? "").trim();
        if (!t) {
          throw new Error(
            "No topic given and BLIPR_TOPIC is not set. Pass `topic`, or set the BLIPR_TOPIC env var."
          );
        }
        const outcome = await checkReply(t, message_id, wait_seconds ?? 0, cfg);
        const result =
          outcome.status === "answered"
            ? { responded: true, value: outcome.value, replied_at: outcome.repliedAt }
            : { responded: false, reason: "timeout" };
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (e) {
        return { content: [{ type: "text", text: (e as Error).message }], isError: true };
      }
    }
  );

  return server;
}
