/**
 * Per-project default-topic discovery.
 *
 * The topic for a call is resolved with this precedence:
 *   1. the `topic` tool argument (per call — always wins),
 *   2. the nearest `.blipr-topic` file from the launch directory upward
 *      (per project),
 *   3. the `BLIPR_TOPIC` env var (global fallback, backward compatible).
 *
 * MCP hosts launch stdio servers with the project directory as cwd, so a
 * `.blipr-topic` file checked into a project gives that project its own
 * default topic even when the MCP server is registered globally.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** File name looked up from the launch directory upward. */
export const TOPIC_FILE = ".blipr-topic";

/** Where a resolved default topic came from. */
export type TopicSource = "file" | "env";

export type DefaultTopic =
  | { topic: string; source: "file"; path: string }
  | { topic: string; source: "env" };

/**
 * Parse the topic out of a `.blipr-topic` file: the first non-empty line that
 * is not a `#` comment, trimmed. Returns undefined when the file has none.
 */
export function parseTopicFile(contents: string): string | undefined {
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) return trimmed;
  }
  return undefined;
}

/**
 * Find the nearest `.blipr-topic` file walking up from `startDir` to the
 * filesystem root. A file that yields no topic (empty / comments only) is
 * skipped and the walk continues upward.
 */
export function findTopicFile(startDir: string): { topic: string; path: string } | undefined {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, TOPIC_FILE);
    let contents: string | undefined;
    try {
      contents = readFileSync(candidate, "utf8");
    } catch {
      contents = undefined; // no readable file here — keep walking up
    }
    if (contents !== undefined) {
      const topic = parseTopicFile(contents);
      if (topic) return { topic, path: candidate };
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined; // reached the filesystem root
    dir = parent;
  }
}

/**
 * Resolve the server's default topic — used only when a tool call omits
 * `topic`. Nearest `.blipr-topic` file wins over the `BLIPR_TOPIC` env var;
 * returns undefined when neither is present (calls must then pass `topic`).
 */
export function resolveDefaultTopic(
  startDir: string,
  env: Record<string, string | undefined> = process.env
): DefaultTopic | undefined {
  const fromFile = findTopicFile(startDir);
  if (fromFile) return { topic: fromFile.topic, source: "file", path: fromFile.path };
  const fromEnv = env.BLIPR_TOPIC?.trim();
  if (fromEnv) return { topic: fromEnv, source: "env" };
  return undefined;
}
