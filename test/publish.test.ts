import { afterEach, describe, expect, it, vi } from "vitest";
import {
  publish,
  publishExpectingReply,
  pollReply,
  checkReply,
  type BliprConfig,
} from "../src/publish.js";
import { authOf, bodyOf, calls, installFetch as mockFetch, jsonRes } from "./helpers.js";

const cfg: BliprConfig = { bliprUrl: "https://blipr.dev", defaultTopic: "default-topic" };

const ok = async () => new Response(null, { status: 200 });

describe("publish", () => {
  afterEach(() => vi.restoreAllMocks());

  it("POSTs a JSON body to /blip/{topic}", async () => {
    mockFetch(ok);
    const topic = await publish({ message: "hi", topic: "alerts" }, cfg);
    expect(topic).toBe("alerts");
    const [url, init] = calls()[0];
    expect(url).toBe("https://blipr.dev/blip/alerts");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    // topic is in the URL, not the body
    expect(bodyOf()).toEqual({ message: "hi" });
  });

  it("falls back to the default topic when none is given", async () => {
    mockFetch(ok);
    const topic = await publish({ message: "hi" }, cfg);
    expect(topic).toBe("default-topic");
    expect(calls()[0][0]).toBe("https://blipr.dev/blip/default-topic");
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
    expect(calls()[0][0]).toBe("https://blipr.dev/blip/a%2Fb%20c");
  });

  it("strips a trailing slash from the base URL", async () => {
    mockFetch(ok);
    await publish({ message: "m", topic: "t" }, { bliprUrl: "https://blipr.dev/" });
    expect(calls()[0][0]).toBe("https://blipr.dev/blip/t");
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
      /^https:\/\/blipr\.dev\/blip\/ops\/abc123def456\/reply\?wait=\d+$/
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
    mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        })
    );
    const p = pollReply("ops", "id1", { timeoutSeconds: 2, waitSeconds: 1 }, cfg);
    await vi.advanceTimersByTimeAsync(6000); // slice 1 deadline: wait(1s) + slack(5s)
    await vi.advanceTimersByTimeAsync(6000); // slice 2 deadline
    await expect(p).resolves.toEqual({ status: "timeout" });
    expect(calls().length).toBe(2);
    vi.useRealTimers();
  });
});

describe("checkReply (single-shot resume)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns an already-attached answer immediately, one wait=0 GET, no looping", async () => {
    mockFetch(async () => jsonRes({ status: "answered", value: "no", replied_at: 1700000123 }));
    const outcome = await checkReply("ops", "id1", 0, cfg);
    expect(outcome).toEqual({ status: "answered", value: "no", repliedAt: 1700000123 });
    expect(calls().length).toBe(1);
    expect(calls()[0][0]).toBe("https://blipr.dev/blip/ops/id1/reply?wait=0");
  });

  it("returns timeout (nothing yet) without looping", async () => {
    mockFetch(async () => jsonRes({ status: "pending" }));
    const outcome = await checkReply("ops", "id1", 0, cfg);
    expect(outcome).toEqual({ status: "timeout" });
    expect(calls().length).toBe(1);
  });

  it("throws (fail-closed) on a non-2xx check", async () => {
    mockFetch(async () => new Response("gone", { status: 404, statusText: "Not Found" }));
    await expect(checkReply("ops", "id1", 0, cfg)).rejects.toThrow(/reply poll returned 404/);
  });
});

const TOKEN = "blipr_pk_secret123";
const tokenCfg: BliprConfig = { ...cfg, token: TOKEN };

