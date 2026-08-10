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

/** Key/value file read from the launch directory only (never walked upward). */
export const ENV_FILE = ".env";

/** Where a resolved default topic came from. */
export type TopicSource = "file" | "env";

export interface DefaultTopic {
  topic: string;
  source: TopicSource;
  /** Absolute path of the topic file, when `source` is "file". */
  path?: string;
}

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

/**
 * Parse `KEY=VALUE` pairs out of a `.env` file. Blank lines, `#` comments and
 * lines without a key are skipped; an optional `export ` prefix and one layer
 * of matching quotes are stripped.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).replace(/^export\s+/, "").trim();
    if (!key) continue;
    let value = trimmed.slice(eq + 1).trim();
    const quote = value[0];
    if (value.length > 1 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

/**
 * Read `.env` from `dir`. A missing or unreadable file yields nothing rather
 * than throwing. (Hand-rolled because `process.loadEnvFile` needs Node 20.6+
 * and this package supports Node 18.)
 */
function readEnvFile(dir: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(join(dir, ENV_FILE), "utf8"));
  } catch {
    return {}; // no readable .env — env vars alone decide
  }
}

/**
 * Resolve the scoped token sent with requests, from `BLIPR_TOKEN`. The real
 * environment wins; a `.env` in the launch directory is the fallback. Only
 * this one key is read from the file — nothing is injected into `process.env`.
 */
export function resolveToken(
  startDir: string,
  env: Record<string, string | undefined> = process.env
): string | undefined {
  const fromEnv = env.BLIPR_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  return readEnvFile(startDir).BLIPR_TOKEN?.trim() || undefined;
}
