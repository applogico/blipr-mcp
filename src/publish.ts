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

/** POST a message to a Blipr topic. Returns the resolved topic on success. */
export async function publish(opts: PublishOpts, cfg: BliprConfig): Promise<string> {
  const topic = (opts.topic ?? cfg.defaultTopic ?? "").trim();
  if (!topic) {
    throw new Error(
      "No topic given and BLIPR_TOPIC is not set. Pass `topic`, or set the BLIPR_TOPIC env var."
    );
  }

  const headers: Record<string, string> = { "Content-Type": "text/plain" };
  if (opts.title) headers["X-Title"] = opts.title;
  if (opts.priority) headers["X-Priority"] = String(opts.priority);
  if (opts.tags?.length) headers["X-Tags"] = opts.tags.join(",");
  if (opts.click) headers["X-Click"] = opts.click;

  const base = cfg.bliprUrl.replace(/\/+$/, "");
  const url = `${base}/api/notify/${encodeURIComponent(topic)}`;

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: opts.message });
  } catch (e) {
    throw new Error(`Could not reach Blipr at ${base}: ${(e as Error).message}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Blipr returned ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`);
  }
  return topic;
}
