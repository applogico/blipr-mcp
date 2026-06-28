import { afterEach, describe, expect, it, vi } from "vitest";
import { publish, type BliprConfig } from "../src/publish.js";

const cfg: BliprConfig = { bliprUrl: "https://blipr.dev", defaultTopic: "default-topic" };

function mockFetch(impl: () => Promise<Response>) {
  global.fetch = vi.fn(impl) as unknown as typeof fetch;
}
const calls = () => (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
const bodyOf = (i = 0) => JSON.parse(calls()[i][1].body);
const ok = async () => new Response(null, { status: 200 });

describe("publish", () => {
  afterEach(() => vi.restoreAllMocks());

  it("POSTs JSON to /api/notify with the topic and message", async () => {
    mockFetch(ok);
    const topic = await publish({ message: "hi", topic: "alerts" }, cfg);
    expect(topic).toBe("alerts");
    const [url, init] = calls()[0];
    expect(url).toBe("https://blipr.dev/api/notify");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(bodyOf()).toMatchObject({ topic: "alerts", message: "hi" });
  });

  it("falls back to the default topic when none is given", async () => {
    mockFetch(ok);
    const topic = await publish({ message: "hi" }, cfg);
    expect(topic).toBe("default-topic");
    expect(bodyOf().topic).toBe("default-topic");
  });

  it("throws a clear error when there is no topic and no default", async () => {
    mockFetch(ok);
    await expect(publish({ message: "hi" }, { bliprUrl: "https://blipr.dev" })).rejects.toThrow(
      /No topic/
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("maps title/priority/tags/click into the JSON body", async () => {
    mockFetch(ok);
    await publish(
      { message: "m", topic: "t", title: "T", priority: 5, tags: ["a", "b"], click: "https://x.com" },
      cfg
    );
    expect(bodyOf()).toEqual({
      topic: "t",
      message: "m",
      title: "T",
      priority: 5,
      tags: ["a", "b"],
      click: "https://x.com",
    });
  });

  it("preserves unicode (emoji) in the title — the whole point of JSON publish", async () => {
    mockFetch(ok);
    await publish({ message: "done", topic: "t", title: "Deploy ✅" }, cfg);
    expect(bodyOf().title).toBe("Deploy ✅");
  });

  it("omits optional fields when not provided", async () => {
    mockFetch(ok);
    await publish({ message: "m", topic: "t" }, cfg);
    const b = bodyOf();
    expect(b.title).toBeUndefined();
    expect(b.priority).toBeUndefined();
    expect(b.tags).toBeUndefined();
    expect(b.click).toBeUndefined();
  });

  it("strips a trailing slash from the base URL", async () => {
    mockFetch(ok);
    await publish({ message: "m", topic: "t" }, { bliprUrl: "https://blipr.dev/" });
    expect(calls()[0][0]).toBe("https://blipr.dev/api/notify");
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
