import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type BliprConfig } from "../src/server.js";

/** Link a Client to a fresh server over an in-memory transport pair. */
async function connect(cfg: BliprConfig) {
  const server = createServer(cfg);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const calls = () => (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
const bodyOf = (i = 0) => JSON.parse(calls()[i][1].body);
function mockFetch(status = 200, statusText = "OK", body: string | null = null) {
  global.fetch = vi.fn(async () => new Response(body, { status, statusText })) as unknown as typeof fetch;
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
    const res: any = await client.callTool({
      name: "send_alert",
      arguments: { message: "hi", topic: "ops", priority: 4 },
    });
    expect(res.isError ?? false).toBe(false);
    expect(res.content[0].text).toMatch(/Sent to "ops"/);
    expect(calls()[0][0]).toBe("https://blipr.dev/blip/ops");
    expect(bodyOf()).toMatchObject({ message: "hi", priority: 4 });
  });

  it("send_critical sends priority 5", async () => {
    mockFetch();
    const client = await connect({ bliprUrl: "https://blipr.dev" });
    const res: any = await client.callTool({
      name: "send_critical",
      arguments: { message: "down", topic: "page" },
    });
    expect(res.content[0].text).toMatch(/Paged "page"/);
    expect(calls()[0][0]).toBe("https://blipr.dev/blip/page");
    expect(bodyOf()).toMatchObject({ priority: 5 });
  });

  it("returns isError when Blipr responds with a failure", async () => {
    mockFetch(502, "Bad Gateway", "nope");
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const res: any = await client.callTool({ name: "send_alert", arguments: { message: "hi" } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/502/);
  });

  /**
   * Route the two-step reply flow: the publish POST returns the message id,
   * the reply GET returns whatever `replyBody` we want for the case.
   */
  function mockReplyFlow(replyBody: unknown, id = "abc123def456") {
    const json = (obj: unknown) =>
      new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json" } });
    global.fetch = vi.fn(async (url: any, init?: any) => {
      const method = init?.method ?? "GET";
      if (method === "POST") return json({ id, expected_reply: "binary", topic: "demo" });
      return json(replyBody); // the reply GET
    }) as unknown as typeof fetch;
  }

  it("ask publishes reply:binary, captures the id, and returns the answer", async () => {
    mockReplyFlow({ status: "answered", value: "yes", replied_at: 1700000000 });
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const res: any = await client.callTool({
      name: "ask",
      arguments: { message: "delete prod?", timeout_seconds: 5 },
    });
    expect(res.isError ?? false).toBe(false);
    expect(JSON.parse(res.content[0].text)).toEqual({
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
    const res: any = await client.callTool({
      name: "ask",
      arguments: { message: "proceed?", timeout_seconds: 1 },
    });
    expect(res.isError ?? false).toBe(false);
    expect(JSON.parse(res.content[0].text)).toEqual({
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
    const res: any = await client.callTool({
      name: "ask",
      arguments: { message: "delete prod?", timeout_seconds: 5 },
    });
    expect(res.isError ?? false).toBe(false);
    expect(JSON.parse(res.content[0].text)).toEqual({
      responded: true,
      approved: false,
      value: "no",
      message_id: "abc123def456",
      topic: "demo",
    });
  });

  it("ask surfaces isError (never approval) when the reply poll fails", async () => {
    const json = (obj: unknown) =>
      new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json" } });
    global.fetch = vi.fn(async (_url: any, init?: any) => {
      const method = init?.method ?? "GET";
      if (method === "POST") return json({ id: "id1", expected_reply: "binary", topic: "demo" });
      return new Response("boom", { status: 500, statusText: "Internal Server Error" }); // reply GET fails
    }) as unknown as typeof fetch;
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const res: any = await client.callTool({
      name: "ask",
      arguments: { message: "proceed?", timeout_seconds: 5 },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/500/);
  });

  it("ask surfaces isError when the publish itself fails (no question, no approval)", async () => {
    mockFetch(503, "Service Unavailable", "down");
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const res: any = await client.callTool({
      name: "ask",
      arguments: { message: "go?", timeout_seconds: 5 },
    });
    expect(res.isError).toBe(true);
  });

  it("request_ack publishes reply:ack and returns acknowledged on answer", async () => {
    mockReplyFlow({ status: "answered", value: "ack", replied_at: 1700000042 });
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const res: any = await client.callTool({
      name: "request_ack",
      arguments: { message: "starting the long run", timeout_seconds: 5 },
    });
    expect(res.isError ?? false).toBe(false);
    expect(JSON.parse(res.content[0].text)).toEqual({
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
    const res: any = await client.callTool({
      name: "request_ack",
      arguments: { message: "ack me", timeout_seconds: 1 },
    });
    expect(JSON.parse(res.content[0].text)).toEqual({
      responded: false,
      reason: "timeout",
      message_id: "abc123def456",
      topic: "demo",
    });
  });

  it("check_reply returns the stored answer when one exists (resume after a timeout)", async () => {
    mockFetch(200, "OK", JSON.stringify({ status: "answered", value: "yes", replied_at: 1700000099 }));
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const res: any = await client.callTool({
      name: "check_reply",
      arguments: { message_id: "abc123def456" },
    });
    expect(res.isError ?? false).toBe(false);
    expect(JSON.parse(res.content[0].text)).toEqual({
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
    const res: any = await client.callTool({
      name: "check_reply",
      arguments: { message_id: "abc123def456" },
    });
    expect(JSON.parse(res.content[0].text)).toEqual({ responded: false, reason: "timeout" });
  });
});
