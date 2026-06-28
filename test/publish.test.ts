import { afterEach, describe, expect, it, vi } from "vitest";
import {
  publish,
  publishExpectingReply,
  pollReply,
  type BliprConfig,
} from "../src/publish.js";

const cfg: BliprConfig = { bliprUrl: "https://blipr.dev", defaultTopic: "default-topic" };

function mockFetch(impl: () => Promise<Response>) {
  global.fetch = vi.fn(impl) as unknown as typeof fetch;
}
const calls = () => (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
const bodyOf = (i = 0) => JSON.parse(calls()[i][1].body);
const ok = async () => new Response(null, { status: 200 });

describe("publish", () => {
  afterEach(() => vi.restoreAllMocks());

  it("POSTs a JSON body to /api/notify/{topic}", async () => {
    mockFetch(ok);
    const topic = await publish({ message: "hi", topic: "alerts" }, cfg);
    expect(topic).toBe("alerts");
    const [url, init] = calls()[0];
    expect(url).toBe("https://blipr.dev/api/notify/alerts");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    // topic is in the URL, not the body
    expect(bodyOf()).toEqual({ message: "hi" });
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

  it("maps title/priority/tags/click into the JSON body", async () => {
    mockFetch(ok);
    await publish(
      { message: "m", topic: "t", title: "T", priority: 5, tags: ["a", "b"], click: "https://x.com" },
      cfg
    );
    expect(bodyOf()).toEqual({
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
    expect(bodyOf()).toEqual({ message: "m" });
  });

  it("url-encodes the topic in the path", async () => {
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

const jsonRes = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

describe("publishExpectingReply", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends the reply field and returns the parsed id + expected_reply", async () => {
    mockFetch(async () => jsonRes({ id: "abc123def456", expected_reply: "binary", topic: "ops" }));
    const result = await publishExpectingReply(
      { message: "delete prod?", topic: "ops", reply: "binary" },
      cfg
    );
    expect(bodyOf()).toMatchObject({ message: "delete prod?", reply: "binary" });
    expect(result).toEqual({ topic: "ops", id: "abc123def456", expectedReply: "binary" });
  });

  it("throws when the publish response has no id", async () => {
    mockFetch(async () => jsonRes({ topic: "ops" }));
    await expect(
      publishExpectingReply({ message: "m", topic: "ops", reply: "ack" }, cfg)
    ).rejects.toThrow(/did not include a message id/);
  });
});

describe("pollReply", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns the answer when the reply GET reports answered", async () => {
    mockFetch(async () => jsonRes({ status: "answered", value: "yes", replied_at: 1700000000 }));
    const outcome = await pollReply("ops", "abc123def456", { timeoutSeconds: 5 }, cfg);
    expect(outcome).toEqual({ status: "answered", value: "yes", repliedAt: 1700000000 });
    expect(calls()[0][0]).toMatch(
      /^https:\/\/blipr\.dev\/api\/notify\/ops\/abc123def456\/reply\?wait=\d+$/
    );
  });

  it("keeps polling past a 'timeout' response, then answers", async () => {
    let n = 0;
    mockFetch(async () => {
      n += 1;
      return n === 1
        ? jsonRes({ status: "timeout" })
        : jsonRes({ status: "answered", value: "no", replied_at: 1700000001 });
    });
    const outcome = await pollReply("ops", "id1", { timeoutSeconds: 10, waitSeconds: 1 }, cfg);
    expect(outcome).toEqual({ status: "answered", value: "no", repliedAt: 1700000001 });
    expect(n).toBe(2);
  });

  it("gives up with timeout once the overall deadline passes", async () => {
    mockFetch(async () => jsonRes({ status: "timeout" }));
    const outcome = await pollReply("ops", "id1", { timeoutSeconds: 0 }, cfg);
    expect(outcome).toEqual({ status: "timeout" });
    // deadline already passed → no request made
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("throws (fail-closed) on a non-2xx reply poll — e.g. 404 after the message is pruned", async () => {
    mockFetch(async () => new Response("gone", { status: 404, statusText: "Not Found" }));
    await expect(pollReply("ops", "id1", { timeoutSeconds: 5 }, cfg)).rejects.toThrow(
      /reply poll returned 404/
    );
  });

  it("throws (fail-closed) on a network error during polling — never reports an answer", async () => {
    mockFetch(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(pollReply("ops", "id1", { timeoutSeconds: 5 }, cfg)).rejects.toThrow(
      /Could not reach Blipr/
    );
  });

  it("polls each slice until the budget is exhausted, then gives up with timeout", async () => {
    mockFetch(async () => jsonRes({ status: "timeout" }));
    const outcome = await pollReply("ops", "id1", { timeoutSeconds: 3, waitSeconds: 1 }, cfg);
    expect(outcome).toEqual({ status: "timeout" });
    expect(calls().length).toBe(3); // three 1-second slices, then give up
  });

  it("never invents an answer from a malformed 'answered' (missing value)", async () => {
    mockFetch(async () => jsonRes({ status: "answered" })); // no value field
    const outcome = await pollReply("ops", "id1", { timeoutSeconds: 2, waitSeconds: 1 }, cfg);
    expect(outcome).toEqual({ status: "timeout" });
    expect(calls().length).toBe(2);
  });

  it("aborts a hung request and counts it as a no-reply slice (never an answer)", async () => {
    vi.useFakeTimers();
    // a fetch that never resolves on its own — only its abort signal ends it
    global.fetch = vi.fn(
      (_url: any, init: any) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        })
    ) as unknown as typeof fetch;
    const p = pollReply("ops", "id1", { timeoutSeconds: 2, waitSeconds: 1 }, cfg);
    await vi.advanceTimersByTimeAsync(6000); // slice 1 deadline: wait(1s) + slack(5s)
    await vi.advanceTimersByTimeAsync(6000); // slice 2 deadline
    await expect(p).resolves.toEqual({ status: "timeout" });
    expect(calls().length).toBe(2);
    vi.useRealTimers();
  });
});
