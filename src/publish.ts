/** Blipr publish client — the one piece of real logic, kept pure for testing. */

export interface BliprConfig {
  /** Base URL of the Blipr server, e.g. https://blipr.dev */
  bliprUrl: string;
  /** Topic used when a call omits one. */
  defaultTopic?: string;
}

/** The kind of reply a published message asks the human to attach. */
export type ReplyKind = "binary" | "ack";

/** Per-request long-poll deadline slack (ms) on top of the server's `wait`. */
const POLL_SLACK_MS = 5000;
/** Hard client-side timeout for the publish POST (ms). */
const PUBLISH_TIMEOUT_MS = 15000;
/** Server's max accepted long-poll `wait` (seconds); notify `reply.max_wait_secs`. */
const SERVER_WAIT_CAP_SECONDS = 300;

/**
 * `fetch` with a hard client-side deadline. A hung / black-holed connection
 * would otherwise ignore our timeout budget entirely; this aborts it. The timer
 * is always cleared, so nothing lingers after the request resolves.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** True when an error came from our own abort timer (vs a real network error). */
function isAbort(e: Error): boolean {
  return e.name === "AbortError" || e.name === "TimeoutError";
}

export interface PublishOpts {
  message: string;
  topic?: string;
  title?: string;
  priority?: number;
  tags?: string[];
  click?: string;
  /** Ask the recipient for a reply: "binary" (yes/no) or "ack". */
  reply?: ReplyKind;
}

/** Parsed result of a publish that requested a reply. */
export interface PublishResult {
  /** The resolved topic the message was sent to. */
  topic: string;
  /** Server-assigned 12-char hex message id — needed to retrieve the reply. */
  id: string;
  /** The reply type the server recorded for this message, echoed back. */
  expectedReply?: ReplyKind;
}

/** Resolve the topic (call-supplied or default) or throw a clear error. */
function resolveTopic(opts: PublishOpts, cfg: BliprConfig): string {
  const topic = (opts.topic ?? cfg.defaultTopic ?? "").trim();
  if (!topic) {
    throw new Error(
      "No topic given and BLIPR_TOPIC is not set. Pass `topic`, or set the BLIPR_TOPIC env var."
    );
  }
  return topic;
}

/** Build the JSON publish body from options (topic lives in the URL path). */
function buildPayload(opts: PublishOpts): Record<string, unknown> {
  const payload: Record<string, unknown> = { message: opts.message };
  if (opts.title) payload.title = opts.title;
  if (opts.priority) payload.priority = opts.priority;
  if (opts.tags?.length) payload.tags = opts.tags;
  if (opts.click) payload.click = opts.click;
  if (opts.reply) payload.reply = opts.reply;
  return payload;
}

/** POST the publish body and return the raw Response (after an ok() check). */
async function postPublish(topic: string, opts: PublishOpts, cfg: BliprConfig): Promise<Response> {
  const base = cfg.bliprUrl.replace(/\/+$/, "");
  const url = `${base}/blip/${encodeURIComponent(topic)}`;

  let res: Response;
  try {
    res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload(opts)),
      },
      PUBLISH_TIMEOUT_MS
    );
  } catch (e) {
    const err = e as Error;
    const reason = isAbort(err) ? `timed out after ${PUBLISH_TIMEOUT_MS / 1000}s` : err.message;
    throw new Error(`Could not reach Blipr at ${base}: ${reason}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Blipr returned ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`);
  }
  return res;
}

/**
 * Publish a message to a Blipr topic. Returns the resolved topic on success.
 *
 * Posts to `POST /blip/{topic}` (topic in the URL) with a JSON body. JSON
 * is UTF-8, so titles/messages with emoji or accents survive — HTTP headers are
 * Latin-1 only and would corrupt or reject them.
 */
export async function publish(opts: PublishOpts, cfg: BliprConfig): Promise<string> {
  const topic = resolveTopic(opts, cfg);
  await postPublish(topic, opts, cfg);
  return topic;
}

/**
 * Publish a message that asks the human for a reply and return the parsed
 * response, including the server-assigned message `id`. The caller then
 * long-polls {@link pollReply} with that id to wait for the answer.
 */
