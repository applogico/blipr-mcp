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
    expect(calls()[0][0]).toBe("https://blipr.dev/api/notify/ops");
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
    expect(calls()[0][0]).toBe("https://blipr.dev/api/notify/page");
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
    expect(JSON.parse(res.content[0].text)).toEqual({ answered: true, value: "yes" });

    // First call is the publish POST carrying reply:binary.
    expect(calls()[0][0]).toBe("https://blipr.dev/api/notify/demo");
    expect(bodyOf(0)).toMatchObject({ message: "delete prod?", reply: "binary" });
    // Second call is the long-poll GET against the returned id.
    expect(calls()[1][0]).toMatch(
      /^https:\/\/blipr\.dev\/api\/notify\/demo\/abc123def456\/reply\?wait=\d+$/
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
    expect(JSON.parse(res.content[0].text)).toEqual({ answered: false, reason: "timeout" });
  });

  it("request_ack publishes reply:ack and returns acknowledged on answer", async () => {
    mockReplyFlow({ status: "answered", value: "ack", replied_at: 1700000042 });
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const res: any = await client.callTool({
      name: "request_ack",
      arguments: { message: "starting the long run", timeout_seconds: 5 },
    });
    expect(res.isError ?? false).toBe(false);
    expect(JSON.parse(res.content[0].text)).toEqual({ acknowledged: true, replied_at: 1700000042 });
    expect(bodyOf(0)).toMatchObject({ message: "starting the long run", reply: "ack" });
  });

  it("request_ack returns the timed-out shape when no ack arrives", async () => {
    mockReplyFlow({ status: "timeout" });
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const res: any = await client.callTool({
      name: "request_ack",
      arguments: { message: "ack me", timeout_seconds: 1 },
    });
    expect(JSON.parse(res.content[0].text)).toEqual({ acknowledged: false, reason: "timeout" });
  });
});
