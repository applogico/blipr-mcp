import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { BliprConfig } from "../src/publish.js";
import { bodyOf, calls, installFetch, jsonRes } from "./helpers.js";

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
      "send_alert",
      "send_critical",
    ]);
  });

  it("send_alert publishes the right JSON body and reports success", async () => {
    mockFetch();
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const res = await callTool(client, "send_alert", { message: "hi", topic: "ops", priority: 4 });
    expect(res.isError ?? false).toBe(false);
    expect(textOf(res)).toMatch(/Sent to "ops"/);
    expect(calls()[0][0]).toBe("https://blipr.dev/blip/ops");
    expect(bodyOf()).toMatchObject({ message: "hi", priority: 4 });
  });

  it("send_critical sends priority 5", async () => {
    mockFetch();
    const client = await connect({ bliprUrl: "https://blipr.dev" });
    const res = await callTool(client, "send_critical", { message: "down", topic: "page" });
    expect(textOf(res)).toMatch(/Paged "page"/);
    expect(calls()[0][0]).toBe("https://blipr.dev/blip/page");
    expect(bodyOf()).toMatchObject({ priority: 5 });
  });

  it("returns isError when Blipr responds with a failure", async () => {
    mockFetch(502, "Bad Gateway", "nope");
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const res = await callTool(client, "send_alert", { message: "hi" });
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
      approved: true,
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

  it("ask returns the timed-out shape when the reply never lands", async () => {
    mockReplyFlow({ status: "timeout" });
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const res = await callTool(client, "ask", { message: "proceed?", timeout_seconds: 1 });
    expect(res.isError ?? false).toBe(false);
    expect(jsonOf(res)).toEqual({
      responded: false,
      approved: false,
      reason: "timeout",
      message_id: "abc123def456",
      topic: "demo",
    });
  });

  it("ask returns approved:false on a No — a refusal can never read as a go-ahead", async () => {
    mockReplyFlow({ status: "answered", value: "no", replied_at: 1700000005 });
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const res = await callTool(client, "ask", { message: "delete prod?", timeout_seconds: 5 });
    expect(res.isError ?? false).toBe(false);
    expect(jsonOf(res)).toEqual({
      responded: true,
      approved: false,
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

  it("check_reply reports not-responded when there is no answer yet", async () => {
    mockFetch(200, "OK", JSON.stringify({ status: "pending" }));
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const res = await callTool(client, "check_reply", { message_id: "abc123def456" });
    expect(jsonOf(res)).toEqual({ responded: false, reason: "timeout" });
  });
});
