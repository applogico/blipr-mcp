import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  publish,
  publishExpectingReply,
  pollReply,
  checkReply,
  validateChoiceOptions,
  MIN_CHOICE_OPTIONS,
  MAX_CHOICE_OPTIONS,
  TEXT_REPLY_MAX_CHARS,
  type BliprConfig,
  type ReplyKind,
  type ReplyOutcome,
} from "./publish.js";

/** Default overall time to wait for a human reply before giving up. */
const DEFAULT_REPLY_TIMEOUT_SECONDS = 120;

/** `topic` input shared by every publishing tool. */
const topicSchema = z
  .string()
  .optional()
  .describe(
    "Topic to publish to. When omitted, falls back to the project's `.blipr-topic` file, then the BLIPR_TOPIC env var."
  );

/** `markdown` input shared by every publishing tool. */
const markdownSchema = z
  .boolean()
  .optional()
  .describe("Render the body as Markdown (bold, italics, links, code). Off by default.");

/** `options` input that turns `ask` into a multiple-choice question. */
const optionsSchema = z
  .array(z.string())
  .min(MIN_CHOICE_OPTIONS)
  .max(MAX_CHOICE_OPTIONS)
  .optional()
  .describe(
    `Makes this a multiple-choice question: ${String(MIN_CHOICE_OPTIONS)} to ${String(MAX_CHOICE_OPTIONS)} distinct, non-empty choices. ` +
      "Omit for a yes/no question."
  );

/** `open_question` input that turns `ask` into a question answered by typing. */
const openQuestionSchema = z
  .boolean()
  .optional()
  .describe(
    `Makes this an open question: the human types a short answer of up to ${String(TEXT_REPLY_MAX_CHARS)} characters, ` +
      "returned as `value`."
  );

/** Pick the `ask` reply kind from its inputs, validating choices before anything is sent. */
function askKind(options?: string[], openQuestion?: boolean): { reply: ReplyKind; choices?: string[] } {
  if (options && openQuestion) {
    throw new Error("Pass either `options` or `open_question`, not both.");
  }
  if (options) return { reply: "choice", choices: validateChoiceOptions(options) };
  return { reply: openQuestion ? "text" : "binary" };
}

/** Shape the `ask` result: the answer as given, or a timeout. */
function askResult(outcome: ReplyOutcome, id: string, topic: string) {
  return outcome.status === "answered"
    ? { responded: true, value: outcome.value, message_id: id, topic }
    : { responded: false, reason: "timeout", message_id: id, topic };
}

/** Build a configured Blipr MCP server with its tools registered. */
// Zod 4 drops additionalProperties: false from tool schemas; OpenAI strict mode needs it.
const toolInput = <T extends z.ZodRawShape>(shape: T) =>
  z.object(shape).meta({ additionalProperties: false });