export async function publishExpectingReply(
  opts: PublishOpts & { reply: ReplyKind },
  cfg: BliprConfig
): Promise<PublishResult> {
  const topic = resolveTopic(opts, cfg);
  const res = await postPublish(topic, opts, cfg);

  let parsed: { id?: string; expected_reply?: ReplyKind };
  try {
    parsed = (await res.json()) as typeof parsed;
  } catch (e) {
    throw new Error(`Blipr publish returned an unparseable response: ${(e as Error).message}`);
  }
  if (!parsed.id) {
    throw new Error("Blipr publish response did not include a message id — cannot await a reply.");
  }
  return { topic, id: parsed.id, expectedReply: parsed.expected_reply };
}

/** The answer the human attached, or a non-answer terminal/keep-waiting state. */
export type ReplyOutcome =
  | { status: "answered"; value: string; repliedAt?: number }
  | { status: "timeout" };

export interface PollOpts {
  /** Overall seconds to wait for a human reply before giving up. */
  timeoutSeconds: number;
  /** Per-request long-poll cap, in seconds. Server caps at ~300; default 30. */
  waitSeconds?: number;
}

/** Build the reply endpoint base URL for a topic + message id. */
function replyUrlFor(topic: string, messageId: string, cfg: BliprConfig): { base: string; replyUrl: string } {
  const base = cfg.bliprUrl.replace(/\/+$/, "");
  return {
    base,
    replyUrl: `${base}/blip/${encodeURIComponent(topic)}/${encodeURIComponent(messageId)}/reply`,
  };
}

/**
 * One reply `GET`. Returns the answer, or `null` for "no reply on this slice"
 * (`pending`/`timeout`, a malformed `answered`, or our own abort of a hung
 * request). Throws on a real error (non-2xx, network) so callers fail closed.
 */
async function pollOnce(replyUrl: string, wait: number, base: string): Promise<ReplyOutcome | null> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${replyUrl}?wait=${wait}`, { method: "GET" }, wait * 1000 + POLL_SLACK_MS);
  } catch (e) {
    const err = e as Error;
    // Our own per-request deadline fired (a hung / black-holed connection): no
    // reply this slice — NEVER an answer. Genuine network errors fail closed.
    if (isAbort(err)) return null;
    throw new Error(`Could not reach Blipr at ${base}: ${err.message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Blipr reply poll returned ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`);
  }
  const data = (await res.json().catch(() => ({}))) as {
    status?: string;
    value?: string;
    replied_at?: number;
  };
  if (data.status === "answered" && typeof data.value === "string") {
    return { status: "answered", value: data.value, repliedAt: data.replied_at };
  }
  return null; // "pending" / "timeout" / malformed → nothing yet
}

/**
 * Long-poll the reply endpoint in a loop until the human answers or the overall
 * timeout budget is exhausted. Each request blocks server-side for up to `wait`
 * seconds; "nothing yet" spends that slice and we poll again. Network/HTTP errors
 * throw (fail closed) — a non-answer is never reported as an answer.
 */
export async function pollReply(
  topic: string,
  messageId: string,
  opts: PollOpts,
  cfg: BliprConfig
): Promise<ReplyOutcome> {
  const { base, replyUrl } = replyUrlFor(topic, messageId, cfg);
  const perRequestWait = Math.max(1, opts.waitSeconds ?? 30);
  let remaining = opts.timeoutSeconds;

  while (remaining > 0) {
    // Never request more than the server's accepted cap, nor more than is left.
    const wait = Math.min(perRequestWait, remaining, SERVER_WAIT_CAP_SECONDS);
    const outcome = await pollOnce(replyUrl, wait, base);
    if (outcome) return outcome;
    remaining -= wait;
  }
  return { status: "timeout" };
}

/**
 * Single, non-looping reply check — for resuming an earlier ask/request_ack
 * (after it timed out or the client cancelled). `waitSeconds` 0 returns the
 * current state immediately; >0 briefly long-polls (capped at the server max).
 */
export async function checkReply(
  topic: string,
  messageId: string,
  waitSeconds: number,
  cfg: BliprConfig
): Promise<ReplyOutcome> {
  const { base, replyUrl } = replyUrlFor(topic, messageId, cfg);
  const wait = Math.max(0, Math.min(waitSeconds, SERVER_WAIT_CAP_SECONDS));
  return (await pollOnce(replyUrl, wait, base)) ?? { status: "timeout" };
}
