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

  it("exposes send_alert and send_critical", async () => {
    mockFetch();
    const client = await connect({ bliprUrl: "https://blipr.dev", defaultTopic: "demo" });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["send_alert", "send_critical"]);
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
});