export function createServer(cfg: BliprConfig): McpServer {
  const server = new McpServer({ name: "blipr", version: "0.1.0" });

  server.registerTool(
    "send_alert",
    {
      title: "Send a Blipr message",
      description:
        "Send a push notification to the user's phone via Blipr. Priority 1 (silent) to 5 (Time Sensitive with Blipr Pro, delivered as 4 on the free plan); defaults to 3.",
      inputSchema: toolInput({
        message: z.string().describe("The message body."),
        title: z.string().optional().describe("Short title, shown bold above the message."),
        topic: topicSchema,
        priority: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe("1=min/silent, 2=low, 3=default, 4=high (plays a sound, respects Focus), 5=Time Sensitive (surfaces through Focus with Blipr Pro; delivered as 4 on the free plan, never refused)."),
        tags: z
          .array(z.string())
          .optional()
          .describe('Tags / emoji shortcodes, e.g. ["warning", "rocket"].'),
        click: z.url().optional().describe("URL opened when the notification is tapped."),
        markdown: markdownSchema,
      }),
    },
    async ({ message, title, topic, priority, tags, click, markdown }) => {
      try {
        const sent = await publish({ message, title, topic, priority, tags, click, markdown }, cfg);
        return { content: [{ type: "text", text: `Sent to "${sent}" (priority ${priority ?? 3}).` }] };
      } catch (e) {
        return { content: [{ type: "text", text: (e as Error).message }], isError: true };
      }
    }
  );

  server.registerTool(
    "send_critical",
    {
      title: "Send a priority 5 message",
      description:
        "Send a priority 5 message. With Blipr Pro it is delivered as Time Sensitive, so it surfaces through Focus and Do Not Disturb; on the free plan it is delivered as priority 4, never refused.",
      inputSchema: toolInput({
        message: z.string().describe("The message body."),
        title: z.string().optional().describe("Short title."),
        topic: topicSchema,
        markdown: markdownSchema,
      }),
    },
    async ({ message, title, topic, markdown }) => {
      try {
        const sent = await publish(
          { message, title, topic, priority: 5, tags: ["rotating_light"], markdown },
          cfg
        );
        return { content: [{ type: "text", text: `Sent to "${sent}" (priority 5).` }] };
      } catch (e) {
        return { content: [{ type: "text", text: (e as Error).message }], isError: true };
      }
    }
  );

  server.registerTool(
    "ask",
    {
      title: "Ask the human a yes/no, multiple-choice or open question (BLOCKS until they answer)",
      description:
        "Send a question to the user's phone via Blipr and BLOCK until they answer, then return it. " +
        "Three kinds: yes/no (the default), multiple choice (pass `options`), or open (pass `open_question: true`), " +
        `where the human types an answer of up to ${String(TEXT_REPLY_MAX_CHARS)} characters. ` +
        "The call does not return until the human answers or it times out. Returns " +
        '{ responded, value, message_id, topic }: `value` is "yes" or "no", the option the human tapped ' +
        "exactly as you passed it (trimmed), or the text they typed (trimmed, single line). With no answer in time " +
        'it returns { responded: false, reason: "timeout", message_id, topic }. After a timeout (or if your client ' +
        "cancels the call) the human may still answer; check_reply with the returned message_id picks it up.",
      inputSchema: toolInput({
        message: z.string().describe("The question to ask the human."),
        title: z.string().optional().describe("Short title, shown bold above the question."),
        topic: topicSchema,
        priority: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe("1=min/silent … 5=Time Sensitive (Blipr Pro; 4 on the free plan). Defaults to 4 (high)."),
        tags: z
          .array(z.string())
          .optional()
          .describe('Tags / emoji shortcodes, e.g. ["question"].'),
        markdown: markdownSchema,
        options: optionsSchema,
        open_question: openQuestionSchema,
        timeout_seconds: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`How long to block waiting for the answer before giving up. Defaults to ${DEFAULT_REPLY_TIMEOUT_SECONDS}s. Some MCP clients cancel a long tool call before this elapses; after a timeout or cancel, check_reply with the returned message_id picks up a later answer.`),
      }),
    },
    async ({ message, title, topic, priority, tags, markdown, options, open_question, timeout_seconds }) => {
      try {
        const { reply, choices } = askKind(options, open_question);
        const { topic: sent, id } = await publishExpectingReply(
          { message, title, topic, priority: priority ?? 4, tags, markdown, reply, options: choices },
          cfg
        );
        const outcome = await pollReply(
          sent,
          id,
          { timeoutSeconds: timeout_seconds ?? DEFAULT_REPLY_TIMEOUT_SECONDS },
          cfg
        );
        const result = askResult(outcome, id, sent);
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
        "then return. The call " +
        "does not return until the human acks or it times out. Returns { responded, message_id, topic } plus " +
        '`replied_at` when acked (responded:true), or { responded: false, reason: "timeout" } if no one acks in ' +
        "time. After a timeout or cancel, check_reply with the returned message_id picks up a later ack.",
      inputSchema: toolInput({
        message: z.string().describe("The message body."),
        title: z.string().optional().describe("Short title, shown bold above the message."),
        topic: topicSchema,
        priority: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe("1=min/silent … 5=Time Sensitive (Blipr Pro; 4 on the free plan). Defaults to 4 (high)."),
        tags: z
          .array(z.string())
          .optional()
          .describe('Tags / emoji shortcodes, e.g. ["eyes"].'),
        markdown: markdownSchema,
        timeout_seconds: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`How long to block waiting for the acknowledgement before giving up. Defaults to ${DEFAULT_REPLY_TIMEOUT_SECONDS}s. Some MCP clients cancel a long tool call early; after a timeout or cancel, check_reply with the returned message_id picks up a later ack.`),
      }),
    },
    async ({ message, title, topic, priority, tags, markdown, timeout_seconds }) => {
      try {
        const { topic: sent, id } = await publishExpectingReply(
          { message, title, topic, priority: priority ?? 4, tags, markdown, reply: "ack" },
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
        "Look up whether the human has replied to an earlier `ask` or `request_ack`, including one that timed out " +
        "or that your client cancelled. Takes the " +
        "`message_id` (and `topic`) that call returned. Returns immediately by default; set `wait_seconds` " +
        'to briefly long-poll. Returns { responded, value?, replied_at? } — `value` is "yes"/"no" (a yes/no ' +
        'question), the chosen option (a multiple-choice question), the typed text (an open question) or "ack".',
      inputSchema: toolInput({
        message_id: z.string().describe("The message_id returned by a prior ask / request_ack call."),
        topic: z
          .string()
          .optional()
          .describe(
            "Topic the original message was sent to. When omitted, falls back to the same default " +
              "(`.blipr-topic` file, then the BLIPR_TOPIC env var)."
          ),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Seconds to long-poll for an answer (0 = instant check; default 0)."),
      }),
    },
    async ({ message_id, topic, wait_seconds }) => {
      try {
        const t = (topic ?? cfg.defaultTopic ?? "").trim();
        if (!t) {
          throw new Error(
            "No topic given and no default is configured. Pass `topic` in the tool call, " +
              "or set a per-project default in a `.blipr-topic` file (or the BLIPR_TOPIC env var)."
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
