/** Blipr publish client — the one piece of real logic, kept pure for testing. */

export interface BliprConfig {
  /** Base URL of the Blipr server, e.g. https://blipr.dev */
  bliprUrl: string;
  /** Topic used when a call omits one. */
  defaultTopic?: string;
}

export interface PublishOpts {
  message: string;
  topic?: string;
  title?: string;
  priority?: number;
  tags?: string[];
  click?: string;
}

/**
 * Publish a message to a Blipr topic. Returns the resolved topic on success.
 *
 * Posts to `POST /api/notify/{topic}` (topic in the URL) with a JSON body. JSON
 * is UTF-8, so titles/messages with emoji or accents survive — HTTP headers are
 * Latin-1 only and would corrupt or reject them.
 */
export async function publish(opts: PublishOpts, cfg: BliprConfig): Promise<string> {
  const topic = (opts.topic ?? cfg.defaultTopic ?? "").trim();
  if (!topic) {
    throw new Error(
      "No topic given and BLIPR_TOPIC is not set. Pass `topic`, or set the BLIPR_TOPIC env var."
    );
  }

  // Topic goes in the URL path; everything else is the JSON body.
  const payload: Record<string, unknown> = { message: opts.message };
  if (opts.title) payload.title = opts.title;
  if (opts.priority) payload.priority = opts.priority;
  if (opts.tags?.length) payload.tags = opts.tags;
  if (opts.click) payload.click = opts.click;

  const base = cfg.bliprUrl.replace(/\/+$/, "");
  const url = `${base}/api/notify/${encodeURIComponent(topic)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    throw new Error(`Could not reach Blipr at ${base}: ${(e as Error).message}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Blipr returned ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`);
  }
  return topic;
}