describe("bearer token", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends no Authorization header when no token is configured", async () => {
    mockFetch(ok);
    await publish({ message: "m", topic: "t" }, cfg);
    expect(authOf()).toBeUndefined();
  });

  it("sends Authorization: Bearer on publish when a token is configured", async () => {
    mockFetch(ok);
    await publish({ message: "m", topic: "t" }, tokenCfg);
    expect(authOf()).toBe(`Bearer ${TOKEN}`);
    expect(calls()[0][1].headers["Content-Type"]).toBe("application/json");
  });

  it("sends Authorization on a publish that expects a reply", async () => {
    mockFetch(async () => jsonRes({ id: "abc123def456", expected_reply: "binary" }));
    await publishExpectingReply({ message: "m", topic: "t", reply: "binary" }, tokenCfg);
    expect(authOf()).toBe(`Bearer ${TOKEN}`);
  });

  it("sends Authorization on every reply long-poll slice", async () => {
    mockFetch(async () => jsonRes({ status: "timeout" }));
    await pollReply("ops", "id1", { timeoutSeconds: 2, waitSeconds: 1 }, tokenCfg);
    expect(calls().length).toBe(2);
    expect(authOf(0)).toBe(`Bearer ${TOKEN}`);
    expect(authOf(1)).toBe(`Bearer ${TOKEN}`);
  });

  it("sends Authorization on a single-shot reply check, and none without a token", async () => {
    mockFetch(async () => jsonRes({ status: "pending" }));
    await checkReply("ops", "id1", 0, tokenCfg);
    expect(authOf()).toBe(`Bearer ${TOKEN}`);
    await checkReply("ops", "id1", 0, cfg);
    expect(authOf(1)).toBeUndefined();
  });

  it("never leaks the token into an HTTP error message", async () => {
    mockFetch(async () => new Response("denied", { status: 403, statusText: "Forbidden" }));
    const err = await publish({ message: "m", topic: "@alice/alerts" }, tokenCfg).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it("never leaks the token into a network error message", async () => {
    mockFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    const err = await publish({ message: "m", topic: "@alice/alerts" }, tokenCfg).catch(
      (e: unknown) => e
    );
    expect((err as Error).message).not.toContain(TOKEN);
  });
});

describe("namespaced @handle/topic URLs", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps the handle and topic as separate path segments on publish", async () => {
    mockFetch(ok);
    const topic = await publish({ message: "m", topic: "@alice/alerts" }, cfg);
    expect(topic).toBe("@alice/alerts");
    expect(calls()[0][0]).toBe("https://blipr.dev/blip/%40alice/alerts");
  });

  it("keeps both segments on the reply URL", async () => {
    mockFetch(async () => jsonRes({ status: "answered", value: "yes" }));
    await checkReply("@alice/alerts", "abc123def456", 0, cfg);
    expect(calls()[0][0]).toBe("https://blipr.dev/blip/%40alice/alerts/abc123def456/reply?wait=0");
  });

  it("encodes each segment without escaping the separator", async () => {
    mockFetch(ok);
    await publish({ message: "m", topic: "@a b/c d" }, cfg);
    expect(calls()[0][0]).toBe("https://blipr.dev/blip/%40a%20b/c%20d");
  });

  it("leaves a plain topic encoded as a single segment (unchanged behaviour)", async () => {
    mockFetch(ok);
    await publish({ message: "m", topic: "a/b" }, cfg);
    expect(calls()[0][0]).toBe("https://blipr.dev/blip/a%2Fb");
  });

  it("publishes then polls the reply on a namespaced topic, authorized throughout", async () => {
    let n = 0;
    mockFetch(async () => {
      n += 1;
      return n === 1
        ? jsonRes({ id: "abc123def456", expected_reply: "binary" })
        : jsonRes({ status: "answered", value: "yes", replied_at: 1700000000 });
    });
    const { topic, id } = await publishExpectingReply(
      { message: "ship it?", topic: "@alice/alerts", reply: "binary" },
      tokenCfg
    );
    const outcome = await pollReply(topic, id, { timeoutSeconds: 5 }, tokenCfg);
    expect(outcome).toEqual({ status: "answered", value: "yes", repliedAt: 1700000000 });
    expect(calls()[0][0]).toBe("https://blipr.dev/blip/%40alice/alerts");
    expect(calls()[1][0]).toMatch(
      /^https:\/\/blipr\.dev\/blip\/%40alice\/alerts\/abc123def456\/reply\?wait=\d+$/
    );
    expect(authOf(0)).toBe(`Bearer ${TOKEN}`);
    expect(authOf(1)).toBe(`Bearer ${TOKEN}`);
  });
});
