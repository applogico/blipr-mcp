import { afterEach, describe, expect, it, vi } from "vitest";
import { publish, type BliprConfig } from "../src/publish.js";

const cfg: BliprConfig = { bliprUrl: "https://blipr.dev", defaultTopic: "default-topic" };

function mockFetch(impl: () => Promise<Response>) {
  global.fetch = vi.fn(impl) as unknown as typeof fetch;
}
const calls = () => (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
const ok = async () => new Response(null, { status: 200 });

describe("publish", () => {
  afterEach(() => vi.restoreAllMocks());

  it("POSTs the message body to the topic URL", async () => {
    mockFetch(ok);
    const topic = await publish({ message: "hi", topic: "alerts" }, cfg);
    expect(topic).toBe("alerts");
    const [url, init] = calls()[0];
    expect(url).toBe("https://blipr.dev/api/notify/alerts");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("hi");
  });

  it("falls back to the default topic when none is given", async () => {
    mockFetch(ok);
    const topic = await publish({ message: "hi" }, cfg);
    expect(topic).toBe("default-topic");
    expect(calls()[0][0]).toBe("https://blipr.dev/api/notify/default-topic");
  });

  it("throws a clear error when there is no topic and no default", async () => {
    mockFetch(ok);
    await expect(publish({ message: "hi" }, { bliprUrl: "https://blipr.dev" })).rejects.toThrow(
      /No topic/
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("maps title/priority/tags/click to headers", async () => {
    mockFetch(ok);
    await publish(
      { message: "m", topic: "t", title: "T", priority: 5, tags: ["a", "b"], click: "https://x.com" },
      cfg
    );
    const h = calls()[0][1].headers;
    expect(h["X-Title"]).toBe("T");
    expect(h["X-Priority"]).toBe("5");
    expect(h["X-Tags"]).toBe("a,b");
    expect(h["X-Click"]).toBe("https://x.com");
  });

  it("omits optional headers when not provided", async () => {
    mockFetch(ok);
    await publish({ message: "m", topic: "t" }, cfg);
    const h = calls()[0][1].headers;
    expect(h["X-Title"]).toBeUndefined();
    expect(h["X-Priority"]).toBeUndefined();
    expect(h["X-Tags"]).toBeUndefined();
    expect(h["X-Click"]).toBeUndefined();
  });

  it("url-encodes the topic", async () => {
    mockFetch(ok);
    await publish({ message: "m", topic: "a/b c" }, cfg);
    expect(calls()[0][0]).toBe("https://blipr.dev/api/notify/a%2Fb%20c");
  });

  it("strips a trailing slash from the base URL", async () => {
    mockFetch(ok);
    await publish({ message: "m", topic: "t" }, { bliprUrl: "https://blipr.dev/" });
    expect(calls()[0][0]).toBe("https://blipr.dev/api/notify/t");
  });

  it("throws on a non-2xx response", async () => {
    mockFetch(async () => new Response("bad", { status: 500, statusText: "Internal Server Error" }));
    await expect(publish({ message: "m", topic: "t" }, cfg)).rejects.toThrow(/500/);
  });

  it("wraps network failures with a friendly message", async () => {
    mockFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(publish({ message: "m", topic: "t" }, cfg)).rejects.toThrow(/Could not reach Blipr/);
  });
});
