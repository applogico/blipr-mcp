import { BliprClient, BliprError, type NotifyMessage } from "@blipr/js";
import type { BliprConfig } from "./publish.js";

export interface WaitOpts {
  /** Where to start: "all", "c<cursor>", a Unix time in seconds or a duration like "10m". */
  since?: string;
  /** Stop waiting after this many seconds; no limit when unset. */
  timeoutSeconds?: number;
  /** Aborts the wait, e.g. when the MCP client cancels the call. */
  signal?: AbortSignal;
}

export type WaitOutcome = { status: "message"; message: NotifyMessage } | { status: "timeout" };

/** A refusal the server will repeat on every reconnect (bad topic, no access). */
function isRefusal(err: unknown): err is BliprError {
  const status = err instanceof BliprError ? err.status : undefined;
  return status !== undefined && status >= 400 && status < 500 && status !== 429;
}

/** Wait on the topic's event stream and return the next message. */
export async function waitForMessage(topic: string, opts: WaitOpts, cfg: BliprConfig): Promise<WaitOutcome> {
  const client = new BliprClient({ server: cfg.bliprUrl, token: cfg.token });
  const stop = new AbortController();
  const cancel = () => {
    stop.abort();
  };
  opts.signal?.addEventListener("abort", cancel, { once: true });
  const timer = opts.timeoutSeconds ? setTimeout(cancel, opts.timeoutSeconds * 1000) : undefined;
  let refused: BliprError | undefined;
  try {
    const stream = client.messages(topic, {
      since: opts.since,
      signal: stop.signal,
      onError: (err) => {
        if (!isRefusal(err)) return;
        refused = err;
        stop.abort();
      },
    });
    for await (const message of stream) return { status: "message", message };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", cancel);
  }
  if (refused) throw refused;
  return { status: "timeout" };
}
