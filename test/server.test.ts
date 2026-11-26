import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { BliprConfig } from "../src/publish.js";
import { authOf, bodyOf, calls, installFetch, jsonRes } from "./helpers.js";

/** Link a Client to a fresh server over an in-memory transport pair. */
async function connect(cfg: BliprConfig): Promise<Client> {
  const server = createServer(cfg);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Every Blipr tool answers with exactly one text block, which is what the cast below relies on. */
interface TextToolResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<TextToolResult> {
  return (await client.callTool({ name, arguments: args })) as TextToolResult;
}

const textOf = (res: TextToolResult): string => res.content[0].text ?? "";
const jsonOf = (res: TextToolResult): Record<string, unknown> =>
  JSON.parse(textOf(res)) as Record<string, unknown>;

function mockFetch(status = 200, statusText = "OK", body: string | null = null) {
  installFetch(async () => new Response(body, { status, statusText }));
}

describe("MCP server", () => {
  afterEach(() => vi.restoreAllMocks());

  it("exposes the alert and reply tools", async () => {
    mockFetch();
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "ask",
      "check_reply",
      "request_ack",
      "send_critical",
      "send_message",
      "wait_for_message",
    ]);
  });

  it("send_message publishes the right JSON body and reports success", async () => {
    mockFetch();
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const res = await callTool(client, "send_message", { message: "hi", topic: "ops", priority: 4 });
    expect(res.isError ?? false).toBe(false);
    expect(textOf(res)).toMatch(/Sent to "ops"/);
    expect(calls()[0][0]).toBe("https://blipr.dev/blip/ops");
    expect(bodyOf()).toMatchObject({ message: "hi", priority: 4 });
  });

  it("send_message forwards markdown as the X-Markdown header", async () => {
    mockFetch();
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    await callTool(client, "send_message", { message: "**hi**", markdown: true });
    expect(calls()[0][1].headers["X-Markdown"]).toBe("true");
  });

  it("send_message sends no X-Markdown header when markdown is omitted", async () => {
    mockFetch();
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    await callTool(client, "send_message", { message: "hi" });
    expect(calls()[0][1].headers).not.toHaveProperty("X-Markdown");
  });

  it("send_critical sends priority 5", async () => {
    mockFetch();
    const client = await connect({ bliprUrl: "https://blipr.dev" });
    const res = await callTool(client, "send_critical", { message: "down", topic: "page" });
    expect(textOf(res)).toMatch(/Sent to "page"/);
    expect(calls()[0][0]).toBe("https://blipr.dev/blip/page");
    expect(bodyOf()).toMatchObject({ priority: 5 });
    expect(bodyOf()).not.toHaveProperty("tags");
  });

  it("returns isError when Blipr responds with a failure", async () => {
    mockFetch(502, "Bad Gateway", "nope");
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const res = await callTool(client, "send_message", { message: "hi" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/502/);
  });

  /**
   * Route the two-step reply flow: the publish POST returns the message id,
   * the reply GET returns whatever `replyBody` we want for the case.
   */
  function mockReplyFlow(replyBody: unknown, id = "abc123def456") {
    installFetch(async (_url, init) => {
      const method = init.method ?? "GET";
      if (method === "POST") return jsonRes({ id, expected_reply: "binary", topic: "demo" });
      return jsonRes(replyBody); // the reply GET
    });
  }

  it("ask publishes reply:binary, captures the id, and returns the answer", async () => {
    mockReplyFlow({ status: "answered", value: "yes", replied_at: 1700000000 });
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const res = await callTool(client, "ask", { message: "delete prod?", timeout_seconds: 5 });
    expect(res.isError ?? false).toBe(false);
    expect(jsonOf(res)).toEqual({
      responded: true,
      value: "yes",
      message_id: "abc123def456",
      topic: "demo",
    });

    // First call is the publish POST carrying reply:binary.
    expect(calls()[0][0]).toBe("https://blipr.dev/blip/demo");
    expect(bodyOf(0)).toMatchObject({ message: "delete prod?", reply: "binary" });
    // Second call is the long-poll GET against the returned id.
    expect(calls()[1][0]).toMatch(
      /^https:\/\/blipr\.dev\/blip\/demo\/abc123def456\/reply\?wait=\d+$/
    );
  });

  it("ask forwards markdown as the X-Markdown header on the publish", async () => {
    mockReplyFlow({ status: "answered", value: "yes" });
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    await callTool(client, "ask", { message: "**ship?**", markdown: true, timeout_seconds: 5 });
    expect(calls()[0][1].headers["X-Markdown"]).toBe("true");
  });

  it("ask returns the timed-out shape when the reply never lands", async () => {
    mockReplyFlow({ status: "timeout" });
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const res = await callTool(client, "ask", { message: "proceed?", timeout_seconds: 1 });
    expect(res.isError ?? false).toBe(false);
    expect(jsonOf(res)).toEqual({
      responded: false,
      reason: "timeout",
      message_id: "abc123def456",
      topic: "demo",
    });
  });

  it("ask returns the No as given", async () => {
    mockReplyFlow({ status: "answered", value: "no", replied_at: 1700000005 });
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const res = await callTool(client, "ask", { message: "delete prod?", timeout_seconds: 5 });
    expect(res.isError ?? false).toBe(false);
    expect(jsonOf(res)).toEqual({
      responded: true,
      value: "no",
      message_id: "abc123def456",
      topic: "demo",
    });
  });

  it("ask surfaces isError (never approval) when the reply poll fails", async () => {
    installFetch(async (_url, init) => {
      const method = init.method ?? "GET";
      if (method === "POST") return jsonRes({ id: "id1", expected_reply: "binary", topic: "demo" });
      return new Response("boom", { status: 500, statusText: "Internal Server Error" }); // reply GET fails
    });
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const res = await callTool(client, "ask", { message: "proceed?", timeout_seconds: 5 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/500/);
  });

  it("ask surfaces isError when the publish itself fails (no question, no approval)", async () => {
    mockFetch(503, "Service Unavailable", "down");
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const res = await callTool(client, "ask", { message: "go?", timeout_seconds: 5 });
    expect(res.isError).toBe(true);
  });

  it("ask with options publishes reply:choice and returns the chosen option", async () => {
    mockReplyFlow({ status: "answered", value: "Hold", replied_at: 1700000010 });
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const res = await callTool(client, "ask", {
      message: "next step?",
      options: [" Ship ", "Hold", "Stop"],
      timeout_seconds: 5,
    });
    expect(res.isError ?? false).toBe(false);
    expect(jsonOf(res)).toEqual({
      responded: true,
      value: "Hold",
      message_id: "abc123def456",
      topic: "demo",
    });
    expect(bodyOf(0)).toMatchObject({
      message: "next step?",
      reply: "choice",
      options: ["Ship", "Hold", "Stop"],
    });
  });

  it("ask with options returns the timed-out shape", async () => {
    mockReplyFlow({ status: "timeout" });
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const res = await callTool(client, "ask", {
      message: "next step?",
      options: ["Ship", "Hold"],
      timeout_seconds: 1,
    });
    expect(jsonOf(res)).toEqual({
      responded: false,
      reason: "timeout",
      message_id: "abc123def456",
      topic: "demo",
    });
  });

  it("ask rejects duplicate or empty options without publishing", async () => {
    mockFetch();
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const dupes = await callTool(client, "ask", { message: "pick", options: ["A", "A"] });
    expect(dupes.isError).toBe(true);
    expect(textOf(dupes)).toMatch(/distinct/);
    const empty = await callTool(client, "ask", { message: "pick", options: ["A", ""] });
    expect(empty.isError).toBe(true);
    expect(textOf(empty)).toMatch(/empty/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("ask rejects more than 5 or fewer than 2 options without publishing", async () => {
    mockFetch();
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    for (const options of [["A"], ["1", "2", "3", "4", "5", "6"]]) {
      const res = await callTool(client, "ask", { message: "pick", options });
      expect(res.isError).toBe(true);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("ask with open_question publishes reply:text and returns the typed answer", async () => {
    mockReplyFlow({ status: "answered", value: "Use the staging bucket", replied_at: 1700000020 });
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const res = await callTool(client, "ask", {
      message: "which bucket?",
      open_question: true,
      timeout_seconds: 5,
    });
    expect(res.isError ?? false).toBe(false);
    expect(jsonOf(res)).toEqual({
      responded: true,
      value: "Use the staging bucket",
      message_id: "abc123def456",
      topic: "demo",
    });
    expect(bodyOf(0)).toMatchObject({ message: "which bucket?", reply: "text" });
    expect(bodyOf(0)).not.toHaveProperty("options");
  });

  it("ask with open_question returns the timed-out shape", async () => {
    mockReplyFlow({ status: "timeout" });
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const res = await callTool(client, "ask", { message: "name?", open_question: true, timeout_seconds: 1 });
    expect(jsonOf(res)).toEqual({
      responded: false,
      reason: "timeout",
      message_id: "abc123def456",
      topic: "demo",
    });
  });

  it("ask with open_question:false stays a yes/no question", async () => {
    mockReplyFlow({ status: "answered", value: "no" });
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const res = await callTool(client, "ask", { message: "go?", open_question: false, timeout_seconds: 5 });
    expect(bodyOf(0)).toMatchObject({ reply: "binary" });
    expect(jsonOf(res)).toMatchObject({ value: "no" });
  });

  it("ask rejects open_question combined with options without publishing", async () => {
    mockFetch();
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const res = await callTool(client, "ask", {
      message: "pick",
      options: ["A", "B"],
      open_question: true,
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not both/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("request_ack publishes reply:ack and returns acknowledged on answer", async () => {
    mockReplyFlow({ status: "answered", value: "ack", replied_at: 1700000042 });
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const res = await callTool(client, "request_ack", {
      message: "starting the long run",
      timeout_seconds: 5,
    });
    expect(res.isError ?? false).toBe(false);
    expect(jsonOf(res)).toEqual({
      responded: true,
      replied_at: 1700000042,
      message_id: "abc123def456",
      topic: "demo",
    });
    expect(bodyOf(0)).toMatchObject({ message: "starting the long run", reply: "ack" });
  });

  it("request_ack returns the timed-out shape when no ack arrives", async () => {
    mockReplyFlow({ status: "timeout" });
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const res = await callTool(client, "request_ack", { message: "ack me", timeout_seconds: 1 });
    expect(jsonOf(res)).toEqual({
      responded: false,
      reason: "timeout",
      message_id: "abc123def456",
      topic: "demo",
    });
  });

  it("check_reply returns the stored answer when one exists (resume after a timeout)", async () => {
    mockFetch(200, "OK", JSON.stringify({ status: "answered", value: "yes", replied_at: 1700000099 }));
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const res = await callTool(client, "check_reply", { message_id: "abc123def456" });
    expect(res.isError ?? false).toBe(false);
    expect(jsonOf(res)).toEqual({
      responded: true,
      value: "yes",
      replied_at: 1700000099,
    });
    // a single instant GET (wait=0), no publish
    expect(calls()[0][0]).toBe("https://blipr.dev/blip/demo/abc123def456/reply?wait=0");
  });

  it("check_reply returns a typed answer to an open question verbatim", async () => {
    const typed = "Ship it after 5, café closes early";
    mockFetch(200, "OK", JSON.stringify({ status: "answered", value: typed, replied_at: 1700000100 }));
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const res = await callTool(client, "check_reply", { message_id: "abc123def456" });
    expect(jsonOf(res)).toEqual({ responded: true, value: typed, replied_at: 1700000100 });
  });

  it("check_reply waits as long as asked, across several requests", async () => {
    mockFetch(200, "OK", JSON.stringify({ status: "timeout" }));
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const res = await callTool(client, "check_reply", { message_id: "abc123def456", wait_seconds: 700 });
    expect(jsonOf(res)).toEqual({ responded: false });
    const waits = calls().map((c) => Number(new URL(c[0]).searchParams.get("wait")));
    expect(waits.length).toBeGreaterThan(1);
    expect(waits.reduce((sum, w) => sum + w, 0)).toBe(700);
  });

  it("check_reply reports not-responded when there is no answer yet", async () => {
    mockFetch(200, "OK", JSON.stringify({ status: "pending" }));
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const res = await callTool(client, "check_reply", { message_id: "abc123def456" });
    expect(jsonOf(res)).toEqual({ responded: false });
  });

  /** An event-stream response carrying the given frames, then left open. */
  function sseRes(frames: unknown[], signal: AbortSignal): Response {
    const text = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        // Like a real fetch body, the stream fails when the request is aborted.
        signal.addEventListener("abort", () => {
          controller.error(new Error("aborted"));
        });
      },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }

  it("wait_for_message returns the next message from the topic stream", async () => {
    const message = { id: "m1", event: "message", topic: "demo", message: "build done", cursor: 7 };
    installFetch(async (_url, init) => sseRes([{ event: "open" }, { event: "keepalive" }, message], init.signal));
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo", token: "blipr_pk_x" });
    const res = await callTool(client, "wait_for_message", { since: "c6" });
    expect(jsonOf(res)).toEqual({ received: true, message });
    expect(calls()).toHaveLength(1);
    expect(calls()[0][0]).toBe("https://blipr.dev/blip/demo/sse?since=c6");
    expect(authOf(0)).toBe("Bearer blipr_pk_x");
  });

  it("wait_for_message stops at timeout_seconds when nothing arrives", async () => {
    installFetch(async (_url, init) => sseRes([{ event: "open" }], init.signal));
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const res = await callTool(client, "wait_for_message", { timeout_seconds: 1 });
    expect(jsonOf(res)).toEqual({ received: false, reason: "timeout" });
  });

  it("wait_for_message reports a refused topic instead of retrying forever", async () => {
    installFetch(async () => jsonRes({ error: "Topic not found" }, 404));
    const client = await connect({ bliprUrl: "https://blipr.dev" });
    const res = await callTool(client, "wait_for_message", { topic: "nope" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/404/);
    expect(calls()).toHaveLength(1);
  });
});
